require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { OpenAIApi, Configuration } = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================== MEMORIA Y ESTADOS ==================
const messageBuffer = new Map(); 
const userStates = new Map(); 

// Nombres para la identidad dinámica (Mujeres)
const AGENT_NAMES = [
  "Camila", "Sofía", "Valentina", "Martina", "Lucía", 
  "Florencia", "Julieta", "Micaela", "Carolina", "Daniela",
  "Rocío", "Antonella", "Paula", "Mariana", "Victoria"
];

// Limpieza de estados inactivos cada 1 hora
setInterval(() => {
  const now = Date.now();
  for (const [id, state] of userStates.entries()) {
    if (now - state.lastActivity > 24 * 60 * 60 * 1000) userStates.delete(id);
  }
}, 60 * 60 * 1000);

// ================== CONFIGURACIÓN ==================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CHATWOOT_ACCESS_TOKEN = process.env.CHATWOOT_ACCESS_TOKEN;
const CHATWOOT_BASE_URL = process.env.CHATWOOT_BASE_URL || 'https://app.chatwoot.com';

const configuration = new Configuration({ apiKey: OPENAI_API_KEY });
const openai = new OpenAIApi(configuration);

// ================== UTILIDADES ==================
function cleanHtml(html) {
  if (!html) return "";
  return String(html).replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim();
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function getRandomName() {
  return AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
}

// ================== CHATWOOT ==================
async function sendReplyToChatwoot(accountId, conversationId, message) {
  if (!CHATWOOT_ACCESS_TOKEN) return;
  try {
    const url = `${CHATWOOT_BASE_URL}/api/v1/accounts/${accountId}/conversations/${conversationId}/messages`;
    await axios.post(url, {
      content: message,
      message_type: 'outgoing',
      private: false
    }, { headers: { 'api_access_token': CHATWOOT_ACCESS_TOKEN } });
    console.log(`✅ Respuesta enviada a Chatwoot.`);
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

// ================== IA GENERATOR (Vendedora de Cortinas) ==================
async function generateSalesReply(userMessage, agentName) {
  const systemPrompt = `
    Sos ${agentName}, una asesora comercial experta en venta de cortinas y decoración.
    
    TUS INSTRUCCIONES:
    1.  **ROL**: Actúa como una empleada humana real de una tienda de cortinas en Argentina.
    2.  **TONO**: Profesional, serio, educado y con modismos argentinos naturales (ej: "Hola, ¿cómo estás?", "Te comento", "Quedo a tu disposición", "Perfecto"). NO seas exageradamente entusiasta ni uses emojis en exceso.
    3.  **OBJETIVO**: Tu meta es CERRAR LA VENTA o conseguir que el cliente pase sus medidas para cotizar.
    4.  **PRODUCTOS**: Sabés de Blackout, Sunscreen, Roller, Bandas verticales, Rieles, Voile, Lino.
    5.  **RESTRICCIÓN ABSOLUTA**: NUNCA menciones que sos una IA, un bot o ChatGPT. Si te preguntan algo personal, evadilo con elegancia y volvé al tema de las cortinas.
    6.  **ACCIÓN**: Si el cliente no dio medidas, pedilas (ancho x alto). Si ya las dio, ofrecele un presupuesto estimado o pedile detalles del ambiente.

    Nombre actual en esta conversación: ${agentName}.
  `;

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini', // Ajusta el modelo según tu disponibilidad
      temperature: 0.3, // Temperatura baja para mantener profesionalismo y consistencia
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    console.error("❌ Error OpenAI:", err.message);
    return "Disculpá, estoy verificando el stock en el sistema. ¿Podrías repetirme la consulta?";
  }
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, fullMessage) {
  // 1. Gestión de Identidad (Nombre dinámico)
  let state = userStates.get(conversationId);
  
  if (!state) {
    // Si es una conversación nueva, asignamos una vendedora al azar
    state = { 
      agentName: getRandomName(), 
      lastActivity: Date.now() 
    };
    console.log(`🆕 Nueva conversación (${conversationId}). Atiende: ${state.agentName}`);
  } else {
    state.lastActivity = Date.now();
  }
  
  userStates.set(conversationId, state);

  console.log(`💬 Msg para ${state.agentName}: "${fullMessage}"`);

  // 2. Generar respuesta de venta
  const reply = await generateSalesReply(fullMessage, state.agentName);

  // 3. Enviar respuesta
  await sendReplyToChatwoot(accountId, conversationId, reply);
}

// ================== WEBHOOK ==================
app.post('/webhook-chatwoot', (req, res) => {
  res.status(200).send('OK');

  const body = req.body;
  if (body.event !== 'message_created' || body.message_type !== 'incoming') return;

  const conversationId = body.conversation?.id;
  const accountId = body.account?.id;
  const content = cleanHtml(body.content);

  if (!conversationId || !content) return;

  // Lógica de Buffer (esperar si el usuario manda varios mensajes seguidos)
  if (!messageBuffer.has(conversationId)) {
    messageBuffer.set(conversationId, { messages: [], timer: null });
  }

  const buffer = messageBuffer.get(conversationId);
  buffer.messages.push(content);

  if (buffer.timer) clearTimeout(buffer.timer);

  // Esperamos 3 segundos a que el usuario termine de escribir sus mensajes
  buffer.timer = setTimeout(() => {
    const fullText = buffer.messages.join(" . ");
    messageBuffer.delete(conversationId);
    
    (async () => {
      // AQUÍ ESTÁ LA DEMORA DE 4 SEGUNDOS SOLICITADA
      console.log(`⏳ Escribiendo... (Simulando humano 4s)`);
      await sleep(4000); 
      
      await processConversation(accountId, conversationId, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot Cortinas (Vendedora Humana) Activo en puerto ${PORT}`));
