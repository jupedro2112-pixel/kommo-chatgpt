require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware para procesar JSON
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging básico
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (req, res) => res.send('Chatwoot Bot is running!'));

// ================== VARIABLES DE ENTORNO ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN; // Tu Token de Agente o Admin
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com'; // O tu URL self-hosted
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ Faltan credenciales: OPENAI_API_KEY');
if (!CHATWOOT_ACCESS_TOKEN) console.error('❌ Faltan credenciales: CHATWOOT_ACCESS_TOKEN');

// ================== OPENAI CONFIG ==================
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// ================== GOOGLE SHEETS CONFIG ==================
let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try { GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON); } 
  catch (e) { console.error('❌ Error parseando GOOGLE_CREDENTIALS_JSON', e.message); }
}
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

async function getSheetData(spreadsheetId, range) {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (error) {
    console.error('❌ Error leyendo Sheets:', error?.message || error);
    return [];
  }
}

async function markUserAsClaimed(spreadsheetId, rowNumber, columnLetter = 'E') {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const range = `Sheet1!${columnLetter}${rowNumber}`;
    const resource = { values: [['RECLAMADO']] };
    await sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'RAW', resource });
    console.log(`✅ Marcado RECLAMADO en fila ${rowNumber}`);
    return true;
  } catch (err) {
    console.error('❌ Error marcando reclamado:', err?.message);
    return false;
  }
}

// ================== LÓGICA FINANCIERA ==================
function parseAmount(value) {
  if (value == null) return 0;
  const s = String(value).replace(/\s/g, '').replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function calculateTotalsByUser(rows) {
  const totals = {};
  rows.forEach(row => {
    const type = String(row[0] || '').toLowerCase().trim();
    const user = String(row[1] || '').trim().toLowerCase();
    const amount = parseAmount(row[2]);
    if (!user) return;
    if (!totals[user]) totals[user] = { deposits: 0, withdrawals: 0 };
    
    if (type.includes('deposit') || type.includes('depósito') || type.includes('deposito')) {
      totals[user].deposits += amount;
    } else if (type.includes('withdraw') || type.includes('retiro') || type.includes('retir')) {
      totals[user].withdrawals += amount;
    }
  });
  return totals;
}

// ================== CHATWOOT SEND LOGIC ==================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;

  try {
    console.log('⏳ Escribiendo... (esperando 4s)');
    // Opcional: Podrías enviar un evento "toggle_typing" a Chatwoot aquí si quisieras
    await sleep(4000); 

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    
    const payload = {
      content: message,
      message_type: 'outgoing', // Importante para que se vea como respuesta del agente
      private: false
    };

    await axios.post(url, payload, {
      headers: {
        'api_access_token': CHATWOOT_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Enviado a Chatwoot [Conv: ${conversationId}]: "${message.substring(0, 20)}..."`);
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err?.response?.data || err.message);
  }
}

// ================== AI LOGIC ==================
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
    try { return JSON.parse(content); } catch (e) { return { type: 'chat' }; }
  } catch (err) { return { type: 'chat' }; }
}

async function casinoChatResponse(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: `Sos un agente de casino online. Respondés en español rioplatense (Argentina). Profesional pero cercano.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Tuve un pequeño error, ¿me repetís?'; }
}

function extractUsername(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias']);
  // Patrones simples
  const explicit = /@?([A-Za-z0-9._-]{3,30})/;
  const found = m.match(explicit);
  
  // Si parece una frase larga, usar lógica de tokens, si es corto, asumir username
  if (m.split(' ').length < 2) return m.replace('@','');
  if (found && found[1] && !STOPWORDS.has(found[1].toLowerCase())) return found[1];
  
  return null; // Dejar que GPT ayude si falla el regex básico en el futuro
}

// ================== WEBHOOK HANDLER ==================
app.post('/webhook-chatwoot', (req, res) => {
  res.status(200).send('OK'); // Responder rápido a Chatwoot

  (async () => {
    try {
      const event = req.body.event;
      const messageType = req.body.message_type;
      
      // SOLO procesar mensajes NUEVOS creados por el USUARIO (incoming)
      // Ignorar mensajes enviados por el bot (outgoing) o actualizaciones de sistema
      if (event !== 'message_created' || messageType !== 'incoming') {
        return;
      }

      const accountId = req.body.account?.id;
      const conversationId = req.body.conversation?.id;
      const content = req.body.content; // El texto del mensaje

      if (!content || !conversationId || !accountId) return;

      console.log(`📩 Mensaje recibido de Chatwoot: "${content}"`);

      // 1. Detectar intención
      const intent = await detectIntent(content);

      // 2. Si es charla casual
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(content);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
      }

      // 3. Si parece un username (intento de reclamo)
      let username = extractUsername(content);
      if (!username) {
        // Si el detector de intents dijo username pero el regex falló, preguntamos
        await sendReplyToChatwoot(accountId, conversationId, "Por favor, escribí solamente tu nombre de usuario para verificar.");
        return;
      }

      console.log(`🔎 Buscando usuario: ${username}`);
      const lookupKey = username.toLowerCase().trim();
      
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:E10000';
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      // Buscar fila del usuario
      let foundRowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowUser = String(rows[i][1] || '').toLowerCase().trim();
        if (rowUser === lookupKey) { foundRowIndex = i; break; }
      }

      if (foundRowIndex === -1) {
        await sendReplyToChatwoot(accountId, conversationId, `No encontré el usuario ${username}. Por favor verificá que esté bien escrito.`);
        return;
      }

      // Verificar si ya reclamó
      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        await sendReplyToChatwoot(accountId, conversationId, `El usuario ${username} ya reclamó su beneficio anteriormente.`);
        return;
      }

      // Cálculos
      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      
      if (net <= 1) {
        await sendReplyToChatwoot(accountId, conversationId, `Tus movimientos:\nDepósitos: $${userTotals.deposits}\nRetiros: $${userTotals.withdrawals}\n\nNo tenés saldo negativo suficiente para reintegro.`);
      } else {
        const bonus = (net * 0.08).toFixed(2);
        await sendReplyToChatwoot(accountId, conversationId, `¡Felicidades! Tenés un reintegro disponible de $${bonus}.\n(Depósitos: ${userTotals.deposits} - Retiros: ${userTotals.withdrawals}).\n\nYa lo estoy procesando.`);
        
        // Marcar en Sheets
        await markUserAsClaimed(spreadsheetId, 2 + foundRowIndex);
      }

    } catch (e) {
      console.error('❌ Error en webhook:', e);
    }
  })();
});

app.listen(PORT, () => console.log(`🚀 Chatwoot Bot escuchando en puerto ${PORT}`));
