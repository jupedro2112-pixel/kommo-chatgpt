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
  "Cami", "Sofi", "Valen", "Martu", "Lu", 
  "Flor", "Juli", "Mica", "Caro", "Dani",
  "Rochi", "Anto", "Pau", "Marian", "Vicky"
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
    Sos ${agentName}, vendés cortinas. Tu personalidad es: "De entre casa", super amigable, relajada, como si hablaras con una amiga/o, pero queriendo cerrar la venta. Nada corporativo ni robotizado.

    REGLAS DE ORO:
    1. NO SALUDES todo el tiempo. Si ya venís hablando, andá al grano.
    2. RESPUESTAS CORTAS Y RESUMIDAS. La gente no lee textos largos.
    3. OPINIÓN PERSONAL: Tirá siempre algún dato tuyo random pero útil (ej: "A mí me encanta el lino para el living porque deja pasar linda luz", "Yo en mi pieza puse blackout porque odio que me entre sol a la mañana").
    4. CÁLCULO DE PRECIO (Fórmula):
       - Si te dan medidas (Ancho x Alto), calculá así: (Ancho * Alto * 0.000184 * 1500).
       - El resultado es en DÓLARES. Pasalo tal cual.

    INFO COMERCIAL (Tirala de a poco, no todo junto):
    - Pago: 6 cuotas SIN interés o 10% OFF en efectivo.
    - Demora: 10 días (se hacen a pedido).
    - Flete: ¡Gratis si compra en las próximas 48hs! (Usalo para cerrar).
    - Colocación: Decile que ronda el 10% del valor de la cortina aprox.
    - Telas: Ofrecé de todo (Blackout, Sunscreen, Voile, Lino, Roller, Bandas).

    IDENTIDAD:
    - Sos humana, Argentina.
    - Tu nombre es ${agentName}.
    - NUNCA digas que sos una IA.
  `;

  try {
    const resp = await openai.createChatCompletion({
      model: 'gpt-4o-mini', 
      temperature: 0.6, // Un poco más alta para que sea más natural y "charlatana"
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
    });
    return resp.data?.choices?.[0]?.message?.content;
  } catch (err) {
    console.error("❌ Error OpenAI:", err.message);
    return "Uy, se me colgó el sistema un segundo. ¿Me repetís?";
  }
}

// ================== PROCESAMIENTO ==================
async function processConversation(accountId, conversationId, fullMessage) {
  // 1. Gestión de Identidad (Nombre dinámico)
  let state = userStates.get(conversationId);
  
  if (!state) {
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

  // 2. Generar respuesta
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

  // Lógica de Buffer
  if (!messageBuffer.has(conversationId)) {
    messageBuffer.set(conversationId, { messages: [], timer: null });
  }

  const buffer = messageBuffer.get(conversationId);
  buffer.messages.push(content);

  if (buffer.timer) clearTimeout(buffer.timer);

  // Esperamos 3 segundos a que termine de mandar mensajes
  buffer.timer = setTimeout(() => {
    const fullText = buffer.messages.join(" . ");
    messageBuffer.delete(conversationId);
    
    (async () => {
      // DEMORA DE 4 SEGUNDOS (Simula que lee y escribe)
      console.log(`⏳ Escribiendo... (Simulando humano 4s)`);
      await sleep(4000); 
      
      await processConversation(accountId, conversationId, fullText);
    })();
  }, 3000);
});

app.listen(PORT, () => console.log(`🚀 Bot Cortinas (Vendedora Amigable) Activo en puerto ${PORT}`));
