require('dotenv').config();  // Para cargar las variables de entorno
const express = require('express');  // Importar Express
const axios = require('axios');  // Importar axios

const app = express();  // Aquí estamos creando la instancia de Express

const PORT = process.env.PORT || 3000;

app.use(express.json());  // Middleware para procesar JSON en las peticiones
app.use(express.urlencoded({ extended: true }));  // Middleware para procesar datos de formularios (si es necesario)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_ACCESS_TOKEN = process.env.KOMMO_ACCESS_TOKEN;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN;

// Tu endpoint de webhook
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

    // Enviar mensaje a OpenAI
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: userMessage }]
    }, {
      headers: {
        Authorization: Bearer ${OPENAI_API_KEY},
        'Content-Type': 'application/json'
      }
    });

    // Verificar respuesta
    console.log("🧠 Raw OpenAI response:", JSON.stringify(openaiResponse.data, null, 2));
    console.log("💬 Mensaje completo:", JSON.stringify(openaiResponse.data.choices[0].message, null, 2));

    const reply = openaiResponse.data.choices[0].message.content.trim();
    console.log('📨 Respuesta generada por ChatGPT:', reply);

    if (!reply) {
      return res.status(400).json({ error: 'No se generó una respuesta válida de OpenAI' });
    }

    // Enviar respuesta al chat en Kommo
    await axios.post(`https://api.kommo.com/v1/messages`, {
      chat_id: chatId,
      message: reply
    }, {
      headers: {
        Authorization: Bearer ${KOMMO_ACCESS_TOKEN},
        'Content-Type': 'application/json'
      }
    });

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('❌ Error en webhook:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// Inicia el servidor de Express
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
