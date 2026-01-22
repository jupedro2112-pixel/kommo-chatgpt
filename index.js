// Cargar las variables de entorno desde el archivo .env
require('dotenv').config();

// Leer las claves de OpenAI y Kommo desde las variables de entorno
const openaiApiKey = process.env.OPENAI_API_KEY;
const kommoApiToken = process.env.KOMMO_API_TOKEN;

// Asegurarse de que las claves no estén vacías
if (!openaiApiKey || !kommoApiToken) {
  console.error("Error: Las claves de API de OpenAI o Kommo no están configuradas.");
  process.exit(1); // Detener la ejecución si faltan las claves
}

const openai = require('openai');
const axios = require('axios');

openai.apiKey = openaiApiKey;

// Mostrar las claves en la consola (puedes eliminar esto después de probar)
console.log('¡Hola, mundo!');
console.log('API Key de OpenAI:', openaiApiKey);
console.log('API Key de Kommo:', kommoApiToken);

// URL para obtener todos los contactos (leads) de Kommo
const urlContactos = `https://dxzwuwtc.kommo.com/api/v4/contacts`;

// Obtener todos los contactos de Kommo
const obtenerContactosDeKommo = async () => {
  try {
    const response = await axios.get(urlContactos, {
      headers: {
        'Authorization': `Bearer ${kommoApiToken}`  // Usamos el token de API de Kommo en los encabezados
      }
    });

    const contactos = response.data._embedded.contacts;  // Los contactos estarán en esta parte de la respuesta
    console.log('Contactos obtenidos:', contactos);

    // Enviar un mensaje a cada contacto
    contactos.forEach(contacto => {
      const contactoId = contacto.id;  // Obtenemos el ID del contacto
      responderConIA(contactoId);
    });

  } catch (error) {
    console.error('Error al obtener contactos de Kommo:', error);
  }
};

// Función para interactuar con OpenAI (ChatGPT)
const obtenerRespuestaChatGPT = async (mensaje) => {
  try {
    const response = await openai.Completion.create({
      model: "gpt-4", // Usamos el modelo GPT-4
      prompt: mensaje,
      max_tokens: 150
    });

    // Regresamos la respuesta de ChatGPT
    return response.choices[0].text.trim();
  } catch (error) {
    console.error('Error al obtener respuesta de OpenAI:', error);
    return 'Lo siento, hubo un error al generar la respuesta.';
  }
};

// Función para enviar el mensaje a Kommo
const enviarMensajeAKommo = async (contactoId, mensaje) => {
  const urlMensajes = `https://dxzwuwtc.kommo.com/api/v4/messages`;

  try {
    const response = await axios.post(urlMensajes, {
      message: mensaje,
      contact: contactoId,  // Usamos el ID del contacto para enviar el mensaje
    }, {
      headers: {
        'Authorization': `Bearer ${kommoApiToken}`
      }
    });

    console.log(`Mensaje enviado a contacto ${contactoId}:`, response.data);
  } catch (error) {
    console.error(`Error al enviar mensaje al contacto ${contactoId}:`, error);
  }
};

// Función para responder a un cliente usando OpenAI y luego enviar el mensaje a Kommo
const responderConIA = async (contactoId) => {
  const mensajeDeEntrada = 'Hola, ¿en qué puedo ayudarte?';  // Este sería el mensaje de entrada para interactuar con el cliente

  // Obtener la respuesta de la IA (OpenAI)
  const respuestaIA = await obtenerRespuestaChatGPT(mensajeDeEntrada);

  // Enviar la respuesta generada a Kommo para el contacto
  await enviarMensajeAKommo(contactoId, respuestaIA);
};

// Llamar a la función para obtener los contactos y enviar respuestas con IA
obtenerContactosDeKommo();
