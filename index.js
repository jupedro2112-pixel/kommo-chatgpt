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
const kommodesarrolladores = require('@api/kommodesarrolladores');

// Autenticación con la API de Kommo
kommodesarrolladores.auth(kommoApiToken);

// Inicializar OpenAI
openai.apiKey = openaiApiKey;

// Mostrar las claves en la consola (puedes eliminar esto después de probar)
console.log('¡Hola, mundo!');
console.log('API Key de OpenAI:', openaiApiKey);
console.log('API Key de Kommo:', kommoApiToken);

// Función para obtener respuesta de OpenAI
const obtenerRespuestaChatGPT = async (mensaje) => {
  try {
    const response = await openai.Completion.create({
      model: "gpt-4",
      prompt: mensaje,
      max_tokens: 150
    });
    console.log('Respuesta de ChatGPT:', response.choices[0].text.trim());
    return response.choices[0].text.trim(); // Retornar la respuesta para enviarla a Kommo
  } catch (error) {
    console.error('Error al obtener respuesta de OpenAI:', error);
    return "Lo siento, hubo un error al generar la respuesta.";
  }
};

// Función para enviar el mensaje a Kommo
const enviarMensajeAKommo = async (mensaje) => {
  try {
    // Obtener la lista de contactos de Kommo
    const { data } = await kommodesarrolladores.listaDeContactos();
    
    if (data && data.length > 0) {
      const contactoId = data[0].id; // Obtener el ID del primer contacto (puedes personalizar esto)
      
      const respuestaChatGPT = await obtenerRespuestaChatGPT(mensaje);

      // Enviar el mensaje a Kommo usando el ID del primer contacto
      const response = await kommodesarrolladores.enviarMensaje({
        message: respuestaChatGPT, 
        contact: contactoId
      });
      
      console.log('Mensaje enviado a Kommo:', response);
    } else {
      console.error('No se encontraron contactos en Kommo.');
    }
  } catch (error) {
    console.error('Error al enviar mensaje a Kommo:', error);
  }
};

// Prueba las funciones
enviarMensajeAKommo('Hola desde mi aplicación que usa OpenAI y Kommo!');
