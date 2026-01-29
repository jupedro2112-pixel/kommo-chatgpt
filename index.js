require('dotenv').config();
const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
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

// URL CONFIRMADA
const PLATFORM_URL = "https://admin.agentesadmin.bet/api/admin/"; 
const PLATFORM_USER = process.env.PLATFORM_USER; 
const PLATFORM_PASS = process.env.PLATFORM_PASS;

if (!PLATFORM_USER || !PLATFORM_PASS) {
  console.error("❌ ERROR CRÍTICO: Faltan PLATFORM_USER o PLATFORM_PASS en variables de entorno.");
}

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

// ================== INTEGRACIÓN PLATAFORMA ==================

// Configuración base para Axios (Headers para evitar bloqueos WAF)
const BASE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'Accept': 'application/json',
};

async function getPlatformToken() {
  console.log(`🔄 [API] Iniciando Login en ${PLATFORM_URL}...`);
  
  try {
    const form = new FormData();
    form.append('action', 'LOGIN');
    form.append('username', PLATFORM_USER);
    form.append('password', PLATFORM_PASS);

    const headers = { 
        ...BASE_HEADERS, 
        ...form.getHeaders() 
    };

    const resp = await axios.post(PLATFORM_URL, form, { headers });

    // Manejo de respuesta
    let data = resp.data;
    
    // Si la API devuelve string sucio (a veces pasa en sistemas legacy)
    if (typeof data === 'string') {
        try { 
             if (data.includes('{')) {
                const jsonPart = data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1);
                data = JSON.parse(jsonPart);
             }
        } catch(e) {}
    }

    // Log seguro (sin mostrar password)
    console.log("📩 [API] Login Response:", data.success ? "SUCCESS" : JSON.stringify(data));

    if (data && data.success && data.token) {
      return data.token;
    } else {
      console.error("❌ [API] Login falló:", data);
      return null;
    }
  } catch (err) {
    console.error("❌ [API] Error HTTP Login:", err.message);
    if (err.response) console.error("   Status:", err.response.status, err.response.data);
    return null;
  }
}

async function creditUserBalance(username, amount) {
  console.log(`💰 [API] Intentando cargar $${amount} a ${username}`);
  
  const token = await getPlatformToken();
  if (!token) {
    return { success: false, error: 'Login Failed - Check Credentials' };
  }

  try {
    const form = new FormData();
    form.append('action', 'DEPOSIT'); 
    form.append('token', token);
    form.append('username', username);
    form.append('amount', amount.toString());

    const headers = { 
        ...BASE_HEADERS, 
        ...form.getHeaders() 
    };

    const resp = await axios.post(PLATFORM_URL, form, { headers });

    let data = resp.data;
    if (typeof data === 'string' && data.includes('{')) {
        try { 
            const jsonPart = data.substring(data.indexOf('{'), data.lastIndexOf('}') + 1);
            data = JSON.parse(jsonPart);
        } catch(e) {}
    }

    console.log("📩 [API] Deposit Response:", JSON.stringify(data));

    if (data && data.success) {
      console.log(`✅ [API] Carga Exitosa para ${username}`);
      return { success: true };
    } else {
      console.error(`❌ [API] Carga Rechazada:`, data);
      return { success: false, error: data.error || 'Unknown API Error' };
    }
  } catch (err) {
    console.error("❌ [API] Error HTTP Deposit:", err.message);
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
    console.log(`✅ Chatwoot Reply Enviado.`);
  } catch (err) {
    console.error('❌ Chatwoot Send Error:', err.message);
  }
}

async function updateChatwootContact(accountId, contactId, username) {
  if (!CHATWOOT_ACCESS_TOKEN || !contactId) return;
  try {
    console.log(`📝 Chatwoot: Renombrando contacto a ${username}`);
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/contacts/${contactId}`;
    await axios.put(url, { name: username }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
  } catch (err) {
    console.error('❌ Chatwoot Rename Error:', err?.message);
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
async function generateSalesReply(userMessage, agentName) {
  const systemPrompt = `
    Sos ${agentName}, una experta vendedora de cortinas y decoración de interiores.
    
    TUS INSTRUCCIONES:
    1. TONO: Profesional, serio pero amable. Sos Argentina, usá modismos locales sutiles (viste, claro, te comento) pero mantene la formalidad de un negocio.
    2. OBJETIVO: Cerrar la venta. Asesorar sobre telas (Blackout, Sunscreen, Voile, Lino), sistemas (Roller, Bandas Verticales, Rieles) y medidas.
    3. IDENTIDAD: Actúa siempre como humana. NUNCA menciones que sos una IA o ChatGPT. Si te preguntan algo fuera de tema, redirigí la charla a las cortinas educadamente.
    4. ACCIÓN: Pedí medidas (ancho x alto) si no las tenés. Ofrecé presupuesto. Preguntá qué tipo de ambiente quieren oscurecer o decorar.
    
    Recordá: Tu nombre es ${agentName}.
  `;

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini', // O gpt-3.5-turbo según tu plan
      temperature: 0.3, // Temperatura baja para ser más seria y consistente
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    console.error("❌ Error OpenAI:", err.message);
    return "Disculpá, estoy verificando el stock. ¿Podrías repetirme la consulta?";
  }
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, fullMessage) {
  // 1. Obtener o Inicializar Estado
  let state = userStates.get(conversationId);
  
  if (!state) {
    // Si es nueva conversación, asignamos un nombre aleatorio
    state = { 
      agentName: getRandomName(), 
      lastActivity: Date.now() 
    };
    console.log(`🆕 Nueva conversación (${conversationId}). Agente asignada: ${state.agentName}`);
  } else {
    state.lastActivity = Date.now();
  }
  
  userStates.set(conversationId, state);

  console.log(`💬 Msg para ${state.agentName}: "${fullMessage}"`);

  // 2. Generar respuesta con IA
  const reply = await generateSalesReply(fullMessage, state.agentName);

  // 3. Enviar a Chatwoot
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
      console.log(`⏳ Escribiendo... (Conv ${conversationId})`);
      await sleep(3500); 
      await processConversation(accountId, conversationId, contactId, contactName, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot Casino 24/7 Activo en puerto ${PORT}`));
