require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging para depuración
app.use((req, res, next) => {
  const now = new Date().toISOString();
  // Filtramos logs ruidosos para ver solo lo importante
  if (req.method === 'POST' && req.url.includes('webhook')) {
    console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);
  }
  next();
});

app.get('/', (req, res) => res.send('Chatwoot Casino Bot Online 🚀'));

// ================== VARIABLES ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ Faltan credenciales: OPENAI_API_KEY');
if (!CHATWOOT_ACCESS_TOKEN) console.error('❌ Faltan credenciales: CHATWOOT_ACCESS_TOKEN');

// ================== CONFIGURACIONES ==================
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try { GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON); } 
  catch (err) { console.error('❌ Error JSON Credentials:', err.message); }
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
    console.error('❌ Error Sheets:', error?.message);
    return [];
  }
}

async function markUserAsClaimed(spreadsheetId, rowNumber, columnLetter = 'E') {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `Sheet1!${columnLetter}${rowNumber}`,
      valueInputOption: 'RAW',
      resource: { values: [['RECLAMADO']] },
    });
    console.log(`✅ Fila ${rowNumber} marcada como RECLAMADO.`);
    return true;
  } catch (err) {
    console.error('❌ Error marcando reclamado:', err?.message);
    return false;
  }
}

// ================== UTILIDADES ==================
// Nueva función para limpiar el HTML que manda Chatwoot
function cleanHtml(html) {
  if (!html) return "";
  // Reemplaza etiquetas HTML por espacios y limpia espacios dobles
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

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

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ================== CHATWOOT SENDER ==================
async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;
  try {
    console.log(`⏳ Esperando 4s (simulando humano)...`);
    await sleep(4000); 

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(url, {
      content: message,
      message_type: 'outgoing',
      private: false
    }, {
      headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN, 'Content-Type': 'application/json' }
    });
    console.log(`✅ Respuesta enviada a Chatwoot.`);
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err?.response?.data || err.message);
  }
}

// ================== INTELIGENCIA ARTIFICIAL ==================
async function detectIntent(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Sos un clasificador. Decidí si el mensaje es un NOMBRE DE USUARIO o una CHARLA.
          Respondé SOLO JSON: { "type": "username" } o { "type": "chat" }
          Reglas:
          - Si el texto contiene un posible username (3-30 caracteres) o dice "mi usuario es...", responde { "type": "username" }.
          - Si el texto es un saludo o pregunta general, responde { "type": "chat" }.`
        },
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
        { role: 'system', content: `Sos un agente de casino online. Respondés en español rioplatense (Argentina). Profesional, serio y empático. No das consejos financieros.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Tuve un error temporal. ¿Me repetís?'; }
}

function extractUsername(message) {
  if (!message || typeof message !== 'string') return null;
  const m = message.trim();
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','por','favor','quiero','reclamar']);

  // 1. Patrones explícitos (ej: "usuario: pepe")
  const explicitPatterns = [
    /usuario(?:\s+es|\s*:\s*|\s+:+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /username(?:\s*:\s*|\s+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /@([A-Za-z0-9._-]{3,30})/i
  ];
  for (const re of explicitPatterns) {
    const found = m.match(re);
    if (found && found[1]) return found[1].trim();
  }

  // 2. Análisis de tokens (palabras sueltas)
  const tokens = m.split(/[\s,;.:\-()]+/).filter(Boolean);
  
  // Filtramos palabras comunes y basura
  const candidates = tokens.filter(t => 
    t.length >= 3 && 
    !STOPWORDS.has(t.toLowerCase()) &&
    /^[A-Za-z0-9._-]+$/.test(t) // Solo caracteres de usuario válidos
  );

  // Si queda solo 1 candidato válido, asumimos que es el usuario
  if (candidates.length === 1) return candidates[0];

  // Si hay varios, priorizamos los que tienen números (ej: marale707)
  for (const t of candidates) {
    if (/\d/.test(t)) return t;
  }

  return null;
}

// ================== WEBHOOK HANDLER ==================
app.post('/webhook-chatwoot', (req, res) => {
  res.status(200).send('OK');

  (async () => {
    try {
      const event = req.body.event;
      const messageType = req.body.message_type;
      
      // Filtrar eventos que no nos interesan
      if (event !== 'message_created' || messageType !== 'incoming') return;

      const accountId = req.body.account?.id;
      const conversationId = req.body.conversation?.id;
      
      // AQUÍ ESTÁ LA SOLUCIÓN: Limpiamos el HTML antes de procesar
      const rawContent = req.body.content; 
      const content = cleanHtml(rawContent); // <p>user</p> -> user

      if (!content || !conversationId) return;

      console.log(`📩 Mensaje Limpio: "${content}"`);

      // 1. Detectar intención
      const intent = await detectIntent(content);
      console.log('Intent ->', intent.type);

      // 2. Chat casual
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(content);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
      }

      // 3. Username / Reclamo
      const username = extractUsername(content);
      console.log('Username extraído ->', username);

      if (!username) {
        await sendReplyToChatwoot(accountId, conversationId, 'Por favor, escribí solamente tu nombre de usuario para verificar.');
        return;
      }

      const lookupKey = username.toLowerCase().trim();
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:E10000';
      
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      // Buscar usuario en filas
      let foundRowIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const rowUser = String(rows[i][1] || '').toLowerCase().trim();
        if (rowUser === lookupKey) { foundRowIndex = i; break; }
      }

      if (foundRowIndex === -1) {
        await sendReplyToChatwoot(accountId, conversationId, `No encontré el usuario "${username}" en la base de datos. Verificá que esté bien escrito.`);
        return;
      }

      // Verificar si ya reclamó
      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        await sendReplyToChatwoot(accountId, conversationId, `El beneficio para el usuario ${username} ya fue reclamado anteriormente.`);
        return;
      }

      // Calcular montos
      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      
      if (net <= 1) {
        await sendReplyToChatwoot(accountId, conversationId, `No tenés saldo negativo suficiente para reintegro.\nDepósitos: $${userTotals.deposits.toFixed(2)}\nRetiros: $${userTotals.withdrawals.toFixed(2)}`);
      } else {
        const bonus = (net * 0.08).toFixed(2);
        await sendReplyToChatwoot(accountId, conversationId, `¡Corresponde reintegro! Monto: $${bonus}\n(Depósitos: $${userTotals.deposits.toFixed(2)} - Retiros: $${userTotals.withdrawals.toFixed(2)}).`);
        
        // Marcar reclamado
        await markUserAsClaimed(spreadsheetId, 2 + foundRowIndex);
      }

    } catch (e) {
      console.error('❌ Error Webhook:', e);
    }
  })();
});

app.listen(PORT, () => console.log(`🚀 Bot escuchando puerto ${PORT}`));
