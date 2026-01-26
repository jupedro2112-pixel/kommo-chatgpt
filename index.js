require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); },
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = (req.rawBody || '') + (buf && buf.toString());
  },
}));

// Debug / dedupe
let lastRequest = null;
const processedMessages = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000;
function pruneProcessed() {
  const now = Date.now();
  for (const [k, t] of processedMessages.entries()) {
    if (now - t > DEDUP_TTL_MS) processedMessages.delete(k);
  }
}
setInterval(pruneProcessed, 60 * 1000);

// Logging middleware
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);
  console.log('Headers:', req.headers);
  console.log('Raw body:', req.rawBody || '(empty)');
  console.log('Parsed body:', req.body && Object.keys(req.body).length ? req.body : '(empty)');
  lastRequest = {
    time: now,
    method: req.method,
    url: req.originalUrl,
    headers: req.headers,
    body: req.body,
    rawBody: req.rawBody,
  };
  next();
});

app.get('/', (req, res) => res.send('OK'));
app.get('/debug/last', (req, res) => res.json(lastRequest || {}));

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CALLBELL_API_TOKEN = process.env.CALLBELL_API_TOKEN;
const CALLBELL_INTEGRATION_UUID = process.env.CALLBELL_INTEGRATION_UUID || null;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ OPENAI_API_KEY no está definido en las variables de entorno.');
if (!CALLBELL_API_TOKEN) console.error('❌ CALLBELL_API_TOKEN no está definido en las variables de entorno.');
if (!GOOGLE_CREDENTIALS_JSON) console.warn('⚠️ GOOGLE_CREDENTIALS_JSON no está definido. Sheets solo funcionará si está presente.');

// OpenAI init
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// Google Auth
let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try { GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON); } catch (e) { console.error('❌ GOOGLE_CREDENTIALS_JSON parse error', e.message); }
}
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Google Sheets helpers
async function getSheetData(spreadsheetId, range) {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (error) {
    console.error('❌ Error leyendo Google Sheets:', error?.message || error);
    return [];
  }
}
async function markUserAsClaimed(spreadsheetId, rowNumber, columnLetter = 'E') {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const range = `Sheet1!${columnLetter}${rowNumber}`;
    const resource = { values: [['RECLAMADO']] };
    const res = await sheets.spreadsheets.values.update({
      spreadsheetId,
      range,
      valueInputOption: 'RAW',
      resource,
    });
    console.log(`Google Sheets: marcado row ${rowNumber} col ${columnLetter} -> RECLAMADO. Status:`, res.status);
    return true;
  } catch (err) {
    console.error('❌ Error marcando usuario como reclamado en Sheets:', err?.message || err);
    return false;
  }
}

// Utilities
function parseAmount(value) {
  if (value === null || value === undefined) return 0;
  const s = String(value).replace(/\s/g, '').replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function calculateTotalsByUser(rows) {
  const totals = {};
  rows.forEach(row => {
    const type = String(row[0] || '').toLowerCase().trim();
    const userRaw = String(row[1] || '').trim();
    const user = userRaw.toLowerCase();
    const amount = parseAmount(row[2]);
    if (!user) return;
    if (!totals[user]) totals[user] = { deposits: 0, withdrawals: 0 };
    if (type.includes('deposit') || type.includes('depósito') || type.includes('deposito')) totals[user].deposits += amount;
    if (type.includes('withdraw') || type.includes('withdrawal') || type.includes('whitdraw') || type.includes('witdraw') || type.includes('retiro') || type.includes('retiros') || type.includes('retir') || type.includes('withdraws') || type.includes('ret')) totals[user].withdrawals += amount;
  });
  return totals;
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Callbell send with reattempts (tries multiple payload shapes)
async function sendReplyToCallbell(conversationId, message, rawFromString = null, channelUuid = null, phoneNumber = null) {
  if (!CALLBELL_API_TOKEN) {
    console.warn('⚠️ No CALLBELL_API_TOKEN; aborting send.');
    return false;
  }

  // normalize phone
  const normalizePhone = (p) => { if (!p) return null; const s = String(p).trim(); return s.startsWith('+') ? s : s; };

  const phone = normalizePhone(phoneNumber);

  // Build attempts in order:
  const attempts = [];

  // A: conversationId + raw from string (some accounts expect the raw 'from' string)
  if (conversationId && rawFromString) {
    attempts.push({
      to: conversationId,
      from: rawFromString,
      type: 'text',
      content: { text: message },
    });
  }

  // B: conversationId + from object with channelUuid (livechat)
  if (conversationId && channelUuid) {
    attempts.push({
      to: conversationId,
      from: { type: 'livechat', uuid: channelUuid },
      type: 'text',
      content: { text: message },
    });
  }

  // C: conversationId only (no from)
  if (conversationId) {
    attempts.push({
      to: conversationId,
      type: 'text',
      content: { text: message },
    });
  }

  // D: if CALLBELL_INTEGRATION_UUID provided, try with that (integrationId property)
  if (CALLBELL_INTEGRATION_UUID) {
    // attempt using integrationId with conversationId
    if (conversationId) {
      attempts.push({
        to: conversationId,
        from: { type: 'whatsapp', integrationId: CALLBELL_INTEGRATION_UUID },
        type: 'text',
        content: { text: message },
      });
    }
    // attempt using phone with integrationId (if phone exists)
    if (phone) {
      attempts.push({
        to: phone,
        from: { type: 'whatsapp', integrationId: CALLBELL_INTEGRATION_UUID },
        type: 'text',
        content: { text: message },
      });
    }
  }

  // Final attempt: to = phone without from
  if (phone) {
    attempts.push({
      to: phone,
      type: 'text',
      content: { text: message },
    });
  }

  // Wait a human-like delay before first attempt
  console.log('Esperando 5s antes de enviar a Callbell (human-like) ...');
  await sleep(5000);

  for (let i = 0; i < attempts.length; i++) {
    const payload = attempts[i];
    try {
      console.log(`Callbell send attempt ${i + 1}/${attempts.length}:`, JSON.stringify(payload));
      const resp = await axios.post('https://api.callbell.eu/v1/messages/send', payload, {
        headers: { Authorization: `Bearer ${CALLBELL_API_TOKEN}`, 'Content-Type': 'application/json' },
        timeout: 15000,
      });
      console.log('Callbell response status:', resp.status, resp.data ? resp.data : '');
      if (resp.status >= 200 && resp.status < 300) return true;
      if (resp.data && resp.data.error) console.warn('Callbell API returned error payload:', JSON.stringify(resp.data.error));
    } catch (err) {
      if (err?.response?.data) {
        console.error(`Error attempt ${i + 1}:`, JSON.stringify(err.response.data, null, 2));
      } else {
        console.error(`Error attempt ${i + 1}:`, err?.message || err);
      }
      // continue to next attempt
    }
  }

  console.error('Todos los intentos de envío a Callbell fallaron.');
  return false;
}

// OpenAI helpers
async function detectIntent(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        { role: 'system', content: `Sos un clasificador. Decidí si el mensaje es un NOMBRE DE USUARIO o una CHARLA. Respondé SOLO JSON: { "type": "username" } o { "type": "chat" }` },
        { role: 'user', content: message },
      ],
    });
    const content = resp.data?.choices?.[0]?.message?.content;
    if (!content) return { type: 'chat' };
    try { return JSON.parse(content); } catch (e) { console.warn('detectIntent parse failed', content); return { type: 'chat' }; }
  } catch (err) {
    console.error('detectIntent error:', err?.message || err);
    return { type: 'chat' };
  }
}
async function casinoChatResponse(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: `Sos un agente virtual de casino online. Respondés en español con variante rioplatense. Sé serio, profesional y empático.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('casinoChatResponse error:', err?.message || err);
    return 'Perdón, estoy teniendo un problema ahora mismo. ¿Podés repetir o darme tu nombre de usuario?';
  }
}

// Extractors
function extractMessageFromBody(body, raw) {
  const tryPaths = [
    () => body?.payload?.text,
    () => body?.text,
    () => body?.message?.add?.[0]?.text,
  ];
  for (const fn of tryPaths) {
    try { const v = fn(); if (v) return String(v).trim(); } catch (e) {}
  }
  if (raw) {
    try {
      const j = JSON.parse(raw);
      if (j?.payload?.text) return String(j.payload.text).trim();
    } catch (e) {}
    try {
      const params = new URLSearchParams(raw);
      for (const [k, v] of params) { if (!v) continue; const keyLower = k.toLowerCase(); if (keyLower.includes('text')) return decodeURIComponent(String(v)).replace(/\+/g, ' ').trim(); }
    } catch (e) {}
  }
  return null;
}
function extractUsername(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();
  const STOPWORDS = new Set(['mi','miembro','usuario','es','soy','me','llamo','nombre','el','la','de','por','favor','porfavor','hola','buenas','buenos','noches','dias','tarde','gracias']);
  const explicitPatterns = [
    /usuario(?:\s+es|\s*:\s*|\s+:+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /mi usuario(?:\s+es|\s*:\s*|\s+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /\bsoy\s+@?([A-Za-z0-9._-]{3,30})\b/i,
    /username(?:\s*:\s*|\s+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /@([A-Za-z0-9._-]{3,30})/i,
  ];
  for (const re of explicitPatterns) { const found = m.match(re); if (found && found[1]) return found[1].trim(); }
  const tokens = m.split(/[\s,;.:\-()]+/).filter(Boolean);
  const tokenCandidates = tokens.map(t => t.replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9._-]+$/g, '')).filter(t => t.length >= 3).filter(t => !STOPWORDS.has(t.toLowerCase()));
  for (const t of tokenCandidates) if (/\d/.test(t) && /^[A-Za-z0-9._-]{3,30}$/.test(t)) return t;
  for (const t of tokenCandidates) { if (/^[A-Za-z0-9._-]{3,30}$/.test(t)) { const low = t.toLowerCase(); if (!STOPWORDS.has(low)) return t; } }
  return null;
}

// Webhook handler
app.post(['/', '/webhook-callbell', '/webhook-kommo'], (req, res) => {
  // respond early to provider
  res.sendStatus(200);

  (async () => {
    try {
      const receivedText = extractMessageFromBody(req.body, req.rawBody);
      // conversationId (payload.to)
      const conversationId = req.body?.payload?.to || req.body?.to || null;
      const rawFromString = req.body?.payload?.from || req.body?.from || null;
      const channelUuid = req.body?.payload?.contact?.channel?.uuid || req.body?.contact?.channel?.uuid || null;
      const phoneNumber = req.body?.payload?.contact?.phoneNumber || req.body?.contact?.phoneNumber || null;
      const messageUuid = req.body?.payload?.uuid || req.body?.uuid || null;

      // dedupe
      if (messageUuid && processedMessages.has(messageUuid)) {
        console.log(`Mensaje UUID ${messageUuid} ya procesado; ignorando.`);
        return;
      }
      if (messageUuid) processedMessages.set(messageUuid, Date.now());

      if (!receivedText) {
        console.log('Webhook recibido pero no se encontró texto. Payload guardado en /debug/last.');
        return;
      }

      console.log('Mensaje recibido ->', receivedText);
      if (conversationId) console.log('Conversation ID ->', conversationId);
      if (rawFromString) console.log('rawFromString ->', rawFromString);
      if (channelUuid) console.log('channelUuid ->', channelUuid);

      const intent = await detectIntent(receivedText);
      console.log('Intent detectado ->', intent);

      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(receivedText);
        console.log('Respuesta ChatGPT ->', reply);
        await sendReplyToCallbell(conversationId, reply, rawFromString, channelUuid, phoneNumber);
        return;
      }

      // username flow
      const username = extractUsername(receivedText);
      console.log('Username extraído ->', username);
      if (!username) {
        const ask = 'Estimado/a, por favor enviá exactamente tu nombre de usuario tal como figura en la plataforma para que lo confirme en nuestros registros.';
        console.log('Solicitando username ->', ask);
        await sendReplyToCallbell(conversationId, ask, rawFromString, channelUuid, phoneNumber);
        return;
      }

      const lookupKey = String(username).toLowerCase().trim();
      console.log('Lookup key ->', lookupKey);

      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:E10000';
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      let foundRowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowUser = String(rows[i][1] || '').toLowerCase().trim();
        if (rowUser === lookupKey) { foundRowIndex = i; break; }
      }

      if (foundRowIndex === -1) {
        const msg = `Estimado/a, no encontramos el usuario ${username} en nuestros registros. Por favor dirigite al WhatsApp principal donde realizás tus cargas para solicitar tu usuario correcto y volvé a este chat con el usuario exacto.`;
        console.log('Usuario no encontrado ->', msg);
        await sendReplyToCallbell(conversationId, msg, rawFromString, channelUuid, phoneNumber);
        return;
      }

      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        const msg = `Estimado/a, según nuestros registros el reembolso para ${username} ya fue marcado como reclamado anteriormente. Si hay un error, contactanos por WhatsApp principal con evidencia.`;
        console.log('Ya reclamado ->', msg);
        await sendReplyToCallbell(conversationId, msg, rawFromString, channelUuid, phoneNumber);
        return;
      }

      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      const depositsStr = Number(userTotals.deposits).toFixed(2);
      const withdrawalsStr = Number(userTotals.withdrawals).toFixed(2);
      const netStr = Number(net).toFixed(2);

      if (net <= 1) {
        const msg = `Estimado/a, hemos verificado tus movimientos y, según nuestros registros, no corresponde reembolso en este caso.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nSi creés que hay un error, contactanos por WhatsApp principal y traenos el usuario correcto para que lo revisemos.`;
        console.log('No aplica reembolso ->', msg);
        await sendReplyToCallbell(conversationId, msg, rawFromString, channelUuid, phoneNumber);
        return;
      } else {
        const bonusStr = (net * 0.08).toFixed(2);
        const msg = `Estimado/a, confirmamos que corresponde un reembolso del 8% sobre tu neto. Monto: $${bonusStr}.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nEl reembolso se depositará automáticamente y podrás verificarlo en la plataforma usando tu usuario. Procedo a marcar este reembolso como reclamado en nuestros registros.`;
        console.log('Aplica reembolso ->', msg);
        const sent = await sendReplyToCallbell(conversationId, msg, rawFromString, channelUuid, phoneNumber);

        // mark as claimed if we at least sent the reply (sent true or false — we still attempt marking)
        const rowNumber = 2 + foundRowIndex;
        const marked = await markUserAsClaimed(spreadsheetId, rowNumber, 'E');
        if (marked) console.log(`Usuario ${username} marcado RECLAMADO en fila ${rowNumber}.`);
        else console.warn(`No se pudo marcar RECLAMADO para ${username} en fila ${rowNumber}.`);
        return;
      }
    } catch (err) {
      console.error('❌ Error procesando webhook (background):', err?.message || err);
    }
  })();
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
