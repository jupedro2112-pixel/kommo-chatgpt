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

// Logging limpio
app.use((req, res, next) => {
  if (req.method === 'POST' && req.url.includes('webhook')) {
    console.log(`\n[${new Date().toISOString()}] Webhook recibido`);
  }
  next();
});

app.get('/', (req, res) => res.send('Chatwoot Bot Activo 🚀'));

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

// NUEVO: Marca TODAS las filas que coincidan con el usuario
async function markAllUserRowsAsClaimed(spreadsheetId, indices, columnLetter = 'E') {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });
    
    // Procesamos todas las filas encontradas
    const promises = indices.map(rowIndex => {
      // rowIndex es base 0, Sheets es base 1. Si los datos empiezan en fila 2, rowIndex 0 = fila 2.
      // Ajuste: rowIndex viene del array de datos. Si data empieza en A2:
      // data[0] -> Fila 2. data[n] -> Fila n+2.
      const sheetRow = rowIndex + 2; 
      
      return sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!${columnLetter}${sheetRow}`,
        valueInputOption: 'RAW',
        resource: { values: [['RECLAMADO']] },
      });
    });

    await Promise.all(promises);
    console.log(`✅ Marcado RECLAMADO en ${indices.length} filas.`);
    return true;
  } catch (err) {
    console.error('❌ Error marcando reclamado:', err?.message);
    return false;
  }
}

// ================== LÓGICA FINANCIERA ==================
function parseAmount(value) {
  if (value == null) return 0;
  const s = String(value).replace(/\s/g, '').replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function calculateTotalsByUser(rows) {
  const totals = {};
  rows.forEach(row => {
    const type = String(row[0] || '').toLowerCase().trim();
    const user = String(row[1] || '').trim().toLowerCase();
    const amount = parseAmount(row[2]);
    
    if (!user) return;
    if (!totals[user]) totals[user] = { deposits: 0, withdrawals: 0 };

    // Detección robusta de depósitos
    if (type.includes('deposit') || type.includes('depósito') || type.includes('carga')) {
      totals[user].deposits += amount;
    } 
    // Detección robusta de retiros (incluyendo errores comunes)
    else if (
      type.includes('withdraw') || 
      type.includes('whitdraw') || 
      type.includes('widthdraw') || 
      type.includes('witdraw') || 
      type.includes('retiro') || 
      type.includes('retir')
    ) {
      totals[user].withdrawals += amount;
    }
  });
  return totals;
}

// ================== UTILIDADES ==================
function cleanHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;
  try {
    console.log('⏳ Escribiendo (4s)...');
    await sleep(4000); 
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(url, {
      content: message,
      message_type: 'outgoing',
      private: false
    }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
    console.log('✅ Mensaje enviado.');
  } catch (err) {
    console.error('❌ Error enviando:', err.message);
  }
}

// ================== INTELIGENCIA ARTIFICIAL ==================
async function detectIntent(message) {
  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `Sos un clasificador.
          Respondé SOLO JSON: { "type": "username" } o { "type": "chat" }
          Reglas:
          - Si el texto parece un nombre de usuario (ej: marale707, pepe.123, usuario: x) responde "username".
          - Si es solo charla, saludo o pregunta sin dar el usuario, responde "chat".`
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
      temperature: 0.5, // Más determinista
      messages: [
        { 
          role: 'system', 
          content: `Sos un agente de casino online. Respondés en español rioplatense (Argentina).
          
          REGLA DE ORO: Tus respuestas deben ser MUY CORTAS y concisas (máximo 1 o 2 oraciones).
          OBJETIVO PRINCIPAL: Pedir el nombre de usuario para verificar reembolsos.
          
          Si el usuario saluda o pregunta por reembolsos, decíle que necesitás su usuario para verificar. No des explicaciones largas.` 
        },
        { role: 'user', content: message },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content || '';
  } catch (err) { return 'Tuve un error. ¿Me decís tu usuario?'; }
}

function extractUsername(message) {
  if (!message) return null;
  const m = message.trim();
  const STOPWORDS = new Set(['mi','usuario','es','soy','hola','gracias','por','favor','quiero','reclamar']);

  const explicitPatterns = [
    /usuario(?:\s+es|\s*:\s*|\s+:+)\s*@?([A-Za-z0-9._-]{3,30})/i,
    /username(?:\s*:\s*|\s+)\s*@?([A-Za-z0-9._-]{3,30})/i
  ];
  for (const re of explicitPatterns) {
    const found = m.match(re);
    if (found && found[1]) return found[1].trim();
  }

  const tokens = m.split(/[\s,;.:\-()]+/).filter(Boolean);
  const candidates = tokens.filter(t => 
    t.length >= 3 && 
    !STOPWORDS.has(t.toLowerCase()) &&
    /^[A-Za-z0-9._-]+$/.test(t)
  );

  if (candidates.length === 1) return candidates[0];
  for (const t of candidates) { if (/\d/.test(t)) return t; }

  return null;
}

// ================== WEBHOOK HANDLER ==================
app.post('/webhook-chatwoot', (req, res) => {
  res.status(200).send('OK');

  (async () => {
    try {
      const event = req.body.event;
      const messageType = req.body.message_type;
      
      if (event !== 'message_created' || messageType !== 'incoming') return;

      const accountId = req.body.account?.id;
      const conversationId = req.body.conversation?.id;
      const rawContent = req.body.content; 
      const content = cleanHtml(rawContent);

      if (!content || !conversationId) return;

      console.log(`📩 Mensaje: "${content}"`);

      // 1. Detectar intención
      const intent = await detectIntent(content);

      // 2. Chat casual (GPT Corto)
      if (intent.type === 'chat') {
        const reply = await casinoChatResponse(content);
        await sendReplyToChatwoot(accountId, conversationId, reply);
        return;
      }

      // 3. Username detectado -> Procesar
      const username = extractUsername(content);
      console.log('Username ->', username);

      if (!username) {
        await sendReplyToChatwoot(accountId, conversationId, 'Por favor, escribime tu usuario para revisar.');
        return;
      }

      const lookupKey = username.toLowerCase().trim();
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:E10000'; // Ajustar rango si es necesario
      
      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      // Buscar TODAS las filas donde aparece el usuario
      const foundIndices = [];
      for (let i = 0; i < rows.length; i++) {
        const rowUser = String(rows[i][1] || '').toLowerCase().trim();
        if (rowUser === lookupKey) {
          foundIndices.push(i);
        }
      }

      if (foundIndices.length === 0) {
        await sendReplyToChatwoot(accountId, conversationId, `No encontré el usuario "${username}". Verificá que esté bien escrito.`);
        return;
      }

      // Verificar si ALGUNA de las filas ya dice "reclamado"
      let yaReclamo = false;
      for (const idx of foundIndices) {
        const claimedCell = String(rows[idx][4] || '').toLowerCase();
        if (claimedCell.includes('reclam')) {
          yaReclamo = true;
          break;
        }
      }

      if (yaReclamo) {
        await sendReplyToChatwoot(accountId, conversationId, `El beneficio para ${username} ya fue reclamado.`);
        return;
      }

      // Cálculos
      const userTotals = totals[lookupKey] || { deposits: 0, withdrawals: 0 };
      const net = userTotals.deposits - userTotals.withdrawals;
      
      if (net <= 1) {
        // Mensaje corto de rechazo
        await sendReplyToChatwoot(accountId, conversationId, `No tenés saldo negativo suficiente para reintegro.\n\nNeto: $${net.toFixed(2)}`);
      } else {
        const bonus = (net * 0.08).toFixed(2);
        // Mensaje corto de éxito
        const msg = `¡Tenés un reintegro!\n\nNeto: $${net.toFixed(2)}\nReembolso (8%): $${bonus}\n\nSe acreditará automáticamente.`;
        
        await sendReplyToChatwoot(accountId, conversationId, msg);
        
        // Marcar "RECLAMADO" en TODAS las filas encontradas
        await markAllUserRowsAsClaimed(spreadsheetId, foundIndices, 'E');
      }

    } catch (e) {
      console.error('❌ Error Webhook:', e);
    }
  })();
});

app.listen(PORT, () => console.log(`🚀 Bot listo en puerto ${PORT}`));
