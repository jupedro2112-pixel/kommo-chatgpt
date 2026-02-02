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

function getArgentinaDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
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

      // Corrección: si viene como entero, se interpreta como centavos
      let balancePesos = balanceRaw;
      if (Number.isInteger(balanceRaw)) {
        balancePesos = balanceRaw / 100;
      }

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
    const todayStr = getArgentinaDateString();
    const state = userStates.get(conversationId);
    let finalMessage = message;

    if (state?.greetedDate === todayStr) {
      const stripped = finalMessage.replace(/^hola[\s,!]+/i, '').trim();
      if (stripped.length > 0) finalMessage = stripped;
    }

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(url, {
      content: finalMessage,
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
const firstReplyByConversation = new Map();

function calcTypingDelayMs(text, conversationId) {
  if (conversationId && !firstReplyByConversation.get(conversationId)) return 0;
  const len = (text || '').length;
  const extra = Math.min(7000, Math.floor(len / 12) * 250);
  return Math.min(10000, 3000 + extra);
}

async function applyTypingDelay(text, conversationId) {
  const delay = calcTypingDelayMs(text, conversationId);
  if (delay > 0) await sleep(delay);
  if (conversationId) firstReplyByConversation.set(conversationId, true);
}

function normalizeUsernameValue(text) {
  return (text || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

function isNameQuestion(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('tu nombre') ||
    m.includes('como te llamas') ||
    m.includes('cómo te llamas') ||
    m.includes('quien sos') ||
    m.includes('quién sos')
  );
}

function isBalanceQuestion(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('saldo') ||
    m.includes('cuanto tengo') ||
    m.includes('cuánto tengo') ||
    m.includes('cuanto saldo') ||
    m.includes('cuánto saldo')
  );
}

function isYesterdayTransfersQuestion(message) {
  const m = (message || '').toLowerCase();
  const asksTransfers = m.includes('carga') || m.includes('deposit') || m.includes('retiro') || m.includes('movim');
  return m.includes('ayer') && asksTransfers;
}

function isNetoQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('neto') && (m.includes('que es') || m.includes('qué es') || m.includes('que seria') || m.includes('qué sería') || m.includes('explica'));
}

function isNetoAmountQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('cuanto es el neto') || m.includes('cuánto es el neto') || m.includes('cuanto neto') || m.includes('cuánto neto');
}

function isExplanationQuestion(message) {
  const m = (message || '').toLowerCase();
  return (
    m.includes('por que') ||
    m.includes('por qué') ||
    m.includes('porque') ||
    m.includes('como seria') ||
    m.includes('cómo sería') ||
    m.includes('explica') ||
    m.includes('explicame')
  );
}

function isConfusedMessage(message) {
  const m = (message || '').trim().toLowerCase();
  if (!m) return false;
  if (m.length <= 4 && /[\?\!]/.test(m)) return true;
  return m.includes('no entiendo') || m.includes('??') || m.includes('???');
}

function isReintegroQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('reintegro') || m.includes('reembolso');
}

function isCreditQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('me lo cargan') || m.includes('me lo acreditan') || m.includes('me lo cargás') || m.includes('me lo acreditás') || m.includes('me lo dan');
}

function isWhereRefundQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('donde veo') || m.includes('dónde veo') || m.includes('donde aparece') || m.includes('dónde aparece') || m.includes('a donde va') || m.includes('a dónde va');
}

function isHowProceedQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('como sigo') || m.includes('cómo sigo') || m.includes('como hago') || m.includes('cómo hago') || m.includes('como procedo') || m.includes('cómo procedo');
}

function isHelpQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('ayuda') || m.includes('necesito ayuda') || m.includes('no se que hacer') || m.includes('no sé que hacer');
}

function isComoSeCalculaQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('como se calcula') || m.includes('cómo se calcula') || m.includes('calculo del reintegro') || m.includes('calculo de reintegro');
}

function isHorarioQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('horario') || m.includes('hasta que hora') || m.includes('hasta qué hora') || m.includes('a que hora') || m.includes('a qué hora');
}

function isRequisitosQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('requisitos') || m.includes('condiciones') || m.includes('que necesito') || m.includes('qué necesito');
}

function isLinkQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('link') || m.includes('pagina') || m.includes('página') || m.includes('url') || m.includes('web');
}

function isPorcentajeQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('porcentaje') || m.includes('8%') || m.includes('ocho por ciento');
}

function isComoReclamarQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('como reclamo') || m.includes('cómo reclamo') || m.includes('como pedir') || m.includes('cómo pedir') || m.includes('reclamar reintegro');
}

function isTodayDepositQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('cargue hoy') || m.includes('cargué hoy') || m.includes('deposite hoy') || m.includes('deposité hoy');
}

function isGanamosQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('ganamos');
}

function isWeeklyRefundQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('reembolso semanal') || m.includes('bono semanal') || m.includes('reintegro semanal') || m.includes('lunes') || m.includes('martes');
}

function isPastLoadQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('cargue ayer') || m.includes('cargué ayer') || m.includes('cargue antes') || m.includes('cargué antes') || m.includes('dias anteriores') || m.includes('días anteriores');
}

function isWithdrawQuestion(message) {
  const m = (message || '').toLowerCase();
  return m.includes('retiro') || m.includes('retirar') || m.includes('sacar') || m.includes('extraer') || m.includes('cobrar') || m.includes('cobro');
}

function isUsernameConfirmMessage(message) {
  const m = (message || '').toLowerCase();
  return m.includes('ese es mi usuario') || m.includes('ese es mi user') || m.includes('ese es mi usuario correcto') || m.includes('ese es mi usuario.');
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
    m.includes('no es mi user') ||
    m.includes('me confundi') ||
    m.includes('me confundí') ||
    m.includes('error mio') ||
    m.includes('error mío') ||
    m.includes('lo escribi mal') ||
    m.includes('lo escribí mal')
  );
}

async function generateCasualChat(message, conversationId, context = {}) {
  try {
    await applyTypingDelay(message, conversationId);
    const greeted = context.greeted ? 'si' : 'no';
    const lastReason = context.lastReason || 'none';
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.4,
      messages: [
        {
          role: 'system',
          content: `Sos Camila, agente real de jugaygana (Argentina), atención 24 hs. Nunca digas que sos IA ni bot. Respuestas breves, humanas, con algun error de tipeo leve y natural. Si greeted=si, NO saludes ni te presentes de nuevo. Si el cliente pide explicación, respondé con el motivo usando last_reason (balance_limit, no_balance, claimed, user_not_found). Si falta el usuario para acreditar, pedilo. Si no recuerda su usuario, indicá que consulte al WhatsApp principal de su equipo. Reintegro: siempre por el día de ayer (00:00-23:59 AR). Cálculo: neto = depósitos - retiros, y el reintegro es 8% del neto si el neto es mayor a $1. Si el saldo actual supera $1000, no se acredita reintegro (debe tener menos de $1000). Solo trabajamos con ${PLATFORM_URL}. Si no podés ayudar, pedí que consulten al WhatsApp principal. Link: ${PLATFORM_URL}. Contexto: greeted=${greeted}, last_reason=${lastReason}.`
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(message, conversationId);
    return 'Hola! soy Cami, pasame tu usuario y te reviso el reintegro.';
  }
}

async function generateCheckResult(username, status, data = {}, conversationId) {
  if (status === 'success') {
    const bonusText = Number(data.bonus || 0).toFixed(2);
    const successMessage = `¡Hola ${username}! Tu reembolso del día de ayer te lo acabamos de cargar en tu cuenta, tu reembolso es de $${bonusText}. Ya lo podés ver en la plataforma ${PLATFORM_URL}! Cualquier cosa, estoy por acá. ¡Suerte!`;
    await applyTypingDelay(successMessage, conversationId);
    return successMessage;
  }

  let systemPrompt = `Sos Camila, agente real de jugaygana. Usuario: "${username}". Respuesta breve, humana, con algun error de tipeo leve. Nunca digas que sos IA ni bot. Link: ${PLATFORM_URL}.`;
  if (status === 'api_error') systemPrompt += ` No pude encontrar el usuario o hubo un error al consultarlo. Pedí que corrobore su usuario con el WhatsApp principal y que lo envíe bien para acreditar el reintegro.`;
  else if (status === 'no_balance') systemPrompt += ` Hoy no corresponde reintegro porque ayer no hubo cargas/retiros o el neto no alcanzó. Podés volver mañana y consultar de nuevo.`;
  else if (status === 'claimed') systemPrompt += ` Ya fue reclamado hoy.`;

  const delaySeed = `${status} ${data?.bonus || ''}`;

  try {
    await applyTypingDelay(delaySeed, conversationId);
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
    await applyTypingDelay(delaySeed, conversationId);
    return 'No se pudo procesar, probá más tarde.';
  }
}

async function generateAfterCare(message, username, conversationId) {
  try {
    await applyTypingDelay(message, conversationId);
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
    await applyTypingDelay(message, conversationId);
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
  const normalized = normalizeUsernameValue(text);
  if (TEAM_USER_PATTERN.test(normalized)) return true;
  if (/[a-z]+\d{3,}$/i.test(normalized)) return true;
  return false;
}

function extractUsername(message) {
  if (!message) return null;
  const raw = message.trim();
  const normalized = normalizeUsernameValue(raw);
  const teamMatch = normalized.match(TEAM_USER_PATTERN);
  if (teamMatch) return teamMatch[0].toLowerCase();
  const explicit = /usuario\s*:?\s*@?([a-z0-9._-]+)/i.exec(normalized);
  if (explicit) return explicit[1].toLowerCase();
  const genericMatch = normalized.match(/[a-z]{3,}\d{3,}/i);
  if (genericMatch) return genericMatch[0].toLowerCase();
  return null;
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

  const todayStr = getArgentinaDateString();
  let state = userStates.get(conversationId) || { claimed: false, username: null, greeted: false, greetedDate: null, lastReason: null, pendingIntent: null, lastActivity: Date.now() };
  state.lastActivity = Date.now();

  if (state.greetedDate !== todayStr) {
    state.greeted = false;
  }

  userStates.set(conversationId, state);

  const markReplied = () => {
    state.greeted = true;
    state.greetedDate = todayStr;
    userStates.set(conversationId, state);
    firstReplyByConversation.set(conversationId, true);
  };

  const usernameFromMsg = extractUsername(fullMessage);
  const hasUsernameInMessage = Boolean(usernameFromMsg);

  if (usernameFromMsg && usernameFromMsg !== state.username) {
    state.username = usernameFromMsg;
    state.lastReason = null;
    state.pendingIntent = null;
    state.claimed = false;
    userStates.set(conversationId, state);
  }

  if (!state.greeted && usernameFromMsg) {
    state.greeted = true;
    state.greetedDate = todayStr;
    userStates.set(conversationId, state);
  }

  if (!state.greeted) {
    await sendReplyToChatwoot(accountId, conversationId, 'Hola! soy Cami 🙂 Para acreditar el reembolso de ayer necesito tu usuario. El reintegro es automático y se calcula con el neto de ayer. Pasame tu usuario y lo reviso.');
    markReplied();
    return;
  }

  if (isWithdrawQuestion(fullMessage)) {
    await sendReplyToChatwoot(accountId, conversationId, 'Los retiros (normales o de reembolso) se gestionan por el WhatsApp principal de tu equipo. Acá solo hacemos cargas de reembolsos.');
    markReplied();
    return;
  }

  if (isUsernameConfirmMessage(fullMessage)) {
    await sendReplyToChatwoot(accountId, conversationId, 'Perfecto, ya tengo tu usuario. Decime si querés que revise el reembolso.');
    markReplied();
    return;
  }

  if (isWrongUsernameMessage(fullMessage)) {
    state.username = null;
    state.claimed = false;
    state.lastReason = null;
    state.pendingIntent = null;
    userStates.set(conversationId, state);

    const tempName = randomTempName();
    await updateChatwootContact(accountId, contactId, tempName);

    await sendReplyToChatwoot(accountId, conversationId, 'Entiendo, pasame tu usuario correcto y lo reviso.');
    markReplied();
    return;
  }

  if (!hasUsernameInMessage) {
    if (isGanamosQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, `Los reembolsos diarios son solo en ${PLATFORM_URL}. La plataforma "ganamos" no aplica para reembolsos diarios.`);
      markReplied();
      return;
    }

    if (isWeeklyRefundQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El reembolso semanal se acredita lunes o martes y es aparte del reembolso diario. El diario se reclama por el día de ayer.');
      markReplied();
      return;
    }

    if (isPastLoadQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El reembolso diario solo toma el día de ayer. Cargas de días anteriores no aplican; para próximas cargas, podés reclamar al día siguiente.');
      markReplied();
      return;
    }

    if (isTodayDepositQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Si cargaste hoy, lo vas a ver reflejado mañana en cualquier horario.');
      markReplied();
      return;
    }

    if (isWhereRefundQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, `El reintegro se acredita en tu saldo de ${PLATFORM_URL}. Si corresponde, lo vas a ver en la cuenta apenas se procesa.`);
      markReplied();
      return;
    }

    if (isHowProceedQuestion(fullMessage) || isHelpQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Decime tu usuario y reviso si corresponde el reintegro de ayer. Si tenés otra duda, también te ayudo.');
      markReplied();
      return;
    }

    if (isNetoQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El neto de ayer es la suma de todas las cargas menos la suma de todos los retiros de ayer.');
      markReplied();
      return;
    }

    if (isLinkQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, `${PLATFORM_URL}`);
      markReplied();
      return;
    }

    if (!state.username && isReintegroQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El reintegro es del 8% del neto de ayer (depósitos menos retiros), si ese neto es mayor a $1.');
      markReplied();
      return;
    }

    if (!state.username && isComoSeCalculaQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Se calcula con el neto de ayer: sumás cargas, restás retiros, y si da más de $1 se acredita el 8%.');
      markReplied();
      return;
    }

    if (!state.username && isPorcentajeQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El reintegro es del 8% del neto de ayer.');
      markReplied();
      return;
    }

    if (!state.username && isRequisitosQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Necesito tu usuario. El reintegro es por ayer y se acredita si el neto es mayor a $1 y tu saldo actual es menor a $1000.');
      markReplied();
      return;
    }

    if (!state.username && isComoReclamarQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Para reclamar el reintegro solo pasame tu usuario y lo reviso.');
      markReplied();
      return;
    }

    if (isHorarioQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'El reintegro se reclama de 00:00 a 23:59 y corresponde al día de ayer.');
      markReplied();
      return;
    }
  }

  if (isNetoAmountQuestion(fullMessage)) {
    const usernameToCheck = state.username || usernameFromMsg;
    if (!usernameToCheck) {
      state.pendingIntent = 'neto';
      await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo el neto de ayer.');
      markReplied();
      return;
    }
    const result = await getUserNetYesterday(usernameToCheck);
    if (!result.success) {
      state.lastReason = 'api_error';
      await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
      markReplied();
      return;
    }
    await sendReplyToChatwoot(accountId, conversationId, `Tu neto de ayer fue $${result.net.toFixed(2)} (cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}).`);
    markReplied();
    return;
  }

  if (isCreditQuestion(fullMessage) && state.lastReason === 'no_balance') {
    await sendReplyToChatwoot(accountId, conversationId, 'Hoy no corresponde reintegro por el neto de ayer. Podés volver mañana y consultar de nuevo.');
    markReplied();
    return;
  }

  if (isCreditQuestion(fullMessage) && state.lastReason === 'balance_limit') {
    await sendReplyToChatwoot(accountId, conversationId, 'Para que se acredite, tu saldo al momento de pedirlo debe ser menor a $1000. Si es mayor, no se acredita.');
    markReplied();
    return;
  }

  if (isConfusedMessage(fullMessage) && state.lastReason) {
    let explain = 'Te explico: el reintegro se calcula por el día de ayer.';
    if (state.lastReason === 'balance_limit') {
      explain = 'Para que se acredite el reintegro, tu saldo al momento de pedirlo debe ser menor a $1000. Si es mayor, no se acredita.';
    } else if (state.lastReason === 'no_balance') {
      explain = 'Ayer no hubo cargas/retiros o el neto no alcanzó. Podés volver mañana y consultar de nuevo.';
    } else if (state.lastReason === 'claimed') {
      explain = 'Ya lo reclamaste hoy. Mañana podés volver a pedirlo.';
    } else if (state.lastReason === 'user_not_found') {
      explain = 'Ese usuario no figura. Revisalo con tu WhatsApp principal y pasamelo bien.';
    }
    await sendReplyToChatwoot(accountId, conversationId, explain);
    markReplied();
    return;
  }

  if (isNameQuestion(fullMessage)) {
    await sendReplyToChatwoot(accountId, conversationId, 'Mi nombre es Camila, ¿en qué puedo ayudarte hoy?');
    markReplied();
    return;
  }

  if (isExplanationQuestion(fullMessage) && state.lastReason) {
    let explain = 'Te explico: el reintegro se calcula por el día de ayer.';
    if (state.lastReason === 'balance_limit') {
      explain = 'Para que se acredite el reintegro, tu saldo al momento de pedirlo debe ser menor a $1000. Si es mayor, no se acredita.';
    } else if (state.lastReason === 'no_balance') {
      explain = 'Ayer no hubo cargas/retiros o el neto no alcanzó. Podés volver mañana y consultar de nuevo.';
    } else if (state.lastReason === 'claimed') {
      explain = 'Ya lo reclamaste hoy. Mañana podés volver a pedirlo.';
    } else if (state.lastReason === 'user_not_found') {
      explain = 'Ese usuario no figura. Revisalo con tu WhatsApp principal y pasamelo bien.';
    }
    await sendReplyToChatwoot(accountId, conversationId, explain);
    markReplied();
    return;
  }

  if (isForgotUsernameMessage(fullMessage)) {
    await sendReplyToChatwoot(accountId, conversationId, 'Si no recordás tu usuario, escribile a tu agente en el WhatsApp principal para que te lo confirme.');
    markReplied();
    return;
  }

  let activeUsername = state.username;
  if (!activeUsername && isValidUsername(contactName)) {
    activeUsername = normalizeUsernameValue(contactName);
    state.username = activeUsername;
    userStates.set(conversationId, state);
  }

  const usernameToCheck = activeUsername || usernameFromMsg;

  if (state.pendingIntent && usernameToCheck) {
    if (state.pendingIntent === 'balance') {
      const userInfo = await getUserInfoByName(usernameToCheck);
      if (!userInfo) {
        state.lastReason = 'user_not_found';
        state.username = null;
        await sendReplyToChatwoot(accountId, conversationId, 'No encuentro ese usuario. Revisalo con tu WhatsApp principal y pasamelo bien.');
        markReplied();
        return;
      }
      await sendReplyToChatwoot(accountId, conversationId, `Tu saldo actual es $${Number(userInfo.balance).toFixed(2)}.`);
      state.pendingIntent = null;
      markReplied();
      return;
    }

    if (state.pendingIntent === 'transfers' || state.pendingIntent === 'neto') {
      const result = await getUserNetYesterday(usernameToCheck);
      if (!result.success) {
        state.lastReason = 'api_error';
        await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
        markReplied();
        return;
      }
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        `Ayer tuviste cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}. Neto $${result.net.toFixed(2)}.`
      );
      state.pendingIntent = null;
      markReplied();
      return;
    }
  }

  if (isBalanceQuestion(fullMessage)) {
    if (!usernameToCheck) {
      state.pendingIntent = 'balance';
      await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo el saldo.');
      markReplied();
      return;
    }

    const userInfo = await getUserInfoByName(usernameToCheck);
    if (!userInfo) {
      state.lastReason = 'user_not_found';
      state.username = null;
      await sendReplyToChatwoot(accountId, conversationId, 'No encuentro ese usuario. Revisalo con tu WhatsApp principal y pasamelo bien.');
      markReplied();
      return;
    }

    await sendReplyToChatwoot(accountId, conversationId, `Tu saldo actual es $${Number(userInfo.balance).toFixed(2)}.`);
    markReplied();
    return;
  }

  if (isYesterdayTransfersQuestion(fullMessage)) {
    if (!usernameToCheck) {
      state.pendingIntent = 'transfers';
      await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo las cargas/retiros de ayer.');
      markReplied();
      return;
    }

    const result = await getUserNetYesterday(usernameToCheck);
    if (!result.success) {
      state.lastReason = 'api_error';
      await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
      markReplied();
      return;
    }

    await sendReplyToChatwoot(
      accountId,
      conversationId,
      `Ayer tuviste cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}. Neto $${result.net.toFixed(2)}.`
    );
    markReplied();
    return;
  }

  if (state.claimed && activeUsername) {
    const reply = await generateAfterCare(fullMessage, activeUsername, conversationId);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    markReplied();
    return;
  }

  if (usernameToCheck) {
    console.log(`⚡ Usuario detectado: ${usernameToCheck}`);

    const claimedCheck = await checkClaimedToday(usernameToCheck);

    // 2) Saldo actual
    const userInfo = await getUserInfoByName(usernameToCheck);
    if (!userInfo) {
      const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      state.lastReason = 'user_not_found';
      state.username = null;
      userStates.set(conversationId, state);
      markReplied();
      return;
    }

    if (userInfo.balance >= 1000) {
      await sendReplyToChatwoot(accountId, conversationId, 'Tu saldo actual supera $1000, por eso no aplica el reintegro automático.');
      state.lastReason = 'balance_limit';
      userStates.set(conversationId, state);
      markReplied();
      return;
    }

    // 3) Neto de ayer
    const result = await getUserNetYesterday(usernameToCheck);
    if (result.success) {
      const net = result.net;

      if (claimedCheck.success && claimedCheck.claimed && net > 1) {
        const expectedBonus = Number((net * 0.08).toFixed(2));
        if (claimedCheck.totalBonus >= expectedBonus - 0.01) {
          const reply = await generateCheckResult(usernameToCheck, 'claimed', {}, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.claimed = true;
          state.username = usernameToCheck;
          state.lastReason = 'claimed';
          userStates.set(conversationId, state);
          markReplied();
          return;
        }
      }

      if (net > 1) {
        const bonus = Number((net * 0.08).toFixed(2));
        const apiResult = await creditUserBalance(usernameToCheck, bonus);
        if (apiResult.success) {
          await appendBonusToSheet(usernameToCheck, bonus);
          const reply = await generateCheckResult(usernameToCheck, 'success', { bonus }, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          await updateChatwootContact(accountId, contactId, usernameToCheck);
          state.claimed = true;
          state.username = usernameToCheck;
          state.lastReason = 'success';
          userStates.set(conversationId, state);
          markReplied();
        } else {
          const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.lastReason = 'api_error';
          userStates.set(conversationId, state);
          markReplied();
        }
      } else {
        const reply = await generateCheckResult(usernameToCheck, 'no_balance', { net }, conversationId);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        state.claimed = false;
        state.username = usernameToCheck;
        state.lastReason = 'no_balance';
        userStates.set(conversationId, state);
        markReplied();
      }
    } else {
      const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      state.lastReason = 'api_error';
      userStates.set(conversationId, state);
      markReplied();
    }
    return;
  }

  const reply = await generateCasualChat(fullMessage, conversationId, { greeted: state.greeted, lastReason: state.lastReason });
  await sendReplyToChatwoot(accountId, conversationId, reply);
  markReplied();
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
      await processConversation(accountId, conversationId, contactId, contactName, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot (Token Fresco) Activo en puerto ${PORT}`));
