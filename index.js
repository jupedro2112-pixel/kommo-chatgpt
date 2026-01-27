require('dotenv').config();	
const express = require('express');	
const axios = require('axios');	
const { google } = require('googleapis');	
const { GoogleAuth } = require('google-auth-library');	
const { OpenAIApi, Configuration } = require('openai');	
	
const app = express();	
const PORT = process.env.PORT || 3000;	
	
// Capture raw body to debug content-types	
app.use(express.json({	
verify: (req, res, buf) => { req.rawBody = buf && buf.toString(); },	
}));	
app.use(express.urlencoded({	
extended: true,	
verify: (req, res, buf) => {	
req.rawBody = (req.rawBody || '') + (buf && buf.toString());	
},	
}));	
	
// Simple in-memory last request for debugging	
let lastRequest = null;	
	
// Logging middleware (most verbose: logs headers, raw body AND parsed body)	
app.use((req, res, next) => {	
const now = new Date().toISOString();	
console.log(`\n[${now}] ${req.method} ${req.originalUrl}`);	
console.log('Headers:', req.headers);	
console.log('Raw body:', req.rawBody || '(empty)');	
console.log('Parsed body:', req.body && Object.keys(req.body).length ? req.body : '(empty)');	
lastRequest = {	
time: now,	
method: req.method,	
url: req.originalUrl,	
headers: req.headers,	
body: req.body,	
rawBody: req.rawBody,	
};	
next();	
});	
	
// Health and debug endpoints	
app.get('/', (req, res) => res.send('OK'));	
app.get('/debug/last', (req, res) => res.json(lastRequest || {}));	
	
// ================== ENV ==================	
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;	
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;	
	
if (!OPENAI_API_KEY) {	
console.error('❌ OPENAI_API_KEY no está definido en las variables de entorno.');	
}	
if (!KOMMO_ACCESS_TOKEN) {	
console.error('❌ KOMMO_ACCESS_TOKEN no está definido en las variables de entorno.');	
}	
	
let GOOGLE_CREDENTIALS = null;	
if (process.env.GOOGLE_CREDENTIALS_JSON) {	
try {	
GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);	
} catch (err) {	
console.error('❌ No se pudo parsear GOOGLE_CREDENTIALS_JSON:', err.message);	
}	
}	
	
// ================== Inicialización de OpenAI ==================	
const openai = new OpenAIApi(new Configuration({	
apiKey: OPENAI_API_KEY,	
}));	
	
// ================== GOOGLE AUTH (AHORA CON PERMISO DE ESCRITURA) ==================	
const auth = new GoogleAuth({	
credentials: GOOGLE_CREDENTIALS,	
scopes: ['https://www.googleapis.com/auth/spreadsheets'], // escritura incluida	
});	
	
// ================== GOOGLE SHEETS ==================	
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
	
// ================== UTIL: sleep para simular demora humana ==================	
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));	
	
// ================== SEND MESSAGE TO KOMMO (espera 5s antes de enviar) ==================	
async function sendReply(chatId, message) {	
if (!KOMMO_ACCESS_TOKEN) {	
console.warn('⚠️ No hay KOMMO_ACCESS_TOKEN; no se enviará el mensaje.');	
return;	
}	
try {	
console.log(`Esperando 5s antes de enviar mensaje a Kommo...`);	
await sleep(5000); // 5 segundos para parecer humano	
console.log(`Enviando a Kommo -> chat_id: ${chatId}, message: ${message}`);	
if (!chatId) {	
console.warn('⚠️ chatId es nulo o indefinido — Kommo podría requerir chat_id para enviar mensajes.');	
}	
const resp = await axios.post('https://api.kommo.com/v1/messages', {	
chat_id: chatId,	
message,	
}, {	
headers: {	
Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,	
Content-Type': 'application/json',	
},	
});	
console.log('Kommo response status:', resp.status);	
} catch (err) {	
console.error('❌ Error enviando mensaje a Kommo:', err?.response?.data || err.message || err);	
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
	
// ================== GPT CHAT RESPONSE ==================	
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
// Solo usamos la primera opción y la retornamos (una única respuesta)	
return resp.data?.choices?.[0]?.message?.content || '';	
} catch (err) {	
console.error('❌ casinoChatResponse error:', err?.message || err);	
return 'Perdón, estoy teniendo un problema ahora mismo. ¿Podés repetir o darme tu nombre de usuario?';	
}	
}	
	
// ================== UTIL: extraer texto del body (soporta varias formas) ==================	
function extractMessageFromBody(body, raw) {	
const tryPaths = [	
() => body?.message?.add?.[0]?.text,	
() => body?.unsorted?.update?.[0]?.source_data?.data?.[0]?.text,	
() => body?.unsorted?.update?.[0]?.source_data?.data?.[0]?.text,	
() => body?.leads?.update?.[0]?.some_text,	
() => body?.message?.add?.[0]?.source?.text,	
() => body?.message?.add?.[0]?.text_raw,	
];	
	
for (const fn of tryPaths) {	
try {	
const v = fn();	
if (v) return String(v).trim();	
} catch (e) { /* ignore */ }	
}	
	
if (raw) {	
try {	
const params = new URLSearchParams(raw);	
for (const [k, v] of params) {	
if (!v) continue;	
const keyLower = k.toLowerCase();	
if (keyLower.endsWith('[text]') || keyLower.includes('[text]') || keyLower.endsWith('text') || keyLower.includes('source_data%5D%5Bdata%5D%5B0%5D%5Btext')) {	
return decodeURIComponent(String(v)).replace(/\+/g, ' ').trim();	
}	
}	
for (const [k, v] of params) {	
const keyLower = k.toLowerCase();	
if ((keyLower.includes('message') || keyLower.includes('source_data') || keyLower.includes('data')) && v) {	
const s = decodeURIComponent(String(v)).replace(/\+/g, ' ').trim();	
if (s.length > 0) return s;	
}	
}	
} catch (e) {	
console.warn('extractMessageFromBody: fallo al parsear raw body:', e?.message || e);	
}	
}	
	
return null;	
}	
	
// ================== UTIL: extraer username desde un texto natural ==================	
function extractUsername(message) {	
if (!message || typeof message !== 'string') return null;	
const m = message.trim();	
	
const STOPWORDS = new Set([	
mi','miembro','usuario','es','soy','me','llamo','nombre','el','la','de','por','favor','porfavor','hola','buenas','buenos','noches','dias','tarde','gracias'	
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
	
// ================== WEBHOOK ==================	
app.post('/webhook-kommo', (req, res) => {	
// Responder rápido para que Kommo reciba 200	
res.sendStatus(200);	
	
(async () => {	
try {	
// Extraer texto del body de forma robusta	
const receivedText = extractMessageFromBody(req.body, req.rawBody);	
	
let chatId = null;	
try {	
chatId = req.body?.message?.add?.[0]?.chat_id || req.body?.unsorted?.update?.[0]?.source_data?.origin?.chat_id || null;	
} catch (e) { chatId = null; }	
	
if (!chatId && req.rawBody) {	
const params = new URLSearchParams(req.rawBody);	
for (const [k, v] of params) {	
const kl = k.toLowerCase();	
if (kl.endsWith('[chat_id]') || kl.includes('chat_id')) {	
chatId = v;	
break;	
}	
}	
}	
	
if (!receivedText) {	
console.log('Webhook recibido pero no se encontró texto del usuario. Payload guardado en /debug/last para inspección.');	
return;	
}	
	
console.log('Mensaje recibido desde Kommo ->', receivedText);	
if (chatId) console.log('Chat ID detectado ->', chatId);	
	
// Detectar intención	
const intent = await detectIntent(receivedText);	
console.log('Intent detectado por OpenAI ->', intent);	
	
// Si es chat, generar respuesta conversacional	
if (intent.type === 'chat') {	
const reply = await casinoChatResponse(receivedText);	
console.log('Respuesta ChatGPT generada (solo una) ->', reply);	
await sendReply(chatId, reply);	
return;	
}	
	
// Si el intent indica username -> extraer username del texto	
const username = extractUsername(receivedText);	
console.log('Username extraído ->', username);	
	
if (!username) {	
const ask = 'Estimado/a, entiendo que querés que verifique tu usuario. Por favor enviá exactamente tu nombre de usuario tal como figura en la plataforma para que lo confirme en nuestros registros.';	
console.log('No se pudo extraer username; se solicita aclaración ->', ask);	
await sendReply(chatId, ask);	
return;	
}	
	
const lookupKey = String(username).toLowerCase().trim();	
console.log('Lookup key (lowercased) ->', lookupKey);	
	
// Buscar en Google Sheets (ahora leemos columna E también para ver si está reclamado)	
const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';	
const range = 'Sheet1!A2:E10000'; // incluye columna E como marcador de reclamo	
const rows = await getSheetData(spreadsheetId, range);	
const totals = calculateTotalsByUser(rows);	
	
// localizar la fila exacta (para marcar columna E si es necesario)	
let foundRowIndex = -1;	
for (let i = 0; i < rows.length; i++) {	
const rowUser = String(rows[i][1] || '').toLowerCase().trim();	
if (rowUser === lookupKey) {	
foundRowIndex = i; // index dentro de rows (A2 corresponde a i=0)	
break;	
}	
}	
	
if (foundRowIndex === -1) {	
const msg = `Estimado/a, no encontramos el usuario ${username} en nuestros registros. Por favor dirigite al WhatsApp principal donde realizás tus cargas para solicitar tu nombre de usuario correcto y volvé a este chat con el usuario exacto para que podamos corroborar el reembolso.`;	
console.log('Respuesta enviada (usuario no encontrado) ->', msg);	
await sendReply(chatId, msg);	
return;	
}	
	
// verificar si ya fue reclamado (columna E = index 4 en rows)	
const claimedCell = String(rows[foundRowIndex][4] || '').toLowerCase();	
if (claimedCell.includes('reclam')) {	
const msg = `Estimado/a, según nuestros registros el reembolso para ${username} ya fue marcado como reclamado anteriormente. Si creés que hay un error, contactanos por WhatsApp principal con evidencia y lo revisamos.`;	
console.log('Respuesta enviada (ya reclamado) ->', msg);	
await sendReply(chatId, msg);	
return;	
}	
	
// obtener totales y decidir reembolso	
const userTotals = totals[lookupKey];	
const data = userTotals || { deposits: 0, withdrawals: 0 };	
const net = data.deposits - data.withdrawals;	
const depositsStr = Number(data.deposits).toFixed(2);	
const withdrawalsStr = Number(data.withdrawals).toFixed(2);	
const netStr = Number(net).toFixed(2);	
	
if (net <= 1) {	
const msg = `Estimado/a, hemos verificado tus movimientos y, según nuestros registros, no corresponde reembolso en este caso.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nSi considerás que hay un error, por favor contactanos por WhatsApp principal y traenos el usuario correcto para que lo revisemos.`;	
console.log('Respuesta enviada (no aplica reembolso) ->', msg);	
await sendReply(chatId, msg);	
return;	
} else {	
const bonus = (net * 0.08);	
const bonusStr = bonus.toFixed(2);	
const msg = `Estimado/a, confirmamos que corresponde un reembolso del 8% sobre tu neto. El monto de reembolso es: $${bonusStr}.\n\nDetalle:\n- Depósitos: $${depositsStr}\n- Retiros: $${withdrawalsStr}\n- Neto: $${netStr}\n\nEl reembolso se depositará automáticamente en tu cuenta y podrás verificarlo en la plataforma usando tu usuario. Procedo a marcar este reembolso como reclamado en nuestros registros.`;	
console.log('Respuesta enviada (aplica reembolso) ->', msg);	
await sendReply(chatId, msg);	
	
// marcar en Sheets: rowNumber = 2 + foundRowIndex (porque rows comienza en A2)	
const rowNumber = 2 + foundRowIndex;	
const marked = await markUserAsClaimed(spreadsheetId, rowNumber, 'E');	
if (marked) {	
console.log(`Usuario ${username} marcado como RECLAMADO en la fila ${rowNumber}.`);	
} else {	
console.warn(`No se pudo marcar como RECLAMADO al usuario ${username} en la fila ${rowNumber}.`);	
}	
return;	
}	
} catch (err) {	
console.error('❌ Error procesando webhook (background):', err?.message || err);	
}	
})();	
});	
	
// Inicia el servidor de Express	
app.listen(PORT, () => {	
console.log(`🚀 Servidor escuchando en puerto ${PORT}`);	
});	
