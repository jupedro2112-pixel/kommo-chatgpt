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
const userStates = new Map(); // { claimed: boolean, username: string, lastActivity: number }

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

// ================== UTILIDADES ==================
function cleanHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const TEAM_USER_PATTERN = /\b(big|arg|cir|mar|lux|zyr|met|tri|ign|roy|tig)[a-z._-]*\d{3,}\b/i;

// Verifica si un texto es un usuario válido para operar
function isValidUsername(text) {
  if (!text) return false;
  // Debe coincidir con el patrón de equipo O tener letras y números al final
  if (TEAM_USER_PATTERN.test(text)) return true;
  if (/[a-z]+\d{3,}$/i.test(text)) return true; // fallback genérico (ej: pepe123)
  return false;
}

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  
  const teamMatch = m.match(TEAM_USER_PATTERN);
  if (teamMatch) return teamMatch[0].toLowerCase();

  const explicit = /usuario\s*:?\s*@?([a-zA-Z0-9._-]+)/i.exec(m);
  if (explicit) return explicit[1].toLowerCase();

  // Tokenización estricta para evitar falsos positivos en charla
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','quiero','reclamar','reembolso','bono','buenas','tardes','noches','tengo','plata','carga']);
  const tokens = m.split(/[\s,;:]+/).filter(t => t.length >= 4 && !STOPWORDS.has(t.toLowerCase()));
  
  const withNumbers = tokens.find(t => /\d/.test(t));
  if (withNumbers) return withNumbers.toLowerCase();

  return null;
}

// ================== GENERADORES DE RESPUESTA CON IA ==================

// 1. CHAT CASUAL: El cliente saluda o pregunta, pero NO sabemos el usuario aún.
async function generateCasualChat(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { 
          role: 'system', 
          content: `Sos "Soporte Casino", un agente humano, profesional y amable de Argentina.
          
          TU OBJETIVO: Atender al cliente y eventualmente pedirle su usuario para verificar el reintegro del 8%.
          
          DIRECTRICES:
          - Respondé de forma natural, explicativa y educada.
          - Si te dicen "Hola", saludá y preguntá en qué podés ayudar.
          - Si preguntan por reembolsos, explicá que es un beneficio diario sobre pérdidas y pedí el usuario para verificar.
          - NUNCA des ejemplos de usuarios.
          - Usá "vos", sé cálido.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '¡Hola! ¿Cómo estás? Para ayudarte con tu reintegro necesito tu usuario.';
  } catch (err) { return 'Hola, por favor decime tu usuario para revisar.'; }
}

// 2. RESULTADO DE REVISIÓN: Ya revisamos Sheets, la IA redacta el resultado.
async function generateCheckResult(username, status, data = {}) {
  // status: 'not_found', 'claimed', 'no_balance', 'success'
  let systemPrompt = `Sos un agente de casino amable. Estás hablando con el usuario "${username}".`;

  if (status === 'not_found') {
    systemPrompt += ` Buscaste su usuario y NO figura en la base de datos.
    Pedile amablemente que verifique si lo escribió bien. Recordale que debe ser tal cual lo usa en la plataforma.`;
  } 
  else if (status === 'claimed') {
    systemPrompt += ` El sistema indica que su reintegro YA FUE RECLAMADO hoy.
    Informale esto amablemente. Decile que puede volver a intentar mañana.`;
  } 
  else if (status === 'no_balance') {
    systemPrompt += ` Verificaste su cuenta. Su Neto es ${data.net}. NO tiene saldo negativo suficiente para reintegro.
    Explicaselo profesionalmente. Decile que siga probando suerte.`;
  } 
  else if (status === 'success') {
    systemPrompt += ` ¡BUENAS NOTICIAS! Le corresponde un reintegro.
    Neto: ${data.net}. Reembolso a acreditar: ${data.bonus}.
    Confirmale que ya se lo estás acreditando ahora mismo. Felicitalo.`;
  }

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: "Generá la respuesta para el cliente." },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    if (status === 'success') return `¡Listo! Tenés un reintegro de $${data.bonus}. Ya se acredita.`;
    return 'Tengo información sobre tu cuenta.';
  }
}

// 3. POST-VENTA: El cliente sigue hablando después de cobrar.
async function generateAfterCare(message, username) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0.7,
      messages: [
        { role: 'system', content: `Sos agente de casino. Hablas con "${username}".
        Ya cobró su reintegro hoy. Sé amable. Si pide más, decile que es diario.` },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) { return 'Cualquier cosa avisame. ¡Suerte!'; }
}

// ================== LÓGICA DE NEGOCIO (SHEETS) ==================
async function checkUserInSheets(username) {
  const lookupKey = username.toLowerCase().trim();
  const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg'; // Tu ID Real
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

  // Resultado del análisis
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
    spreadsheetId // Retornamos ID para poder escribir después
  };
}

// ================== PROCESAMIENTO CENTRAL ==================
async function processConversation(accountId, conversationId, contactId, contactName, fullMessage) {
  console.log(`🤖 Msg: "${fullMessage}" | ContactName: "${contactName}"`);

  let state = userStates.get(conversationId) || { claimed: false, username: null, lastActivity: Date.now() };
  state.lastActivity = Date.now();
  
  // 1. REGLA DE ORO: ¿Ya tenemos el usuario identificado?
  // Prioridad A: Ya lo guardamos en memoria (state)
  // Prioridad B: El nombre del contacto en Chatwoot YA ES un usuario válido (Agenda previa)
  let activeUsername = state.username;

  if (!activeUsername && isValidUsername(contactName)) {
    console.log(`✅ Usuario detectado por Agenda Chatwoot: ${contactName}`);
    activeUsername = contactName.toLowerCase();
    // Actualizamos estado sin marcar claimed todavía, para que procese la lógica
    state.username = activeUsername;
  }

  userStates.set(conversationId, state);

  // 2. Si ya cobró hoy (Estado en Memoria)
  if (state.claimed && activeUsername) {
    const reply = await generateAfterCare(fullMessage, activeUsername);
    await sendReplyToChatwoot(accountId, conversationId, reply);
    return;
  }

  // 3. Si TENEMOS usuario (por Agenda o por Estado), vamos DIRECTO a verificar
  // No importa lo que diga el cliente ("Hola", "Reembolso"), si ya sabemos quién es, verificamos.
  if (activeUsername) {
    console.log(`⚡ Procesando usuario conocido: ${activeUsername}`);
    const result = await checkUserInSheets(activeUsername);
    
    // Generar respuesta explicativa con IA
    const reply = await generateCheckResult(activeUsername, result.status, result);
    await sendReplyToChatwoot(accountId, conversationId, reply);

    if (result.status === 'success') {
      // Marcar en sheets
      await markAllUserRowsAsClaimed(result.spreadsheetId, result.indices);
      // Actualizar estado memoria
      state.claimed = true;
      userStates.set(conversationId, state);
      // (Opcional) Re-confirmar nombre en agenda por si acaso
      await updateChatwootContact(accountId, contactId, activeUsername);
    } else if (result.status === 'claimed' || result.status === 'no_balance') {
      // Marcamos como "procesado" para no re-calcular a cada mensaje
      state.claimed = true; 
      userStates.set(conversationId, state);
    }
    return;
  }

  // 4. Si NO tenemos usuario: CHARLA NORMAL
  // Intentamos extraerlo del mensaje actual
  const extractedUser = extractUsername(fullMessage);

  if (extractedUser) {
    // ¡Lo encontramos en el mensaje! Procesamos.
    console.log(`⚡ Usuario encontrado en mensaje: ${extractedUser}`);
    const result = await checkUserInSheets(extractedUser);
    
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
    // No sabemos quién es, ni lo dijo en el mensaje.
    // RESPUESTA DE CHAT AMABLE (Humanizada)
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
  const contactName = body.sender?.name || ''; // Nombre actual en la agenda
  const content = cleanHtml(body.content);

  if (!conversationId || !content) return;

  if (!messageBuffer.has(conversationId)) {
    messageBuffer.set(conversationId, { messages: [], timer: null });
  }

  const buffer = messageBuffer.get(conversationId);
  buffer.messages.push(content);

  if (buffer.timer) clearTimeout(buffer.timer);

  // 3.5 segundos de "typing..." simulado
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

app.listen(PORT, () => console.log(`🚀 Bot Casino 100% Humano Activo en puerto ${PORT}`));
