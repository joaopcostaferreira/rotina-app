// Configuração do projeto Firebase (Configurações do projeto > Seus apps > App da Web).
//
// Esses valores NÃO são secretos: eles identificam o projeto e podem ficar
// públicos no GitHub. Quem protege os dados são as regras do Firestore
// (arquivo firestore.rules), que só deixam cada pessoa ler/escrever os próprios dados.

export const firebaseConfig = {
  apiKey: 'AIzaSyBqTSi75VQ4xojupmVruSvAqFcx6V-Diyk',
  authDomain: 'rotina-app-4b367.firebaseapp.com',
  projectId: 'rotina-app-4b367',
  storageBucket: 'rotina-app-4b367.firebasestorage.app',
  messagingSenderId: '632004387570',
  appId: '1:632004387570:web:7ba46be7a03e799c9f666b',

  // Para os avisos chegarem com o app fechado: Configurações do projeto > Cloud Messaging >
  // Configuração da Web > Certificados push da Web > "Gerar par de chaves". Cole aqui a chave.
  vapidKey: '',
};
