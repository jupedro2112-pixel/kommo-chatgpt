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

function calcularTotalesPorUsuario(rows) {
  const resultados = {};

  rows.forEach(row => {
    const tipo = (row[0] || '').toLowerCase(); // deposit / withdraw
    const usuario = (row[1] || '').trim().toLowerCase();
    const monto = parseFloat(row[2]) || 0;

    if (!usuario) return;

    if (!resultados[usuario]) {
      resultados[usuario] = { deposits: 0, withdrawals: 0 };
    }

    if (tipo === 'deposit') {
      resultados[usuario].deposits += monto;
    } else if (tipo === 'withdraw') {
      resultados[usuario].withdrawals += monto;
    }
  });

  return resultados;
}

app.post('/webhook-kommo', async (req, res) => {
  try {
    const messageData = req.body.message?.add?.[0];
    if (!messageData) return res.status(400).json({ error: 'No se encontró mensaje válido' });

    const userInput = messageData.text?.trim().toLowerCase();
    const chatId = messageData.chat_id;

    const sheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg';
    const range = 'Sheet1!A2:D10000';
    const rows = await getSheetData(sheetId, range);
    const totales = calcularTotalesPorUsuario(rows);

    const usuario = userInput;
    const datos = totales[usuario];

    let reply;

    if (!datos) {
      reply = `❌ No encontré movimientos para el usuario *${usuario}*. Asegurate de escribirlo igual que en la hoja.`;
    } else {
      const neto = datos.deposits - datos.withdrawals;

      if (neto <= 1) {
        reply = `ℹ️ Usuario: *${usuario}*\n💰 Depósitos: ${datos.deposits}\n💸 Retiros: ${datos.withdrawals}\n\nEl total neto es ${neto}. No aplica el 8%.`;
      } else {
        const bonus = (neto * 0.08).toFixed(2);
        reply = `✅ Usuario: *${usuario}*\n\n💰 Depósitos: ${datos.deposits}\n💸 Retiros: ${datos.withdrawals}\n📊 Total neto: ${neto}\n\n🎁 El *8%* de tu total neto es *${bonus}*.`;
      }
    }

    await axios.post(
      'https://api.kommo.com/v1/messages',
      {
        chat_id: chatId,
        message: reply,
      },
      {
        headers: {
          Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error en webhook:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
