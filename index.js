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

// ================== MEMORIA TEMPORAL ==================
const messageBuffer = new Map(); 
const userStates = new Map();

// Limpieza de estados antiguos
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of userStates.entries()) {
    if (now - state.lastActivity > 24 * 60 * 60 * 1000) userStates.delete(id);
  }
}, 60 * 60 * 1000);

// ================== CONFIGURACIÓN ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try { GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON); } 
  catch (err) { console.error('❌ Error Credentials JSON:', err.message); }
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

async function markAllUserRowsAsClaimed(spreadsheetId, indices, columnLetter = 'E') {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const promises = indices.map(rowIndex => {
      const sheetRow = rowIndex + 2; 
      return sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!${columnLetter}${sheetRow}`,
        valueInputOption: 'RAW',
        resource: { values: [['RECLAMADO']] },
      });
    });
    await Promise.all(promises);
    return true;
  } catch (err) {
    console.error('❌ Error marcando reclamado:', err?.message);
    return false;
  }
}

// ================== CHATWOOT ==================
async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;
  try {
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(url, {
      content: message,
      message_type: 'outgoing',
      private: false
    }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
    console.log(`✅ Respuesta enviada [Conv: ${conversationId}]`);
  } catch (err) {
    console.error('❌ Error enviando:', err.message);
  }
}

async function updateChatwootContact(accountId, contactId, username) {
  if (!CHATWOOT_ACCESS_TOKEN || !contactId) return;
  try {
    console.log(`📝 Agendando contacto ${contactId} como "${username}"...`);
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    await axios.put(url, { name: username }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
    console.log(`✅ Contacto agendado.`);
  } catch (err) {
    console.error('❌ Error agendando contacto:', err?.message);
  }
}

// ================== LOGICA DE USUARIOS ==================
const TEAM_USER_PATTERN = /\b(big|arg|cir|mar|lux|zyr|met|tri|ign|roy|tig)[a-z._-]*\d{3,}\b/i;

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  
  const teamMatch = m.match(TEAM_USER_PATTERN);
  if (teamMatch) return teamMatch[0].toLowerCase();

  const explicit = /usuario\s*:?\s*@?([a-zA-Z0-9._-]+)/i.exec(m);
  if (explicit) return explicit[1].toLowerCase();

  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','quiero','reclamar','reembolso','bono','buenas','tardes','noches']);
  const tokens = m.split(/[\s,;:]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  
  const withNumbers = tokens.find(t => /\d/.test(t));
  if (withNumbers) return withNumbers.toLowerCase();

  return null;
}

// ================== UTILIDADES ==================
function cleanHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ================== IA (PERSONALIDAD ACTUALIZADA) ==================
async function detectIntent(message) {
  const msgLower = message.toLowerCase();
  if (msgLower.includes('no') && (msgLower.includes('se') || msgLower.includes('acuerdo') || msgLower.includes('recuerdo')) && (msgLower.includes('usuario') || msgLower.includes('user'))) {
    return { type: 'forgot_username' };
  }
  if (TEAM_USER_PATTERN.test(message)) return { type: 'username' };

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Clasificador JSON. Tipos: "username", "chat".
          - Si ves un usuario (formato equipo ej bigjose10, o con numeros) -> "username".
          - Si es saludo, pregunta o charla -> "chat".`
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
      temperature: 0.7, // Un poco más creativo para parecer humano
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de soporte real de un casino en Argentina. 
          Tu tono es: Profesional, respetuoso, humano y cálido (Rioplatense, usá "vos").
          
          REGLAS CRÍTICAS:
          1. Tu objetivo es pedir el usuario para verificar el reintegro.
          2. NUNCA des ejemplos de usuarios inventados (tipo "ejemplo: pepe123"). JAMÁS.
          3. No seas robótico ni excesivamente cortante. Respondé como una persona que trabaja en atención al cliente.
          
          Si el cliente saluda ("Hola"), devolvé el saludo con amabilidad y preguntá por su usuario.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return '¡Hola! ¿Cómo estás? Por favor, pasame tu usuario así revisamos tu reintegro.'; }
}

async function chatAfterClaim(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de soporte de casino (Argentina).
          Estás hablando con "${username}".
          
          SITUACIÓN: Este cliente YA COBRÓ su reintegro de hoy.
          - Mantené la charla con naturalidad y respeto.
          - Si vuelve a pedir plata, explicá amablemente que el beneficio es una vez por día.
          - Mostrate siempre dispuesto a ayudar en otras consultas.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Cualquier otra duda que tengas, avisame. Recordá que el reintegro es diario.'; }
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, contactId, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}"`);

  let state = userStates.get(conversationId) || { claimed: false, username: null, lastActivity: Date.now() };
  state.lastActivity = Date.now();
  userStates.set(conversationId, state);

  // 1. Cliente que ya cobró (Charla continua)
  if (state.claimed && state.username) {
    const reply = await chatAfterClaim(fullMessage, state.username);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  // 2. Análisis
  const intent = await detectIntent(fullMessage);

  if (intent.type === 'forgot_username') {
    await sendReplyToChatwoot(accountId, conversationId, "Uh, no hay problema. Por favor escribile a nuestro WhatsApp principal (donde hacés las cargas) y pediles tu usuario correcto, así te lo verificamos acá.");
    return;
  }

  const extractedUser = extractUsername(fullMessage);

  // Si es charla sin usuario
  if (intent.type === 'chat' && !extractedUser) {
    const reply = await casinoChatResponse(fullMessage);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  const username = extractedUser;
  
  if (!username) {
    // Respuesta manual humana para casos donde no se entiende el usuario
    await sendReplyToChatwoot(accountId, conversationId, "Disculpame, necesito que me escribas tu usuario tal cual es para poder buscarlo en el sistema.");
    return;
  }

  console.log(`🔎 Buscando en Sheets: ${username}`);
  const lookupKey = username.toLowerCase().trim();
  
  const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
  const rows = await getSheetData(spreadsheetId, 'Sheet1!A2:E10000');
  
  const foundIndices = [];
  let userTotals = { deposits: 0, withdrawals: 0 };

  for (let i = 0; i < rows.length; i++) {
    const rowUser = String(rows[i][1] || '').toLowerCase().trim();
    if (rowUser === lookupKey) {
      foundIndices.push(i);
      const type = String(rows[i][0] || '').toLowerCase();
      const amount = parseFloat(String(rows[i][2] || '0').replace(/[^0-9.-]/g, '')) || 0;

      if (type.includes('deposit') || type.includes('depósito') || type.includes('carga')) {
        userTotals.deposits += amount;
      } else if (type.includes('withdraw') || type.includes('retiro') || type.includes('retir')) {
        userTotals.withdrawals += amount;
      }
    }
  }

  if (foundIndices.length === 0) {
    await sendReplyToChatwoot(accountId, conversationId, `Te pido mil disculpas, pero no encuentro el usuario "${username}" en nuestra base de datos. ¿Podrás verificar si está bien escrito?`);
    return;
  }

  // Verificar si ya reclamó
  let yaReclamo = false;
  for (const idx of foundIndices) {
    if (String(rows[idx][4] || '').toLowerCase().includes('reclam')) {
      yaReclamo = true;
      break;
    }
  }

  if (yaReclamo) {
    state.claimed = true;
    state.username = username;
    userStates.set(conversationId, state);
    await sendReplyToChatwoot(accountId, conversationId, `Hola ${username}, estuve revisando y me figura que tu reintegro de hoy ya fue reclamado.`);
    return;
  }

  // Calcular
  const net = userTotals.deposits - userTotals.withdrawals;
  
  if (net <= 1) {
    state.claimed = true; 
    state.username = username;
    userStates.set(conversationId, state);
    
    // Respuesta humana de rechazo
    await sendReplyToChatwoot(accountId, conversationId, `Estuve verificando tu cuenta. Por el momento no tenés saldo negativo suficiente para generar el reintegro (Neto: $${net.toFixed(2)}). ¡Cualquier otra consulta estoy a disposición!`);
  
  } else {
    // === ÉXITO: ACREDITACIÓN ===
    const bonus = (net * 0.08).toFixed(2);
    
    // 1. Agendamos el contacto (SOLO AQUÍ)
    await updateChatwootContact(accountId, contactId, username);
    
    // 2. Enviamos mensaje
    const msg = `¡Listo! Ya verifiqué tu cuenta.\n\nTenés un reintegro aprobado de $${bonus} (sobre un neto de $${net.toFixed(2)}). Ya te lo estoy acreditando automáticamente en tu usuario. ¡Mucha suerte!`;
    await sendReplyToChatwoot(accountId, conversationId, msg);
    
    // 3. Marcamos Sheets
    await markAllUserRowsAsClaimed(spreadsheetId, foundIndices);
    
    // 4. Guardamos estado
    state.claimed = true;
    state.username = username;
    userStates.set(conversationId, state);
  }
}

// ================== WEBHOOK ==================
app.post('/webhook-chatwoot', (req, res) => {
  res.status(200).send('OK');

  const body = req.body;
  if (body.event !== 'message_created' || body.message_type !== 'incoming') return;

  const conversationId = body.conversation?.id;
  const accountId = body.account?.id;
  const contactId = body.sender?.id;
  const content = cleanHtml(body.content);

  if (!conversationId || !content) return;

  if (!messageBuffer.has(conversationId)) {
    messageBuffer.set(conversationId, { messages: [], timer: null });
  }

  const buffer = messageBuffer.get(conversationId);
  buffer.messages.push(content);

  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(() => {
    const fullText = buffer.messages.join(" . ");
    messageBuffer.delete(conversationId);
    
    (async () => {
      console.log(`⏳ Procesando conv ${conversationId}...`);
      await sleep(3500); // 3.5s para simular lectura y escritura humana
      await processConversation(accountId, conversationId, contactId, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot Humano Activo en puerto ${PORT}`));
