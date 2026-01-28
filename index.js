require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data'); // Necesario para form-data
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

// CREDENCIALES DE LA PLATAFORMA (AGENTE)
const PLATFORM_URL = "https://admin.agentesadmin.bet/api/admin/";
const PLATFORM_USER = process.env.PLATFORM_USER; 
const PLATFORM_PASS = process.env.PLATFORM_PASS;

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

// ================== INTEGRACIÓN PLATAFORMA (REAL) ==================

// 1. Obtener Token de Agente (Login)
async function getPlatformToken() {
  try {
    const form = new FormData();
    form.append('action', 'LOGIN');
    form.append('username', PLATFORM_USER);
    form.append('password', PLATFORM_PASS);

    const resp = await axios.post(PLATFORM_URL, form, {
      headers: { ...form.getHeaders() }
    });

    if (resp.data && resp.data.success && resp.data.token) {
      console.log("✅ Login Plataforma Exitoso");
      return resp.data.token;
    } else {
      console.error("❌ Login Fallido:", resp.data);
      return null;
    }
  } catch (err) {
    console.error("❌ Error conectando plataforma:", err.message);
    return null;
  }
}

// 2. Cargar Saldo (Reembolso)
async function creditUserBalance(username, amount) {
  console.log(`💰 Iniciando carga real de $${amount} a ${username}...`);
  
  const token = await getPlatformToken();
  if (!token) return { success: false, error: 'Login Error' };

  try {
    const form = new FormData();
    // NOTA: 'DEPOSIT' suele ser el standard. Si tu API usa 'CHANGE_BALANCE' avísame.
    form.append('action', 'DEPOSIT'); 
    form.append('token', token);
    form.append('username', username);
    form.append('amount', amount.toString());

    const resp = await axios.post(PLATFORM_URL, form, {
      headers: { ...form.getHeaders() }
    });

    if (resp.data && resp.data.success) {
      console.log(`✅ CARGA EXITOSA: $${amount} acreditados a ${username}`);
      return { success: true };
    } else {
      console.error(`❌ Falló la carga:`, resp.data);
      return { success: false, error: resp.data.error || 'API Error' };
    }
  } catch (err) {
    console.error("❌ Error en request de carga:", err.message);
    return { success: false, error: err.message };
  }
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
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    await axios.put(url, { name: username }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
  } catch (err) {
    console.error('❌ Error agendando:', err?.message);
  }
}

// ================== UTILIDADES ==================
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

// ================== IA GENERATORS ==================
async function generateCasualChat(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino virtual. Tono: SERIO, BREVE y PROFESIONAL.
          Reembolso = Neto día anterior. Horario 24hs.
          Si saluda, devolvé saludo y pedí usuario. NUNCA des ejemplos.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || 'Hola. Indicame tu usuario para verificar.';
  } catch (err) { return 'Hola, por favor indicame tu usuario.'; }
}

async function generateCheckResult(username, status, data = {}) {
  let systemPrompt = `Sos agente de casino. Usuario: "${username}". Sé breve.`;

  if (status === 'not_found') {
    systemPrompt += ` Usuario NO encontrado en base de ayer. Pedile que verifique escritura.`;
  } 
  else if (status === 'claimed') {
    systemPrompt += ` Ya reclamó hoy. Decile que ya fue procesado.`;
  } 
  else if (status === 'no_balance') {
    systemPrompt += ` Neto ayer: ${data.net}. No tiene saldo negativo suficiente para reintegro.`;
  } 
  else if (status === 'success') {
    // IMPORTANTE: Aquí cambiamos el texto porque ya se cargó realmente
    systemPrompt += ` ÉXITO TOTAL. Reintegro ACREDITADO REALMENTE en su cuenta.
    Neto ayer: ${data.net}.
    Monto acreditado: ${data.bonus}.
    Confirmale que YA TIENE LA PLATA en su usuario y puede jugar.`;
  } else if (status === 'api_error') {
     systemPrompt += ` Error técnico al intentar cargar el saldo. Decile que contacte a soporte humano o intente en un rato.`;
  }

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Generá respuesta." },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    if (status === 'success') return `¡Listo! Ya te cargué $${data.bonus} en tu cuenta.`;
    return 'Estoy verificando.';
  }
}

async function generateAfterCare(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: `Agente de casino. Hablas con "${username}". Ya cobró hoy.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return 'Tu reintegro ya está listo. Volvé mañana.'; }
}

// ================== LÓGICA DE NEGOCIO ==================
async function checkUserInSheets(username) {
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
    bonus: (net * 0.08).toFixed(2), // 8% de reintegro
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
  
  let activeUsername = state.username;
  if (!activeUsername && isValidUsername(contactName)) {
    activeUsername = contactName.toLowerCase();
    state.username = activeUsername;
  }
  userStates.set(conversationId, state);

  if (state.claimed && activeUsername) {
    const reply = await generateAfterCare(fullMessage, activeUsername);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  if (activeUsername) {
    console.log(`⚡ Procesando usuario conocido: ${activeUsername}`);
    const result = await checkUserInSheets(activeUsername);
    
    // Si corresponde reembolso, INTENTAMOS CARGAR SALDO REAL
    if (result.status === 'success') {
      const apiResult = await creditUserBalance(activeUsername, result.bonus);
      
      if (apiResult.success) {
        // Carga exitosa -> Avisamos al cliente, marcamos Sheets y agendamos
        const reply = await generateCheckResult(activeUsername, 'success', result);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
        await updateChatwootContact(accountId, contactId, activeUsername);
        
        state.claimed = true;
        userStates.set(conversationId, state);
      } else {
        // Falló la API -> Avisamos error técnico (NO marcamos claimed)
        console.error("❌ Falló la carga de saldo en API");
        const reply = await generateCheckResult(activeUsername, 'api_error', result);
        await sendReplyToChatwoot(accountId, conversationId, reply);
      }
    } 
    else {
      // Casos not_found, claimed, no_balance
      const reply = await generateCheckResult(activeUsername, result.status, result);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      if (result.status === 'claimed' || result.status === 'no_balance') {
        state.claimed = true; 
        userStates.set(conversationId, state);
      }
    }
    return;
  }

  // Si no tenemos usuario
  const msgLower = fullMessage.toLowerCase();
  if (msgLower.includes('no') && (msgLower.includes('recuerdo') || msgLower.includes('se')) && msgLower.includes('usuario')) {
      await sendReplyToChatwoot(accountId, conversationId, "Si no recordás tu usuario, por favor comunicate con nuestro WhatsApp principal.");
      return;
  }

  const extractedUser = extractUsername(fullMessage);
  if (extractedUser) {
    console.log(`⚡ Usuario en mensaje: ${extractedUser}`);
    const result = await checkUserInSheets(extractedUser);
    
    if (result.status === 'success') {
       // CARGA REAL
       const apiResult = await creditUserBalance(extractedUser, result.bonus);
       
       if (apiResult.success) {
          const reply = await generateCheckResult(extractedUser, 'success', result);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
          await updateChatwootContact(accountId, contactId, extractedUser);
          
          state.claimed = true;
          state.username = extractedUser;
          userStates.set(conversationId, state);
       } else {
          const reply = await generateCheckResult(extractedUser, 'api_error', result);
          await sendReplyToChatwoot(accountId, conversationId, reply);
       }
    } else {
      const reply = await generateCheckResult(extractedUser, result.status, result);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      if (result.status === 'claimed' || result.status === 'no_balance') {
        state.claimed = true;
        state.username = extractedUser;
        userStates.set(conversationId, state);
      }
    }
  } else {
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

app.listen(PORT, () => console.log(`🚀 Bot de Cargas Reales Activo en puerto ${PORT}`));
