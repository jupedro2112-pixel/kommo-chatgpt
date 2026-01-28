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

// ================== MEMORIA ==================
const messageBuffer = new Map(); 

// Mapa de Estado del Usuario
// Clave: conversationId
// Valor: { username: "bigjose1010", claimed: boolean, lastActivity: number }
const userStates = new Map();

// Limpieza de memoria (borra estados de hace más de 24hs)
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

// ================== LÓGICA DE USUARIOS (PREFIJOS) ==================
// Regex poderosa para detectar equipos específicos
// Busca: Inicio de palabra + (big|arg|cir...) + letras + numeros al final
const TEAM_USER_PATTERN = /\b(big|arg|cir|mar|lux|zyr|met|tri|ign|roy|tig)[a-z._-]*\d{3,}\b/i;

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  
  // 1. Prioridad TOTAL: Buscar patrón de equipo (ej: bigjose1010, marale707)
  const teamMatch = m.match(TEAM_USER_PATTERN);
  if (teamMatch) return teamMatch[0].toLowerCase();

  // 2. Si no hay patrón de equipo, buscar explícitos "usuario: pepe"
  const explicit = /usuario\s*:?\s*@?([a-zA-Z0-9._-]+)/i.exec(m);
  if (explicit) return explicit[1].toLowerCase();

  // 3. Último recurso: Tokenización (solo si tiene números y longitud decente)
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','quiero','reclamar','reembolso','bono']);
  const tokens = m.split(/[\s,;:]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  
  // Debe tener números para ser considerado user si no tiene prefijo conocido
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

// ================== INTELIGENCIA ARTIFICIAL ==================
async function detectIntent(message) {
  const msgLower = message.toLowerCase();
  if (msgLower.includes('no') && (msgLower.includes('se') || msgLower.includes('acuerdo') || msgLower.includes('recuerdo')) && (msgLower.includes('usuario') || msgLower.includes('user'))) {
    return { type: 'forgot_username' };
  }

  // Si detectamos el patrón de equipo por Regex, es username seguro
  if (TEAM_USER_PATTERN.test(message)) {
    return { type: 'username' };
  }

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Clasificador JSON. Tipos: "username", "chat".
          - Si contiene un usuario con formato de equipo (ej: bigjose1010, argpepe20, cirjuan99) -> "username".
          - Si es saludo o pregunta -> "chat".`
        },
        { role: 'user', content: message },
      ],
    });
    const content = resp.data?.choices?.[0]?.message?.content;
    try { return JSON.parse(content); } catch (e) { return { type: 'chat' }; }
  } catch (err) { return { type: 'chat' }; }
}

// CHAT 1: Cuando aún no sabemos el usuario
async function casinoChatResponse(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino. Respuesta CORTA (max 15 palabras).
          Tu OBJETIVO es pedir el usuario para ver el reembolso.
          Si el usuario saluda, pedíle el usuario amablemente.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Hola, por favor decime tu usuario para revisar tu reembolso.'; }
}

// CHAT 2: Cuando YA COBRÓ (Context aware)
async function chatAfterClaim(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino. Estás hablando con el usuario "${username}".
          IMPORTANTE: Este usuario YA COBRÓ su reembolso de hoy.
          - Si te saluda o charla, respondé amablemente y corto.
          - Si vuelve a pedir plata o reembolso, decíle que ya se le acreditó hoy y que vuelva mañana.
          - NO le pidas el usuario de nuevo (ya sabés quién es).` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Tu reembolso ya fue procesado hoy. ¡Cualquier otra duda estoy acá!'; }
}

// ================== PROCESAMIENTO CENTRAL ==================
async function processConversation(accountId, conversationId, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}"`);

  // 1. Recuperar estado (¿Ya lo conocemos?)
  let state = userStates.get(conversationId) || { claimed: false, username: null, lastActivity: Date.now() };
  state.lastActivity = Date.now(); // Actualizar timestamp
  userStates.set(conversationId, state);

  // 2. CAMINO A: El usuario ya cobró hoy (Charla Post-Reembolso)
  if (state.claimed && state.username) {
    console.log(`🗣️ Usuario ${state.username} sigue charlando después de cobrar.`);
    const reply = await chatAfterClaim(fullMessage, state.username);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  // 3. CAMINO B: Procesamiento Normal
  const intent = await detectIntent(fullMessage);

  if (intent.type === 'forgot_username') {
    await sendReplyToChatwoot(accountId, conversationId, "Si no recordás tu usuario, pedílo en nuestro WhatsApp de cargas principal.");
    return;
  }

  // Intentamos extraer usuario
  const extractedUser = extractUsername(fullMessage);

  // Si NO hay usuario y es chat casual
  if (intent.type === 'chat' && !extractedUser) {
    const reply = await casinoChatResponse(fullMessage);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  // Si detectamos usuario (o GPT dijo username)
  const username = extractedUser;
  
  if (!username) {
    await sendReplyToChatwoot(accountId, conversationId, "Necesito tu usuario exacto (ej: bigjuan10, argpepe20) para verificar.");
    return;
  }

  console.log(`🔎 Verificando usuario: ${username}`);
  const lookupKey = username.toLowerCase().trim();
  
  // Buscar en Sheets
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
      } else if (
        type.includes('withdraw') || type.includes('whitdraw') || 
        type.includes('witdraw') || type.includes('retiro')
      ) {
        userTotals.withdrawals += amount;
      }
    }
  }

  if (foundIndices.length === 0) {
    await sendReplyToChatwoot(accountId, conversationId, `No encontré el usuario "${username}". Revisá que empiece con el prefijo de tu equipo (big, arg, mar, etc) y termine con números.`);
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
    // Actualizamos estado local
    state.claimed = true;
    state.username = username;
    userStates.set(conversationId, state);

    await sendReplyToChatwoot(accountId, conversationId, `El reembolso para ${username} ya fue reclamado hoy.`);
    return;
  }

  // Resultado Financiero
  const net = userTotals.deposits - userTotals.withdrawals;
  
  if (net <= 1) {
    // No aplica, pero guardamos que ya lo revisamos para no buscar de nuevo en 5 mins
    state.claimed = true; // Tratamos como "claimed" para no volver a calcular, o podrías manejar un estado "checked"
    state.username = username;
    userStates.set(conversationId, state);

    await sendReplyToChatwoot(accountId, conversationId, `No tenés saldo negativo para reintegro.\nNeto: $${net.toFixed(2)}`);
  } else {
    const bonus = (net * 0.08).toFixed(2);
    const msg = `¡Reintegro aprobado!\nNeto: $${net.toFixed(2)}\nReembolso (8%): $${bonus}\n\nSe acredita automáticamente.`;
    
    await sendReplyToChatwoot(accountId, conversationId, msg);
    await markAllUserRowsAsClaimed(spreadsheetId, foundIndices);
    
    // Guardar estado exitoso
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
  const content = cleanHtml(body.content);

  if (!conversationId || !content) return;

  // Lógica BUFFER (3 segundos)
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
      await sleep(3000); // Pequeña espera humana
      await processConversation(accountId, conversationId, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot listo en puerto ${PORT}`));
