// Cole aqui o objeto firebaseConfig do console do Firebase
// (Configurações do projeto > Seus apps > App da Web).
//
// Esses valores NÃO são secretos: eles identificam o projeto e podem ficar
// públicos no GitHub. Quem protege os dados são as regras do Firestore
// (arquivo firestore.rules), que só deixam cada pessoa ler/escrever os próprios dados.
//
// Enquanto apiKey estiver vazio, o app roda em "modo demonstração",
// salvando tudo apenas no navegador atual.

export const firebaseConfig = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',

  // Para os avisos chegarem com o app fechado: Configurações do projeto > Cloud Messaging >
  // Configuração da Web > Certificados push da Web > "Gerar par de chaves". Cole aqui a chave.
  vapidKey: '',
};
