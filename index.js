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

const API_URL = "https://admin.agentesadmin.bet/api/admin/";
const PLATFORM_CURRENCY = process.env.PLATFORM_CURRENCY || 'ARS';

const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON;
const SHEET_ID = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
const SHEET_NAME = 'Sheet1';

const PLATFORM_URL = 'www.jugaygana.bet';

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

  if (FIXED_API_TOKEN) {
    SESSION_TOKEN = FIXED_API_TOKEN;
    return true;
  }

  console.error("❌ No hay credenciales ni token fijo.");
  return false;
}

// ================== FECHAS ARGENTINA ==================
function getYesterdayRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;

  const todayLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);

  const yparts = formatter.formatToParts(yesterdayLocal);
  const y = yparts.find(p => p.type === 'year').value;
  const m = yparts.find(p => p.type === 'month').value;
  const d = yparts.find(p => p.type === 'day').value;

  const from = new Date(`${y}-${m}-${d}T00:00:00-03:00`);
  const to = new Date(`${y}-${m}-${d}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
  };
}

function getTodayRangeArgentinaEpoch() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const now = new Date();
  const parts = formatter.formatToParts(now);
  const yyyy = parts.find(p => p.type === 'year').value;
  const mm = parts.find(p => p.type === 'month').value;
  const dd = parts.find(p => p.type === 'day').value;

  const from = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const to = new Date(`${yyyy}-${mm}-${dd}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
  };
}

function getArgentinaDateTime() {
  return new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date());
}

// ================== GOOGLE SHEETS ==================
async function appendBonusToSheet(username, amount) {
  try {
    if (!auth) throw new Error('GoogleAuth no inicializado');
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const row = [
      'bonus',
      username,
      amount,
      getArgentinaDateTime()
    ];

    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${SHEET_NAME}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] }
    });

    console.log('✅ Bonus registrado en Google Sheets');
  } catch (err) {
    console.error('❌ Error guardando en Sheets:', err.message);
  }
}

// ================== USUARIO ==================
async function getUserInfoByName(targetUsername) {
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
      let balanceRaw = found.user_balance ?? found.balance ?? found.balance_amount ?? found.available_balance ?? 0;
      balanceRaw = Number(balanceRaw || 0);

      let balancePesos = balanceRaw;
      if (balanceRaw > 10000) balancePesos = balanceRaw / 100;

      console.log(`✅ [API] ID encontrado: ${found.user_id} | Balance: ${balancePesos}`);
      return { id: found.user_id, balance: balancePesos };
    }

    console.error(`❌ [API] Usuario no encontrado. Lista recibida: ${list.length}`);
    return null;
  } catch (err) {
    console.error("❌ [API] Error Búsqueda:", err.message);
    return null;
  }
}

// ================== TRANSFERENCIAS (AYER) ==================
async function getUserNetYesterday(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch } = getYesterdayRangeArgentinaEpoch();

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 30,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1)); } catch (e) {}
    }

    if (typeof data === 'string' && data.trim().startsWith('<')) {
      logBlockedHtml('ShowUserTransfersByAgent', data);
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    const totalDepositsCents = Number(data?.total_deposits || 0);
    const totalWithdrawsCents = Number(data?.total_withdraws || 0);
    const netCents = totalDepositsCents - totalWithdrawsCents;

    const totalDeposits = totalDepositsCents / 100;
    const totalWithdraws = totalWithdrawsCents / 100;
    const net = netCents / 100;

    console.log(`📊 Totales ${username}: deposits=${totalDeposits} withdraws=${totalWithdraws} net=${net}`);

    return {
      success: true,
      net: Number(net.toFixed(2)),
      totalDeposits,
      totalWithdraws,
      fromEpoch,
      toEpoch
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================== RECLAMO HOY ==================
async function checkClaimedToday(username) {
  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  if (!SESSION_PARENT_ID) {
    return { success: false, error: 'No se pudo obtener Admin ID' };
  }

  try {
    const { fromEpoch, toEpoch } = getTodayRangeArgentinaEpoch();

    const body = toFormUrlEncoded({
      action: 'ShowUserTransfersByAgent',
      token: SESSION_TOKEN,
      page: 1,
      pagesize: 30,
      fromtime: fromEpoch,
      totime: toEpoch,
      username: username,
      userrole: 'player',
      direct: 'False',
      childid: SESSION_PARENT_ID
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1)); } catch (e) {}
    }

    const totalBonusCents = Number(data?.total_bonus || 0);
    const totalBonus = totalBonusCents / 100;

    return { success: true, claimed: totalBonus > 0, totalBonus };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================== DEPOSITAR BONUS ==================
async function creditUserBalance(username, amount) {
  console.log(`💰 [API] Cargando $${amount} a ${username}`);

  const ok = await ensureSession();
  if (!ok) return { success: false, error: 'No hay sesión válida' };

  const userInfo = await getUserInfoByName(username);
  if (!userInfo) return { success: false, error: 'Usuario no encontrado' };

  try {
    const amountCents = Math.round(parseFloat(amount) * 100);

    const body = toFormUrlEncoded({
      action: 'DepositMoney',
      token: SESSION_TOKEN,
      childid: userInfo.id,
      amount: amountCents,
      currency: PLATFORM_CURRENCY,
      deposit_type: 'individual_bonus'
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
function calcTypingDelayMs(text) {
  const len = (text || '').length;
  const extra = Math.min(5000, Math.floor(len / 12) * 250);
  return Math.min(10000, 5000 + extra);
}

async function applyTypingDelay(text) {
  const delay = calcTypingDelayMs(text);
  await sleep(delay);
}

async function generateCasualChat(message) {
  try {
    await applyTypingDelay(message);
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: `Sos Camila, agente real de Jugá y Ganá (Argentina), atención 24 hs. Tu tarea es ayudar y gestionar el reembolso diario. Nunca digas que sos IA ni bot. Escribí como persona real: breve, clara y con algun error de tipeo leve y natural. Si falta el usuario, pedilo. Si el cliente no recuerda su usuario, indicá que consulte en el WhatsApp principal de su equipo. El reintegro es por el día de ayer (00:00-23:59 AR) y se acredita automáticamente cuando tengamos el usuario. Link: ${PLATFORM_URL}.`
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(message);
    return 'Hola! soy Cami, pasame tu usuario y te reviso el reintegro.';
  }
}

async function generateCheckResult(username, status, data = {}) {
  let systemPrompt = `Sos Camila, agente real de Jugá y Ganá. Usuario: "${username}". Respuesta breve, humana, con algun error de tipeo leve. Nunca digas que sos IA ni bot. Link: ${PLATFORM_URL}.`;
  if (status === 'success') systemPrompt += ` Reintegro de ayer acreditado por $${data.bonus}. Decí que ya puede verlo en la plataforma.`;
  else if (status === 'api_error') systemPrompt += ` Hubo un problema técnico al consultar o acreditar.`;
  else if (status === 'no_balance') systemPrompt += ` El neto de ayer no supera $1, por eso no aplica reintegro hoy.`;
  else if (status === 'claimed') systemPrompt += ` Ya fue reclamado hoy.`;

  const delaySeed = `${status} ${data?.bonus || ''}`;

  try {
    await applyTypingDelay(delaySeed);
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Generá respuesta." }
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(delaySeed);
    return status === 'success' ? `Listo, ya lo tenés acreditado.` : 'No se pudo procesar, probá más tarde.';
  }
}

async function generateAfterCare(message, username) {
  try {
    await applyTypingDelay(message);
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content: `Sos Camila, agente real. El cliente "${username}" ya cobró hoy. Respuesta corta, humana y con algun typo leve. Nunca digas que sos IA ni bot.`
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(message);
    return 'El reintegro ya quedó hoy. Mañana podés volver a pedirlo.';
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

function isWrongUsernameMessage(message) {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('no es mi usuario') ||
    m.includes('ese no es mi usuario') ||
    m.includes('me equivoque') ||
    m.includes('me equivoqué') ||
    m.includes('usuario incorrecto') ||
    m.includes('usuario mal') ||
    m.includes('no es mi user')
  );
}

function isForgotUsernameMessage(message) {
  if (!message) return false;
  const m = message.toLowerCase();
  return (
    m.includes('no recuerdo mi usuario') ||
    m.includes('no me acuerdo mi usuario') ||
    m.includes('olvide mi usuario') ||
    m.includes('olvidé mi usuario') ||
    m.includes('no se mi usuario') ||
    m.includes('no sé mi usuario')
  );
}

function randomTempName() {
  return `temp-${Math.random().toString(36).slice(2, 8)}`;
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, contactId, contactName, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}" | Contact: "${contactName}"`);

  let state = userStates.get(conversationId) || { claimed: false, username: null, lastActivity: Date.now() };
  state.lastActivity = Date.now();
  userStates.set(conversationId, state);

  if (isForgotUsernameMessage(fullMessage)) {
    await sendReplyToChatwoot(accountId, conversationId, 'Si no recordás tu usuario, escribile a tu agente en WhatsApp principal para que te lo confirme.');
    return;
  }

  if (isWrongUsernameMessage(fullMessage)) {
    state.username = null;
    state.claimed = false;
    userStates.set(conversationId, state);

    const tempName = randomTempName();
    await updateChatwootContact(accountId, contactId, tempName);

    await sendReplyToChatwoot(accountId, conversationId, 'Entiendo, pasame tu usuario correcto para acreditarte el reintegro.');
    return;
  }

  let activeUsername = state.username;
  if (!activeUsername && isValidUsername(contactName)) {
    activeUsername = contactName.toLowerCase();
    state.username = activeUsername;
    userStates.set(conversationId, state);
  }

  if (state.claimed && activeUsername) {
    const reply = await generateAfterCare(fullMessage, activeUsername);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  const usernameToCheck = activeUsername || extractUsername(fullMessage);
  if (usernameToCheck) {
    console.log(`⚡ Usuario detectado: ${usernameToCheck}`);

    // 1) Ya reclamado hoy
    const claimedCheck = await checkClaimedToday(usernameToCheck);
    if (claimedCheck.success && claimedCheck.claimed) {
      const reply = await generateCheckResult(usernameToCheck, 'claimed');
      await sendReplyToChatwoot(accountId, conversationId, reply);
      state.claimed = true;
      state.username = usernameToCheck;
      userStates.set(conversationId, state);
      return;
    }

    // 2) Saldo actual
    const userInfo = await getUserInfoByName(usernameToCheck);
    if (!userInfo) {
      const reply = await generateCheckResult(usernameToCheck, 'api_error');
      await sendReplyToChatwoot(accountId, conversationId, reply);
      return;
    }

    if (userInfo.balance >= 1000) {
      await sendReplyToChatwoot(accountId, conversationId, 'Tu saldo actual supera $1000, por eso no aplica el reintegro automático.');
      return;
    }

    // 3) Neto de ayer
    const result = await getUserNetYesterday(usernameToCheck);
    if (result.success) {
      const net = result.net;
      if (net > 1) {
        const bonus = Number((net * 0.08).toFixed(2));
        const apiResult = await creditUserBalance(usernameToCheck, bonus);
        if (apiResult.success) {
          await appendBonusToSheet(usernameToCheck, bonus);
          const reply = await generateCheckResult(usernameToCheck, 'success', { bonus });
          await sendReplyToChatwoot(accountId, conversationId, reply);
          await updateChatwootContact(accountId, contactId, usernameToCheck);
          state.claimed = true;
          state.username = usernameToCheck;
          userStates.set(conversationId, state);
        } else {
          const reply = await generateCheckResult(usernameToCheck, 'api_error');
          await sendReplyToChatwoot(accountId, conversationId, reply);
        }
      } else {
        const reply = await generateCheckResult(usernameToCheck, 'no_balance', { net });
        await sendReplyToChatwoot(accountId, conversationId, reply);
        state.claimed = true;
        state.username = usernameToCheck;
        userStates.set(conversationId, state);
      }
    } else {
      const reply = await generateCheckResult(usernameToCheck, 'api_error');
      await sendReplyToChatwoot(accountId, conversationId, reply);
    }
    return;
  }

  const reply = await generateCasualChat(fullMessage);
  await sendReplyToChatwoot(accountId, conversationId, reply);
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
