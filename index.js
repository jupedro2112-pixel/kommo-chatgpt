require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// Google Sheets Auth
const auth = new GoogleAuth({
  credentials: GOOGLE_CREDENTIALS,
  scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
});

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
    const type = (row[0] || '').toLowerCase();
    const user = (row[1] || '').trim();
    const amount = parseFloat(row[2]) || 0;

    if (!user) return;

    if (!totals[user]) {
      totals[user] = { deposits: 0, withdrawals: 0 };
    }

    if (type === 'deposit') totals[user].deposits += amount;
    if (type === 'withdraw') totals[user].withdrawals += amount;
  });

  return totals;
}

// Webhook de Kommo

app.post('/webhook-kommo', async (req, res) => {
  try {
    console.log('📩 Webhook recibido de Kommo:');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const messageData = req.body.message?.add?.[0];  // Obtenemos el primer mensaje

    if (!messageData) {
      return res.status(400).json({ error: 'No se encontró mensaje válido en el webhook' });
    }

    const userMessage = messageData.text;
    const chatId = messageData.chat_id;

    // Leer datos desde Google Sheets
    const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg'; // <-- actualizalo si cambia
    const range = 'Sheet1!A2:D10000';

    const rows = await getSheetData(spreadsheetId, range);
    const totals = calculateTotalsByUser(rows);

    const user = userMessage;
    const data = totals[user];

    let reply = '';

    if (!data) {
      reply = `❌ No encontré movimientos para el usuario *${user}*. Verificá que esté bien escrito.`;
    } else {
      const net = data.deposits - data.withdrawals;

      if (net <= 1) {
        reply = `ℹ️ Usuario: *${user}*\nDepósitos: ${data.deposits}\nRetiros: ${data.withdrawals}\n\nEl total neto es ${net}. No aplica el 8%.`;
      } else {
        const bonus = (net * 0.08).toFixed(2);
        reply = `✅ Usuario: *${user}*\n\n💰 Depósitos: ${data.deposits}\n💸 Retiros: ${data.withdrawals}\n📊 Total neto: ${net}\n\n🎁 El *8%* de tu total neto es *${bonus}*.`;
      }
    }

    // Enviar respuesta a Kommo
    await axios.post('https://api.kommo.com/v1/messages', {
      chat_id: chatId,
      message: reply
    }, {
      headers: {
        Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error en webhook:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
