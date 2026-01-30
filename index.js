require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== CONFIGURACIÓN ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;

const API_URL = "https://admin.agentesadmin.bet/api/admin/";
const PLATFORM_CURRENCY = process.env.PLATFORM_CURRENCY || 'ARS';

// Credenciales para login automático
const PLATFORM_USER = process.env.PLATFORM_USER;
const PLATFORM_PASS = process.env.PLATFORM_PASS;

// Fallback opcional (solo si no hay user/pass)
const FIXED_API_TOKEN = process.env.FIXED_API_TOKEN;

// TTL de token en minutos
const TOKEN_TTL_MINUTES = parseInt(process.env.TOKEN_TTL_MINUTES || '20', 10);

// Proxy
const PROXY_URL = process.env.PROXY_URL;

if (!PLATFORM_USER || !PLATFORM_PASS) {
  console.log("⚠️ PLATFORM_USER / PLATFORM_PASS no definidos. Se usará FIXED_API_TOKEN si existe.");
}

const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));

let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    if (GOOGLE_CREDENTIALS.private_key) {
      GOOGLE_CREDENTIALS.private_key = GOOGLE_CREDENTIALS.private_key.replace(/\\n/g, '\n');
    }
    console.log(`✅ Google credentials cargadas: ${GOOGLE_CREDENTIALS.client_email}`);
  } catch (err) {
    console.error('❌ Error Credentials JSON:', err.message);
  }
} else {
  console.error('❌ GOOGLE_CREDENTIALS_JSON no está definido.');
}

const auth = GOOGLE_CREDENTIALS
  ? new GoogleAuth({
      credentials: GOOGLE_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  : null;

const messageBuffer = new Map();
const userStates = new Map();

// Limpieza memoria
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of userStates.entries()) {
    if (now - state.lastActivity > 24 * 60 * 60 * 1000) userStates.delete(id);
  }
}, 60 * 60 * 1000);

// ================== CLIENTE HTTP ==================

function toFormUrlEncoded(data) {
  return Object.keys(data).map(key => {
    return encodeURIComponent(key) + '=' + encodeURIComponent(data[key]);
  }).join('&');
}

let httpsAgent = null;
if (PROXY_URL) {
  console.log("🌐 Usando Proxy configurado.");
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

async function logProxyIP() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent,
      timeout: 10000,
    });
    console.log('🌍 IP pública (via proxy):', res.data);
  } catch (err) {
    console.error('❌ Error obteniendo IP pública (proxy):', err.message);
  }
}

if (httpsAgent) logProxyIP();

function logBlockedHtml(context, html) {
  console.error(`❌ [API] RESPUESTA HTML (BLOQUEO DE IP) en ${context}. HTML completo:`);
  console.error(html);
}

const client = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  httpsAgent: httpsAgent,
  proxy: false,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://admin.agentesadmin.bet',
    'Referer': 'https://admin.agentesadmin.bet/users',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Accept-Language': 'es-419,es;q=0.9'
  }
});

// ================== SESIÓN (TOKEN FRESCO) ==================
let SESSION_TOKEN = null;
let SESSION_COOKIE = null;
let SESSION_PARENT_ID = null;
let SESSION_LAST_LOGIN = 0;

async function loginAndGetToken() {
  if (!PLATFORM_USER || !PLATFORM_PASS) {
    console.error("❌ Falta PLATFORM_USER/PLATFORM_PASS.");
    return false;
  }

  console.log("🔐 Iniciando login automático...");
  try {
    const loginRes = await client.post('', toFormUrlEncoded({
      action: 'LOGIN',
      username: PLATFORM_USER,
      password: PLATFORM_PASS
    }), {
      validateStatus: status => status >= 200 && status < 500,
      maxRedirects: 0
    });

    if (loginRes.headers['set-cookie']) {
      SESSION_COOKIE = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');
    }

    let loginData = loginRes.data;
    if (typeof loginData === 'string') {
      try {
        loginData = JSON.parse(loginData.substring(loginData.indexOf('{'), loginData.lastIndexOf('}') + 1));
      } catch (e) {}
    }

    if (!loginData?.token) {
      console.error("❌ Login falló: no se recibió token.");
      return false;
    }

    SESSION_TOKEN = loginData.token;
    SESSION_PARENT_ID = loginData.user ? loginData.user.user_id : null;
    SESSION_LAST_LOGIN = Date.now();

    console.log("✅ Login OK (token fresco).");
    if (SESSION_PARENT_ID) console.log(`✅ Admin ID: ${SESSION_PARENT_ID}`);

    return true;
  } catch (err) {
    console.error("❌ Error en login:", err.message);
    return false;
  }
}

async function ensureSession() {
  // Si hay user/pass -> token fresco con TTL
  if (PLATFORM_USER && PLATFORM_PASS) {
    const isExpired = Date.now() - SESSION_LAST_LOGIN > TOKEN_TTL_MINUTES * 60 * 1000;
    if (!SESSION_TOKEN || isExpired) {
      SESSION_TOKEN = null;
      SESSION_COOKIE = null;
      SESSION_PARENT_ID = null;
      return await loginAndGetToken();
    }
    return true;
  }

  // Fallback token fijo
  if (FIXED_API_TOKEN) {
    SESSION_TOKEN = FIXED_API_TOKEN;
    return true;
  }

  console.error("❌ No hay credenciales ni token fijo.");
  return false;
}

// 1. BUSCAR USUARIO
async function getUserIdByName(targetUsername) {
  console.log(`🔎 [API] Buscando usuario: ${targetUsername}...`);

  const ok = await ensureSession();
  if (!ok) return null;

  try {
    const body = toFormUrlEncoded({
      action: 'ShowUsers',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 50,
      viewtype: 'tree',
      username: targetUsername,
      showhidden: 'false',
      parentid: SESSION_PARENT_ID || undefined
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, {
      headers: headers2,
      validateStatus: () => true,
      maxRedirects: 0
    });

    console.log("🔎 [DEBUG] status:", resp.status);
    console.log("🔎 [DEBUG] content-type:", resp.headers?.['content-type']);

    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1)); } catch (e) {}
    }

    if (typeof data === 'string' && data.trim().startsWith('<')) {
      logBlockedHtml('ShowUsers', data);
      return null;
    }

    const list = data.users || data.data || (Array.isArray(data) ? data : []);
    const found = list.find(u => String(u.user_name).toLowerCase().trim() === String(targetUsername).toLowerCase().trim());

    if (found && found.user_id) {
      console.log(`✅ [API] ID encontrado: ${found.user_id}`);
      return found.user_id;
    }

    console.error(`❌ [API] Usuario no encontrado. Lista recibida: ${list.length}`);
    return null;
  } catch (err) {
    console.error("❌ [API] Error Búsqueda:", err.message);
    return null;
  }
}

// 2. DEPOSITAR
async function creditUserBalance(username, amount) {
  console.log(`💰 [API] Cargando $${amount} a ${username}`);

  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  const childId = await getUserIdByName(username);
  if (!childId) return { success: false, error: 'Usuario no encontrado o IP Bloqueada' };

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);

    const body = toFormUrlEncoded({
      action: 'DepositMoney',
      token: SESSION_TOKEN,
      childid: childId,
      amount: amountCents,
      currency: PLATFORM_CURRENCY
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1)); } catch (e) {}
    }

    if (typeof data === 'string' && data.trim().startsWith('<')) {
      logBlockedHtml('DepositMoney', data);
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    console.log("📩 [API] Resultado:", JSON.stringify(data));

    if (data && data.success) {
      return { success: true };
    } else {
      return { success: false, error: data.error || 'API Error' };
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================== GOOGLE SHEETS ==================
async function getSheetData(spreadsheetId, range) {
  try {
    if (!auth) throw new Error('GoogleAuth no inicializado (credenciales inválidas)');
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    return res.data.values || [];
  } catch (error) {
    console.error('❌ Error Sheets:', error?.message);
    return [];
  }
}

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
    bonus: (net * 0.08).toFixed(2),
    username,
    indices: foundIndices,
    spreadsheetId
  };
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
    console.log(`✅ Respuesta enviada.`);
  } catch (err) {
    console.error('❌ Error Chatwoot:', err.message);
  }
}

async function updateChatwootContact(accountId, contactId, username) {
  if (!CHATWOOT_ACCESS_TOKEN || !contactId) return;
  try {
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    await axios.put(url, { name: username }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
  } catch (err) { console.error('❌ Error Rename:', err?.message); }
}

// ================== GENERADORES IA ==================
async function generateCasualChat(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: `Sos un agente de casino virtual. Breve.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return 'Hola, indicame tu usuario.'; }
}

async function generateCheckResult(username, status, data = {}) {
  let systemPrompt = `Sos agente de casino. Usuario: "${username}". Breve.`;
  if (status === 'success') systemPrompt += ` ÉXITO. Acreditado: ${data.bonus}.`;
  else if (status === 'api_error') systemPrompt += ` Hubo un error técnico.`;
  else if (status === 'not_found') systemPrompt += ` Usuario no encontrado en nuestros registros.`;
  else if (status === 'claimed') systemPrompt += ` Ya reclamó hoy.`;
  else if (status === 'no_balance') systemPrompt += ` Sin saldo negativo para reintegro.`;

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: "Generá respuesta." }],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return status === 'success' ? `Listo. $${data.bonus}.` : 'Error.'; }
}

async function generateAfterCare(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        { role: 'system', content: `Agente de casino. Cliente "${username}" ya cobró hoy.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return 'Tu reintegro ya está listo.'; }
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

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, contactId, contactName, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}" | Contact: "${contactName}"`);

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
    console.log(`⚡ Usuario conocido: ${activeUsername}`);
    const result = await checkUserInSheets(activeUsername);

    if (result.status === 'success') {
      const apiResult = await creditUserBalance(activeUsername, result.bonus);
      if (apiResult.success) {
        const reply = await generateCheckResult(activeUsername, 'success', result);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
        await updateChatwootContact(accountId, contactId, activeUsername);
        state.claimed = true;
        userStates.set(conversationId, state);
      } else {
        console.error(`❌ FALLO API: ${apiResult.error}`);
        const reply = await generateCheckResult(activeUsername, 'api_error', result);
        await sendReplyToChatwoot(accountId, conversationId, reply);
      }
    } else {
      const reply = await generateCheckResult(activeUsername, result.status, result);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      if (result.status === 'claimed' || result.status === 'no_balance') {
        state.claimed = true;
        userStates.set(conversationId, state);
      }
    }
    return;
  }

  const extractedUser = extractUsername(fullMessage);
  if (extractedUser) {
    console.log(`⚡ Usuario detectado: ${extractedUser}`);
    const result = await checkUserInSheets(extractedUser);

    if (result.status === 'success') {
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
        console.error(`❌ FALLO API: ${apiResult.error}`);
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
      console.log(`⏳ Procesando... (Conv ${conversationId})`);
      await sleep(3500);
      await processConversation(accountId, conversationId, contactId, contactName, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot (Token Fresco) Activo en puerto ${PORT}`));
