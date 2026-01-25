require('dotenv').config();  // Para cargar las variables de entorno
const express = require('express');  // Importar Express
const axios = require('axios');  // Importar axios
const { google } = require('googleapis'); // Importar Google APIs
const { GoogleAuth } = require('google-auth-library'); // Para autenticación de Google
const { OpenAIApi, Configuration } = require("openai");  // Asegúrate de tener esto

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());  // Middleware para procesar JSON
app.use(express.urlencoded({ extended: true }));  // Middleware para datos de formularios

// ================== ENV ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// ================== Inicialización de OpenAI ==================
const openai = new OpenAIApi(new Configuration({
  apiKey: OPENAI_API_KEY,
}));

// ================== GOOGLE AUTH ==================
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// ================== GOOGLE SHEETS ==================
async function getSheetData(spreadsheetId, range) {
  try {
    const authClient = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    return res.data.values || [];
  } catch (error) {
    console.error('❌ Error leyendo Google Sheets:', error.message);
    return [];
  }
}

function calculateTotalsByUser(rows) {
  const totals = {};

  rows.forEach(row => {
    const type = (row[0] || '').toLowerCase(); // deposit / withdraw
    const user = (row[1] || '').trim();
    const amount = parseFloat(row[2]) || 0;

    if (!user) return;

    if (!totals[user]) {
      totals[user] = { deposits: 0, withdrawals: 0 };
    }

    if (type === 'deposit') {
      totals[user].deposits += amount;
    }

    if (type === 'whitdraw') {
      totals[user].withdrawals += amount;
    }
  });

  return totals;
}

// ================== SEND MESSAGE TO KOMMO ==================
async function sendReply(chatId, message) {
  await axios.post('https://api.kommo.com/v1/messages', {
    chat_id: chatId,
    message,
  }, {
    headers: {
      Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,  // Asegúrate de usar comillas invertidas (backticks) aquí
      'Content-Type': 'application/json',
    },
  });
}

// ================== GPT INTENT DETECTOR ==================
async function detectIntent(message) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',  // Cambié a un modelo de OpenAI GPT más apropiado
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `
Sos un clasificador.
Decidí si el mensaje es un NOMBRE DE USUARIO o una CHARLA.

Respondé SOLO JSON:
{ "type": "username" } o { "type": "chat" }
        `,
      },
      { role: 'user', content: message },
    ],
  });

  return JSON.parse(completion.choices[0].message.content);
}

// ================== GPT CHAT RESPONSE ==================
async function casinoChatResponse(message) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      {
        role: 'system',
        content: `
Sos un agente humano de casino online.
Sos amable, claro, natural.
Tu objetivo es ayudar y pedir el nombre de usuario sin sonar robot.
        `,
      },
      { role: 'user', content: message },
    ],
  });

  return completion.choices[0].message.content;
}

// ================== WEBHOOK ==================
app.post('/webhook-kommo', async (req, res) => {
  try {
    const messageData = req.body.message?.add?.[0];
    if (!messageData) return res.sendStatus(200);

    const userMessage = messageData.text.trim();
    const chatId = messageData.chat_id;

    const intent = await detectIntent(userMessage);

    // ======= SI ES CHAT =======
    if (intent.type === 'chat') {
      const reply = await casinoChatResponse(userMessage);
      await sendReply(chatId, reply);
      return res.sendStatus(200);
    }

    // ======= SI ES POSIBLE USUARIO =======
    const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
    const range = 'Sheet1!A2:D10000';

    const rows = await getSheetData(spreadsheetId, range);
    const totals = calculateTotalsByUser(rows);

    const data = totals[userMessage];

    if (!data) {
      await sendReply(
        chatId,
        'No logro encontrar ese usuario 🤔 ¿podés revisarlo y enviármelo nuevamente?'
      );
      return res.sendStatus(200);
    }

    const net = data.deposits - data.withdrawals;

    if (net <= 1) {
      await sendReply(
        chatId,
        `ℹ️ Perfecto, ya te encontré.\n\nDepósitos: ${data.deposits}\nRetiros: ${data.withdrawals}\n\nPor ahora no aplica el 8% 😉`
      );
    } else {
      const bonus = (net * 0.08).toFixed(2);
      await sendReply(
        chatId,
        `🎉 ¡Listo!\n\n💰 Depósitos: ${data.deposits}\n💸 Retiros: ${data.withdrawals}\n📊 Neto: ${net}\n\n🎁 Tu reembolso es *${bonus}*`
      );
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// Inicia el servidor de Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
