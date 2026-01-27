// Servidor webhook + integración Chatwoot + OpenAI + Google Sheets
// Variables de entorno necesarias:
// - OPENAI_API_KEY
// - CHATWOOT_API_TOKEN
// - CHATWOOT_BASE (opcional, por defecto https://app.chatwoot.com)
// - (opcional) CHATWOOT_ACCOUNT_ID (se usa si no viene en el webhook)
// - (opcional) GOOGLE_CREDENTIALS_JSON (si usás Sheets)
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body (Chatwoot sends application/json)
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); },
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf) => { req.rawBody = (req.rawBody || '') + (buf && buf.toString()); },
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
  lastRequest = { time: now, method: req.method, url: req.originalUrl, headers: req.headers, body: req.body, rawBody: req.rawBody };
  next();
});

app.get('/', (req, res) => res.send('OK'));
app.get('/debug/last', (req, res) => res.json(lastRequest || {}));

// ENV
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_API_TOKEN = process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_BASE = process.env.CHATWOOT_BASE || 'https://app.chatwoot.com';
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID || null;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ OPENAI_API_KEY no está definido en las variables de entorno.');
if (!CHATWOOT_API_TOKEN) console.error('❌ CHATWOOT_API_TOKEN no está definido en las variables de entorno.');

const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// Google Auth (optional)
let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try { GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON); } catch (e) { console.error('❌ GOOGLE_CREDENTIALS_JSON parse error', e.message); }
}
const auth = new GoogleAuth({ credentials: GOOGLE_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

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
    const res = await sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'RAW', resource });
    console.log(`Google Sheets: marcado row ${rowNumber} col ${columnLetter} -> RECLAMADO. Status:`, res.status);
    return true;
  } catch (err) {
    console.error('❌ Error marcando usuario como reclamado en Sheets:', err?.message || err);
    return false;
  }
}

// Utilities (reused from original)
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
    if (/withdraw|retiro|retir/i.test(type)) totals[user].withdrawals += amount;
  });
  return totals;
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// OpenAI helpers (unchanged)
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

// Text helpers
function stripHtml(s) {
  return String(s || '').replace(/<\/?[^>]+(>|$)/g, '').trim();
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
  for (const re of explicitPatterns) {
    const found = m.match(re);
    if (found && found[1]) return found[1].trim();
  }
  const tokens = m.split(/[\s,;.:\-()]+/).filter(Boolean);
  const tokenCandidates = tokens.map(t => t.replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9._-]+$/g, '')).filter(t => t.length >= 3).filter(t => !STOPWORDS.has(t.toLowerCase()));
  for (const t of tokenCandidates) if (/\d/.test(t) && /^[A-Za-z0-9._-]{3,30}$/.test(t)) return t;
  for (const t of tokenCandidates) { if (/^[A-Za-z0-9._-]{3,30}$/.test(t)) { const low = t.toLowerCase(); if (!STOPWORDS.has(low)) return t; } }
  return null;
}

// Chatwoot integration: send outgoing message (masked logging for debug)
async function sendToChatwoot(accountId, conversationId, content) {
  if (!CHATWOOT_API_TOKEN) {
    console.error('❌ CHATWOOT_API_TOKEN no definido.');
    return false;
  }
  if (!conversationId) {
    console.warn('No conversationId provided; cannot send message to Chatwoot.');
    return false;
  }
  const acct = accountId || CHATWOOT_ACCOUNT_ID;
  if (!acct) {
    console.warn('No account id available to send message to Chatwoot.');
    return false;
  }

  const url = `${CHATWOOT_BASE.replace(/\/$/, '')}/api/v1/accounts/${acct}/conversations/${conversationId}/messages`;
  const payload = { content, message_type: 'outgoing' };

  // Build headers and mask token for logs
  const maskToken = (t) => (typeof t === 'string' && t.length > 8) ? `${t.slice(0,6)}...${t.slice(-4)}` : '*****';
  const headers = { Authorization: `Bearer ${CHATWOOT_API_TOKEN}`, 'Content-Type': 'application/json' };

  console.log('Enviando a Chatwoot:', { url, acct, conversationId, payloadPreview: (content && content.slice(0,120)), hasToken: !!CHATWOOT_API_TOKEN, maskedToken: maskToken(CHATWOOT_API_TOKEN), CHATWOOT_BASE });

  try {
    const resp = await axios.post(url, payload, { headers, timeout: 15000 });
    console.log('Chatwoot send response status:', resp.status, resp.data ? resp.data : '');
    return resp.status >= 200 && resp.status < 300;
  } catch (err) {
    // Mostrar detalles del error recibido por Chatwoot (status y body si existen)
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('❌ Error sending message to Chatwoot:', { status, data });
    // También imprimir la URL y headers (mask token) para verificar que se usó lo correcto
    console.error('Request info debug:', { url, acct, conversationId, maskedToken: maskToken(CHATWOOT_API_TOKEN), CHATWOOT_BASE });
    return false;
  }
}

// Webhook handler for Chatwoot (and compatible payloads)
app.post(['/', '/webhook-chatwoot'], (req, res) => {
  // respond early
  res.sendStatus(200);

  (async () => {
    try {
      const body = req.body || {};
      // Chatwoot event name is "message_created"
      const eventType = body.event || body.type || null;
      if (String(eventType) !== 'message_created') {
        console.log('Evento no procesado (no message_created):', eventType);
        return;
      }

      // Message can be at body.message, body.messages[0], or body.data.message
      const messageObj = body.message || (Array.isArray(body.messages) && body.messages[0]) || body.data?.message || (body.data && Array.isArray(body.data?.messages) && body.data.messages[0]) || null;
      const messageId = messageObj?.id || body.id || null;
      const accountId = (body.account && body.account.id) || (body.data && body.data.account && body.data.account.id) || CHATWOOT_ACCOUNT_ID;
      const conversationId = (body.conversation && body.conversation.id) || (body.data && body.data.conversation && body.data.conversation.id) || null;
      const incomingFlag = messageObj ? (messageObj.message_type === 0 || messageObj.sender_type === 'Contact' || messageObj.incoming === true) : true;

      if (!incomingFlag) return; // sólo procesar mensajes entrantes
      if (!conversationId) {
        console.warn('No conversationId encontrado en webhook');
        return;
      }
      if (messageId && processedMessages.has(messageId)) {
        console.log(`Mensaje ${messageId} ya procesado; ignorando.`);
        return;
      }
      if (messageId) processedMessages.set(messageId, Date.now());

      // Extraer texto y limpiar
      const rawContent = messageObj?.content || body.content || body.data?.content || '';
      const text = stripHtml(rawContent);
      if (!text) {
        console.log('Webhook sin texto útil; se ignora.');
        return;
      }

      console.log('Mensaje entrante desde Chatwoot:', { accountId, conversationId, messageId, text });

      // Detect intent
      const intent = await detectIntent(text);
      console.log('Intent detectado ->', intent);

      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(text);
        console.log('Respuesta ChatGPT ->', reply);
        const sent = await sendToChatwoot(accountId, conversationId, reply);
        if (!sent) console.warn('No se pudo enviar la respuesta a Chatwoot (ver logs).');
        return;
      }

      // Username flow (as before)
      const username = extractUsername(text);
      console.log('Username extraído ->', username);
      if (!username) {
        const ask = 'Estimado/a, por favor enviá exactamente tu nombre de usuario tal como figura en la plataforma para que lo confirme en nuestros registros.';
        console.log('Solicitando username ->', ask);
        await sendToChatwoot(accountId, conversationId, ask);
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
        const msg = `Estimado/a, no encontramos el usuario ${username} en nuestros registros. Por favor dirigite al canal principal donde realizás tus cargas para solicitar tu usuario correcto y volvé a intentarlo.`;
        console.log('Usuario no encontrado ->', msg);
        await sendToChatwoot(accountId, conversationId, msg);
        return;
      }

      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        const msg = `Estimado/a, según nuestros registros el reembolso para ${username} ya fue marcado como reclamado anteriormente. Si hay un error, contactanos por el canal principal con evidencia.`;
        console.log('Ya reclamado ->', msg);
        await sendToChatwoot(accountId, conversationId, msg);
        return;
      }

      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      const depositsStr = Number(userTotals.deposits).toFixed(2);
      const withdrawalsStr = Number(userTotals.withdrawals).toFixed(2);
      const netStr = Number(net).toFixed(2);

      if (net <= 1) {
        const msg = `Estimado/a, hemos verificado tus movimientos y, según nuestros registros, no corresponde reembolso en este caso.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}`;
        console.log('No aplica reembolso ->', msg);
        await sendToChatwoot(accountId, conversationId, msg);
        return;
      } else {
        const bonusStr = (net * 0.08).toFixed(2);
        const msg = `Estimado/a, confirmamos que corresponde un reembolso del 8% sobre tu neto. Monto: $${bonusStr}.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}`;
        console.log('Aplica reembolso ->', msg);
        const sent = await sendToChatwoot(accountId, conversationId, msg);
        if (!sent) console.warn('No se pudo enviar la respuesta a Chatwoot (ver logs).');

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

// --- DEBUG: comprobar token Chatwoot (añadido) ---
app.get('/debug/check-token', async (req, res) => {
  try {
    const url = `${CHATWOOT_BASE.replace(/\/$/, '')}/api/v1/accounts`;
    console.log('DEBUG: comprobando token Chatwoot ->', { url, CHATWOOT_BASE, hasToken: !!CHATWOOT_API_TOKEN });
    const headers = { Authorization: `Bearer ${CHATWOOT_API_TOKEN}` };
    const resp = await axios.get(url, { headers, timeout: 15000 });
    console.log('DEBUG: respuesta /api/v1/accounts ->', { status: resp.status, dataPreview: resp.data && (Array.isArray(resp.data) ? resp.data.map(a => ({ id: a.id, name: a.name })) : resp.data) });
    res.json({ ok: true, status: resp.status, accounts: resp.data && (Array.isArray(resp.data) ? resp.data.map(a => ({ id: a.id, name: a.name })) : resp.data) });
  } catch (err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    console.error('DEBUG: error al consultar /api/v1/accounts ->', { status, data });
    res.status(status || 500).json({ ok: false, status, data });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
