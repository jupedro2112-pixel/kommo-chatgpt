app.post('/webhook-kommo', async (req, res) => {
  try {
    console.log('📩 Webhook recibido de Kommo:');
    console.log('Body:', JSON.stringify(req.body, null, 2));

    const messageData = req.body.message?.add?.[0];

    if (!messageData) {
      return res.status(400).json({ error: 'No se encontró mensaje válido en el webhook' });
    }

    const userMessage = messageData.text;
    const chatId = messageData.chat_id;

    // Agregar log de datos antes de la solicitud a Kommo
    console.log('✉️ Enviando mensaje a Kommo con los siguientes datos:');
    console.log('Chat ID:', chatId);
    console.log('Mensaje:', userMessage);
    console.log('🔐 Kommo Subdomain:', KOMMO_SUBDOMAIN);
    console.log('🔐 Longitud de Token Kommo:', KOMMO_ACCESS_TOKEN.length); // Sólo la longitud del token (sin mostrarlo)

    // Enviar mensaje a OpenAI
    const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: userMessage }]
    }, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const reply = openaiResponse.data.choices[0].message.content.trim();

    // Enviar respuesta al chat en Kommo
    await axios.post(`https://api.kommo.com/v1/messages`, {
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
