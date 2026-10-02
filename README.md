# Rotina — app web de rotina pessoal

To-do list diária agrupada por categorias (Religião, Relacionamento, Trabalho, Saúde…), com clientes dentro do trabalho, rotina semanal fixa, calendário para editar dias específicos e um quadro de horários só para consulta.

- **Site estático**: só HTML, CSS e JavaScript. Não precisa instalar nada nem "compilar".
- **Login com Google** (Firebase Auth): cada pessoa tem seus próprios dados e configurações.
- **Banco na nuvem** (Firestore), com cache offline: abre e funciona sem internet e sincroniza depois.
- **Responsivo e instalável**: no celular vira um app na tela inicial (PWA).
- **Notificações** no celular e no computador, mesmo com o app fechado (envio pelo GitHub Actions, de graça). Cada pessoa ativa nos Ajustes e escolhe o que quer receber.

> Enquanto o Firebase não estiver configurado, o app roda em **modo demonstração**: tudo fica salvo só no navegador, com dados de exemplo.

---

## 1. Publicar no GitHub Pages

1. Crie um repositório no GitHub (ex.: `rotina`). Pode ser público ou privado (para privado, o GitHub Pages exige plano pago).
2. Clique em **Add file › Upload files** e arraste **todo o conteúdo desta pasta** (o `index.html` precisa ficar na raiz do repositório). Clique em **Commit changes**.
   - Confira se a pasta `.github` (com `workflows/notificacoes.yml` dentro) também subiu. Pastas que começam com ponto às vezes ficam ocultas no Windows. Se ela não aparecer no repositório, crie pelo site: **Add file › Create new file**, digite o nome `.github/workflows/notificacoes.yml` e cole o conteúdo do arquivo.
3. Vá em **Settings › Pages**. Em *Build and deployment*, escolha **Deploy from a branch**, branch **main**, pasta **/ (root)** e salve.
4. Em 1–2 minutos o site fica no ar em `https://SEU-USUARIO.github.io/rotina/`.

Já dá para abrir e testar no modo demonstração.

## 2. Ativar o login Google (Firebase)

Tudo isso é feito no site do Firebase, no plano gratuito.

1. Acesse [console.firebase.google.com](https://console.firebase.google.com) e clique em **Criar projeto**. O Google Analytics pode ficar desativado.
2. **Login com Google**: menu **Criação › Authentication › Vamos começar › Método de login › Google**. Ative, escolha o e-mail de suporte e salve.
3. **Autorizar seu site**: ainda em Authentication, abra **Configurações › Domínios autorizados › Adicionar domínio** e coloque `SEU-USUARIO.github.io` (sem `https://` e sem `/rotina`).
4. **Banco de dados**: menu **Criação › Firestore Database › Criar banco de dados**. Escolha a região `southamerica-east1 (São Paulo)` e o **modo de produção**.
5. **Regras de segurança**: no Firestore, aba **Regras**. Apague o que estiver lá, cole o conteúdo do arquivo [`firestore.rules`](firestore.rules) e clique em **Publicar**. Com essas regras, só e-mails liberados entram, e cada pessoa só lê e grava os próprios dados.
6. **Pegar a configuração**: clique na engrenagem **› Configurações do projeto › Seus apps** e no ícone **`</>`** (Web). Dê um apelido e registre (não precisa marcar o Firebase Hosting). Ele mostra um bloco `const firebaseConfig = { ... }`.
7. No GitHub, abra o arquivo `js/firebase-config.js`, clique no lápis (editar) e preencha os valores com os do passo anterior. Exemplo:

   ```js
   export const firebaseConfig = {
     apiKey: 'AIza...',
     authDomain: 'meu-projeto.firebaseapp.com',
     projectId: 'meu-projeto',
     storageBucket: 'meu-projeto.firebasestorage.app',
     messagingSenderId: '1234567890',
     appId: '1:1234567890:web:abc123',
   };
   ```

   Clique em **Commit changes**. Esses valores **não são senhas**: podem ficar públicos no GitHub. Quem protege os dados são as regras do passo 5.

8. **Torne-se o administrador** (só esta vez, pelo site do Firebase). Só e-mails liberados conseguem entrar no app, então o primeiro tem que ser o seu:
   1. No Firestore, aba **Dados**, clique em **+ Iniciar coleção**.
   2. Em *ID da coleção*, digite `permitidos` e avance.
   3. Em *ID do documento*, digite **o seu e-mail Google, todo em letras minúsculas** (ex.: `seunome@gmail.com`).
   4. Adicione um campo: nome `admin`, tipo **boolean**, valor **true**. Salve.
9. Espere 1–2 minutos, abra o site e clique em **Entrar com Google**. No primeiro acesso, o app cria as categorias iniciais (Religião, Relacionamento, Trabalho e Saúde), que você pode editar.
10. **Liberar outras pessoas**: no app, menu **Acessos** (só administradores veem). Digite o e-mail Google da pessoa e clique em **Liberar acesso**. Ela já pode entrar na hora. Quem não estiver na lista vê a mensagem "Acesso não liberado".

> Cada pessoa tem a própria rotina, categorias, clientes e tarefas. Nada se mistura: nem o administrador vê os dados dos outros pelo app. A lista de e-mails liberados fica só no Firebase, nunca no GitHub.

> O GitHub Pages pode demorar até 10 minutos para entregar a versão nova de um arquivo. Se algo não mudou, espere um pouco e recarregue a página.

## 3. Ativar as notificações

Funcionam de dois jeitos:

- **Com o app aberto** (aba no computador ou app aberto no celular): o próprio app avisa, na hora exata. Já funciona depois do passo 2.
- **Com o app fechado**: o GitHub Actions confere a cada ~5 minutos e envia o aviso pelo Firebase Cloud Messaging. Pode chegar alguns minutos atrasado (o GitHub às vezes atrasa a execução em 10–15 min nos horários de pico).

Para ligar o envio com o app fechado (uma vez só):

1. **Chave da Web**: no Firebase, engrenagem **› Configurações do projeto › Cloud Messaging**. Em *Configuração da Web › Certificados push da Web*, clique em **Gerar par de chaves**. Copie a chave e cole em `vapidKey` no arquivo `js/firebase-config.js` (no GitHub, pelo lápis).
2. **Chave do servidor**: ainda em Configurações do projeto, aba **Contas de serviço › Gerar nova chave privada**. Vai baixar um arquivo `.json`.
3. **Guardar no GitHub como segredo**: no repositório, **Settings › Secrets and variables › Actions › New repository secret**. Nome: `FIREBASE_SERVICE_ACCOUNT`. Valor: abra o `.json` no Bloco de Notas, copie **todo** o conteúdo e cole. Salve.
   - ⚠️ Esse arquivo `.json` é uma senha de administrador do seu Firebase. **Nunca** envie ele para o repositório nem compartilhe. Depois de colar no GitHub, pode apagar do computador.
4. **Testar o envio**: no repositório, aba **Actions › Notificações › Run workflow**. Em alguns segundos deve aparecer um ✓ verde. A partir daí ele roda sozinho a cada 5 minutos.
5. **Em cada aparelho**: abra o app › **Ajustes › Notificações › Ativar neste aparelho** e permita quando o navegador perguntar. Toque em **Enviar teste** para ver como fica.
   - **iPhone**: só funciona com o app instalado na Tela de Início (iOS 16.4 ou mais novo). Instale primeiro (seção abaixo), abra pelo ícone e ative por lá.

**O que cada pessoa escolhe nos Ajustes**

- **Avisar antes das tarefas com horário**, com o tempo padrão (10 min, por exemplo).
- **Lembrar das tarefas pendentes no fim do dia**, no horário escolhido.
- Em cada tarefa: ligar ou desligar o aviso e mudar o tempo só daquela tarefa.

> Repositórios sem atividade por 60 dias têm o agendamento pausado pelo GitHub. O próprio workflow se reativa todo dia para evitar isso. Se mesmo assim chegar um e-mail do GitHub avisando, basta abrir a aba **Actions** e clicar em **Enable workflow**.

## 4. Instalar no celular

- **Android (Chrome)**: abra o site › menu ⋮ › **Instalar app** (ou *Adicionar à tela inicial*).
- **iPhone (Safari)**: abra o site › botão Compartilhar › **Adicionar à Tela de Início**.

## Como o app funciona

| Tela | O que faz |
| --- | --- |
| **Painel** | Progresso do dia, o que está planejado para agora e o próximo, pendências, progresso por categoria e cliente, últimos 7 dias. É a tela inicial no computador. |
| **Hoje** | To-do list do dia agrupada por categoria e, dentro dela, por cliente. Filtros por status (pendentes, atrasadas, concluídas), categoria e cliente. Só aqui (e no Painel/Calendário) se marca como concluído. Navegue entre os dias com ‹ ›. |
| **Horários** | Linha do tempo do dia, com os blocos de horário e uma linha vermelha no "agora". É só visual: concluir é na lista. |
| **Calendário** | Mês inteiro com o progresso de cada dia. Abra um dia para adicionar tarefas avulsas ou remover tarefas da rotina **só daquele dia** (dá para restaurar). |
| **Rotina** | Tarefas fixas que se repetem por dia da semana (seg a dom), sempre com horário. Elas aparecem sozinhas na lista de cada dia. |
| **Clientes** | Clientes ligados a uma categoria (normalmente Trabalho), cada um com as próprias tarefas fixas e avulsas. |
| **Categorias** | Nome, cor e ordem das categorias. |
| **Ajustes** | Como quer ser chamado, notificações, tema claro/escuro, horário de início/fim do quadro, duração padrão e sair. |
| **Acessos** | Só para administradores: liberar ou remover e-mails que podem entrar no app. |

**Regras principais**

- Tarefas são concluídas **por dia**, não por horário. O horário serve só para saber o que fazer naquele momento.
- Se o horário passar, a tarefa continua pendente, marcada como **Atrasada**, até você concluir.
- **Cronômetro (opcional)**: o botão ▶ em cada tarefa marca quanto tempo você leva nela. Pode pausar e continuar quantas vezes quiser. Iniciar outra tarefa pausa a anterior, e concluir a tarefa para o cronômetro. O total aparece em cada categoria/cliente e no Painel. Esqueceu de pausar? Edite a tarefa e corrija o "Tempo gasto".
- No celular, toque no nome da tarefa para editar ou excluir.
- Horário é **obrigatório na rotina semanal** e **opcional** nas tarefas avulsas do dia. Só tarefas com horário podem ter aviso.
- Ao abrir um dia, o app gera as tarefas da rotina daquele dia da semana que ainda não existem.
- Marcar como concluído altera só a tarefa daquele dia, nunca a rotina.
- Editar uma tarefa fixa atualiza as próximas ocorrências ainda não concluídas. Dias passados ficam como histórico.
- Uma tarefa fixa nova só começa a aparecer a partir do dia em que foi criada.

## Estrutura de dados (Firestore)

Os dados de cada pessoa ficam dentro de `users/{uid}`, e cada documento também guarda o campo `uid`:

| Caminho | Campos |
| --- | --- |
| `permitidos/{email}` | admin (true/false), liberadoPor, liberadoEm: e-mails que podem entrar |
| `users/{uid}` | nome, email, foto, fuso, apelido, tema, agendaInicio, agendaFim, duracaoPadrao, notifTarefas, avisoAntes, notifPendentes, notifPendentesHora |
| `users/{uid}/categories/{id}` | nome, cor, ordem |
| `users/{uid}/clients/{id}` | nome, categoriaId, observacoes |
| `users/{uid}/recurringTasks/{id}` | titulo, categoriaId, clienteId?, diasDaSemana [0–6], horario, duracao?, aviso, avisoAntes, inicio |
| `users/{uid}/dailyTasks/{id}` | titulo, categoriaId, clienteId?, data (AAAA-MM-DD), horario?, duracao?, aviso, avisoAntes, tempoGasto (segundos), cronometroInicio?, concluido, origem ('fixa' \| 'avulsa'), recurringTaskId?, removido |
| `users/{uid}/devices/{id}` | token, nome (ex.: "Android · Chrome"), atualizadoEm: aparelhos que recebem avisos |
| `users/{uid}/notifLog/{chave}` | data, tipo, origem: avisos já enviados (evita repetir; apagados após 2 dias) |

## Arquivos

```
index.html              página única do app
css/styles.css          visual (claro/escuro, desktop e celular)
js/app.js               telas e regras do app
js/store.js             acesso ao Firebase (ou ao navegador no modo demonstração)
js/firebase-config.js   ← cole aqui a configuração do seu projeto Firebase
js/utils.js, icons.js   funções auxiliares e ícones
manifest.webmanifest    dados para instalar no celular
sw.js                   permite abrir offline e recebe os avisos com o app fechado
icons/                  ícones do app
firestore.rules         regras de segurança do banco (colar no Firebase)
notificacoes/           script que envia os avisos (roda no GitHub Actions)
.github/workflows/      agendamento do envio a cada 5 minutos
```

## Testar no computador (opcional)

Abrir o `index.html` direto com dois cliques não funciona (o navegador bloqueia módulos JavaScript em `file://`). Para testar localmente, com o Python instalado, rode na pasta do projeto:

```bash
python -m http.server 5173
```

e abra `http://localhost:5173`. Para o login Google funcionar localmente, `localhost` já vem autorizado no Firebase.
