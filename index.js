require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 👉 1. ENDPOINT TEMPORAL DE DEBUG (AGREGAR ACÁ)
app.get('/debug/kommo-scopes', async (req, res) => {
  try {
    const response = await axios.get(
      'https://amojo.kommo.com/v2/origin/custom',
      {
        headers: {
          Authorization: `Bearer ${process.env.KOMMO_ACCESS_TOKEN}`
        }
      }
    );

    res.json(response.data);
  } catch (err) {
    console.error('❌ Error scopes:', err.response?.data || err.message);
    res.status(500).json(err.response?.data || err.message);
  }
});

// 👉 2. TU WEBHOOK (SE QUEDA TAL CUAL)
app.post('/webhook-kommo', async (req, res) => {
  try {
    console.log('📩 Webhook recibido de Kommo:');
    console.log(JSON.stringify(req.body, null, 2));

    // todo tu código actual...
    res.status(200).json({ ok: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'error' });
  }
});

// 👉 3. SERVER
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});
