require('dotenv').config();
const express = require('express');
const axios = require('axios');
const axiosRetry = require('axios-retry');
const pino = require('pino');
const { cleanEnv, str, num } = require('envalid');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { OpenAIApi, Configuration } = require('openai');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { createClient } = require('redis');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['*.token', '*.password', '*.Authorization', '*.api_access_token'],
    remove: true,
  },
});

const env = cleanEnv(process.env, {
  PORT: num({ default: 3000 }),
  OPENAI_API_KEY: str({ default: '' }),
  CHATWOOT_ACCESS_TOKEN: str({ default: '' }),
  CHATWOOT_BASE_URL: str({ default: 'https://app.chatwoot.com' }),
  PLATFORM_CURRENCY: str({ default: 'ARS' }),
  GOOGLE_CREDENTIALS_JSON: str({ default: '' }),
  PLATFORM_USER: str({ default: '' }),
  PLATFORM_PASS: str({ default: '' }),
  FIXED_API_TOKEN: str({ default: '' }),
  TOKEN_TTL_MINUTES: num({ default: 20 }),
  PROXY_URL: str({ default: '' }),
  REDIS_URL: str({ default: '' }),
  REDIS_PREFIX: str({ default: 'reintegros' }),
  MESSAGE_BUFFER_MAX: num({ default: 20 }),
  MESSAGE_QUEUE_MAX: num({ default: 10 }),
});

const app = express();
const PORT = env.PORT;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== CONFIGURACIÓN ==================
const OPENAI_API_KEY = env.OPENAI_API_KEY || '';
const CHATWOOT_ACCESS_TOKEN = env.CHATWOOT_ACCESS_TOKEN || '';
const CHATWOOT_BASE_URL = env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';

const API_URL = 'https://admin.agentesadmin.bet/api/admin/';
const PLATFORM_CURRENCY = env.PLATFORM_CURRENCY || 'ARS';

const GOOGLE_CREDENTIALS_JSON = env.GOOGLE_CREDENTIALS_JSON || '';
const SHEET_ID = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
const SHEET_NAME = 'Sheet1';

const PLATFORM_URL = 'www.jugaygana.bet';

// Credenciales para login automático
const PLATFORM_USER = env.PLATFORM_USER || '';
const PLATFORM_PASS = env.PLATFORM_PASS || '';

// Fallback opcional (solo si no hay user/pass)
const FIXED_API_TOKEN = env.FIXED_API_TOKEN || '';

// TTL de token en minutos
const TOKEN_TTL_MINUTES = env.TOKEN_TTL_MINUTES || 20;

// Proxy
const PROXY_URL = env.PROXY_URL || '';

const REPEAT_REASON_WINDOW_MS = 2 * 60 * 1000;
const REPEAT_REASON_TYPES = new Set([
  'no_balance',
  'negative_net',
  'no_deposits',
  'balance_limit',
  'claimed',
  'user_not_found',
]);

const MESSAGE_BUFFER_DELAY_MS = 5000;
const MESSAGE_BUFFER_MAX = env.MESSAGE_BUFFER_MAX || 20;
const MESSAGE_QUEUE_MAX = env.MESSAGE_QUEUE_MAX || 10;

if (!PLATFORM_USER || !PLATFORM_PASS) {
  logger.warn('⚠️ PLATFORM_USER / PLATFORM_PASS no definidos. Se usará FIXED_API_TOKEN si existe.');
}

const openai = OPENAI_API_KEY ? new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY })) : null;

let GOOGLE_CREDENTIALS = null;
if (GOOGLE_CREDENTIALS_JSON) {
  try {
    GOOGLE_CREDENTIALS = JSON.parse(GOOGLE_CREDENTIALS_JSON);
    if (GOOGLE_CREDENTIALS.private_key) {
      GOOGLE_CREDENTIALS.private_key = GOOGLE_CREDENTIALS.private_key.replace(/\\n/g, '\n');
    }
    logger.info({ email: GOOGLE_CREDENTIALS.client_email }, '✅ Google credentials cargadas');
  } catch (err) {
    logger.error({ err }, '❌ Error Credentials JSON');
  }
} else {
  logger.error('❌ GOOGLE_CREDENTIALS_JSON no está definido.');
}

const auth = GOOGLE_CREDENTIALS
  ? new GoogleAuth({
      credentials: GOOGLE_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    })
  : null;

let googleAuthClient = null;

// ================== REDIS (PERSISTENCIA) ==================
const REDIS_URL = env.REDIS_URL || '';
const REDIS_PREFIX = env.REDIS_PREFIX || 'reintegros';
const USER_STATE_TTL_SEC = 24 * 60 * 60;

let redisClient = null;
let redisReady = false;

if (REDIS_URL) {
  redisClient = createClient({ url: REDIS_URL });
  redisClient.on('ready', () => {
    redisReady = true;
    logger.info('✅ Redis conectado');
  });
  redisClient.on('end', () => {
    redisReady = false;
    logger.warn('⚠️ Redis desconectado, fallback a memoria');
  });
  redisClient.on('error', (err) => {
    redisReady = false;
    logger.error({ err }, '❌ Error Redis');
  });
  redisClient
    .connect()
    .then(() => {
      // listo
    })
    .catch((err) => {
      redisReady = false;
      logger.error({ err }, '❌ No se pudo conectar Redis, fallback a memoria');
    });
}

const userStatesCache = new Map();

function getUserStateKey(conversationId) {
  return `${REDIS_PREFIX}:userState:${conversationId}`;
}

async function getUserState(conversationId) {
  if (userStatesCache.has(conversationId)) return userStatesCache.get(conversationId);
  if (redisClient && redisReady) {
    try {
      const raw = await redisClient.get(getUserStateKey(conversationId));
      if (raw) {
        const parsed = JSON.parse(raw);
        userStatesCache.set(conversationId, parsed);
        return parsed;
      }
    } catch (err) {
      logger.error({ err }, '❌ Error leyendo estado desde Redis');
    }
  }
  return null;
}

async function setUserState(conversationId, state) {
  userStatesCache.set(conversationId, state);
  if (redisClient && redisReady) {
    try {
      await redisClient.set(getUserStateKey(conversationId), JSON.stringify(state), {
        EX: USER_STATE_TTL_SEC,
      });
    } catch (err) {
      logger.error({ err }, '❌ Error guardando estado en Redis');
    }
  }
}

async function deleteUserState(conversationId) {
  userStatesCache.delete(conversationId);
  if (redisClient && redisReady) {
    try {
      await redisClient.del(getUserStateKey(conversationId));
    } catch (err) {
      logger.error({ err }, '❌ Error borrando estado en Redis');
    }
  }
}

const messageBuffer = new Map();

// Limpieza memoria (cache local)
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of userStatesCache.entries()) {
    if (now - state.lastActivity > 24 * 60 * 60 * 1000) userStatesCache.delete(id);
  }
}, 60 * 60 * 1000);

// ================== MÉTRICAS ==================
const metrics = {
  messagesProcessed: 0,
  errors: 0,
  totalProcessingMs: 0,
  droppedBufferMessages: 0,
  droppedQueueItems: 0,
};

// ================== CLIENTE HTTP ==================

function toFormUrlEncoded(data) {
  return Object.keys(data)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(data[key])}`)
    .join('&');
}

let httpsAgent = null;
if (PROXY_URL) {
  logger.info('🌐 Usando Proxy configurado.');
  httpsAgent = new HttpsProxyAgent(PROXY_URL);
}

async function logProxyIP() {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', {
      httpsAgent,
      timeout: 10000,
    });
    logger.info({ ip: res.data }, '🌍 IP pública (via proxy)');
  } catch (err) {
    logger.error({ err }, '❌ Error obteniendo IP pública (proxy)');
  }
}

if (httpsAgent) logProxyIP();

function logBlockedHtml(context, html) {
  logger.error({ context, html }, '❌ [API] RESPUESTA HTML (BLOQUEO DE IP)');
}

function sanitizeLogText(text) {
  if (!text) return '';
  return String(text).replace(/\s+/g, ' ').slice(0, 500);
}

const client = axios.create({
  baseURL: API_URL,
  timeout: 20000,
  httpsAgent: httpsAgent,
  proxy: false,
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://admin.agentesadmin.bet',
    Referer: 'https://admin.agentesadmin.bet/users',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'Accept-Language': 'es-419,es;q=0.9',
  },
});

axiosRetry(client, {
  retries: 3,
  retryDelay: (retryCount) => Math.min(1000 * 2 ** retryCount + Math.random() * 250, 8000),
  retryCondition: (error) => axiosRetry.isNetworkOrIdempotentRequestError(error) || error.code === 'ETIMEDOUT',
});

// ================== SESIÓN (TOKEN FRESCO) ==================
let SESSION_TOKEN = null;
let SESSION_COOKIE = null;
let SESSION_PARENT_ID = null;
let SESSION_LAST_LOGIN = 0;

async function loginAndGetToken() {
  if (!PLATFORM_USER || !PLATFORM_PASS) {
    logger.error('❌ Falta PLATFORM_USER/PLATFORM_PASS.');
    return false;
  }

  logger.info('🔐 Iniciando login automático...');
  try {
    const loginRes = await client.post(
      '',
      toFormUrlEncoded({
        action: 'LOGIN',
        username: PLATFORM_USER,
        password: PLATFORM_PASS,
      }),
      {
        validateStatus: (status) => status >= 200 && status < 500,
        maxRedirects: 0,
      }
    );

    if (loginRes.headers['set-cookie']) {
      SESSION_COOKIE = loginRes.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
    }

    let loginData = loginRes.data;
    if (typeof loginData === 'string') {
      try {
        loginData = JSON.parse(loginData.substring(loginData.indexOf('{'), loginData.lastIndexOf('}') + 1));
      } catch (e) {}
    }

    if (!loginData?.token) {
      logger.error('❌ Login falló: no se recibió token.');
      return false;
    }

    SESSION_TOKEN = loginData.token;
    SESSION_PARENT_ID = loginData.user ? loginData.user.user_id : null;
    SESSION_LAST_LOGIN = Date.now();

    logger.info('✅ Login OK (token fresco).');
    if (SESSION_PARENT_ID) logger.info({ adminId: SESSION_PARENT_ID }, '✅ Admin ID');

    return true;
  } catch (err) {
    logger.error({ err }, '❌ Error en login');
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

  logger.error('❌ No hay credenciales ni token fijo.');
  return false;
}

// ================== FECHAS ARGENTINA ==================
const DATE_FMT_AR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const DATE_TIME_FMT_AR = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function getDatePartsArgentina(date = new Date()) {
  const parts = DATE_FMT_AR.formatToParts(date);
  return {
    yyyy: parts.find((p) => p.type === 'year').value,
    mm: parts.find((p) => p.type === 'month').value,
    dd: parts.find((p) => p.type === 'day').value,
  };
}

function getYesterdayRangeArgentinaEpoch() {
  const { yyyy, mm, dd } = getDatePartsArgentina();
  const todayLocal = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const yesterdayLocal = new Date(todayLocal.getTime() - 24 * 60 * 60 * 1000);
  const yparts = getDatePartsArgentina(yesterdayLocal);

  const from = new Date(`${yparts.yyyy}-${yparts.mm}-${yparts.dd}T00:00:00-03:00`);
  const to = new Date(`${yparts.yyyy}-${yparts.mm}-${yparts.dd}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
  };
}

function getTodayRangeArgentinaEpoch() {
  const { yyyy, mm, dd } = getDatePartsArgentina();
  const from = new Date(`${yyyy}-${mm}-${dd}T00:00:00-03:00`);
  const to = new Date(`${yyyy}-${mm}-${dd}T23:59:59-03:00`);

  return {
    fromEpoch: Math.floor(from.getTime() / 1000),
    toEpoch: Math.floor(to.getTime() / 1000),
  };
}

function getArgentinaDateTime() {
  return DATE_TIME_FMT_AR.format(new Date());
}

function getArgentinaDateString() {
  return DATE_FMT_AR.format(new Date());
}

// ================== RETRY HELPERS ==================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, { retries = 3, baseDelayMs = 400, maxDelayMs = 4000 } = {}) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries) throw err;
      const delay = Math.min(baseDelayMs * 2 ** attempt + Math.random() * 150, maxDelayMs);
      await sleep(delay);
      attempt += 1;
    }
  }
}

// ================== GOOGLE SHEETS ==================
async function getGoogleAuthClient() {
  if (!auth) throw new Error('GoogleAuth no inicializado');
  if (googleAuthClient) return googleAuthClient;
  googleAuthClient = await auth.getClient();
  return googleAuthClient;
}

async function appendBonusToSheet(username, amount) {
  try {
    const authClient = await getGoogleAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const row = ['bonus', username, amount, getArgentinaDateTime()];

    await withRetry(
      async () =>
        sheets.spreadsheets.values.append({
          spreadsheetId: SHEET_ID,
          range: `${SHEET_NAME}!A:D`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: { values: [row] },
        }),
      { retries: 3, baseDelayMs: 500 }
    );

    logger.info('✅ Bonus registrado en Google Sheets');
  } catch (err) {
    logger.error({ err }, '❌ Error guardando en Sheets');
  }
}

// ================== UTILIDADES ==================
function parseBalance(rawValue) {
  if (rawValue === null || rawValue === undefined) return 0;
  const numeric = Number(rawValue);
  if (Number.isNaN(numeric)) return 0;
  const hasDecimals = String(rawValue).includes('.') || String(rawValue).includes(',');
  if (hasDecimals) return numeric;
  if (Number.isInteger(numeric) && numeric >= 100) return numeric / 100;
  return numeric;
}

function calculateNetAndBonus(totalDepositsCents, totalWithdrawsCents) {
  const netCents = Number(totalDepositsCents || 0) - Number(totalWithdrawsCents || 0);
  const totalDeposits = Number(totalDepositsCents || 0) / 100;
  const totalWithdraws = Number(totalWithdrawsCents || 0) / 100;
  const net = netCents / 100;
  const bonus = Number((net * 0.08).toFixed(2));
  return {
    totalDeposits,
    totalWithdraws,
    net: Number(net.toFixed(2)),
    bonus,
  };
}

function cleanHtml(html) {
  if (!html) return '';
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

const TEAM_USER_PATTERN = /\b(big|arg|cir|mar|lux|zyr|met|tri|ign|roy|tig)[a-z._-]*\d{3,}\b/i;

function normalizeUsernameValue(text) {
  return (text || '')
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

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
  const explicit = /(?:usuario|user)(?:es)?\s*:?\s*@?([a-z0-9._-]+)/i.exec(normalized);
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

// ================== DETECCIÓN DE INTENCIONES ==================
const QUESTION_RULES = {
  name: [/tu nombre/i, /como te llamas/i, /cómo te llamas/i, /quien sos/i, /quién sos/i],
  balance: [/saldo/i, /cuanto tengo/i, /cuánto tengo/i, /cuanto saldo/i, /cuánto saldo/i],
  neto: [/neto/i, /que es/i, /qué es/i, /que seria/i, /qué sería/i, /explica/i],
  netoAmount: [/cuanto es el neto/i, /cuánto es el neto/i, /cuanto neto/i, /cuánto neto/i],
  explanation: [/por que/i, /por qué/i, /porque/i, /como seria/i, /cómo sería/i, /explica/i, /explicame/i],
  reintegro: [/reintegro/i, /reembolso/i],
  credit: [/me lo cargan/i, /me lo acreditan/i, /me lo cargás/i, /me lo acreditás/i, /me lo dan/i],
  whereRefund: [/donde veo/i, /dónde veo/i, /donde aparece/i, /dónde aparece/i, /a donde va/i, /a dónde va/i],
  howProceed: [/como sigo/i, /cómo sigo/i, /como hago/i, /cómo hago/i, /como procedo/i, /cómo procedo/i],
  help: [/ayuda/i, /necesito ayuda/i, /no se que hacer/i, /no sé que hacer/i],
  comoSeCalcula: [/como se calcula/i, /cómo se calcula/i, /calculo del reintegro/i, /calculo de reintegro/i],
  horario: [/horario/i, /hasta que hora/i, /hasta qué hora/i, /a que hora/i, /a qué hora/i],
  requisitos: [/requisitos/i, /condiciones/i, /que necesito/i, /qué necesito/i],
  link: [/link/i, /pagina/i, /página/i, /url/i, /web/i],
  porcentaje: [/porcentaje/i, /8%/i, /ocho por ciento/i],
  comoReclamar: [/como reclamo/i, /cómo reclamo/i, /como pedir/i, /cómo pedir/i, /reclamar reintegro/i],
  todayDeposit: [/cargue hoy/i, /cargué hoy/i, /deposite hoy/i, /deposité hoy/i],
  ganamos: [/ganamos/i],
  weeklyRefund: [/reembolso semanal/i, /bono semanal/i, /reintegro semanal/i, /lunes/i, /martes/i],
  pastLoad: [/cargue ayer/i, /cargué ayer/i, /cargue antes/i, /cargué antes/i, /dias anteriores/i, /días anteriores/i],
  withdraw: [/retiro/i, /retirar/i, /sacar/i, /extraer/i, /cobrar/i, /cobro/i],
  usernameConfirm: [/ese es mi usuario/i, /ese es mi user/i, /ese es mi usuario correcto/i, /ese es mi usuario\./i],
  wrongUsername: [
    /no es mi usuario/i,
    /ese no es mi usuario/i,
    /me equivoque/i,
    /me equivoqué/i,
    /usuario incorrecto/i,
    /usuario mal/i,
    /no es mi user/i,
    /me confundi/i,
    /me confundí/i,
    /error mio/i,
    /error mío/i,
    /lo escribi mal/i,
    /lo escribí mal/i,
  ],
};

function matchesRule(message, rules) {
  const m = (message || '').toLowerCase();
  return rules.some((r) => r.test(m));
}

function isNameQuestion(message) {
  return matchesRule(message, QUESTION_RULES.name);
}
function isBalanceQuestion(message) {
  return matchesRule(message, QUESTION_RULES.balance);
}
function isYesterdayTransfersQuestion(message) {
  const m = (message || '').toLowerCase();
  const asksTransfers = m.includes('carga') || m.includes('deposit') || m.includes('retiro') || m.includes('movim');
  return m.includes('ayer') && asksTransfers;
}
function isNetoQuestion(message) {
  return matchesRule(message, QUESTION_RULES.neto);
}
function isNetoAmountQuestion(message) {
  return matchesRule(message, QUESTION_RULES.netoAmount);
}
function isExplanationQuestion(message) {
  return matchesRule(message, QUESTION_RULES.explanation);
}
function isConfusedMessage(message) {
  const m = (message || '').trim().toLowerCase();
  if (!m) return false;
  if (m.length <= 4 && /[\?\!]/.test(m)) return true;
  return m.includes('no entiendo') || m.includes('??') || m.includes('???');
}
function isReintegroQuestion(message) {
  return matchesRule(message, QUESTION_RULES.reintegro);
}
function isCreditQuestion(message) {
  return matchesRule(message, QUESTION_RULES.credit);
}
function isWhereRefundQuestion(message) {
  return matchesRule(message, QUESTION_RULES.whereRefund);
}
function isHowProceedQuestion(message) {
  return matchesRule(message, QUESTION_RULES.howProceed);
}
function isHelpQuestion(message) {
  return matchesRule(message, QUESTION_RULES.help);
}
function isComoSeCalculaQuestion(message) {
  return matchesRule(message, QUESTION_RULES.comoSeCalcula);
}
function isHorarioQuestion(message) {
  return matchesRule(message, QUESTION_RULES.horario);
}
function isRequisitosQuestion(message) {
  return matchesRule(message, QUESTION_RULES.requisitos);
}
function isLinkQuestion(message) {
  return matchesRule(message, QUESTION_RULES.link);
}
function isPorcentajeQuestion(message) {
  return matchesRule(message, QUESTION_RULES.porcentaje);
}
function isComoReclamarQuestion(message) {
  return matchesRule(message, QUESTION_RULES.comoReclamar);
}
function isTodayDepositQuestion(message) {
  return matchesRule(message, QUESTION_RULES.todayDeposit);
}
function isGanamosQuestion(message) {
  return matchesRule(message, QUESTION_RULES.ganamos);
}
function isWeeklyRefundQuestion(message) {
  return matchesRule(message, QUESTION_RULES.weeklyRefund);
}
function isPastLoadQuestion(message) {
  return matchesRule(message, QUESTION_RULES.pastLoad);
}
function isWithdrawQuestion(message) {
  return matchesRule(message, QUESTION_RULES.withdraw);
}
function isUsernameConfirmMessage(message) {
  return matchesRule(message, QUESTION_RULES.usernameConfirm);
}
function isWrongUsernameMessage(message) {
  return matchesRule(message, QUESTION_RULES.wrongUsername);
}

// ================== IA ==================
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

async function generateCasualChat(message, conversationId, context = {}) {
  try {
    await applyTypingDelay(message, conversationId);
    const greeted = context.greeted ? 'si' : 'no';
    const lastReason = context.lastReason || 'none';

    if (!openai) throw new Error('OpenAI no configurado');

    const resp = await openai.createChatCompletion(
      {
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: `Sos Camila, agente real de jugaygana (Argentina), atención 24 hs. Nunca digas que sos IA ni bot. Respuestas breves, humanas, con algun error de tipeo leve y natural. Si greeted=si, NO saludes ni te presentes de nuevo. Si el cliente pide explicación, respondé con el motivo usando last_reason (balance_limit, no_balance, claimed, user_not_found). Si falta el usuario para acreditar, pedilo. Si no recuerda su usuario, indicá que consulte al WhatsApp principal de su equipo. Reintegro: siempre por el día de ayer (00:00-23:59 AR). Cálculo: neto = depósitos - retiros, y el reintegro es 8% del neto si el neto es mayor a $1. Si el saldo actual supera $1000, no se acredita reintegro (debe tener menos de $1000). Solo trabajamos con ${PLATFORM_URL}. Si no podés ayudar, pedí que consulten al WhatsApp principal. Link: ${PLATFORM_URL}. Contexto: greeted=${greeted}, last_reason=${lastReason}.`,
          },
          { role: 'user', content: message },
        ],
      },
      { timeout: 12000 }
    );
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(message, conversationId);
    return 'Hola! soy Cami, pasame tu usuario y te reviso el reintegro.';
  }
}

async function generateCheckResult(username, status, data = {}, conversationId) {
  if (status === 'success') {
    const bonusText = Number(data.bonus || 0).toFixed(2);
    const successMessage = `¡Hola ${username}! Tu reembolso del día de ayer te lo acabamos de cargar en tu cuenta, tu reembolso es de $${bonusText}! Ya lo podés ver en la plataforma ${PLATFORM_URL}! Cualquier cosa, estoy por acá. ¡Suerte!`;
    await applyTypingDelay(successMessage, conversationId);
    return successMessage;
  }

  if (status === 'negative_net') {
    const msg = `${username}, hoy no corresponde reintegro porque ayer retiraste más de lo que depositaste, así que el total quedó negativo. Podés volver mañana y consultar de nuevo. Si tenés alguna duda, estoy acá para ayudarte. ¡Saludos!`;
    await applyTypingDelay(msg, conversationId);
    return msg;
  }

  if (status === 'no_deposits') {
    const msg = `${username}, hoy no corresponde reintegro porque no hubo ninguna carga el día de ayer, y el reembolso es específicamente sobre el día de ayer. Podés volver mañana y consultar de nuevo. Si tenés alguna duda, estoy acá para ayudarte. ¡Saludos!`;
    await applyTypingDelay(msg, conversationId);
    return msg;
  }

  let systemPrompt = `Sos Camila, agente real de jugaygana. Usuario: "${username}". Respuesta breve, humana, con algun error de tipeo leve. Nunca digas que sos IA ni bot. Link: ${PLATFORM_URL}.`;
  if (status === 'api_error')
    systemPrompt +=
      ' No pude encontrar el usuario o hubo un error al consultarlo. Pedí que corrobore su usuario con el WhatsApp principal y que lo envíe bien para acreditar el reintegro.';
  else if (status === 'no_balance')
    systemPrompt += ' Hoy no corresponde reintegro porque ayer no hubo cargas/retiros o el neto no alcanzó. Podés volver mañana y consultar de nuevo.';
  else if (status === 'claimed') systemPrompt += ' Ya fue reclamado hoy.';

  const delaySeed = `${status} ${data?.bonus || ''}`;

  try {
    await applyTypingDelay(delaySeed, conversationId);
    if (!openai) throw new Error('OpenAI no configurado');
    const resp = await openai.createChatCompletion(
      {
        model: 'gpt-4o-mini',
        temperature: 0.4,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: 'Generá respuesta.' },
        ],
      },
      { timeout: 12000 }
    );
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(delaySeed, conversationId);
    return 'No se pudo procesar, probá más tarde.';
  }
}

async function generateAfterCare(message, username, conversationId) {
  try {
    await applyTypingDelay(message, conversationId);
    if (!openai) throw new Error('OpenAI no configurado');
    const resp = await openai.createChatCompletion(
      {
        model: 'gpt-4o-mini',
        temperature: 0.5,
        messages: [
          {
            role: 'system',
            content: `Sos Camila, agente real. El cliente "${username}" ya cobró hoy. Respuesta corta, humana y con algun typo leve. Nunca digas que sos IA ni bot.`,
          },
          { role: 'user', content: message },
        ],
      },
      { timeout: 12000 }
    );
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    await applyTypingDelay(message, conversationId);
    return 'El reintegro ya quedó hoy. Mañana podés volver a pedirlo.';
  }
}

// ================== USUARIO ==================
async function getUserInfoByName(targetUsername) {
  logger.info({ user: sanitizeLogText(targetUsername) }, '🔎 [API] Buscando usuario');

  const ok = await ensureSession();
  if (!ok) return null;

  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const body = toFormUrlEncoded({
        action: 'ShowUsers',
        token: SESSION_TOKEN,
        page: 1,
        pagesize: 50,
        viewtype: 'tree',
        username: targetUsername,
        showhidden: 'false',
        parentid: SESSION_PARENT_ID || undefined,
      });

      const headers2 = {};
      if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

      const resp = await client.post('', body, {
        headers: headers2,
        validateStatus: () => true,
        maxRedirects: 0,
      });

      let data = resp.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
        } catch (e) {}
      }

      if (typeof data === 'string' && data.trim().startsWith('<')) {
        logBlockedHtml('ShowUsers', data);
        if (attempt < maxAttempts) {
          await sleep(400);
          continue;
        }
        return null;
      }

      const list = data.users || data.data || (Array.isArray(data) ? data : []);
      const found = list.find(
        (u) => String(u.user_name).toLowerCase().trim() === String(targetUsername).toLowerCase().trim()
      );

      if (found && found.user_id) {
        const balanceRaw =
          found.user_balance ?? found.balance ?? found.balance_amount ?? found.available_balance ?? 0;
        const balancePesos = parseBalance(balanceRaw);

        logger.info({ id: found.user_id, balance: balancePesos }, '✅ [API] ID encontrado');
        return { id: found.user_id, balance: balancePesos };
      }

      if (attempt < maxAttempts) {
        await sleep(400);
        continue;
      }

      logger.error({ count: list.length }, '❌ [API] Usuario no encontrado');
      return null;
    } catch (err) {
      if (attempt < maxAttempts) {
        await sleep(400);
        continue;
      }
      logger.error({ err }, '❌ [API] Error Búsqueda');
      return null;
    }
  }

  return null;
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
      childid: SESSION_PARENT_ID,
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
      } catch (e) {}
    }

    if (typeof data === 'string' && data.trim().startsWith('<')) {
      logBlockedHtml('ShowUserTransfersByAgent', data);
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    const totals = calculateNetAndBonus(data?.total_deposits || 0, data?.total_withdraws || 0);

    logger.info(
      { user: sanitizeLogText(username), deposits: totals.totalDeposits, withdraws: totals.totalWithdraws, net: totals.net },
      '📊 Totales'
    );

    return {
      success: true,
      net: totals.net,
      totalDeposits: totals.totalDeposits,
      totalWithdraws: totals.totalWithdraws,
      fromEpoch,
      toEpoch,
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
      childid: SESSION_PARENT_ID,
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
      } catch (e) {}
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
  logger.info({ user: sanitizeLogText(username), amount }, '💰 [API] Cargando');

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
      deposit_type: 'individual_bonus',
    });

    const headers2 = {};
    if (SESSION_COOKIE) headers2['Cookie'] = SESSION_COOKIE;

    const resp = await client.post('', body, { headers: headers2 });

    let data = resp.data;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1));
      } catch (e) {}
    }

    if (typeof data === 'string' && data.trim().startsWith('<')) {
      logBlockedHtml('DepositMoney', data);
      return { success: false, error: 'IP Bloqueada (HTML)' };
    }

    logger.info({ data }, '📩 [API] Resultado');

    if (data && data.success) {
      return { success: true };
    }
    return { success: false, error: data.error || 'API Error' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ================== CHATWOOT ==================
async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;
  try {
    const todayStr = getArgentinaDateString();
    const state = await getUserState(conversationId);
    let finalMessage = message;

    if (state?.greetedDate === todayStr) {
      const stripped = finalMessage.replace(/^hola[\s,!]+/i, '').trim();
      if (stripped.length > 0) finalMessage = stripped;
    }

    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(
      url,
      {
        content: finalMessage,
        message_type: 'outgoing',
        private: false,
      },
      { headers: { api_access_token: CHATWOOT_ACCESS_TOKEN } }
    );
    logger.info('✅ Respuesta enviada.');
  } catch (err) {
    logger.error({ err }, '❌ Error Chatwoot');
  }
}

async function updateChatwootContact(accountId, contactId, username) {
  if (!CHATWOOT_ACCESS_TOKEN || !contactId) return;
  try {
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    await axios.put(url, { name: username }, { headers: { api_access_token: CHATWOOT_ACCESS_TOKEN } });
  } catch (err) {
    logger.error({ err }, '❌ Error Rename');
  }
}

// ================== CONCURRENCIA / COLAS ==================
const conversationQueues = new Map();
const conversationQueueStats = new Map();

async function enqueueConversation(conversationId, handler) {
  const stat = conversationQueueStats.get(conversationId) || { pending: 0 };
  if (stat.pending >= MESSAGE_QUEUE_MAX) {
    metrics.droppedQueueItems += 1;
    logger.warn({ conversationId }, '⚠️ Cola por conversación llena, descartando tarea');
    return;
  }
  stat.pending += 1;
  conversationQueueStats.set(conversationId, stat);

  const prev = conversationQueues.get(conversationId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(handler)
    .finally(() => {
      stat.pending -= 1;
      if (stat.pending <= 0) {
        conversationQueueStats.delete(conversationId);
      }
      if (conversationQueues.get(conversationId) === next) {
        conversationQueues.delete(conversationId);
      }
    });
  conversationQueues.set(conversationId, next);
  return next;
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, contactId, contactName, fullMessage) {
  const start = Date.now();
  try {
    logger.info(
      { conversationId, message: sanitizeLogText(fullMessage), contact: sanitizeLogText(contactName) },
      '🤖 Msg'
    );

    const todayStr = getArgentinaDateString();
    let state =
      (await getUserState(conversationId)) || {
        claimed: false,
        username: null,
        greeted: false,
        greetedDate: null,
        lastReason: null,
        lastReasonNotified: null,
        lastReasonNotifiedAt: 0,
        pendingIntent: null,
        lastActivity: Date.now(),
      };
    state.lastActivity = Date.now();

    if (state.greetedDate !== todayStr) {
      state.greeted = false;
    }

    await setUserState(conversationId, state);

    const markReplied = async () => {
      state.greeted = true;
      state.greetedDate = todayStr;
      await setUserState(conversationId, state);
      firstReplyByConversation.set(conversationId, true);
    };

    const markReasonNotified = async (reason) => {
      state.lastReason = reason;
      state.lastReasonNotified = reason;
      state.lastReasonNotifiedAt = Date.now();
      await setUserState(conversationId, state);
    };

    const usernameFromMsg = extractUsername(fullMessage);
    const hasUsernameInMessage = Boolean(usernameFromMsg);

    if (usernameFromMsg && usernameFromMsg !== state.username) {
      state.username = usernameFromMsg;
      state.lastReason = null;
      state.lastReasonNotified = null;
      state.lastReasonNotifiedAt = 0;
      state.pendingIntent = null;
      state.claimed = false;
      await setUserState(conversationId, state);
    }

    if (!state.greeted && usernameFromMsg) {
      state.greeted = true;
      state.greetedDate = todayStr;
      await setUserState(conversationId, state);
    }

    if (!state.greeted) {
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        '🤖 ¡Hola! Soy tu asistente de reembolsos. 🎮\n\nPara reclamar tu reembolso, ten en cuenta:\n\n1️⃣ Solo pueden reclamar clientes activos que jugaron ayer y tuvieron pérdidas.\n2️⃣ El reembolso es un reintegro por las pérdidas. Si ganaste, no podrás retirar el monto diario. 💸\n\n🔑 Por favor, ingresa tu usuario para verificar si eres elegible para el reembolso. 👇'
      );
      await markReplied();
      return;
    }

    if (
      state.lastReasonNotified &&
      REPEAT_REASON_TYPES.has(state.lastReasonNotified) &&
      state.lastReasonNotifiedAt &&
      Date.now() - state.lastReasonNotifiedAt < REPEAT_REASON_WINDOW_MS &&
      !hasUsernameInMessage &&
      !isExplanationQuestion(fullMessage) &&
      !isConfusedMessage(fullMessage) &&
      !isCreditQuestion(fullMessage) &&
      !isHowProceedQuestion(fullMessage) &&
      !isHelpQuestion(fullMessage) &&
      !isNetoAmountQuestion(fullMessage) &&
      !isBalanceQuestion(fullMessage) &&
      !isYesterdayTransfersQuestion(fullMessage)
    ) {
      return;
    }

    if (isWithdrawQuestion(fullMessage)) {
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        'Los retiros (normales o de reembolso) se gestionan por el WhatsApp principal de tu equipo. Acá solo hacemos cargas de reembolsos.'
      );
      await markReplied();
      return;
    }

    if (isUsernameConfirmMessage(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Perfecto, ya tengo tu usuario. Decime si querés que revise el reembolso.');
      await markReplied();
      return;
    }

    if (isWrongUsernameMessage(fullMessage)) {
      state.username = null;
      state.claimed = false;
      state.lastReason = null;
      state.lastReasonNotified = null;
      state.lastReasonNotifiedAt = 0;
      state.pendingIntent = null;
      await setUserState(conversationId, state);

      const tempName = randomTempName();
      await updateChatwootContact(accountId, contactId, tempName);

      await sendReplyToChatwoot(accountId, conversationId, 'Entiendo, pasame tu usuario correcto y lo reviso.');
      await markReplied();
      return;
    }

    if (!hasUsernameInMessage) {
      if (isGanamosQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          `Los reembolsos diarios son solo en ${PLATFORM_URL}. La plataforma "ganamos" no aplica para reembolsos diarios.`
        );
        await markReplied();
        return;
      }

      if (isWeeklyRefundQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'El reembolso semanal se acredita lunes o martes y es aparte del reembolso diario. El diario se reclama por el día de ayer.'
        );
        await markReplied();
        return;
      }

      if (isPastLoadQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'El reembolso diario solo toma el día de ayer. Cargas de días anteriores no aplican; para próximas cargas, podés reclamar al día siguiente.'
        );
        await markReplied();
        return;
      }

      if (isTodayDepositQuestion(fullMessage)) {
        await sendReplyToChatwoot(accountId, conversationId, 'Si cargaste hoy, lo vas a ver reflejado mañana en cualquier horario.');
        await markReplied();
        return;
      }

      if (isWhereRefundQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          `El reintegro se acredita en tu saldo de ${PLATFORM_URL}. Si corresponde, lo vas a ver en la cuenta apenas se procesa.`
        );
        await markReplied();
        return;
      }

      if (isHowProceedQuestion(fullMessage) || isHelpQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'Decime tu usuario y reviso si corresponde el reintegro de ayer. Si tenés otra duda, también te ayudo.'
        );
        await markReplied();
        return;
      }

      if (isNetoQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'El neto de ayer es la suma de todas las cargas menos la suma de todos los retiros de ayer.'
        );
        await markReplied();
        return;
      }

      if (isLinkQuestion(fullMessage)) {
        await sendReplyToChatwoot(accountId, conversationId, `${PLATFORM_URL}`);
        await markReplied();
        return;
      }

      if (!state.username && isReintegroQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'El reintegro es del 8% del neto de ayer (depósitos menos retiros), si ese neto es mayor a $1.'
        );
        await markReplied();
        return;
      }

      if (!state.username && isComoSeCalculaQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'Se calcula con el neto de ayer: sumás cargas, restás retiros, y si da más de $1 se acredita el 8%.'
        );
        await markReplied();
        return;
      }

      if (!state.username && isPorcentajeQuestion(fullMessage)) {
        await sendReplyToChatwoot(accountId, conversationId, 'El reintegro es del 8% del neto de ayer.');
        await markReplied();
        return;
      }

      if (!state.username && isRequisitosQuestion(fullMessage)) {
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          'Necesito tu usuario. El reintegro es por ayer y se acredita si el neto es mayor a $1 y tu saldo actual es menor a $1000.'
        );
        await markReplied();
        return;
      }

      if (!state.username && isComoReclamarQuestion(fullMessage)) {
        await sendReplyToChatwoot(accountId, conversationId, 'Para reclamar el reintegro solo pasame tu usuario y lo reviso.');
        await markReplied();
        return;
      }

      if (isHorarioQuestion(fullMessage)) {
        await sendReplyToChatwoot(accountId, conversationId, 'El reintegro se reclama de 00:00 a 23:59 y corresponde al día de ayer.');
        await markReplied();
        return;
      }
    }

    if (isNetoAmountQuestion(fullMessage)) {
      const usernameToCheck = state.username || usernameFromMsg;
      if (!usernameToCheck) {
        state.pendingIntent = 'neto';
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo el neto de ayer.');
        await markReplied();
        return;
      }
      const result = await getUserNetYesterday(usernameToCheck);
      if (!result.success) {
        state.lastReason = 'api_error';
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
        await markReplied();
        return;
      }
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        `Tu neto de ayer fue $${result.net.toFixed(2)} (cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}).`
      );
      await markReplied();
      return;
    }

    if (isCreditQuestion(fullMessage) && state.lastReason === 'no_balance') {
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        'Hoy no corresponde reintegro por el neto de ayer. Podés volver mañana y consultar de nuevo.'
      );
      await markReasonNotified('no_balance');
      await markReplied();
      return;
    }

    if (isCreditQuestion(fullMessage) && state.lastReason === 'balance_limit') {
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        'Para que se acredite, tu saldo al momento de pedirlo debe ser menor a $1000. Si es mayor, no se acredita.'
      );
      await markReasonNotified('balance_limit');
      await markReplied();
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
      await markReplied();
      return;
    }

    if (isNameQuestion(fullMessage)) {
      await sendReplyToChatwoot(accountId, conversationId, 'Mi nombre es Camila, ¿en qué puedo ayudarte hoy?');
      await markReplied();
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
      await markReplied();
      return;
    }

    if (isForgotUsernameMessage(fullMessage)) {
      await sendReplyToChatwoot(
        accountId,
        conversationId,
        'Si no recordás tu usuario, escribile a tu agente en el WhatsApp principal para que te lo confirme.'
      );
      await markReplied();
      return;
    }

    let activeUsername = state.username;
    if (!activeUsername && isValidUsername(contactName)) {
      activeUsername = normalizeUsernameValue(contactName);
      state.username = activeUsername;
      await setUserState(conversationId, state);
    }

    const usernameToCheck = activeUsername || usernameFromMsg;

    if (state.pendingIntent && usernameToCheck) {
      if (state.pendingIntent === 'balance') {
        const userInfo = await getUserInfoByName(usernameToCheck);
        if (!userInfo) {
          state.username = null;
          await setUserState(conversationId, state);
          await sendReplyToChatwoot(accountId, conversationId, 'No encuentro ese usuario. Revisalo con tu WhatsApp principal y pasamelo bien.');
          await markReasonNotified('user_not_found');
          await markReplied();
          return;
        }
        await sendReplyToChatwoot(accountId, conversationId, `Tu saldo actual es $${Number(userInfo.balance).toFixed(2)}.`);
        state.pendingIntent = null;
        await setUserState(conversationId, state);
        await markReplied();
        return;
      }

      if (state.pendingIntent === 'transfers' || state.pendingIntent === 'neto') {
        const result = await getUserNetYesterday(usernameToCheck);
        if (!result.success) {
          state.lastReason = 'api_error';
          await setUserState(conversationId, state);
          await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
          await markReplied();
          return;
        }
        await sendReplyToChatwoot(
          accountId,
          conversationId,
          `Ayer tuviste cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}. Neto $${result.net.toFixed(2)}.`
        );
        state.pendingIntent = null;
        await setUserState(conversationId, state);
        await markReplied();
        return;
      }
    }

    if (isBalanceQuestion(fullMessage)) {
      if (!usernameToCheck) {
        state.pendingIntent = 'balance';
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo el saldo.');
        await markReplied();
        return;
      }

      const userInfo = await getUserInfoByName(usernameToCheck);
      if (!userInfo) {
        state.username = null;
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'No encuentro ese usuario. Revisalo con tu WhatsApp principal y pasamelo bien.');
        await markReasonNotified('user_not_found');
        await markReplied();
        return;
      }

      await sendReplyToChatwoot(accountId, conversationId, `Tu saldo actual es $${Number(userInfo.balance).toFixed(2)}.`);
      await markReplied();
      return;
    }

    if (isYesterdayTransfersQuestion(fullMessage)) {
      if (!usernameToCheck) {
        state.pendingIntent = 'transfers';
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'Pasame tu usuario y te digo las cargas/retiros de ayer.');
        await markReplied();
        return;
      }

      const result = await getUserNetYesterday(usernameToCheck);
      if (!result.success) {
        state.lastReason = 'api_error';
        await setUserState(conversationId, state);
        await sendReplyToChatwoot(accountId, conversationId, 'No pude consultar eso ahora, probá en un rato.');
        await markReplied();
        return;
      }

      await sendReplyToChatwoot(
        accountId,
        conversationId,
        `Ayer tuviste cargas $${result.totalDeposits.toFixed(2)} y retiros $${result.totalWithdraws.toFixed(2)}. Neto $${result.net.toFixed(2)}.`
      );
      await markReplied();
      return;
    }

    if (state.claimed && activeUsername) {
      const reply = await generateAfterCare(fullMessage, activeUsername, conversationId);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      await markReplied();
      return;
    }

    if (usernameToCheck) {
      logger.info({ user: sanitizeLogText(usernameToCheck) }, '⚡ Usuario detectado');

      const claimedCheck = await checkClaimedToday(usernameToCheck);

      // 2) Saldo actual
      const userInfo = await getUserInfoByName(usernameToCheck);
      if (!userInfo) {
        const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        state.username = null;
        await setUserState(conversationId, state);
        await markReasonNotified('user_not_found');
        await markReplied();
        return;
      }

      if (userInfo.balance >= 1000) {
        await sendReplyToChatwoot(accountId, conversationId, 'Tu saldo actual supera $1000, por eso no aplica el reintegro automático.');
        await markReasonNotified('balance_limit');
        await markReplied();
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
            await setUserState(conversationId, state);
            await markReasonNotified('claimed');
            await markReplied();
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
            await setUserState(conversationId, state);
            await markReplied();
          } else {
            const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
            await sendReplyToChatwoot(accountId, conversationId, reply);
            state.lastReason = 'api_error';
            await setUserState(conversationId, state);
            await markReplied();
          }
        } else if (result.totalDeposits === 0 && result.totalWithdraws === 0) {
          const reply = await generateCheckResult(usernameToCheck, 'no_deposits', { net }, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.claimed = false;
          state.username = usernameToCheck;
          await setUserState(conversationId, state);
          await markReasonNotified('no_deposits');
          await markReplied();
        } else if (result.totalDeposits === 0 && result.totalWithdraws > 0) {
          const reply = await generateCheckResult(usernameToCheck, 'negative_net', { net }, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.claimed = false;
          state.username = usernameToCheck;
          await setUserState(conversationId, state);
          await markReasonNotified('negative_net');
          await markReplied();
        } else if (net < 0) {
          const reply = await generateCheckResult(usernameToCheck, 'negative_net', { net }, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.claimed = false;
          state.username = usernameToCheck;
          await setUserState(conversationId, state);
          await markReasonNotified('negative_net');
          await markReplied();
        } else {
          const reply = await generateCheckResult(usernameToCheck, 'no_balance', { net }, conversationId);
          await sendReplyToChatwoot(accountId, conversationId, reply);
          state.claimed = false;
          state.username = usernameToCheck;
          await setUserState(conversationId, state);
          await markReasonNotified('no_balance');
          await markReplied();
        }
      } else {
        const reply = await generateCheckResult(usernameToCheck, 'api_error', {}, conversationId);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        state.lastReason = 'api_error';
        await setUserState(conversationId, state);
        await markReplied();
      }
      return;
    }

    const reply = await generateCasualChat(fullMessage, conversationId, {
      greeted: state.greeted,
      lastReason: state.lastReason,
    });
    await sendReplyToChatwoot(accountId, conversationId, reply);
    await markReplied();
  } catch (err) {
    metrics.errors += 1;
    logger.error({ err }, '❌ Error en processConversation');
  } finally {
    metrics.messagesProcessed += 1;
    metrics.totalProcessingMs += Date.now() - start;
  }
}

// ================== HEALTH & MÉTRICAS ==================
app.get('/health', (req, res) => {
  const avgMs =
    metrics.messagesProcessed > 0
      ? Number((metrics.totalProcessingMs / metrics.messagesProcessed).toFixed(2))
      : 0;

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    redis: redisReady ? 'connected' : 'disconnected',
    metrics: {
      messagesProcessed: metrics.messagesProcessed,
      errors: metrics.errors,
      avgProcessingMs: avgMs,
      droppedBufferMessages: metrics.droppedBufferMessages,
      droppedQueueItems: metrics.droppedQueueItems,
    },
  });
});

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
  if (buffer.messages.length >= MESSAGE_BUFFER_MAX) {
    buffer.messages.shift();
    metrics.droppedBufferMessages += 1;
  }
  buffer.messages.push(content);

  if (buffer.timer) clearTimeout(buffer.timer);

  buffer.timer = setTimeout(() => {
    const fullText = buffer.messages.join(' . ');
    messageBuffer.delete(conversationId);
    enqueueConversation(conversationId, async () => {
      logger.info({ conversationId }, '⏳ Procesando...');
      await processConversation(accountId, conversationId, contactId, contactName, fullText);
    });
  }, MESSAGE_BUFFER_DELAY_MS);
});

app.listen(PORT, () => logger.info({ port: PORT }, '🚀 Bot (Token Fresco) Activo'));
