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

// Función para obtener respuesta de OpenAI
const obtenerRespuestaChatGPT = async (mensaje) => {
  try {
    const response = await openai.Completion.create({
      model: "gpt-4",
      prompt: mensaje,
      max_tokens: 150
    });
    console.log('Respuesta de ChatGPT:', response.choices[0].text.trim());
  } catch (error) {
    console.error('Error al obtener respuesta de OpenAI:', error);
  }
};

// Enviar mensaje a Kommo
const enviarMensajeAKommo = async (mensaje) => {
  const url = 'https://{subdominio}.kommo.com/api/v4/messages'; // Reemplaza con tu subdominio de Kommo
  try {
    const response = await axios.post(url, {
      message: mensaje,
      contact: 'id_del_contacto', // Aquí debes poner el ID del contacto de Kommo al que quieres enviar el mensaje
    }, {
      headers: {
        'Authorization': `Bearer ${kommoApiToken}`
      }
    });
    console.log('Mensaje enviado a Kommo:', response.data);
  } catch (error) {
    console.error('Error al enviar mensaje a Kommo:', error);
  }
};

// Prueba las funciones
obtenerRespuestaChatGPT('Hola, ¿cómo estás?');
enviarMensajeAKommo('Hola desde mi aplicación que usa OpenAI y Kommo!');
