require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración básica de Express para recibir JSON y URL-Encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Logging de tráfico
app.use((req, res, next) => {
  const now = new Date().toISOString();
  console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);
  next();
});

app.get('/', (req, res) => res.send('Chatwoot Casino Bot Online 🚀'));

// ================== VARIABLES DE ENTORNO ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Usamos CHATWOOT en lugar de KOMMO
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

if (!OPENAI_API_KEY) console.error('❌ Faltan credenciales: OPENAI_API_KEY');
if (!CHATWOOT_ACCESS_TOKEN) console.error('❌ Faltan credenciales: CHATWOOT_ACCESS_TOKEN');

// ================== OPENAI INIT ==================
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

// ================== GOOGLE AUTH (CON PERMISO DE ESCRITURA) ==================
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
  scopes: ['https://www.googleapis.com/auth/spreadsheets'], // escritura incluida
});

// ================== GOOGLE SHEETS FUNCTIONS ==================
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

// ================== LÓGICA FINANCIERA ==================
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

// ================== UTIL: SLEEP ==================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ================== CHATWOOT SENDER (REEMPLAZA A KOMMO) ==================
// Adaptado para funcionar con la plataforma Chatwoot
async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;

  try {
    console.log(`⏳ Esperando 4s antes de enviar a Chatwoot (Simulación humana)...`);
    await sleep(4000); 

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    
    // Payload específico de Chatwoot
    const payload = {
      content: message,
      message_type: 'outgoing', // Indica que es respuesta del agente
      private: false
    };

    const resp = await axios.post(url, payload, {
      headers: {
        'api_access_token': CHATWOOT_ACCESS_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    console.log(`✅ Enviado a Chatwoot [Conv: ${conversationId}] Status: ${resp.status}`);
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err?.response?.data || err.message);
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
- Ejemplos implícitos: "usuarioX" -> username; "Hola necesito ayuda" -> chat.

Respondé EXACTAMENTE con el JSON, sin texto adicional.
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

// ================== GPT CHAT RESPONSE (CASINO RIOPLATENSE) ==================
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
- Si luego no se encuentra el usuario en nuestros registros, indicá profesionalmente: que debe dirigirse al WhatsApp principal donde realiza sus cargas para solicitar su nombre de usuario correcto y luego volver a este chat con el usuario exacto para que verifiquemos el reembolso.
- Si corresponde reembolso, ofrecé asistencia adicional ("¿Querés que gestione la solicitud de reembolso ahora?") y mantente empático.
- No des consejos financieros; enfocáte en procesos operativos y atención al cliente.
- Siempre mantén el texto claro, cortés y profesional; evita jerga excesiva.
          `,
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) {
    console.error('❌ casinoChatResponse error:', err?.message || err);
    return 'Perdón, estoy teniendo un problema ahora mismo. ¿Podés repetir o darme tu nombre de usuario?';
  }
}

// ================== EXTRAER USERNAME ==================
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

// ================== WEBHOOK CHATWOOT ==================
app.post('/webhook-chatwoot', (req, res) => {
  // 1. Responder OK rápido para que Chatwoot no reintente
  res.status(200).send('OK');

  (async () => {
    try {
      const event = req.body.event;
      const messageType = req.body.message_type;
      
      // FILTRO: Solo procesamos mensajes NUEVOS creados por el USUARIO (incoming)
      if (event !== 'message_created' || messageType !== 'incoming') {
        return; 
      }

      // Datos específicos de Chatwoot
      const accountId = req.body.account?.id;
      const conversationId = req.body.conversation?.id;
      const content = req.body.content; // El texto del mensaje

      if (!content || !conversationId || !accountId) return;

      console.log(`📩 Mensaje recibido (Chatwoot): "${content}"`);

      // 1. Detectar intención usando tu función avanzada
      const intent = await detectIntent(content);
      console.log('Intent detectado ->', intent);

      // 2. Si es charla casual
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(content);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
      }

      // 3. Si parece un username (intento de reclamo)
      const username = extractUsername(content);
      console.log('Username extraído ->', username);

      if (!username) {
        const ask = 'Estimado/a, entiendo que querés verificar tu usuario. Por favor enviá exactamente tu nombre de usuario tal como figura en la plataforma.';
        await sendReplyToChatwoot(accountId, conversationId, ask);
        return;
      }

      const lookupKey = String(username).toLowerCase().trim();
      
      // Conexión a Google Sheets
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
        const msg = `Estimado/a, no encontramos el usuario ${username} en nuestros registros. Por favor dirigite al WhatsApp principal para verificar tu usuario correcto.`;
        await sendReplyToChatwoot(accountId, conversationId, msg);
        return;
      }

      // Verificar si ya reclamó (Columna E)
      const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();
      if (claimedCell.includes('reclam')) {
        const msg = `Estimado/a, el reembolso para ${username} ya fue marcado como reclamado anteriormente.`;
        await sendReplyToChatwoot(accountId, conversationId, msg);
        return;
      }

      // Cálculos Financieros
      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      const depositsStr = Number(userTotals.deposits).toFixed(2);
      const withdrawalsStr = Number(userTotals.withdrawals).toFixed(2);
      
      if (net <= 1) {
        const msg = `Estimado/a, verificamos tus movimientos y no corresponde reembolso.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}`;
        await sendReplyToChatwoot(accountId, conversationId, msg);
      } else {
        const bonus = (net * 0.08);
        const bonusStr = bonus.toFixed(2);
        const msg = `Estimado/a, confirmamos reembolso del 8%. Monto: $${bonusStr}.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n\nEl monto se acreditará automáticamente.`;
        
        await sendReplyToChatwoot(accountId, conversationId, msg);
        
        // Marcar en Sheets
        const rowNumber = 2 + foundRowIndex;
        await markUserAsClaimed(spreadsheetId, rowNumber, 'E');
      }

    } catch (e) {
      console.error('❌ Error procesando webhook Chatwoot:', e?.message || e);
    }
  })();
});

// Arrancar servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor listo en puerto ${PORT}`);
});
