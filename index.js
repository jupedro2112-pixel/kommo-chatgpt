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
// 1. Buffer para acumular mensajes seguidos (Evita responder a cada frase)
const messageBuffer = new Map(); 

// 2. Memoria de sesiones finalizadas (Para no dar reembolso 2 veces ni seguir charlando)
const completedSessions = new Map(); 

// Limpieza automática de memoria cada hora
setInterval(() => {
  const now = Date.now();
  // Limpiar sesiones viejas (> 24hs)
  for (const [id, time] of completedSessions.entries()) {
    if (now - time > 24 * 60 * 60 * 1000) completedSessions.delete(id);
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
    console.error('❌ Error leyendo Sheets:', error?.message);
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

// ================== LÓGICA ==================
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

// ================== INTELIGENCIA ==================
async function detectIntent(message) {
  // Check rápido de "No sé mi usuario"
  const msgLower = message.toLowerCase();
  if (
    (msgLower.includes('no') && (msgLower.includes('se') || msgLower.includes('recuerdo') || msgLower.includes('acuerdo'))) &&
    (msgLower.includes('usuario') || msgLower.includes('user'))
  ) {
    return { type: 'forgot_username' };
  }

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Clasificador JSON. Tipos: "username", "chat", "forgot_username".
          - Si dice "no recuerdo mi usuario", "no se mi usuario": "forgot_username".
          - Si da un usuario (ej: marale707): "username".
          - Si saluda o pregunta: "chat".`
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
      temperature: 0.5,
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino. Respondé MUY CORTO (máx 15 palabras).
          Tu único objetivo es pedir el usuario para ver el reembolso.
          Si saludan, pedí el usuario.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Por favor, decime tu usuario.'; }
}

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','quiero','reclamar','reembolso']);
  
  // Regex explícito
  const explicit = /usuario\s*:?\s*@?([a-zA-Z0-9._-]+)/i.exec(m);
  if (explicit) return explicit[1];

  // Tokenización
  const tokens = m.split(/[\s,;:]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t.toLowerCase()));
  
  // Si hay números, es muy probable que sea el user
  const withNumbers = tokens.find(t => /\d/.test(t));
  if (withNumbers) return withNumbers;

  // Si queda solo uno, es ese
  if (tokens.length === 1) return tokens[0];

  return null;
}

// ================== PROCESAMIENTO CENTRAL (BUFFERED) ==================
async function processConversation(accountId, conversationId, fullMessage) {
  console.log(`🤖 Procesando bloque: "${fullMessage}"`);

  // 1. CHEQUEO: ¿Ya terminamos con este cliente por hoy?
  if (completedSessions.has(conversationId)) {
    console.log('⛔ Usuario ya atendido hoy. Enviando mensaje de cierre.');
    await sendReplyToChatwoot(accountId, conversationId, "Tu reclamo de hoy ya fue procesado. Podés volver a consultar tu reembolso diario mañana. ¡Saludos!");
    return;
  }

  // 2. Detectar Intención
  const intent = await detectIntent(fullMessage);
  
  // CASO A: Se olvidó el usuario
  if (intent.type === 'forgot_username') {
    await sendReplyToChatwoot(accountId, conversationId, "Si no recordás tu usuario, por favor comunicate con nuestro WhatsApp principal de cargas. Ellos te darán el dato correcto para que vuelvas a reclamar aquí.");
    return;
  }

  // CASO B: Chat casual (sin usuario)
  if (intent.type === 'chat') {
    // Si GPT piensa que es chat, intentamos extraer user por si acaso
    const possibleUser = extractUsername(fullMessage);
    if (!possibleUser) {
      const reply = await casinoChatResponse(fullMessage);
      await sendReplyToChatwoot(accountId, conversationId, reply);
      return;
    }
    // Si encontró user, seguimos abajo...
  }

  // CASO C: Tenemos un usuario (o intento de)
  const username = extractUsername(fullMessage);
  
  if (!username) {
    await sendReplyToChatwoot(accountId, conversationId, "Para verificar tu reembolso, necesito que escribas tu nombre de usuario exacto.");
    return;
  }

  console.log(`🔎 Buscando usuario: ${username}`);
  const lookupKey = username.toLowerCase().trim();
  
  // Sheets
  const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
  const rows = await getSheetData(spreadsheetId, 'Sheet1!A2:E10000');
  
  const foundIndices = [];
  let userTotals = { deposits: 0, withdrawals: 0 };

  // Barrido de datos
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
    await sendReplyToChatwoot(accountId, conversationId, `No encontré el usuario "${username}". Verificá que esté bien escrito (tal cual figura en la plataforma).`);
    return;
  }

  // Verificar si ya reclamó en ALGUNA fila
  let yaReclamo = false;
  for (const idx of foundIndices) {
    if (String(rows[idx][4] || '').toLowerCase().includes('reclam')) {
      yaReclamo = true;
      break;
    }
  }

  if (yaReclamo) {
    await sendReplyToChatwoot(accountId, conversationId, `El beneficio para ${username} ya fue reclamado hoy.`);
    // Marcamos sesión como finalizada
    completedSessions.set(conversationId, Date.now());
    return;
  }

  // Resultado Financiero
  const net = userTotals.deposits - userTotals.withdrawals;
  
  if (net <= 1) {
    await sendReplyToChatwoot(accountId, conversationId, `No tenés saldo negativo suficiente para reintegro.\n\nNeto: $${net.toFixed(2)}`);
    // También finalizamos sesión, porque ya se le dio la respuesta final
    completedSessions.set(conversationId, Date.now());
  } else {
    const bonus = (net * 0.08).toFixed(2);
    const msg = `¡Reintegro aprobado!\n\nNeto: $${net.toFixed(2)}\nReembolso (8%): $${bonus}\n\nSe acreditará automáticamente en tu cuenta.`;
    
    await sendReplyToChatwoot(accountId, conversationId, msg);
    
    // Marcar Sheets
    await markAllUserRowsAsClaimed(spreadsheetId, foundIndices);
    
    // Finalizar sesión por hoy
    completedSessions.set(conversationId, Date.now());
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

  // LÓGICA DE BUFFER (Agrupa mensajes si llegan rápido)
  if (!messageBuffer.has(conversationId)) {
    messageBuffer.set(conversationId, {
      messages: [],
      timer: null
    });
  }

  const buffer = messageBuffer.get(conversationId);
  buffer.messages.push(content);

  // Reiniciar timer
  if (buffer.timer) clearTimeout(buffer.timer);

  // Esperar 3 segundos. Si no llega nada más, procesar.
  buffer.timer = setTimeout(() => {
    const fullText = buffer.messages.join(" . "); // Unir mensajes
    messageBuffer.delete(conversationId); // Limpiar buffer
    
    // Ejecutar lógica principal (Simulamos espera humana dentro)
    (async () => {
      console.log(`⏳ Esperando 4s para responder a conv ${conversationId}...`);
      await sleep(4000); 
      await processConversation(accountId, conversationId, fullText);
    })();
    
  }, 3000); // 3 segundos de ventana para juntar mensajes
});

app.listen(PORT, () => console.log(`🚀 Bot listo en puerto ${PORT}`));
