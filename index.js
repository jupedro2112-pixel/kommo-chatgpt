require("dotenv").config();

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json({ limit: "2mb" }));

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const KOMMO_SUBDOMAIN = process.env.KOMMO_SUBDOMAIN; // ej: dxzwuwtc
const KOMMO_API_TOKEN = process.env.KOMMO_API_TOKEN; // token Bearer

// Render te da PORT automáticamente
const PORT = process.env.PORT || 3000;

function assertEnv(name, value) {
  if (!value) {
    console.error(`Falta variable de entorno: ${name}`);
    process.exit(1);
  }
}

assertEnv("OPENAI_API_KEY", OPENAI_API_KEY);
assertEnv("KOMMO_SUBDOMAIN", KOMMO_SUBDOMAIN);
assertEnv("KOMMO_API_TOKEN", KOMMO_API_TOKEN);

// 1) Ruta para probar en el navegador
app.get("/", (req, res) => {
  res.status(200).send("OK: servidor activo ✅");
});

// 2) Healthcheck
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// 3) Webhook de Kommo (Kommo te va a pegar acá)
app.post("/kommo-webhook", async (req, res) => {
  try {
    // IMPORTANTE:
    // El formato exacto del webhook depende de cómo lo configures en Kommo.
    // Por ahora lo dejamos "genérico" para que NO crashee.
    console.log("Webhook recibido de Kommo:", JSON.stringify(req.body).slice(0, 800));

    // Respondemos 200 rápido para que Kommo no reintente
    res.status(200).json({ received: true });

    // -----
    // En el próximo paso, cuando me pegues un ejemplo real del payload del webhook,
    // acá mismo sacamos: texto del mensaje, chat_id/conversación y respondemos con OpenAI.
    // -----

  } catch (err) {
    console.error("Error en /kommo-webhook:", err?.message || err);
    // Igual respondemos 200 para que Kommo no te bombardee
    res.status(200).json({ received: true, error: true });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
