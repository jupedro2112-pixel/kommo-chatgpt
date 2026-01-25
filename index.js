require('dotenv').config();  // Para cargar las variables de entorno
const express = require('express');  // Importar Express
const axios = require('axios');  // Importar axios
const { google } = require('googleapis'); // Importar Google APIs
const { GoogleAuth } = require('google-auth-library'); // Para autenticación de Google

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());  // Middleware para procesar JSON
app.use(express.urlencoded({ extended: true }));  // Middleware para datos de formularios

// ================== ENV ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const GOOGLE_CREDENTIALS = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);

// Memoria de sesión temporal para manejar pasos de conversación
const sessionMemory = {};

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

    if (type === 'withdraw') {
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

    // Leer datos desde Google Sheets
    const spreadsheetId = '16rLLI5eZ283Qvfgcaxa1S-dC6g_yFHqT9sfDXoluTkg'; // <-- actualizalo si cambia
    const range = 'Sheet1!A2:D10000';
    const rows = await getSheetData(spreadsheetId, range);
    const totals = calculateTotalsByUser(rows);

    console.log(`📊 Totales calculados: ${JSON.stringify(totals, null, 2)}`);

    // Verificar si el usuario ya está en la memoria
    if (!sessionMemory[chatId]) {
      sessionMemory[chatId] = { step: 'ask_user' }; // Si es la primera vez, preguntar por el nombre de usuario
    }

    // Paso 1: Preguntar por el usuario si no lo ha enviado
    if (sessionMemory[chatId].step === 'ask_user') {
      await sendReply(
        chatId,
        '👋 Hola! Soy el asistente. Por favor, indícame tu *usuario completo* para calcular tu balance.'
      );
      sessionMemory[chatId].step = 'waiting_user'; // Cambiamos el paso a esperar el usuario
      return res.sendStatus(200); // Respondemos con un 200 para finalizar este paso
    }

    // Paso 2: Procesar el nombre de usuario cuando el bot ya ha preguntado
    if (sessionMemory[chatId].step === 'waiting_user') {
      const data = totals[userMessage]; // Buscar el usuario en los totales calculados

      // Si el usuario no está en los datos, pida que lo verifique
      if (!data) {
        await sendReply(
          chatId,
          `❌ No encontré movimientos para el usuario *${userMessage}*. Por favor, verifica que esté bien escrito. ¿Puedes intentar de nuevo?`
        );
        return res.sendStatus(200);
      }

      // Calcular el total neto y determinar el reembolso
      const net = data.deposits - data.withdrawals;

      if (net <= 1) {
        await sendReply(
          chatId,
          `ℹ️ Usuario: *${userMessage}*\nDepósitos: ${data.deposits}\nRetiros: ${data.withdrawals}\n\nEl total neto es ${net}. No aplica el 8%.`
        );
      } else {
        const bonus = (net * 0.08).toFixed(2);
        await sendReply(
          chatId,
          `✅ Usuario: *${userMessage}*\n\n💰 Depósitos: ${data.deposits}\n💸 Retiros: ${data.withdrawals}\n📊 Total neto: ${net}\n\n🎁 El *8%* de tu total neto es *${bonus}*.`
        );
      }

      // El bot ha procesado la solicitud, eliminar el paso de la memoria
      delete sessionMemory[chatId];
      return res.sendStatus(200);
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
