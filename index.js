require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const { Configuration, OpenAIApi } = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuración de la API de OpenAI (ChatGPT)
const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
}));

// ================== ENV ==================
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

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

// ================== En memoria - Estado de conversación ==================
const conversationState = {};  // Aquí almacenamos el estado de las conversaciones

// ================== SEND MESSAGE TO KOMMO ==================
async function sendReply(chatId, message) {
  await axios.post('https://api.kommo.com/v1/messages', {
    chat_id: chatId,
    message,
  }, {
    headers: {
      Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });
}

// ================== WEBHOOK ==================
app.post('/webhook-kommo', async (req, res) => {
  try {
    const messageData = req.body.message?.add?.[0];

    if (!messageData) {
      return res.status(400).json({ error: 'No se encontró mensaje válido en el webhook' });
    }

    const userMessage = messageData.text.trim();
    const chatId = messageData.chat_id;

    console.log(`📩 Recibido mensaje de Kommo del usuario: ${userMessage}`);

    // Buscar el estado de la conversación en memoria
    if (!conversationState[chatId]) {
      conversationState[chatId] = { stage: 'waiting_for_username' };
    }

    const userState = conversationState[chatId];

    // Si está esperando el nombre de usuario
    if (userState.stage === 'waiting_for_username') {
      await sendReply(chatId, '¡Hola! Soy tu agente de casino virtual. 😊 ¿Cuál es tu nombre de usuario?');
      userState.stage = 'checking_user';
      return res.status(200).json({ success: true });
    }

    // Si está en la etapa de verificación del usuario
    if (userState.stage === 'checking_user') {
      // Leer datos desde Google Sheets
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg'; 
      const range = 'Sheet1!A2:D10000';

      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      const data = totals[userMessage];

      if (!data) {
        // Si no es un usuario válido
        await sendReply(chatId, `No encontré movimientos para el usuario *${userMessage}*. ¿Seguro que está bien escrito? 🤔`);
        return res.status(200).json({ success: true });
      }

      const net = data.deposits - data.withdrawals;
      const bonus = (net * 0.08).toFixed(2);
      await sendReply(chatId, `¡Hola ${userMessage}! 🎉\n\n💰 Depósitos: ${data.deposits}\n💸 Retiros: ${data.withdrawals}\n📊 Total neto: ${net}\n🎁 El *8%* de tu total neto es *${bonus}*.`);

      // Cambiar el estado de la conversación para permitir una nueva interacción
      userState.stage = 'waiting_for_username';

      return res.status(200).json({ success: true });
    }

  } catch (err) {
    console.error('❌ Error en webhook:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Inicia el servidor de Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
