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

// Logging middleware
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);
  console.log('Headers:', req.headers);
  if (req.rawBody) {
    console.log('Raw body:', req.rawBody);
  } else {
    console.log('Parsed body:', req.body);
  }
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
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;

if (!OPENAI_API_KEY) {
  console.error('❌ OPENAI_API_KEY no está definido en las variables de entorno.');
  // no exit: permitimos arrancar para debug si solo falta esto
}
if (!KOMMO_ACCESS_TOKEN) {
  console.error('❌ KOMMO_ACCESS_TOKEN no está definido en las variables de entorno.');
}

let GOOGLE_CREDENTIALS = null;
if (process.env.GOOGLE_CREDENTIALS_JSON) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
  } catch (err) {
    console.error('❌ No se pudo parsear GOOGLE_CREDENTIALS_JSON:', err.message);
  }
}

// ================== Inicialización de OpenAI ==================
const openai = new OpenAIApi(new Configuration({
  apiKey: OPENAI_API_KEY,
}));

// ================== GOOGLE AUTH ==================
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
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
    if (type.includes('deposit')) totals[user].deposits += amount;
    if (type.includes('withdraw') || type.includes('witdraw') || type.includes('retir')) totals[user].withdrawals += amount;
  });
  return totals;
}

// ================== SEND MESSAGE TO KOMMO ==================
async function sendReply(chatId, message) {
  if (!KOMMO_ACCESS_TOKEN) {
    console.warn('⚠️ No hay KOMMO_ACCESS_TOKEN; no se enviará el mensaje.');
    return;
  }
  try {
    await axios.post('https://api.kommo.com/v1/messages', {
      chat_id: chatId,
      message,
    }, {
      headers: {
        Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    console.error('❌ Error enviando mensaje a Kommo:', err?.response?.data || err.message || err);
  }
}

// ================== GPT INTENT DETECTOR ==================
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
        { role: 'system', content: `Sos un agente humano de casino online. Sos amable, claro, natural. Tu objetivo es ayudar y pedir el nombre de usuario sin sonar robot.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('❌ casinoChatResponse error:', err?.message || err);
    return 'Perdón, estoy teniendo un problema ahora mismo. ¿Podés repetir o darme tu nombre de usuario?';
  }
}

// ================== WEBHOOK ==================
app.post('/webhook-kommo', (req, res) => {
  // Responder rápido para que Kommo reciba 200, y procesar en background
  res.sendStatus(200);

  (async () => {
    try {
      const messageData = req.body?.message?.add?.[0] || null;
      if (!messageData) {
        console.log('Webhook recibido pero no contiene message.add[0]. Payload guardado en /debug/last para inspección.');
        return;
      }
      const userMessage = String(messageData.text || '').trim();
      const chatId = messageData.chat_id;

      if (!userMessage) {
        await sendReply(chatId, 'No recibí tu mensaje, ¿podés intentarlo nuevamente?');
        return;
      }

      const intent = await detectIntent(userMessage);
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(userMessage);
        await sendReply(chatId, reply);
        return;
      }

      // Si parece username -> Google Sheets lookup
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:D10000';
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);
      const lookupKey = userMessage.toLowerCase();
      const data = totals[lookupKey];

      if (!data) {
        await sendReply(chatId, 'No logro encontrar ese usuario 🤔 ¿podés revisarlo y enviármelo nuevamente?');
        return;
      }

      const net = data.deposits - data.withdrawals;
      const depositsStr = Number(data.deposits).toFixed(2);
      const withdrawalsStr = Number(data.withdrawals).toFixed(2);
      const netStr = Number(net).toFixed(2);

      if (net <= 1) {
        await sendReply(chatId, `ℹ️ Perfecto, ya te encontré.\n\nDepósitos: ${depositsStr}\nRetiros: ${withdrawalsStr}\n\nPor ahora no aplica el 8% 😉`);
      } else {
        const bonus = (net * 0.08).toFixed(2);
        await sendReply(chatId, `🎉 ¡Listo!\n\n💰 Depósitos: ${depositsStr}\n💸 Retiros: ${withdrawalsStr}\n📊 Neto: ${netStr}\n\n🎁 Tu reembolso es *${bonus}*`);
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
