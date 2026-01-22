// Importamos las librerías necesarias
import axios from 'axios';
import dotenv from 'dotenv';
import kommodesarrolladores from '@api/kommodesarrolladores';

// Cargar las variables de entorno
dotenv.config();

// Autenticación de Kommo
kommodesarrolladores.auth(process.env.KOMMO_API_KEY);

// Configuración de OpenAI
const { Configuration, OpenAIApi } = require('openai');
const openai = new OpenAIApi(new Configuration({
  apiKey: process.env.OPENAI_API_KEY
}));

// Función que se conecta a Kommo y obtiene todos los contactos
const getContacts = async () => {
  try {
    const response = await kommodesarrolladores.listaDeContactos();
    return response.data;
  } catch (err) {
    console.error('Error al obtener los contactos:', err);
  }
};

// Función para enviar mensaje a Kommo
const sendMessageToKommo = async (message, contactId) => {
  try {
    const response = await axios.post('https://dxzwuwtc.kommo.com/api/v4/messages', {
      message,
      contact: contactId
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.KOMMO_API_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    return response.data;
  } catch (err) {
    console.error('Error al enviar mensaje a Kommo:', err);
  }
};

// Función que llama a OpenAI para obtener una respuesta
const getOpenAIResponse = async (inputMessage) => {
  try {
    const response = await openai.createCompletion({
      model: 'text-davinci-003', // Puedes cambiar el modelo según lo que necesites
      prompt: inputMessage,
      max_tokens: 100
    });
    return response.data.choices[0].text.trim();
  } catch (err) {
    console.error('Error al obtener respuesta de OpenAI:', err);
  }
};

// Función principal que combina todo
const main = async () => {
  const contacts = await getContacts();  // Obtener todos los contactos

  for (const contact of contacts) {
    // Suponiendo que el contacto tiene un campo "message" que es el último mensaje que enviaron
    const message = contact.message || '¡Hola, cómo puedo ayudarte?';
    console.log('Mensaje recibido:', message);
    
    // Obtener la respuesta de OpenAI
    const openAIResponse = await getOpenAIResponse(message);
    
    // Enviar la respuesta a Kommo
    await sendMessageToKommo(openAIResponse, contact.id);
    console.log('Mensaje enviado a Kommo:', openAIResponse);
  }
};

// Ejecutamos el código principal
main();
