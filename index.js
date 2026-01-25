require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== ENV ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// ================== GOOGLE AUTH ==================
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

// ================== SESSION MEMORY ==================
const sessionMemory = {};

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

// ================== CALCULOS ==================
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

    if (type === 'withdraw') {
      totals[user].withdrawals += amount;
    }
  });

  return totals;
}

// ================== SEND MESSAGE TO KOMMO ==================
async function sendReply(chatId, message) {
  await axios.post(
    'https://api.kommo.com/v1/messages',
    {
      chat_id: chatId,
      message,
    },
    {
      headers: {
        Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ================== WEBHOOK ==================
app.post('/webhook-kommo', async (req, res) => {
  try {
    const messageData = req.body.message?.add?.[0];
    if (!messageData) return res.sendStatus(200);

    const chatId = messageData.chat_id;
    const userMessage = messageData.text?.trim();

    if (!sessionMemory[chatId]) {
      sessionMemory[chatId] = { step: 'ask_user' };
    }

    // ================== STEP 1: ASK USER ==================
    if (sessionMemory[chatId].step === 'ask_user') {
      await sendReply(
        chatId,
        '👋 Hola! Por favor indicame tu *usuario exacto* para calcular tu balance.'
      );
      sessionMemory[chatId].step = 'waiting_user';
      return res.sendStatus(200);
    }

    // ================== STEP 2: PROCESS USER ==================
    if (sessionMemory[chatId].step === 'waiting_user') {
      const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
      const range = 'Sheet1!A2:D10000';

      const rows = await getSheetData(spreadsheetId, range);
      const totals = calculateTotalsByUser(rows);

      const user = userMessage;
      const data = totals[user];

      if (!data) {
        await sendReply(
          chatId,
          `❌ No encontré movimientos para el usuario *${user}*. Verificá que esté bien escrito.`
        );
        return res.sendStatus(200);
      }

      const net = data.deposits - data.withdrawals;

      if (net <= 1) {
        await sendReply(
          chatId,
          `ℹ️ Usuario: *${user}*\nDepósitos: ${data.deposits}\nRetiros: ${data.withdrawals}\n\nEl total neto es ${net}. No aplica el 8%.`
        );
      } else {
        const bonus = (net * 0.08).toFixed(2);
        await sendReply(
          chatId,
          `✅ Usuario: *${user}*\n\n💰 Depósitos: ${data.deposits}\n💸 Retiros: ${data.withdrawals}\n📊 Total neto: ${net}\n\n🎁 El *8%* de tu total neto es *${bonus}*.`
        );
      }

      delete sessionMemory[chatId];
      return res.sendStatus(200);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error webhook:', err.message);
    res.sendStatus(500);
  }
});

// ================== SERVER ==================
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
