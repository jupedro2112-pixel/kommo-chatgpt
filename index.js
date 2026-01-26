require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Capture raw body to debug content-types
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); },
}));
app.use(express.urlencoded({
  extended: true,
  verify: (req, res, buf) => {
    req.rawBody = (req.rawBody || '') + (buf && buf.toString());
  },
}));

// Simple in-memory last request for debugging
let lastRequest = null;

// Dedup map for incoming message UUIDs (to avoid duplicate processing)
// Stores timestamp; entries older than 5 min are ignored/pruned
const processedMessages = new Map();
const DEDUP_TTL_MS = 5 * 60 * 1000; // 5 minutes

function pruneProcessed() {
  const now = Date.now();
  for (const [k, t] of processedMessages.entries()) {
    if (now - t > DEDUP_TTL_MS) processedMessages.delete(k);
  }
}
setInterval(pruneProcessed, 60 * 1000);

// Logging middleware (most verbose: logs headers, raw body AND parsed body)
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

// Health and debug endpoints
app.get('/', (req, res) => res.send('OK'));
app.get('/debug/last', (req, res) => res.json(lastRequest || {}));

// ================== ENV ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CALLBELL_API_TOKEN = process.env.CALLBELL_API_TOKEN;
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ OPENAI_API_KEY no está definido en las variables de entorno.');
if (!CALLBELL_API_TOKEN) console.error('❌ CALLBELL_API_TOKEN no está definido en las variables de entorno.');
if (!GOOGLE_CREDENTIALS_JSON) console.warn('⚠️ GOOGLE_CREDENTIALS_JSON no está definido. Sheets solo funcionará si está presente.');

// ================== Inicialización de OpenAI ==================
const openai = new OpenAIApi(new Configuration({
  apiKey: OPENAI_API_KEY,
}));

// ================== GOOGLE AUTH (con permiso de escritura) ==================
let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON);
  } catch (err) {
    console.error('❌ No se pudo parsear GOOGLE_CREDENTIALS_JSON:', err.message);
  }
}
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// ================== GOOGLE SHEETS ==================
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
    console.log(`Google Sheets: marcado row ${rowNumber} col ${columnLetter} como RECLAMADO.`, res.status);
    return true;
  } catch (err) {
    console.error('❌ Error marcando usuario como reclamado en Sheets:', err?.message || err);
    return false;
  }
}

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

    if (type.includes('deposit') || type.includes('depósito') || type.includes('deposito')) {
      totals[user].deposits += amount;
    }

    if (
      type.includes('withdraw') ||
      type.includes('withdrawal') ||
      type.includes('whitdraw') ||
      type.includes('witdraw') ||
      type.includes('retiro') ||
      type.includes('retiros') ||
      type.includes('retir') ||
      type.includes('withdraws') ||
      type.includes('ret')
    ) {
      totals[user].withdrawals += amount;
    }
  });
  return totals;
}

// ================== UTIL: sleep para simular demora humana ==================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ================== SEND MESSAGE TO CALLBELL (espera 5s antes de enviar) ==================
async function sendReplyToCallbell(conversationId, message) {
  if (!CALLBELL_API_TOKEN) {
    console.warn('⚠️ No hay CALLBELL_API_TOKEN; no se enviará el mensaje.');
    return;
  }
  try {
    console.log(`Esperando 5s antes de enviar mensaje a Callbell...`);
    await sleep(5000); // 5 segundos para parecer humano
    const payload = {
      conversationId: conversationId,
      type: 'text',
      text: message,
    };
    console.log('Enviando a Callbell ->', payload);
    const resp = await axios.post('https://api.callbell.eu/v1/messages/send', payload, {
      headers: {
        Authorization: `Bearer ${CALLBELL_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
    console.log('Callbell response status:', resp.status, resp.data ? resp.data : '');
  } catch (err) {
    console.error('❌ Error enviando mensaje a Callbell:', err?.response?.data || err.message || err);
  }
}

// ================== GPT INTENT DETECTOR ==================
async function detectIntent(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `
Sos un clasificador. Decidí si el mensaje es un NOMBRE DE USUARIO o una CHARLA.

Respondé SOLO JSON: { "type": "username" } o { "type": "chat" }

Reglas:
- Si el texto contiene un posible username (token alfanumérico de 3-30 caracteres, puede incluir . _ - y opcionalmente empezar con @), o frases como "mi usuario es X", "usuario: X", "soy X", responde { "type": "username" }.
- Si el texto es un saludo, pregunta, comentario general o conversación sin un username claro, responde { "type": "chat" }.
- Respondé EXACTAMENTE con el JSON, sin texto adicional.
          `,
        },
        { role: 'user', content: message },
      ],
    });
    const content = resp.data?.choices?.[0]?.message?.content;
    if (!content) return { type: 'chat' };
    try { return JSON.parse(content); } catch (e) { console.warn('detectIntent: JSON parse failed:', content); return { type: 'chat' }; }
  } catch (err) {
    console.error('❌ detectIntent error:', err?.message || err);
    return { type: 'chat' };
  }
}

// ================== GPT CHAT RESPONSE ==================
async function casinoChatResponse(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        {
          role: 'system',
          content: `
Sos un agente virtual de casino online. Respondés en español con variante rioplatense (Argentina). Usá "vos" cuando sea apropiado, manteniendo un tono profesional, serio y empático.

Características importantes:
- Atención 24 horas para cargas y retiros.
- No hay límite máximo de retiro; los retiros se procesan 24/7.
- Cuando correspondan reembolsos, informá claramente el monto y explicá que se depositará automáticamente en la cuenta del cliente y podrá verificarlo en la plataforma usando su usuario.
- Si el cliente no proporcionó su usuario, pedílo de manera amable y concisa.
- Si luego no se encuentra el usuario en nuestros registros, indicá profesionalmente que debe dirigirse al WhatsApp principal donde realiza sus cargas para solicitar su nombre de usuario correcto y luego volver a este chat con el usuario exacto para que verifiquemos el reembolso.
- Si corresponde reembolso, ofrecé asistencia adicional y mantente empático.
- No des consejos financieros; enfocáte en procesos operativos y atención al cliente.
- Siempre mantén el texto claro, cortés y profesional; evita jerga excesiva.
          `,
        },
        { role: 'user', content: message },
      ],
    });
    // Solo usamos la primera opción y la retornamos (una única respuesta)
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('❌ casinoChatResponse error:', err?.message || err);
    return 'Perdón, estoy teniendo un problema ahora mismo. ¿Podés repetir o darme tu nombre de usuario?';
  }
}

// ================== UTIL: extraer texto del body (soporta Callbell y otros) ==================
function extractMessageFromBody(body, raw) {
  const tryPaths = [
    () => body?.payload?.text, // Callbell: payload.text
    () => body?.message?.add?.[0]?.text,
    () => body?.unsorted?.update?.[0]?.source_data?.data?.[0]?.text,
    () => body?.message?.add?.[0]?.source?.text,
    () => body?.message?.add?.[0]?.text_raw,
  ];

  for (const fn of tryPaths) {
    try {
      const v = fn();
      if (v) return String(v).trim();
    } catch (e) { /* ignore */ }
  }

  if (raw) {
    try {
      // try parse as JSON (Callbell sends JSON)
      try {
        const j = JSON.parse(raw);
        if (j?.payload?.text) return String(j.payload.text).trim();
      } catch (e) { /* not JSON */ }

      const params = new URLSearchParams(raw);
      for (const [k, v] of params) {
        if (!v) continue;
        const keyLower = k.toLowerCase();
        if (keyLower.endsWith('[text]') || keyLower.includes('[text]') || keyLower.endsWith('text')) {
          return decodeURIComponent(String(v)).replace(/\+/g, ' ').trim();
        }
      }
    } catch (e) {
      console.warn('extractMessageFromBody: fallo al parsear raw body:', e?.message || e);
    }
  }

  return null;
}

// ================== UTIL: extraer username desde un texto natural ==================
function extractUsername(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();

  const STOPWORDS = new Set([
    'mi','miembro','usuario','es','soy','me','llamo','nombre','el','la','de','por','favor','porfavor','hola','buenas','buenos','noches','dias','tarde','gracias'
  ]);

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
  const tokenCandidates = tokens
    .map(t => t.replace(/^[^A-Za-z0-9@]+|[^A-Za-z0-9._-]+$/g, ''))
    .filter(t => t.length >= 3)
    .filter(t => !STOPWORDS.has(t.toLowerCase()));

  for (const t of tokenCandidates) {
    if (/\d/.test(t) && /^[A-Za-z0-9._-]{3,30}$/.test(t)) return t;
  }

  for (const t of tokenCandidates) {
    if (/^[A-Za-z0-9._-]{3,30}$/.test(t)) {
      const low = t.toLowerCase();
      if (!STOPWORDS.has(low)) return t;
    }
  }

  return null;
}

// ================== WEBHOOK (soporta Callbell en / y mantiene compatibilidad con rutas antiguas) ==================
app.post(['/', '/webhook-callbell', '/webhook-kommo'], (req, res) => {
  // Responder rápido para que el proveedor reciba 200
  res.sendStatus(200);

  (async () => {
    try {
      // Extraer texto del body
      const receivedText = extractMessageFromBody(req.body, req.rawBody);

      // Obtener conversationId (Callbell -> payload.to)
      let conversationId = null;
      try {
        conversationId = req.body?.payload?.to || req.body?.message?.add?.[0]?.chat_id || null;
      } catch (e) { conversationId = null; }

      // Obtener unique uuid del mensaje (Callbell -> payload.uuid)
      let messageUuid = null;
      try {
        messageUuid = req.body?.payload?.uuid || req.body?.payload?.message_id || null;
      } catch (e) { messageUuid = null; }

      // Si no uuid, intentar extraer del raw JSON
      if (!messageUuid && req.rawBody) {
        try {
          const parsed = JSON.parse(req.rawBody);
          messageUuid = parsed?.payload?.uuid || parsed?.payload?.message_id || messageUuid;
        } catch (e) { /* ignore */ }
      }

      // Deduplicate: si ya procesamos este UUID recientemente, ignorar
      if (messageUuid && processedMessages.has(messageUuid)) {
        console.log(`Mensaje UUID ${messageUuid} ya procesado recientemente; se ignora para evitar duplicados.`);
        return;
      }
      if (messageUuid) processedMessages.set(messageUuid, Date.now());

      if (!receivedText) {
        console.log('Webhook recibido pero no se encontró texto del usuario. Payload guardado en /debug/last para inspección.');
        return;
      }

      console.log('Mensaje recibido ->', receivedText);
      if (conversationId) console.log('Conversation ID detectado ->', conversationId);
      if (messageUuid) console.log('Message UUID ->', messageUuid);

      // Intent detection
      const intent = await detectIntent(receivedText);
      console.log('Intent detectado por OpenAI ->', intent);

      // If chat -> conversational response
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(receivedText);
        console.log('Respuesta ChatGPT generada (solo una) ->', reply);
        await sendReplyToCallbell(conversationId, reply);
        return;
      }

      // If username intent -> extract username
      const username = extractUsername(receivedText);
      console.log('Username extraído ->', username);

      if (!username) {
        const ask = 'Estimado/a, entiendo que querés que verifique tu usuario. Por favor enviá exactamente tu nombre de usuario tal como figura en la plataforma para que lo confirme en nuestros registros.';
        console.log('No se pudo extraer username; se solicita aclaración ->', ask);
        await sendReplyToCallbell(conversationId, ask);
        return;
      }

      const lookupKey = String(username).toLowerCase().trim();
      console.log('Lookup key (lowercased) ->', lookupKey);

      // Buscar en Google Sheets (incluye columna E)
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:E10000';
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      // localizar la fila exacta (para marcar columna E si es necesario)
      let foundRowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowUser = String(rows[i][1] || '').toLowerCase().trim();
        if (rowUser === lookupKey) {
          foundRowIndex = i;
          break;
        }
      }

      if (foundRowIndex === -1) {
        const msg = `Estimado/a, no encontramos el usuario ${username} en nuestros registros. Por favor dirigite al WhatsApp principal donde realizás tus cargas para solicitar tu nombre de usuario correcto y volvé a este chat con el usuario exacto para que podamos corroborar el reembolso.`;
        console.log('Respuesta enviada (usuario no encontrado) ->', msg);
        await sendReplyToCallbell(conversationId, msg);
        return;
      }

      // verificar si ya fue reclamado (columna E = index 4)
      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        const msg = `Estimado/a, según nuestros registros el reembolso para ${username} ya fue marcado como reclamado anteriormente. Si creés que hay un error, contactanos por WhatsApp principal con evidencia y lo revisamos.`;
        console.log('Respuesta enviada (ya reclamado) ->', msg);
        await sendReplyToCallbell(conversationId, msg);
        return;
      }

      // obtener totales y decidir reembolso
      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      const depositsStr = Number(userTotals.deposits).toFixed(2);
      const withdrawalsStr = Number(userTotals.withdrawals).toFixed(2);
      const netStr = Number(net).toFixed(2);

      if (net <= 1) {
        const msg = `Estimado/a, hemos verificado tus movimientos y, según nuestros registros, no corresponde reembolso en este caso.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nSi considerás que hay un error, por favor contactanos por WhatsApp principal y traenos el usuario correcto para que lo revisemos.`;
        console.log('Respuesta enviada (no aplica reembolso) ->', msg);
        await sendReplyToCallbell(conversationId, msg);
        return;
      } else {
        const bonus = (net * 0.08);
        const bonusStr = bonus.toFixed(2);
        const msg = `Estimado/a, confirmamos que corresponde un reembolso del 8% sobre tu neto. El monto de reembolso es: $${bonusStr}.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nEl reembolso se depositará automáticamente en tu cuenta y podrás verificarlo en la plataforma usando tu usuario. Procedo a marcar este reembolso como reclamado en nuestros registros.`;
        console.log('Respuesta enviada (aplica reembolso) ->', msg);
        await sendReplyToCallbell(conversationId, msg);

        // marcar en Sheets: rowNumber = 2 + foundRowIndex (porque rows comienza en A2)
        const rowNumber = 2 + foundRowIndex;
        const marked = await markUserAsClaimed(spreadsheetId, rowNumber, 'E');
        if (marked) {
          console.log(`Usuario ${username} marcado como RECLAMADO en la fila ${rowNumber}.`);
        } else {
          console.warn(`No se pudo marcar como RECLAMADO al usuario ${username} en la fila ${rowNumber}.`);
        }
        return;
      }
    } catch (err) {
      console.error('❌ Error procesando webhook (background):', err?.message || err);
    }
  })();
});

// Inicia el servidor de Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
