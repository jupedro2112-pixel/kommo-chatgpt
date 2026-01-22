require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express(); // ← ESTA LÍNEA DEBE IR ANTES DE USAR `app`

const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;

app.post('/webhook-kommo', async (req, res) => {
  try {
    console.log('📩 Webhook recibido de Kommo:\n', JSON.stringify(req.body, null, 2));

    const { message, chat_id } = req.body;

    if (!message || !chat_id) {
      return res.status(400).json({ error: 'Missing message or chat_id' });
    }

    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: message }]
    }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const reply = openaiResponse.data.choices[0].message.content.trim();

    await axios.post(`https://${KOMMO_SUBDOMAIN}.kommo.com/api/v4/chats/messages`, {
      chat_id: chat_id,
      message: reply
    }, {
      headers: {
        Authorization: `Bearer ${KOMMO_ACCESS_TOKEN}`,
        'Content-Type': 'application/json'
      }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/', (req, res) => {
  res.send('Kommo + OpenAI chatbot is running.');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
