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

// ================== UTILIDAD DE TIEMPO (ARGENTINA) ==================
function isClaimWindowOpen() {
  // Calculamos la hora en Argentina (UTC -3)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const argentinaTime = new Date(utc + (3600000 * -3));
  const hour = argentinaTime.getHours();

  // Abierto de 18:00 a 23:59
  return hour >= 18 && hour <= 23;
}

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

// ================== CHATWOOT API ==================
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
  } catch (err) {
    console.error('❌ Error agendando:', err?.message);
  }
}

// ================== UTILIDADES Y REGEX ==================
function cleanHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const TEAM_USER_PATTERN = /\b(big|arg|cir|mar|lux|zyr|met|tri|ign|roy|tig)[a-z._-]*\d{3,}\b/i;

function isValidUsername(text) {
  if (!text) return false;
  if (TEAM_USER_PATTERN.test(text)) return true;
  if (/[a-z]+\d{3,}$/i.test(text)) return true; 
  return false;
}

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  
  const teamMatch = m.match(TEAM_USER_PATTERN);
  if (teamMatch) return teamMatch[0].toLowerCase();

  const explicit = /usuario\s*:?\s*@?([a-zA-Z0-9._-]+)/i.exec(m);
  if (explicit) return explicit[1].toLowerCase();

  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','quiero','reclamar','reembolso','bono','buenas','tardes','noches','tengo','plata','carga']);
  const tokens = m.split(/[\s,;:]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  
  const withNumbers = tokens.find(t => /\d/.test(t));
  if (withNumbers) return withNumbers.toLowerCase();

  return null;
}

// ================== GENERADORES IA ==================

// 1. CHAT GENERAL (Sin usuario identificado)
async function generateCasualChat(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4, // Más serio
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino virtual. Tu tono es SERIO, BREVE y PROFESIONAL.
          
          INFORMACIÓN CLAVE:
          - El reembolso es sobre el NETO DEL DÍA ANTERIOR (no digas "pérdidas").
          - El horario de reclamo es estricto: 13:00 a 23:59hs. (argentina)
          
          OBJETIVO:
          - Si el cliente saluda, devolvé el saludo brevemente y pedí el usuario.
          - Si pregunta cómo funciona, explicá brevemente lo del neto y el horario.
          - NUNCA des ejemplos de usuarios.
          - Si no recuerda el usuario, decile que escriba al WhatsApp principal.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || 'Hola. Para verificar tu reembolso sobre el neto de ayer, necesito tu usuario.';
  } catch (err) { return 'Hola, por favor indicame tu usuario.'; }
}

// 2. RESULTADO VERIFICACIÓN
async function generateCheckResult(username, status, data = {}) {
  let systemPrompt = `Sos un agente de casino profesional. Hablas con "${username}". Sé breve y directo.`;

  if (status === 'closed_window') {
     systemPrompt += ` El cliente quiere reclamar pero el horario de atención es de 18:00 a 23:59hs.
     Informale amablemente que el sistema está cerrado y que debe volver a las 18hs para reclamar el neto de ayer.`;
  }
  else if (status === 'not_found') {
    systemPrompt += ` El usuario NO figura en la base de datos del día anterior.
    Pedile que verifique si está bien escrito.`;
  } 
  else if (status === 'claimed') {
    systemPrompt += ` El sistema indica que ya reclamó su reembolso hoy.
    Decile que ya fue procesado.`;
  } 
  else if (status === 'no_balance') {
    systemPrompt += ` Verificaste su cuenta. Su NETO del día anterior es ${data.net}.
    Informale que no tiene saldo negativo suficiente para aplicar al reintegro.`;
  } 
  else if (status === 'success') {
    systemPrompt += ` ÉXITO. Corresponde reintegro.
    Neto del día anterior: ${data.net}.
    Monto a acreditar (8%): ${data.bonus}.
    Confirmale que se acredita ahora mismo.`;
  }

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Generá la respuesta." },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    if (status === 'success') return `Reintegro aprobado sobre neto de ayer. Monto: $${data.bonus}. Se acredita ahora.`;
    return 'El sistema de reembolsos funciona de 18 a 00hs.';
  }
}

// 3. POST-VENTA
async function generateAfterCare(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: `Agente de casino profesional. Hablas con "${username}".
        Ya cobró hoy. Si insiste, recordale que el beneficio es una vez por día sobre el neto de ayer.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return 'Tu reintegro ya fue procesado. Volvé mañana para el próximo.'; }
}

// ================== LÓGICA DE NEGOCIO ==================
async function checkUserInSheets(username) {
  // VERIFICACIÓN DE HORARIO ANTES DE LEER SHEETS
  if (!isClaimWindowOpen()) {
    return { status: 'closed_window' };
  }

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

  if (foundIndices.length === 0) return { status: 'not_found' };

  let alreadyClaimed = false;
  for (const idx of foundIndices) {
    if (String(rows[idx][4] || '').toLowerCase().includes('reclam')) {
      alreadyClaimed = true;
      break;
    }
  }

  if (alreadyClaimed) return { status: 'claimed', username };

  const net = userTotals.deposits - userTotals.withdrawals;
  if (net <= 1) return { status: 'no_balance', net: net.toFixed(2), username, indices: foundIndices };

  return { 
    status: 'success', 
    net: net.toFixed(2), 
    bonus: (net * 0.08).toFixed(2), 
    username, 
    indices: foundIndices,
    spreadsheetId 
  };
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, contactId, contactName, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}" | ContactName: "${contactName}"`);

  let state = userStates.get(conversationId) || { claimed: false, username: null, lastActivity: Date.now() };
  state.lastActivity = Date.now();
  
  // 1. Identificación automática por Agenda
  let activeUsername = state.username;
  if (!activeUsername && isValidUsername(contactName)) {
    console.log(`✅ Usuario detectado por Agenda: ${contactName}`);
    activeUsername = contactName.toLowerCase();
    state.username = activeUsername;
  }
  userStates.set(conversationId, state);

  // 2. Si ya cobró hoy
  if (state.claimed && activeUsername) {
    const reply = await generateAfterCare(fullMessage, activeUsername);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  // 3. Usuario identificado (Agenda o Estado) -> Procesar Reclamo
  if (activeUsername) {
    console.log(`⚡ Procesando usuario conocido: ${activeUsername}`);
    const result = await checkUserInSheets(activeUsername);
    
    // Si está cerrado el horario, avisamos pero NO marcamos como claimed para que vuelva después
    if (result.status === 'closed_window') {
        const reply = await generateCheckResult(activeUsername, 'closed_window');
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
    }

    const reply = await generateCheckResult(activeUsername, result.status, result);
    await sendReplyToChatwoot(accountId, conversationId, reply);

    if (result.status === 'success') {
      await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
      state.claimed = true;
      userStates.set(conversationId, state);
      // Re-confirmar agenda
      await updateChatwootContact(accountId, contactId, activeUsername);
    } else if (result.status === 'claimed' || result.status === 'no_balance') {
      state.claimed = true; 
      userStates.set(conversationId, state);
    }
    return;
  }

  // 4. Usuario NO identificado -> Charla para obtener usuario
  
  // Detección de "Olvidé usuario"
  const msgLower = fullMessage.toLowerCase();
  if (msgLower.includes('no') && (msgLower.includes('recuerdo') || msgLower.includes('se')) && msgLower.includes('usuario')) {
      await sendReplyToChatwoot(accountId, conversationId, "Si no recordás tu usuario, por favor comunicate con nuestro WhatsApp principal para solicitarlo.");
      return;
  }

  // Extracción del mensaje
  const extractedUser = extractUsername(fullMessage);

  if (extractedUser) {
    console.log(`⚡ Usuario en mensaje: ${extractedUser}`);
    const result = await checkUserInSheets(extractedUser);
    
    if (result.status === 'closed_window') {
        const reply = await generateCheckResult(extractedUser, 'closed_window');
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
    }
    
    const reply = await generateCheckResult(extractedUser, result.status, result);
    await sendReplyToChatwoot(accountId, conversationId, reply);

    if (result.status === 'success') {
      await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
      await updateChatwootContact(accountId, contactId, extractedUser); // AGENDAR AHORA
      
      state.claimed = true;
      state.username = extractedUser;
      userStates.set(conversationId, state);
    } else if (result.status === 'claimed' || result.status === 'no_balance') {
      state.claimed = true;
      state.username = extractedUser;
      userStates.set(conversationId, state);
    }
  } else {
    // Charla casual (Pedir usuario)
    const reply = await generateCasualChat(fullMessage);
    await sendReplyToChatwoot(accountId, conversationId, reply);
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
  const contactName = body.sender?.name || ''; 
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
      console.log(`⏳ Escribiendo... (Conv ${conversationId})`);
      await sleep(3500); 
      await processConversation(accountId, conversationId, contactId, contactName, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot Casino Profesional Activo en puerto ${PORT}`));
