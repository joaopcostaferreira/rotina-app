import {
  initBackend,
  signIn,
  signOut,
  db,
  access,
  isDemo,
  resetDemo,
  pushConfigured,
  getPushToken,
  deletePushToken,
} from './store.js';
import * as U from './utils.js';
import { icon, LOGO, GOOGLE } from './icons.js';

const { esc } = U;

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const DEFAULT_PROFILE = {
  tema: 'auto',
  agendaInicio: 6,
  agendaFim: 23,
  duracaoPadrao: 30,
  apelido: '',
  notifTarefas: true, // avisar antes das tarefas com horário
  avisoAntes: 10, // minutos (padrão para tarefas novas)
  notifPendentes: false, // lembrete de pendências no fim do dia
  notifPendentesHora: '21:00',
};
const PALETA = ['#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#64748b'];
const DURACOES = [15, 30, 45, 60, 90, 120, 180, 240];
const AVISOS = [
  [0, 'Na hora'],
  [5, '5 min antes'],
  [10, '10 min antes'],
  [15, '15 min antes'],
  [30, '30 min antes'],
  [60, '1 hora antes'],
];

const S = {
  user: null,
  profile: { ...DEFAULT_PROFILE },
  categories: [],
  clients: [],
  recurring: [],
  days: {}, // 'YYYY-MM-DD' -> dailyTasks[]
  ensured: new Set(), // dias em que a rotina fixa já foi gerada
  ranges: new Set(), // intervalos já buscados (para calendário e semana)
  date: U.todayStr(), // dia aberto em Hoje / Horários
  calMonth: U.todayStr().slice(0, 7),
  calSel: U.todayStr(),
  rotinaDia: 'all',
  filtro: { status: 'todas', cat: '', cli: '' }, // filtros da tela Hoje
  lastToday: U.todayStr(),
  installEvt: null,
  ready: false,
  blocked: false, // e-mail não está na lista de permitidos
  isAdmin: false, // pode liberar outros e-mails (tela Acessos)
  acessos: null, // lista carregada na tela Acessos
};
const pending = { days: {}, ranges: {} };

const NAV = [
  { id: 'painel', label: 'Painel' },
  { id: 'hoje', label: 'Hoje' },
  { id: 'horarios', label: 'Horários' },
  { id: 'calendario', label: 'Calendário' },
  { id: 'rotina', label: 'Rotina' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'categorias', label: 'Categorias' },
  { id: 'ajustes', label: 'Ajustes' },
  { id: 'acessos', label: 'Acessos', admin: true },
];
const TABS = ['hoje', 'horarios', 'calendario', 'painel'];
const navItems = () => NAV.filter((n) => !n.admin || S.isAdmin);
const navLabel = (id) => NAV.find((n) => n.id === id)?.label || '';

// ---------------------------------------------------------------------------
// Utilidades de interface
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const root = document.getElementById('root');
const modal = document.getElementById('modal');

const catById = (id) => S.categories.find((c) => c.id === id);
const cliById = (id) => S.clients.find((c) => c.id === id);
const colorOf = (t) => catById(t.categoriaId)?.cor || '#94a3b8';
const clientsOf = (catId) => S.clients.filter((c) => c.categoriaId === catId).sort(U.byNome);
const visible = (tasks) => (tasks || []).filter((t) => !t.removido);
const duracao = (t) => t.duracao || S.profile.duracaoPadrao || 30;
const firstName = () => S.profile.apelido || (S.user?.nome || '').split(' ')[0] || 'você';
const sortCats = () =>
  S.categories.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || U.byNome(a, b));

function progress(tasks) {
  const v = visible(tasks);
  const done = v.filter((t) => t.concluido).length;
  return { done, total: v.length, pct: v.length ? Math.round((done * 100) / v.length) : 0 };
}

let toastTimer;
function toast(msg) {
  if (!msg) return;
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

const ERROS = {
  'permission-denied': 'Sem permissão no banco de dados. Publique as regras do arquivo firestore.rules no Firebase.',
  'auth/unauthorized-domain':
    'Este endereço não está autorizado no Firebase. Adicione-o em Authentication › Configurações › Domínios autorizados.',
  'auth/operation-not-allowed': 'O login com Google não está ativado no Firebase (Authentication › Método de login).',
  'auth/popup-closed-by-user': '',
  'auth/cancelled-popup-request': '',
  'auth/network-request-failed': 'Sem conexão com a internet.',
  unavailable: 'Sem conexão. As alterações serão enviadas quando a internet voltar.',
};
const errMsg = (err) => (err?.code in ERROS ? ERROS[err.code] : `Algo deu errado: ${err?.message || err}`);

// Salva em segundo plano; a tela já foi atualizada antes (atualização otimista).
function persist(promise, onFail) {
  Promise.resolve(promise).catch((err) => {
    console.error(err);
    toast(errMsg(err));
    if (onFail) {
      onFail();
      render();
    }
  });
}

let askResolver = null;
function openModal(html) {
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
  const focus = modal.querySelector('[autofocus]');
  if (focus && matchMedia('(hover: hover)').matches) focus.focus();
}
function closeModal() {
  if (modal.open) modal.close();
}
modal.addEventListener('close', () => {
  if (askResolver) {
    const r = askResolver;
    askResolver = null;
    r(false);
  }
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

function ask(msg, okLabel = 'Excluir', danger = true) {
  return new Promise((resolve) => {
    openModal(`<div class="modal-body confirm">
      <p>${esc(msg)}</p>
      <footer class="modal-actions"><span class="grow"></span>
        <button type="button" class="btn ghost" data-action="ask-no">Cancelar</button>
        <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-action="ask-yes" autofocus>${esc(okLabel)}</button>
      </footer></div>`);
    askResolver = resolve;
  });
}

function applyTheme() {
  const t = S.profile.tema;
  if (t === 'claro') document.documentElement.dataset.theme = 'light';
  else if (t === 'escuro') document.documentElement.dataset.theme = 'dark';
  else delete document.documentElement.dataset.theme;
}

// ---------------------------------------------------------------------------
// Lógica da rotina: geração das tarefas do dia
// ---------------------------------------------------------------------------

const recurringApplies = (r, date) =>
  r.ativo !== false && (r.diasDaSemana || []).includes(U.weekdayOf(date)) && (!r.inicio || date >= r.inicio);

// O id é fixo (rotina + data): gerar duas vezes nunca duplica a tarefa.
const instanceFrom = (r, date) => ({
  id: `${r.id}_${date}`,
  titulo: r.titulo,
  categoriaId: r.categoriaId,
  clienteId: r.clienteId || null,
  data: date,
  horario: r.horario || null,
  duracao: r.duracao || null,
  aviso: r.aviso ?? null,
  avisoAntes: r.avisoAntes ?? null,
  concluido: false,
  origem: 'fixa',
  recurringTaskId: r.id,
  removido: false,
});

// Ao abrir um dia: garante que as tarefas da rotina daquele dia da semana existam.
function ensureDay(date) {
  if (S.ensured.has(date)) return Promise.resolve(S.days[date]);
  if (pending.days[date]) return pending.days[date];
  pending.days[date] = (async () => {
    const existing = await db.where('dailyTasks', 'data', '==', date);
    const have = new Set(existing.map((t) => t.recurringTaskId).filter(Boolean));
    const created = S.recurring.filter((r) => recurringApplies(r, date) && !have.has(r.id)).map((r) => instanceFrom(r, date));
    persist(db.batch(created.map((t) => ({ type: 'set', col: 'dailyTasks', id: t.id, data: t }))));
    S.days[date] = [...existing, ...created];
    S.ensured.add(date);
    return S.days[date];
  })().finally(() => delete pending.days[date]);
  return pending.days[date];
}

// Tarefas de um dia para a tela; dispara o carregamento se ainda não houver.
function dayTasks(date) {
  if (S.ensured.has(date)) return S.days[date];
  ensureDay(date).then(render, (err) => toast(errMsg(err)));
  return null;
}

// Busca as tarefas já salvas de um intervalo (para indicadores no calendário/semana).
function ensureRange(from, to) {
  const key = `${from}|${to}`;
  if (S.ranges.has(key)) return true;
  if (!pending.ranges[key]) {
    pending.ranges[key] = db
      .range('dailyTasks', 'data', from, to)
      .then((rows) => {
        const by = {};
        rows.forEach((t) => (by[t.data] ||= []).push(t));
        for (let d = from; d <= to; d = U.addDays(d, 1)) if (!S.ensured.has(d)) S.days[d] = by[d] || [];
        S.ranges.add(key);
        render();
      })
      .catch((err) => toast(errMsg(err)))
      .finally(() => delete pending.ranges[key]);
  }
  return false;
}

// O que o dia terá depois de gerar a rotina (sem gravar nada).
function projected(date) {
  const existing = S.days[date] || [];
  const have = new Set(existing.map((t) => t.recurringTaskId).filter(Boolean));
  const virt = S.recurring.filter((r) => recurringApplies(r, date) && !have.has(r.id)).map((r) => instanceFrom(r, date));
  return [...existing, ...virt];
}
const statsTasks = (date) => (S.ensured.has(date) ? S.days[date] : projected(date));

// Depois de mudar a rotina, os dias de hoje em diante são recalculados.
function invalidateFrom(date) {
  for (const d of Object.keys(S.days)) {
    if (d >= date) {
      delete S.days[d];
      S.ensured.delete(d);
    }
  }
  S.ranges.clear();
}

function findTask(id, date) {
  return S.days[date]?.find((t) => t.id === id);
}

// ---------------------------------------------------------------------------
// Carregamento inicial
// ---------------------------------------------------------------------------

function resetState() {
  Object.assign(S, {
    profile: { ...DEFAULT_PROFILE },
    categories: [],
    clients: [],
    recurring: [],
    days: {},
    ensured: new Set(),
    ranges: new Set(),
    date: U.todayStr(),
    calMonth: U.todayStr().slice(0, 7),
    calSel: U.todayStr(),
    ready: false,
    blocked: false,
    isAdmin: false,
    acessos: null,
  });
}

// Confere se o e-mail está liberado (coleção "permitidos" no Firebase).
async function checkAccess() {
  try {
    const acc = await access.get(S.user.email);
    S.blocked = !acc;
    S.isAdmin = !!acc?.admin;
  } catch (err) {
    if (err?.code === 'permission-denied') {
      S.blocked = true;
    } else {
      // Sem internet, por exemplo: segue com o que estiver no cache. As regras do Firebase continuam protegendo os dados.
      console.warn('acesso', err);
    }
  }
}

async function loadAll() {
  const [profile, cats, clients, recurring] = await Promise.all([
    db.getProfile(),
    db.list('categories'),
    db.list('clients'),
    db.list('recurringTasks'),
  ]);
  S.profile = { ...DEFAULT_PROFILE, ...(profile || {}) };
  S.categories = cats;
  S.clients = clients;
  S.recurring = recurring;
  sortCats();
  applyTheme();

  const u = S.user;
  // O fuso horário é usado pelo envio de avisos (GitHub Actions) para saber a hora local da pessoa.
  const fuso = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo';
  if (!profile || profile.nome !== u.nome || profile.foto !== u.foto || profile.email !== u.email || profile.fuso !== fuso) {
    persist(db.setProfile({ nome: u.nome, email: u.email, foto: u.foto, fuso }));
  }
  if (!S.profile.seeded) seed();
  S.ready = true;
  if (deviceNotifOn()) registerPush().catch((err) => console.warn('push', err));
  setTimeout(notifTick, 1500);
}

// Primeiro acesso: cria categorias iniciais (e exemplos no modo demonstração).
function seed() {
  const ops = [];
  if (!S.categories.length) {
    const base = [
      ['Religião', '#8b5cf6'],
      ['Relacionamento', '#ec4899'],
      ['Trabalho', '#0ea5e9'],
      ['Saúde', '#22c55e'],
    ];
    S.categories = base.map(([nome, cor], ordem) => ({ id: U.newId(), nome, cor, ordem }));
    S.categories.forEach((c) => ops.push({ type: 'set', col: 'categories', id: c.id, data: c }));

    if (isDemo) {
      const [rel, relac, trab, saude] = S.categories.map((c) => c.id);
      const hoje = U.todayStr();
      S.clients = [
        { id: U.newId(), nome: 'Padaria Sol', categoriaId: trab, observacoes: 'Redes sociais e campanhas mensais.' },
        { id: U.newId(), nome: 'Studio Lima', categoriaId: trab, observacoes: 'Site e relatórios.' },
      ];
      const [padaria, studio] = S.clients.map((c) => c.id);
      const r = (titulo, categoriaId, dias, horario, dur, clienteId = null) => ({
        id: U.newId(), titulo, categoriaId, clienteId, diasDaSemana: dias, horario, duracao: dur, ativo: true, inicio: hoje,
      });
      const todos = [0, 1, 2, 3, 4, 5, 6];
      const uteis = [1, 2, 3, 4, 5];
      S.recurring = [
        r('Oração da manhã', rel, todos, '06:30', 15),
        r('Leitura da Bíblia', rel, todos, '06:45', 20),
        r('Treino', saude, [1, 3, 5], '07:15', 60),
        r('Beber 2L de água', saude, todos, '08:00', 15),
        r('Responder e-mails', trab, uteis, '09:00', 30),
        r('Posts da semana', trab, [1, 4], '10:00', 90, padaria),
        r('Responder comentários', trab, uteis, '14:00', 30, padaria),
        r('Reunião de alinhamento', trab, [2], '15:00', 60, studio),
        r('Relatório semanal', trab, [5], '16:00', 60, studio),
        r('Jantar sem celular', relac, uteis, '20:00', 60),
        r('Mensagem para a família', relac, todos, '19:00', 15),
      ];
      S.clients.forEach((c) => ops.push({ type: 'set', col: 'clients', id: c.id, data: c }));
      S.recurring.forEach((x) => ops.push({ type: 'set', col: 'recurringTasks', id: x.id, data: x }));
    }
  }
  persist(db.batch(ops));
  S.profile.seeded = true;
  persist(db.setProfile({ seeded: true }));
}

// ---------------------------------------------------------------------------
// Roteamento e renderização
// ---------------------------------------------------------------------------

const isWide = () => matchMedia('(min-width: 900px)').matches;

function currentRoute() {
  const r = location.hash.replace(/^#\/?/, '');
  if (VIEWS[r] && navItems().some((n) => n.id === r)) return r;
  return isWide() ? 'painel' : 'hoje';
}

let lastRoute = null;
function render() {
  if (!S.user) {
    root.innerHTML = loginHTML();
    lastRoute = null;
    return;
  }
  if (S.blocked) {
    root.innerHTML = blockedHTML();
    return;
  }
  if (!S.ready) {
    root.innerHTML = '<div class="splash">' + LOGO + '</div>';
    return;
  }
  if (!$('.app', root)) root.innerHTML = shellHTML();

  const r = currentRoute();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === r;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  $('[data-action="more"]')?.classList.toggle('active', !TABS.includes(r));

  const view = $('#view');
  view.innerHTML = VIEWS[r]();
  document.title = `${navLabel(r)} · Rotina`;

  if (r !== lastRoute) {
    window.scrollTo(0, 0);
    S.scrolledNow = false;
  }
  lastRoute = r;
  afterRender(r);
}

function afterRender(r) {
  if (r === 'horarios' && !S.scrolledNow) {
    const line = $('.now-line');
    if (line) {
      line.scrollIntoView({ block: 'center' });
      S.scrolledNow = true;
    }
  }
}

function shellHTML() {
  const u = S.user;
  const avatar = u.foto
    ? `<img class="avatar" src="${esc(u.foto)}" alt="" referrerpolicy="no-referrer">`
    : `<span class="avatar">${esc((u.nome || '?')[0])}</span>`;
  const link = (n) =>
    `<a href="#/${n.id}" class="nav-link" data-nav="${n.id}">${icon(n.id)}<span>${n.label}</span></a>`;
  return `
  <div class="app">
    <aside class="sidebar">
      <a class="brand" href="#/painel">${LOGO}<span>Rotina</span></a>
      <nav class="nav" aria-label="Principal">${navItems().map(link).join('')}</nav>
      <div class="side-user">${avatar}<div><strong>${esc(u.nome || 'Você')}</strong><small>${esc(u.email)}</small></div></div>
    </aside>
    <main class="main">
      ${isDemo ? `<div class="demo-banner">${icon('sparkle')}<span>Modo demonstração: os dados ficam só neste navegador.</span><a href="#/ajustes">Ativar login Google</a></div>` : ''}
      <div id="view" class="view"></div>
    </main>
    <nav class="tabbar" aria-label="Principal">
      ${TABS.map((id) => link(NAV.find((n) => n.id === id))).join('')}
      <button type="button" class="nav-link" data-action="more">${icon('mais')}<span>Mais</span></button>
    </nav>
    <div class="sheet" id="more">
      <div class="sheet-panel">
        ${navItems().filter((n) => !TABS.includes(n.id)).map(link).join('')}
      </div>
    </div>
  </div>`;
}

function loginHTML() {
  return `
  <div class="login">
    <div class="login-card">
      ${LOGO}
      <h1>Rotina</h1>
      <p class="lead">Sua to-do list diária por categorias, com clientes, rotina semanal e um quadro de horários.</p>
      <button type="button" class="btn google" data-action="login">${isDemo ? icon('sparkle') : GOOGLE}<span>${isDemo ? 'Entrar no modo demonstração' : 'Entrar com Google'}</span></button>
      ${
        isDemo
          ? `<p class="hint">O login Google ainda não foi configurado (arquivo <code>js/firebase-config.js</code>). No modo demonstração, tudo fica salvo apenas neste navegador.</p>`
          : `<p class="hint">Cada conta tem suas próprias categorias, clientes, rotina e configurações.</p>`
      }
    </div>
  </div>`;
}

function blockedHTML() {
  return `
  <div class="login">
    <div class="login-card">
      ${LOGO}
      <h1>Acesso não liberado</h1>
      <p class="lead">O e-mail <strong>${esc(S.user.email)}</strong> ainda não tem acesso a este app. Peça ao administrador para liberar e depois entre de novo.</p>
      <button type="button" class="btn ghost" data-action="logout-now">${icon('logout')}Entrar com outra conta</button>
    </div>
  </div>`;
}

const loading = () => `<div class="loading"><span></span><span></span><span></span></div>`;

// ---------------------------------------------------------------------------
// Componentes
// ---------------------------------------------------------------------------

function dayNav(date) {
  const isToday = date === U.todayStr();
  return `<div class="daynav">
    <button type="button" class="icon-btn" data-action="day-shift" data-n="-1" aria-label="Dia anterior">${icon('left')}</button>
    <div class="daynav-title">
      <span class="eyebrow">${esc(U.relativo(date))}</span>
      <h1>${esc(U.fmtDiaLongo(date))}</h1>
    </div>
    <button type="button" class="icon-btn" data-action="day-shift" data-n="1" aria-label="Próximo dia">${icon('right')}</button>
    ${isToday ? '' : '<button type="button" class="btn ghost sm" data-action="day-today">Ir para hoje</button>'}
  </div>`;
}

// Passou do horário (ou o dia já passou) e ainda não foi concluída: continua pendente, marcada como atrasada.
function isLate(t) {
  if (t.concluido) return false;
  const today = U.todayStr();
  if (t.data < today) return true;
  return t.data === today && !!t.horario && U.toMin(t.horario) + duracao(t) <= U.nowMin();
}

const avisoAtivo = (t) => !!t.horario && S.profile.notifTarefas && t.aviso !== false;
const avisoMin = (t) => (Number.isFinite(t.avisoAntes) ? t.avisoAntes : S.profile.avisoAntes);

// Cronômetro opcional: tempoGasto (segundos já acumulados) + cronometroInicio (momento do play, quando está rodando).
const isRunning = (t) => !!t.cronometroInicio;
const elapsed = (t) => (t.tempoGasto || 0) + (isRunning(t) ? Math.max(0, (Date.now() - t.cronometroInicio) / 1000) : 0);
const sumTime = (list) => list.reduce((a, t) => a + elapsed(t), 0);

// Pausa: soma o tempo corrido ao acumulado.
function stopTimer(t, ops) {
  t.tempoGasto = Math.round(elapsed(t));
  t.cronometroInicio = null;
  ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: { tempoGasto: t.tempoGasto, cronometroInicio: null } });
}

// Texto que se atualiza a cada segundo enquanto o cronômetro roda.
const liveAttrs = (t) => `data-live data-base="${t.tempoGasto || 0}" data-start="${t.cronometroInicio}"`;

function timerHTML(t) {
  const run = isRunning(t);
  const sec = elapsed(t);
  if (t.concluido) return sec >= 60 ? `<span class="timer-chip" title="Tempo gasto">${icon('cronometro')}${U.fmtDur(sec)}</span>` : '';
  const label = run ? `<span ${liveAttrs(t)}>${U.fmtRelogio(sec)}</span>` : sec ? `<span>${U.fmtDur(sec)}</span>` : '';
  return `<button type="button" class="timer${run ? ' running' : ''}" data-action="timer" data-id="${t.id}" data-date="${t.data}"
    aria-label="${run ? 'Pausar' : sec ? 'Continuar' : 'Iniciar'} cronômetro" title="${run ? 'Pausar' : 'Iniciar'} cronômetro">${icon(run ? 'pause' : 'play')}${label}</button>`;
}

const timeTotal = (list) => {
  const s = sumTime(list);
  return s >= 60 ? `<span class="time-total" title="Tempo registrado">${icon('cronometro')}${U.fmtDur(s)}</span>` : '';
};

function taskRow(t, { showCat = false } = {}) {
  const cat = catById(t.categoriaId);
  const cli = cliById(t.clienteId);
  const late = isLate(t);
  const meta = [
    late ? `<span class="chip late">Atrasada</span>` : '',
    t.horario ? `<span class="chip">${icon('horarios')}${t.horario}</span>` : '',
    t.horario && avisoAtivo(t) && !t.concluido
      ? `<span class="chip muted" title="Aviso ${avisoMin(t) ? `${avisoMin(t)} min antes` : 'na hora'}">${icon('sino')}${avisoMin(t) ? `${avisoMin(t)} min` : 'na hora'}</span>`
      : '',
    showCat && cat ? `<span class="chip cat"><i class="dot"></i>${esc(cat.nome)}</span>` : '',
    showCat && cli ? `<span class="chip">${icon('clientes')}${esc(cli.nome)}</span>` : '',
    t.origem === 'fixa' ? `<span class="chip muted" title="Vem da rotina semanal">${icon('rotina')}Rotina</span>` : '',
  ].join('');
  return `<li class="task${t.concluido ? ' done' : ''}${late ? ' late' : ''}${isRunning(t) ? ' running' : ''}" style="--c:${colorOf(t)}">
    <button type="button" class="check" role="checkbox" aria-checked="${!!t.concluido}" aria-label="Concluir ${esc(t.titulo)}"
      data-action="toggle" data-id="${t.id}" data-date="${t.data}">${icon('check')}</button>
    <div class="task-main" data-action="edit-daily" data-id="${t.id}" data-date="${t.data}" title="Editar">
      <span class="task-title">${esc(t.titulo)}</span>
      ${meta ? `<span class="task-meta">${meta}</span>` : ''}
    </div>
    ${timerHTML(t)}
    <div class="task-actions">
      <button type="button" class="icon-btn sm" data-action="edit-daily" data-id="${t.id}" data-date="${t.data}" aria-label="Editar">${icon('edit')}</button>
      <button type="button" class="icon-btn sm" data-action="remove-daily" data-id="${t.id}" data-date="${t.data}" aria-label="Remover deste dia">${icon('trash')}</button>
    </div>
  </li>`;
}

// Lista do dia agrupada por categoria e, dentro dela, por cliente.
function groupedList(tasks) {
  const v = visible(tasks);
  const groups = [...S.categories, { id: '_sem', nome: 'Sem categoria', cor: '#94a3b8' }];
  const keyOf = (t) => (catById(t.categoriaId) ? t.categoriaId : '_sem');
  return `<div class="groups">${groups
    .map((cat) => {
      const list = v.filter((t) => keyOf(t) === cat.id);
      if (!list.length) return '';
      const p = progress(list);
      const direct = list.filter((t) => !cliById(t.clienteId)).sort(U.byHorarioTitulo);
      const byClient = [...new Set(list.map((t) => t.clienteId).filter((id) => cliById(id)))]
        .map(cliById)
        .sort(U.byNome);
      return `<section class="group card" style="--c:${cat.cor}">
        <header class="group-head"><i class="dot"></i><h2>${esc(cat.nome)}</h2>${timeTotal(list)}<span class="count">${p.done}/${p.total}</span></header>
        ${direct.length ? `<ul class="tasks">${direct.map((t) => taskRow(t)).join('')}</ul>` : ''}
        ${byClient
          .map((cli) => {
            const ct = list.filter((t) => t.clienteId === cli.id).sort(U.byHorarioTitulo);
            const cp = progress(ct);
            return `<div class="client-group">
              <h3>${icon('clientes')}<span>${esc(cli.nome)}</span>${timeTotal(ct)}<span class="count">${cp.done}/${cp.total}</span></h3>
              <ul class="tasks">${ct.map((t) => taskRow(t)).join('')}</ul>
            </div>`;
          })
          .join('')}
      </section>`;
    })
    .join('')}</div>`;
}

function emptyState(title, text) {
  return `<div class="empty">${icon('hoje')}<h3>${title}</h3><p>${text}</p></div>`;
}

function dayDots(dias, cls = '') {
  return `<span class="day-dots ${cls}" aria-label="${U.ORDEM_SEMANA.filter((d) => dias.includes(d)).map((d) => U.DIAS_CURTO[d]).join(', ')}">${U.ORDEM_SEMANA.map(
    (d) => `<i class="${dias.includes(d) ? 'on' : ''}">${U.DIAS_LETRA[d]}</i>`,
  ).join('')}</span>`;
}

function ring(pct) {
  const c = 2 * Math.PI * 42;
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true">
    <circle cx="50" cy="50" r="42" class="ring-track"/>
    <circle cx="50" cy="50" r="42" class="ring-fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - pct / 100)}"/>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Telas
// ---------------------------------------------------------------------------

function viewPainel() {
  const today = U.todayStr();
  const tasks = dayTasks(today);
  if (!tasks) return loading();
  const v = visible(tasks);
  const p = progress(tasks);
  const now = U.nowMin();
  const timed = v.filter((t) => t.horario).sort(U.byHorarioTitulo);
  const agora = timed.filter((t) => U.toMin(t.horario) <= now && now < U.toMin(t.horario) + duracao(t));
  const prox = timed.find((t) => U.toMin(t.horario) > now);
  const pend = v.filter((t) => !t.concluido).sort(U.byHorarioTitulo);
  const h = new Date().getHours();
  const saud = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';

  const from = U.addDays(today, -6);
  const weekOk = ensureRange(from, today);
  const week = Array.from({ length: 7 }, (_, i) => U.addDays(from, i));
  const weekStats = week.map((d) => (weekOk ? progress(statsTasks(d)) : null));
  const withTasks = weekStats.filter((s) => s && s.total);
  const media = withTasks.length ? Math.round(withTasks.reduce((a, s) => a + s.pct, 0) / withTasks.length) : null;

  const msg =
    p.total === 0 ? 'Nenhuma tarefa para hoje.' : p.done === p.total ? 'Tudo feito hoje. 🎉' : `Faltam ${p.total - p.done}.`;

  const blockLine = (t) =>
    `<button type="button" class="now-item" style="--c:${colorOf(t)}" data-action="go" data-route="horarios" data-date="${today}">
      <span class="now-time">${t.horario}–${U.fromMin(U.toMin(t.horario) + duracao(t))}</span>
      <span class="now-title${t.concluido ? ' done' : ''}">${esc(t.titulo)}</span>
      <span class="now-sub">${esc([catById(t.categoriaId)?.nome, cliById(t.clienteId)?.nome].filter(Boolean).join(' · '))}</span>
    </button>`;

  const catRows = S.categories
    .map((c) => {
      const cp = progress(v.filter((t) => t.categoriaId === c.id));
      if (!cp.total) return '';
      return `<li style="--c:${c.cor}"><i class="dot"></i><span class="name">${esc(c.nome)}</span>
        <span class="bar"><i style="width:${cp.pct}%"></i></span><span class="count">${cp.done}/${cp.total}</span></li>`;
    })
    .join('');

  const cliRows = [...S.clients]
    .sort(U.byNome)
    .map((cli) => {
      const cp = progress(v.filter((t) => t.clienteId === cli.id));
      const cor = catById(cli.categoriaId)?.cor || '#94a3b8';
      return `<li style="--c:${cor}"><i class="dot"></i><span class="name">${esc(cli.nome)}</span>
        ${cp.total ? `<span class="bar"><i style="width:${cp.pct}%"></i></span><span class="count">${cp.done}/${cp.total}</span>` : '<span class="muted sm">sem tarefas hoje</span>'}</li>`;
    })
    .join('');

  return `
  <header class="page-head">
    <div><p class="eyebrow">${esc(U.fmtDiaLongo(today))}</p><h1>${saud}, ${esc(firstName())}</h1></div>
    <button type="button" class="btn primary" data-action="new-daily" data-date="${today}">${icon('plus')}<span>Tarefa</span></button>
  </header>
  <div class="dash">
    <section class="card hero">
      <div class="ring-wrap">${ring(p.pct)}<span class="ring-label">${p.pct}%</span></div>
      <div>
        <h2>${p.done} de ${p.total} concluídas</h2>
        <p class="muted">${msg}</p>
        ${sumTime(v) >= 60 ? `<p class="muted sm hero-time">${icon('cronometro')}Tempo registrado hoje: <strong>${U.fmtDur(sumTime(v))}</strong></p>` : ''}
        <a class="btn soft sm" href="#/hoje" data-action="go" data-route="hoje" data-date="${today}">Abrir lista de hoje</a>
      </div>
    </section>
    <section class="card now">
      <h2 class="card-title">${icon('horarios')}Agora</h2>
      ${v
        .filter(isRunning)
        .map(
          (t) => `<div class="running-now" style="--c:${colorOf(t)}">
            <span class="running-icon">${icon('cronometro')}</span>
            <div><span class="now-title">${esc(t.titulo)}</span><span class="now-sub">Cronômetro: <strong ${liveAttrs(t)}>${U.fmtRelogio(elapsed(t))}</strong></span></div>
            <button type="button" class="icon-btn sm" data-action="timer" data-id="${t.id}" data-date="${t.data}" aria-label="Pausar cronômetro">${icon('pause')}</button>
          </div>`,
        )
        .join('')}
      ${agora.length ? agora.map(blockLine).join('') : '<p class="muted">Nada planejado para este horário.</p>'}
      <h2 class="card-title sub">Próximo</h2>
      ${prox ? blockLine(prox) : '<p class="muted">Nada mais com horário hoje.</p>'}
    </section>
    <section class="card week">
      <h2 class="card-title">${icon('calendario')}Últimos 7 dias</h2>
      <div class="week-bars">${week
        .map((d, i) => {
          const s = weekStats[i];
          return `<button type="button" class="wb${d === today ? ' today' : ''}" data-action="cal-open" data-date="${d}"
            title="${esc(U.fmtDiaLongo(d))}${s ? `: ${s.done}/${s.total}` : ''}">
            <span class="wb-track"><i style="height:${s ? s.pct : 0}%"></i></span>
            <span class="wb-label">${U.DIAS_CURTO[U.weekdayOf(d)]}</span></button>`;
        })
        .join('')}</div>
      <p class="muted sm">${media === null ? '&nbsp;' : `Média de ${media}% das tarefas concluídas`}</p>
    </section>
    <section class="card pend">
      <h2 class="card-title">${icon('hoje')}Pendentes hoje <span class="count">${pend.length}</span></h2>
      ${pend.length ? `<ul class="tasks">${pend.slice(0, 8).map((t) => taskRow(t, { showCat: true })).join('')}</ul>` : '<p class="muted">Nenhuma pendência. 👏</p>'}
      ${pend.length > 8 ? `<a class="more-link" href="#/hoje" data-action="go" data-route="hoje" data-date="${today}">Ver todas (${pend.length})</a>` : ''}
    </section>
    <div class="dash-side">
      <section class="card">
        <h2 class="card-title">${icon('categorias')}Categorias</h2>
        ${catRows ? `<ul class="meters">${catRows}</ul>` : '<p class="muted">Sem tarefas hoje.</p>'}
      </section>
      <section class="card">
        <h2 class="card-title">${icon('clientes')}Clientes</h2>
        ${cliRows ? `<ul class="meters">${cliRows}</ul>` : '<p class="muted">Nenhum cliente. <a href="#/clientes">Cadastrar</a></p>'}
      </section>
    </div>
  </div>`;
}

function viewHoje() {
  const tasks = dayTasks(S.date);
  const head = `<header class="page-head">${dayNav(S.date)}
    <button type="button" class="btn primary" data-action="new-daily" data-date="${S.date}">${icon('plus')}<span>Tarefa</span></button></header>`;
  if (!tasks) return head + loading();
  const p = progress(tasks);
  if (!p.total) {
    return head + emptyState('Nada para este dia', 'Monte sua <a href="#/rotina">rotina semanal</a> ou adicione uma tarefa avulsa.');
  }

  const F = S.filtro;
  if (F.cat && !catById(F.cat)) F.cat = '';
  if (F.cli && (!cliById(F.cli) || (F.cat && cliById(F.cli).categoriaId !== F.cat))) F.cli = '';
  const v = visible(tasks);
  const byCatCli = v.filter((t) => (!F.cat || t.categoriaId === F.cat) && (!F.cli || t.clienteId === F.cli));
  const pend = byCatCli.filter((t) => !t.concluido);
  const late = pend.filter(isLate);
  const filtered = byCatCli.filter((t) =>
    F.status === 'pendentes' ? !t.concluido : F.status === 'concluidas' ? t.concluido : F.status === 'atrasadas' ? isLate(t) : true,
  );
  const statusBtn = (id, label, n) =>
    `<button type="button" class="tab-chip${F.status === id ? ' on' : ''}" data-action="filtro-status" data-status="${id}">${label}<span>${n}</span></button>`;
  const clientList = (F.cat ? clientsOf(F.cat) : [...S.clients].sort(U.byNome)).filter((c) => v.some((t) => t.clienteId === c.id));
  const catsWithTasks = S.categories.filter((c) => v.some((t) => t.categoriaId === c.id));
  const active = F.status !== 'todas' || F.cat || F.cli;

  return `${head}
    <div class="progress-line"><span class="bar"><i style="width:${p.pct}%"></i></span><span>${p.done} de ${p.total} concluídas</span></div>
    <div class="filters">
      <div class="tab-chips">
        ${statusBtn('todas', 'Todas', byCatCli.length)}
        ${statusBtn('pendentes', 'Pendentes', pend.length)}
        ${late.length ? statusBtn('atrasadas', 'Atrasadas', late.length) : ''}
        ${statusBtn('concluidas', 'Concluídas', byCatCli.length - pend.length)}
      </div>
      <div class="filter-selects">
        <select data-filter="cat" aria-label="Filtrar por categoria">
          <option value="">Todas as categorias</option>
          ${catsWithTasks.map((c) => `<option value="${c.id}" ${c.id === F.cat ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
        </select>
        ${
          clientList.length
            ? `<select data-filter="cli" aria-label="Filtrar por cliente">
          <option value="">Todos os clientes</option>
          ${clientList.map((c) => `<option value="${c.id}" ${c.id === F.cli ? 'selected' : ''}>${esc(c.nome)}</option>`).join('')}
        </select>`
            : ''
        }
        ${active ? `<button type="button" class="link" data-action="filtro-limpar">Limpar filtros</button>` : ''}
      </div>
    </div>
    ${
      filtered.length
        ? groupedList(filtered)
        : emptyState(
            F.status === 'pendentes' && !F.cat && !F.cli ? 'Tudo concluído 🎉' : 'Nada com esses filtros',
            active ? '<button type="button" class="link" data-action="filtro-limpar">Limpar filtros</button>' : '',
          )
    }`;
}

function viewHorarios() {
  const tasks = dayTasks(S.date);
  const head = `<header class="page-head">${dayNav(S.date)}
    <button type="button" class="btn primary" data-action="new-daily" data-date="${S.date}">${icon('plus')}<span>Tarefa</span></button></header>`;
  if (!tasks) return head + loading();
  const v = visible(tasks);
  const timed = v.filter((t) => t.horario).sort(U.byHorarioTitulo);
  const untimed = v.filter((t) => !t.horario).sort(U.byHorarioTitulo);

  let start = (S.profile.agendaInicio ?? 6) * 60;
  let end = Math.max((S.profile.agendaFim ?? 23) * 60, start + 60);
  for (const t of timed) {
    start = Math.min(start, Math.floor(U.toMin(t.horario) / 60) * 60);
    end = Math.max(end, Math.min(24 * 60, Math.ceil((U.toMin(t.horario) + duracao(t)) / 60) * 60));
  }
  const hours = (end - start) / 60;

  // Distribui em colunas os blocos que se sobrepõem.
  const items = timed.map((t) => ({ t, s: U.toMin(t.horario), e: Math.min(U.toMin(t.horario) + duracao(t), 24 * 60) }));
  let cluster = [];
  let clusterEnd = -1;
  const flush = () => {
    const cols = Math.max(...cluster.map((x) => x.col)) + 1;
    cluster.forEach((x) => (x.cols = cols));
    cluster = [];
  };
  for (const it of items) {
    if (it.s >= clusterEnd && cluster.length) flush();
    const used = new Set(cluster.filter((x) => x.e > it.s).map((x) => x.col));
    let col = 0;
    while (used.has(col)) col++;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();

  const isToday = S.date === U.todayStr();
  const now = U.nowMin();
  const blocks = items
    .map(({ t, s, e, col, cols }) => {
      const cli = cliById(t.clienteId);
      const isNow = isToday && s <= now && now < e;
      const short = e - s < 40;
      return `<button type="button" class="block${t.concluido ? ' done' : ''}${isNow ? ' is-now' : ''}${short ? ' short' : ''}"
        style="--c:${colorOf(t)};top:calc(var(--h) * ${(s - start) / 60});height:calc(var(--h) * ${(e - s) / 60});left:calc(${col} / ${cols} * 100%);width:calc(100% / ${cols})"
        data-action="edit-daily" data-id="${t.id}" data-date="${t.data}">
        <span class="block-time">${t.horario}–${U.fromMin(e)}</span>
        <span class="block-title">${esc(t.titulo)}</span>
        ${cli ? `<span class="block-sub">${esc(cli.nome)}</span>` : ''}
      </button>`;
    })
    .join('');

  const hourLines = Array.from(
    { length: hours + 1 },
    (_, i) => `<div class="hour" style="--i:${i}"><span>${U.fromMin(start + i * 60)}</span></div>`,
  ).join('');
  const nowLine =
    isToday && now >= start && now <= end
      ? `<div class="now-line" style="top:calc(var(--h) * ${(now - start) / 60})"><span>${U.fromMin(now)}</span></div>`
      : '';

  return `${head}
  <p class="muted sm intro">Quadro só para consulta: mostra o que você planejou para cada horário. Para concluir, use a <a href="#/hoje">lista do dia</a>.</p>
  <div class="agenda-wrap">
    <div class="card timeline-card">
      <div class="timeline" style="--rows:${hours}">${hourLines}<div class="blocks">${blocks}</div>${nowLine}</div>
    </div>
    <aside class="card untimed">
      <h2 class="card-title">Sem horário <span class="count">${untimed.length}</span></h2>
      ${
        untimed.length
          ? `<ul class="untimed-list">${untimed
              .map(
                (t) =>
                  `<li style="--c:${colorOf(t)}" class="${t.concluido ? 'done' : ''}"><i class="dot"></i><span>${esc(t.titulo)}</span></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted sm">Todas as tarefas têm horário.</p>'
      }
    </aside>
  </div>`;
}

function viewCalendario() {
  const first = `${S.calMonth}-01`;
  const start = U.addDays(first, -U.weekdayOf(first));
  const end = U.addDays(start, 41);
  const ok = ensureRange(start, end);
  const today = U.todayStr();

  let cells = '';
  for (let i = 0, d = start; i < 42; i++, d = U.addDays(d, 1)) {
    const inMonth = d.slice(0, 7) === S.calMonth;
    const p = ok ? progress(statsTasks(d)) : null;
    const cls = [
      'cal-cell',
      inMonth ? '' : 'out',
      d === today ? 'today' : '',
      d === S.calSel ? 'sel' : '',
      p && p.total && p.done === p.total ? 'full' : '',
      d < today ? 'past' : '',
    ].join(' ');
    cells += `<button type="button" class="${cls}" data-action="cal-pick" data-date="${d}"
      aria-label="${esc(U.fmtDiaLongo(d))}${p && p.total ? `, ${p.done} de ${p.total} concluídas` : ''}">
      <span class="cal-num">${Number(d.slice(8))}</span>
      ${p && p.total ? `<span class="cal-meter"><i style="width:${p.pct}%"></i></span><span class="cal-count">${p.done}/${p.total}</span>` : ''}
    </button>`;
  }

  const tasks = dayTasks(S.calSel);
  let panel = loading();
  if (tasks) {
    const v = visible(tasks).sort(U.byHorarioTitulo);
    const removed = tasks.filter((t) => t.removido);
    panel = `
      ${v.length ? `<ul class="tasks">${v.map((t) => taskRow(t, { showCat: true })).join('')}</ul>` : '<p class="muted">Nenhuma tarefa neste dia.</p>'}
      <button type="button" class="btn soft block" data-action="new-daily" data-date="${S.calSel}">${icon('plus')}Adicionar tarefa só neste dia</button>
      ${
        removed.length
          ? `<details class="removed"><summary>${removed.length} tarefa${removed.length > 1 ? 's' : ''} da rotina removida${removed.length > 1 ? 's' : ''} deste dia</summary>
             <ul>${removed
               .map(
                 (t) => `<li><span>${esc(t.titulo)}</span>
                 <button type="button" class="btn ghost sm" data-action="restore" data-id="${t.id}" data-date="${t.data}">${icon('undo')}Restaurar</button></li>`,
               )
               .join('')}</ul></details>`
          : ''
      }`;
  }

  return `
  <header class="page-head">
    <div class="daynav">
      <button type="button" class="icon-btn" data-action="cal-shift" data-n="-1" aria-label="Mês anterior">${icon('left')}</button>
      <div class="daynav-title"><span class="eyebrow">Calendário</span><h1>${esc(U.fmtMes(S.calMonth))}</h1></div>
      <button type="button" class="icon-btn" data-action="cal-shift" data-n="1" aria-label="Próximo mês">${icon('right')}</button>
      ${S.calMonth !== today.slice(0, 7) || S.calSel !== today ? '<button type="button" class="btn ghost sm" data-action="cal-today">Hoje</button>' : ''}
    </div>
  </header>
  <div class="cal-layout">
    <section class="card cal">
      <div class="cal-week">${[0, 1, 2, 3, 4, 5, 6].map((d) => `<span>${U.DIAS_CURTO[d]}</span>`).join('')}</div>
      <div class="cal-grid">${cells}</div>
    </section>
    <section class="card day-panel" id="day-panel">
      <header class="panel-head">
        <div><p class="eyebrow">${esc(U.relativo(S.calSel))}</p><h2>${esc(U.fmtDiaLongo(S.calSel))}</h2></div>
        <div class="panel-links">
          <button type="button" class="btn ghost sm" data-action="go" data-route="hoje" data-date="${S.calSel}">Lista</button>
          <button type="button" class="btn ghost sm" data-action="go" data-route="horarios" data-date="${S.calSel}">Horários</button>
        </div>
      </header>
      ${panel}
      <p class="muted sm">Alterações aqui valem só para este dia. A rotina semanal continua igual.</p>
    </section>
  </div>`;
}

function recRow(r) {
  const cli = cliById(r.clienteId);
  const cat = catById(r.categoriaId);
  return `<li class="rec" style="--c:${cat?.cor || '#94a3b8'}">
    <button type="button" class="rec-main" data-action="edit-rec" data-id="${r.id}">
      <span class="task-title">${esc(r.titulo)}</span>
      <span class="task-meta">
        ${r.horario ? `<span class="chip">${icon('horarios')}${r.horario}${r.duracao ? ` · ${r.duracao} min` : ''}</span>` : '<span class="chip muted">Sem horário</span>'}
        ${cli ? `<span class="chip">${icon('clientes')}${esc(cli.nome)}</span>` : ''}
      </span>
    </button>
    ${dayDots(r.diasDaSemana || [])}
  </li>`;
}

function viewRotina() {
  const sel = S.rotinaDia;
  const count = (d) => S.recurring.filter((r) => (r.diasDaSemana || []).includes(d)).length;
  const list = S.recurring.filter((r) => sel === 'all' || (r.diasDaSemana || []).includes(sel)).sort(U.byHorarioTitulo);
  const groups = [...S.categories, { id: '_sem', nome: 'Sem categoria', cor: '#94a3b8' }];
  const keyOf = (r) => (catById(r.categoriaId) ? r.categoriaId : '_sem');
  const chip = (d, label, n) =>
    `<button type="button" class="tab-chip${sel === d ? ' on' : ''}" data-action="rotina-dia" data-d="${d}">${label}<span>${n}</span></button>`;

  return `
  <header class="page-head">
    <div><p class="eyebrow">Rotina semanal fixa</p><h1>Rotina</h1></div>
    <button type="button" class="btn primary" data-action="new-rec">${icon('plus')}<span>Tarefa fixa</span></button>
  </header>
  <p class="muted intro">Estas tarefas se repetem toda semana e aparecem sozinhas na lista de cada dia. Para mudar só um dia específico, use o <a href="#/calendario">calendário</a>.</p>
  <div class="tab-chips" role="tablist">
    ${chip('all', 'Todas', S.recurring.length)}
    ${U.ORDEM_SEMANA.map((d) => chip(d, U.DIAS_CURTO[d], count(d))).join('')}
  </div>
  ${
    list.length
      ? `<div class="groups">${groups
          .map((cat) => {
            const rs = list.filter((r) => keyOf(r) === cat.id);
            if (!rs.length) return '';
            return `<section class="group card" style="--c:${cat.cor}">
              <header class="group-head"><i class="dot"></i><h2>${esc(cat.nome)}</h2><span class="count">${rs.length}</span></header>
              <ul class="rec-list">${rs.map(recRow).join('')}</ul></section>`;
          })
          .join('')}</div>`
      : emptyState(
          sel === 'all' ? 'Sua rotina está vazia' : `Nada fixo na ${U.DIAS_CURTO[sel].toLowerCase()}`,
          'Crie tarefas que se repetem, como “Oração da manhã” todos os dias ou “Relatório” às sextas.',
        )
  }`;
}

function viewClientes() {
  const todayTasks = visible(dayTasks(U.todayStr()) || []);
  const groups = [...S.categories, { id: '_sem', nome: 'Sem categoria', cor: '#94a3b8' }];
  const keyOf = (c) => (catById(c.categoriaId) ? c.categoriaId : '_sem');

  const card = (cli, cor) => {
    const recs = S.recurring.filter((r) => r.clienteId === cli.id).sort(U.byHorarioTitulo);
    const tt = todayTasks.filter((t) => t.clienteId === cli.id);
    const pend = tt.filter((t) => !t.concluido).length;
    return `<article class="card client-card" style="--c:${cor}">
      <header>
        <div><h3>${esc(cli.nome)}</h3>
        <p class="muted sm">${tt.length ? `${pend} pendente${pend === 1 ? '' : 's'} hoje` : 'Nenhuma tarefa hoje'}</p></div>
        <button type="button" class="icon-btn sm" data-action="edit-client" data-id="${cli.id}" aria-label="Editar cliente">${icon('edit')}</button>
      </header>
      ${cli.observacoes ? `<p class="obs">${esc(cli.observacoes)}</p>` : ''}
      ${
        recs.length
          ? `<ul class="mini">${recs
              .map(
                (r) => `<li><button type="button" data-action="edit-rec" data-id="${r.id}">
                <span>${esc(r.titulo)}${r.horario ? ` <small>${r.horario}</small>` : ''}</span>${dayDots(r.diasDaSemana || [], 'sm')}</button></li>`,
              )
              .join('')}</ul>`
          : '<p class="muted sm">Sem tarefas fixas.</p>'
      }
      <footer>
        <button type="button" class="btn soft sm" data-action="new-rec" data-cat="${cli.categoriaId || ''}" data-cli="${cli.id}">${icon('rotina')}Tarefa fixa</button>
        <button type="button" class="btn ghost sm" data-action="new-daily" data-date="${U.todayStr()}" data-cat="${cli.categoriaId || ''}" data-cli="${cli.id}">${icon('plus')}Tarefa avulsa</button>
      </footer>
    </article>`;
  };

  const body = groups
    .map((cat) => {
      const cs = S.clients.filter((c) => keyOf(c) === cat.id).sort(U.byNome);
      if (!cs.length) return '';
      return `<h2 class="section-title" style="--c:${cat.cor}"><i class="dot"></i>${esc(cat.nome)}</h2>
        <div class="client-grid">${cs.map((c) => card(c, cat.cor)).join('')}</div>`;
    })
    .join('');

  return `
  <header class="page-head">
    <div><p class="eyebrow">Cadastros</p><h1>Clientes</h1></div>
    <button type="button" class="btn primary" data-action="new-client">${icon('plus')}<span>Cliente</span></button>
  </header>
  ${body || emptyState('Nenhum cliente ainda', 'Cadastre seus clientes e dê a cada um as próprias tarefas fixas ou avulsas.')}`;
}

function viewCategorias() {
  const rows = S.categories
    .map((c, i) => {
      const nCli = S.clients.filter((x) => x.categoriaId === c.id).length;
      const nRec = S.recurring.filter((x) => x.categoriaId === c.id).length;
      return `<li class="cat-row" style="--c:${c.cor}">
        <span class="swatch"></span>
        <div class="cat-info"><strong>${esc(c.nome)}</strong>
          <small class="muted">${nRec} tarefa${nRec === 1 ? '' : 's'} fixa${nRec === 1 ? '' : 's'} · ${nCli} cliente${nCli === 1 ? '' : 's'}</small></div>
        <div class="row-actions">
          <button type="button" class="icon-btn sm" data-action="cat-move" data-id="${c.id}" data-n="-1" aria-label="Mover para cima" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
          <button type="button" class="icon-btn sm" data-action="cat-move" data-id="${c.id}" data-n="1" aria-label="Mover para baixo" ${i === S.categories.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
          <button type="button" class="icon-btn sm" data-action="edit-cat" data-id="${c.id}" aria-label="Editar">${icon('edit')}</button>
        </div>
      </li>`;
    })
    .join('');
  return `
  <header class="page-head">
    <div><p class="eyebrow">Cadastros</p><h1>Categorias</h1></div>
    <button type="button" class="btn primary" data-action="new-cat">${icon('plus')}<span>Categoria</span></button>
  </header>
  <p class="muted intro">A ordem aqui é a ordem em que as categorias aparecem na lista do dia.</p>
  ${rows ? `<ul class="card cat-list">${rows}</ul>` : emptyState('Nenhuma categoria', 'Crie categorias como Religião, Relacionamento, Trabalho e Saúde.')}`;
}

function viewAjustes() {
  const p = S.profile;
  const u = S.user;
  const hourOpts = (from, to, sel) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
      .map((h) => `<option value="${h}" ${h === sel ? 'selected' : ''}>${String(h).padStart(2, '0')}:00</option>`)
      .join('');
  const tema = (val, label) =>
    `<label class="seg-opt"><input type="radio" name="tema" value="${val}" ${p.tema === val ? 'checked' : ''}><span>${label}</span></label>`;

  return `
  <header class="page-head"><div><p class="eyebrow">Sua conta</p><h1>Ajustes</h1></div></header>
  <div class="settings" data-settings>
    <section class="card">
      <h2 class="card-title">Perfil</h2>
      <div class="profile">
        ${u.foto ? `<img class="avatar lg" src="${esc(u.foto)}" alt="" referrerpolicy="no-referrer">` : `<span class="avatar lg">${esc((u.nome || '?')[0])}</span>`}
        <div><strong>${esc(u.nome || 'Você')}</strong><small class="muted">${esc(u.email)}</small></div>
      </div>
      <label class="field"><span>Como quer ser chamado</span>
        <input name="apelido" value="${esc(p.apelido || '')}" placeholder="${esc((u.nome || '').split(' ')[0])}" maxlength="40"></label>
    </section>

    <section class="card">
      <h2 class="card-title">Aparência</h2>
      <div class="seg">${tema('auto', 'Automático')}${tema('claro', 'Claro')}${tema('escuro', 'Escuro')}</div>
    </section>

    <section class="card">
      <h2 class="card-title">Quadro de horários</h2>
      <div class="row2">
        <label class="field"><span>Dia começa às</span><select name="agendaInicio">${hourOpts(0, 22, p.agendaInicio)}</select></label>
        <label class="field"><span>Dia termina às</span><select name="agendaFim">${hourOpts(1, 24, p.agendaFim)}</select></label>
      </div>
      <label class="field"><span>Duração padrão de um bloco</span>
        <select name="duracaoPadrao">${DURACOES.map((d) => `<option value="${d}" ${d === p.duracaoPadrao ? 'selected' : ''}>${d} min</option>`).join('')}</select></label>
    </section>

    ${notifCard()}

    <section class="card">
      <h2 class="card-title">${icon('download')}Instalar no celular</h2>
      ${S.installEvt ? `<button type="button" class="btn primary" data-action="install">Instalar app</button>` : ''}
      <p class="muted sm"><strong>Android (Chrome):</strong> menu ⋮ › <em>Instalar app</em> ou <em>Adicionar à tela inicial</em>.</p>
      <p class="muted sm"><strong>iPhone (Safari):</strong> botão Compartilhar › <em>Adicionar à Tela de Início</em>.</p>
      <p class="muted sm">O app abre em tela cheia, como um aplicativo, e funciona mesmo sem internet.</p>
    </section>

    ${
      isDemo
        ? `<section class="card demo-info">
      <h2 class="card-title">${icon('sparkle')}Modo demonstração</h2>
      <p class="muted sm">Para ativar o login Google e salvar tudo na nuvem, crie um projeto no Firebase e cole o <code>firebaseConfig</code> no arquivo <code>js/firebase-config.js</code>. O passo a passo está no README.</p>
      <button type="button" class="btn ghost sm" data-action="reset-demo">${icon('trash')}Apagar dados de demonstração</button>
    </section>`
        : ''
    }

    <section class="card">
      <button type="button" class="btn ghost danger-text" data-action="logout">${icon('logout')}Sair da conta</button>
    </section>
  </div>`;
}

// Tela Acessos (só administradores): quais e-mails podem entrar no app.
function viewAcessos() {
  if (!S.acessos) {
    access
      .list()
      .then((list) => {
        S.acessos = list.sort((a, b) => a.email.localeCompare(b.email));
        render();
      })
      .catch((err) => toast(errMsg(err)));
    return loading();
  }
  const me = S.user.email;
  const rows = S.acessos
    .map(
      (a) => `<li class="acc-row">
        <span class="avatar">${esc(a.email[0].toUpperCase())}</span>
        <div class="cat-info"><strong>${esc(a.email)}</strong>
          <small class="muted">${a.admin ? 'Administrador' : 'Usuário'}${a.email === me ? ' · você' : ''}</small></div>
        ${
          a.email === me
            ? ''
            : `<div class="row-actions">
          <button type="button" class="btn ghost sm" data-action="acesso-admin" data-email="${esc(a.email)}">${a.admin ? 'Tirar admin' : 'Tornar admin'}</button>
          <button type="button" class="icon-btn sm" data-action="acesso-remover" data-email="${esc(a.email)}" aria-label="Remover acesso">${icon('trash')}</button>
        </div>`
        }
      </li>`,
    )
    .join('');
  return `
  <header class="page-head"><div><p class="eyebrow">Administração</p><h1>Acessos</h1></div></header>
  <p class="muted intro">Só os e-mails desta lista conseguem entrar no app. Cada pessoa continua vendo apenas os próprios dados. Esta lista fica guardada no Firebase e não aparece no GitHub.</p>
  <form class="card acc-form" data-form="acesso">
    <label class="field"><span>Liberar novo e-mail (conta Google)</span>
      <input type="email" name="email" required placeholder="nome@gmail.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
    <label class="switch-row"><input type="checkbox" name="admin"><span class="switch" aria-hidden="true"></span><span>Também pode liberar outras pessoas (administrador)</span></label>
    <button type="submit" class="btn primary">${icon('plus')}Liberar acesso</button>
  </form>
  <ul class="card cat-list">${rows}</ul>`;
}

// ---------------------------------------------------------------------------
// Notificações
//
// Duas formas de chegar:
// 1) Com o app aberto: este código confere a cada 30 s e mostra o aviso na hora certa.
// 2) Com o app fechado: o GitHub Actions (pasta notificacoes/) envia pelo Firebase Cloud
//    Messaging para os aparelhos salvos em users/{uid}/devices.
// Os dois gravam users/{uid}/notifLog/{chave}, para o mesmo aviso não chegar duas vezes.
// ---------------------------------------------------------------------------

const NOTIF_KEY = 'rotina-notif:';
const lsGet = (k) => {
  try {
    return localStorage.getItem(NOTIF_KEY + k);
  } catch {
    return null;
  }
};
const lsSet = (k, v) => {
  try {
    if (v == null) localStorage.removeItem(NOTIF_KEY + k);
    else localStorage.setItem(NOTIF_KEY + k, v);
  } catch {}
};

const notifSupported = () => 'Notification' in window;
const deviceNotifOn = () => notifSupported() && Notification.permission === 'granted' && lsGet('on') === '1';
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const tokenKey = () => `token:${S.user?.uid}`;

function deviceId() {
  let id = lsGet('device');
  if (!id) {
    id = U.newId();
    lsSet('device', id);
  }
  return id;
}

function deviceName() {
  const ua = navigator.userAgent;
  const os = /android/i.test(ua) ? 'Android' : isIOS() ? 'iPhone/iPad' : /windows/i.test(ua) ? 'Windows' : /mac/i.test(ua) ? 'Mac' : 'Computador';
  const br = /edg\//i.test(ua) ? 'Edge' : /firefox|fxios/i.test(ua) ? 'Firefox' : /chrome|crios/i.test(ua) ? 'Chrome' : /safari/i.test(ua) ? 'Safari' : 'Navegador';
  return `${os} · ${br}`;
}

// Registra este aparelho para receber avisos com o app fechado.
async function registerPush() {
  if (!pushConfigured || !('serviceWorker' in navigator)) return false;
  const reg = await navigator.serviceWorker.ready;
  const token = await getPushToken(reg);
  if (!token) return false;
  if (token !== lsGet(tokenKey())) {
    await db.set('devices', deviceId(), { token, nome: deviceName(), atualizadoEm: Date.now() });
    lsSet(tokenKey(), token);
  }
  return true;
}

async function unregisterPush() {
  if (!lsGet(tokenKey())) return;
  lsSet(tokenKey(), null);
  const timeout = new Promise((r) => setTimeout(r, 3000));
  await Promise.race([db.remove('devices', deviceId()).catch(() => {}), timeout]);
  deletePushToken().catch(() => {});
}

async function showLocal(title, opts) {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null;
  const options = { icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', data: { url: './#/hoje' }, ...opts };
  if (reg) return reg.showNotification(title, options);
  new Notification(title, options);
}

function textoTarefa(t, antes) {
  return {
    title: antes > 0 ? `Em ${antes} min: ${t.titulo}` : `Agora: ${t.titulo}`,
    body: [t.horario, catById(t.categoriaId)?.nome, cliById(t.clienteId)?.nome].filter(Boolean).join(' · '),
  };
}

function textoPendentes(pend) {
  const n = pend.length;
  return {
    title: n === 1 ? 'Ainda falta 1 tarefa hoje' : `Ainda faltam ${n} tarefas hoje`,
    body: pend.slice(0, 3).map((t) => t.titulo).join(', ') + (n > 3 ? ` e mais ${n - 3}` : ''),
  };
}

let notifBusy = false;
async function notifTick() {
  if (notifBusy || !S.user || !S.ready || !deviceNotifOn()) return;
  notifBusy = true;
  try {
    const today = U.todayStr();
    const tasks = visible(await ensureDay(today));
    const now = U.nowMin();
    const due = [];
    if (S.profile.notifTarefas) {
      for (const t of tasks) {
        if (t.concluido || !avisoAtivo(t)) continue;
        const antes = avisoMin(t);
        const fire = U.toMin(t.horario) - antes;
        if (now >= fire && now - fire <= 2) due.push({ key: `${today}_${t.id}_tarefa`, tipo: 'tarefa', ...textoTarefa(t, antes) });
      }
    }
    const pend = tasks.filter((t) => !t.concluido);
    if (S.profile.notifPendentes && S.profile.notifPendentesHora && pend.length) {
      const fire = U.toMin(S.profile.notifPendentesHora);
      if (now >= fire && now - fire <= 2) due.push({ key: `${today}_pendentes`, tipo: 'pendentes', ...textoPendentes(pend) });
    }
    for (const n of due) {
      if (lsGet('fired:' + n.key)) continue;
      lsSet('fired:' + n.key, today);
      if (await db.get('notifLog', n.key).catch(() => null)) continue; // o servidor já avisou
      persist(db.set('notifLog', n.key, { data: today, tipo: n.tipo, origem: 'app' }));
      await showLocal(n.title, { body: n.body, tag: n.key });
    }
    // Limpa marcas de dias anteriores.
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(NOTIF_KEY + 'fired:') && localStorage.getItem(k) < today)
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  } catch (err) {
    console.warn('notificações', err);
  } finally {
    notifBusy = false;
  }
}

function notifCard() {
  const p = S.profile;
  let status;
  if (!notifSupported()) {
    status = `<p class="note">Este navegador não suporta notificações.${
      isIOS() && !isStandalone() ? ' No iPhone, primeiro adicione o app à Tela de Início (veja abaixo) e abra por lá.' : ''
    }</p>`;
  } else if (Notification.permission === 'denied') {
    status = `<p class="note">As notificações estão bloqueadas neste aparelho. Libere nas configurações do navegador (no computador, pelo ícone ao lado do endereço do site) e recarregue a página.</p>`;
  } else if (deviceNotifOn()) {
    const sub = !pushConfigured
      ? isDemo
        ? 'Modo demonstração: avisos só com o app aberto.'
        : 'Por enquanto só com o app aberto (falta a chave vapidKey, veja o README).'
      : lsGet(tokenKey())
        ? 'Os avisos chegam mesmo com o app fechado.'
        : 'Com o app aberto. Conectando para avisar também com ele fechado…';
    status = `<div class="notif-status">${icon('sino')}<div><strong>Ativadas neste aparelho</strong><small class="muted">${sub}</small></div></div>
      <div class="btn-row">
        <button type="button" class="btn ghost sm" data-action="notif-test">Enviar teste</button>
        <button type="button" class="btn ghost sm" data-action="notif-off">Desativar neste aparelho</button>
      </div>`;
  } else {
    status = `<p class="muted sm">Ative uma vez em cada aparelho (celular, computador). O navegador vai pedir sua permissão.${
      isIOS() && !isStandalone() ? ' No iPhone, adicione o app à Tela de Início antes e abra por lá.' : ''
    }</p>
      <button type="button" class="btn primary" data-action="notif-on">${icon('sino')}Ativar neste aparelho</button>`;
  }
  return `<section class="card">
    <h2 class="card-title">${icon('sino')}Notificações</h2>
    ${status}
    <div class="setting-rows">
      <label class="switch-row"><input type="checkbox" name="notifTarefas" ${p.notifTarefas ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
        <span>Avisar antes das tarefas com horário</span></label>
      ${
        p.notifTarefas
          ? `<label class="field"><span>Tempo padrão para tarefas novas</span>
        <select name="avisoAntes">${AVISOS.map(([m, l]) => `<option value="${m}" ${m === p.avisoAntes ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <p class="hint">Em cada tarefa dá para mudar o tempo ou desligar o aviso.</p>`
          : ''
      }
      <label class="switch-row"><input type="checkbox" name="notifPendentes" ${p.notifPendentes ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
        <span>Lembrar das tarefas pendentes no fim do dia</span></label>
      ${
        p.notifPendentes
          ? `<label class="field"><span>Horário do lembrete</span><input type="time" name="notifPendentesHora" value="${esc(p.notifPendentesHora)}"></label>`
          : ''
      }
    </div>
    ${pushConfigured ? '<p class="hint">Com o app fechado, os avisos podem chegar alguns minutos atrasados.</p>' : ''}
  </section>`;
}

const VIEWS = {
  painel: viewPainel,
  hoje: viewHoje,
  horarios: viewHorarios,
  calendario: viewCalendario,
  rotina: viewRotina,
  clientes: viewClientes,
  categorias: viewCategorias,
  ajustes: viewAjustes,
  acessos: viewAcessos,
};

// ---------------------------------------------------------------------------
// Formulários
// ---------------------------------------------------------------------------

const modalHead = (title) => `<header class="modal-head"><h2>${title}</h2>
  <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></header>`;

const modalFoot = (deleteAction, id) => `<footer class="modal-actions">
  ${deleteAction ? `<button type="button" class="btn ghost danger-text" data-action="${deleteAction}" data-id="${id}">${icon('trash')}Excluir</button>` : ''}
  <span class="grow"></span>
  <button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>
  <button type="submit" class="btn primary">Salvar</button></footer>`;

const clientOptions = (catId, sel) =>
  `<option value="">Nenhum</option>` +
  clientsOf(catId)
    .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.nome)}</option>`)
    .join('');

function catClientFields(catId, cliId) {
  if (!S.categories.length) return `<p class="note">Crie uma <a href="#/categorias">categoria</a> primeiro.</p>`;
  return `<div class="row2">
    <label class="field"><span>Categoria</span>
      <select name="categoriaId" data-cat-select required>${S.categories
        .map((c) => `<option value="${c.id}" ${c.id === catId ? 'selected' : ''}>${esc(c.nome)}</option>`)
        .join('')}</select></label>
    <label class="field" data-client-field ${clientsOf(catId).length ? '' : 'hidden'}><span>Cliente <em>opcional</em></span>
      <select name="clienteId">${clientOptions(catId, cliId)}</select></label>
  </div>`;
}

const duracaoSelect = (val) =>
  `<select name="duracao">${DURACOES.map((d) => `<option value="${d}" ${d === (val || S.profile.duracaoPadrao) ? 'selected' : ''}>${d} min</option>`).join('')}</select>`;

// "Avisar antes" de uma tarefa. Só faz sentido com horário (na lista do dia ele é opcional).
function avisoFields(t) {
  const on = t.aviso ?? true;
  const min = Number.isFinite(t.avisoAntes) ? t.avisoAntes : S.profile.avisoAntes;
  return `<div class="aviso-field">
    <label class="switch-row"><input type="checkbox" name="aviso" ${on ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
      <span>${icon('sino')}Avisar</span></label>
    <select name="avisoAntes" aria-label="Quando avisar">${AVISOS.map(([m, l]) => `<option value="${m}" ${m === min ? 'selected' : ''}>${l}</option>`).join('')}</select>
    ${S.profile.notifTarefas ? '' : '<p class="hint">Os avisos de tarefas estão desligados nos <a href="#/ajustes">Ajustes</a>.</p>'}
  </div>`;
}

const defaultCat = (preferWork) =>
  (preferWork && S.categories.find((c) => /trabalho/i.test(c.nome))?.id) || S.categories[0]?.id || '';

function openDailyForm(t) {
  const editing = !!t.id;
  const fixa = editing && t.origem === 'fixa';
  const catId = t.categoriaId || defaultCat(false);
  openModal(`<form class="modal-body" data-form="daily" data-id="${t.id || ''}" data-old-date="${t.data}">
    ${modalHead(editing ? 'Editar tarefa' : 'Nova tarefa')}
    ${fixa ? '<p class="note">Esta tarefa veio da rotina semanal. Mudanças aqui valem só para este dia.</p>' : ''}
    <label class="field"><span>Título</span>
      <input name="titulo" required maxlength="120" autocomplete="off" value="${esc(t.titulo || '')}" autofocus></label>
    ${catClientFields(catId, t.clienteId)}
    <div class="row2">
      <label class="field"><span>Dia</span><input type="date" name="data" required value="${t.data}" ${fixa ? 'disabled' : ''}></label>
      <label class="field"><span>Horário <em>opcional</em></span><input type="time" name="horario" value="${t.horario || ''}" data-horario></label>
    </div>
    <div data-aviso-group ${t.horario ? '' : 'hidden'}>
      <label class="field"><span>Duração no quadro de horários</span>${duracaoSelect(t.duracao)}</label>
      ${avisoFields(t)}
    </div>
    ${
      editing
        ? `<label class="field"><span>${icon('cronometro')}Tempo gasto <em>(minutos, para corrigir o cronômetro)</em></span>
      <input type="number" name="tempoMin" min="0" max="1440" step="1" inputmode="numeric" value="${Math.round(elapsed(t) / 60)}" data-orig="${Math.round(elapsed(t) / 60)}"></label>`
        : ''
    }
    ${modalFoot(editing ? 'remove-daily' : '', t.id)}
  </form>`);
  if (editing) modal.querySelector('[data-action="remove-daily"]').dataset.date = t.data;
}

function openRecForm(r) {
  const editing = !!r.id;
  const dias = r.diasDaSemana || [1, 2, 3, 4, 5];
  const catId = r.categoriaId || defaultCat(!!r.clienteId);
  openModal(`<form class="modal-body" data-form="rec" data-id="${r.id || ''}">
    ${modalHead(editing ? 'Editar tarefa fixa' : 'Nova tarefa fixa')}
    <label class="field"><span>Título</span>
      <input name="titulo" required maxlength="120" autocomplete="off" value="${esc(r.titulo || '')}" autofocus></label>
    ${catClientFields(catId, r.clienteId)}
    <fieldset class="field">
      <legend>Repete em</legend>
      <div class="day-picks">${U.ORDEM_SEMANA.map(
        (d) => `<label class="day-pick"><input type="checkbox" name="dias" value="${d}" ${dias.includes(d) ? 'checked' : ''}><span>${U.DIAS_CURTO[d]}</span></label>`,
      ).join('')}</div>
      <div class="presets">
        <button type="button" class="link" data-action="days-preset" data-preset="1,2,3,4,5">Dias úteis</button>
        <button type="button" class="link" data-action="days-preset" data-preset="0,1,2,3,4,5,6">Todos os dias</button>
        <button type="button" class="link" data-action="days-preset" data-preset="0,6">Fim de semana</button>
      </div>
    </fieldset>
    <div class="row2">
      <label class="field"><span>Horário</span><input type="time" name="horario" required value="${r.horario || ''}"></label>
      <label class="field"><span>Duração</span>${duracaoSelect(r.duracao)}</label>
    </div>
    ${avisoFields(r)}
    <p class="hint">O horário organiza o quadro de horários e os avisos. Você pode concluir a tarefa a qualquer hora do dia.</p>
    ${modalFoot(editing ? 'delete-rec' : '', r.id)}
  </form>`);
}

function openClientForm(c) {
  const editing = !!c.id;
  openModal(`<form class="modal-body" data-form="client" data-id="${c.id || ''}">
    ${modalHead(editing ? 'Editar cliente' : 'Novo cliente')}
    <label class="field"><span>Nome</span><input name="nome" required maxlength="80" autocomplete="off" value="${esc(c.nome || '')}" autofocus></label>
    <label class="field"><span>Categoria</span>
      <select name="categoriaId" required>${S.categories
        .map((x) => `<option value="${x.id}" ${x.id === (c.categoriaId || defaultCat(true)) ? 'selected' : ''}>${esc(x.nome)}</option>`)
        .join('')}</select></label>
    <label class="field"><span>Observações <em>opcional</em></span><textarea name="observacoes" rows="3" maxlength="500">${esc(c.observacoes || '')}</textarea></label>
    ${modalFoot(editing ? 'delete-client' : '', c.id)}
  </form>`);
}

function openCatForm(c) {
  const editing = !!c.id;
  const cor = c.cor || PALETA[S.categories.length % PALETA.length];
  const custom = !PALETA.includes(cor);
  openModal(`<form class="modal-body" data-form="cat" data-id="${c.id || ''}">
    ${modalHead(editing ? 'Editar categoria' : 'Nova categoria')}
    <label class="field"><span>Nome</span><input name="nome" required maxlength="40" autocomplete="off" value="${esc(c.nome || '')}" autofocus></label>
    <fieldset class="field"><legend>Cor</legend>
      <div class="swatches">
        ${PALETA.map((p) => `<label class="sw" style="--c:${p}"><input type="radio" name="cor" value="${p}" ${p === cor ? 'checked' : ''} aria-label="${p}"><span></span></label>`).join('')}
        <label class="sw custom" style="--c:${custom ? cor : '#888888'}"><input type="radio" name="cor" value="custom" ${custom ? 'checked' : ''} aria-label="Outra cor"><span></span>
          <input type="color" name="corLivre" value="${custom ? cor : '#888888'}" aria-label="Escolher outra cor"></label>
      </div>
    </fieldset>
    ${modalFoot(editing ? 'delete-cat' : '', c.id)}
  </form>`);
}

const formData = (form) => Object.fromEntries(new FormData(form));
const avisoData = (f) => ({ aviso: f.aviso === 'on', avisoAntes: Number(f.avisoAntes) || 0 });

const FORMS = {
  daily(form) {
    const f = formData(form);
    const id = form.dataset.id;
    const patch = {
      titulo: f.titulo.trim(),
      categoriaId: f.categoriaId || null,
      clienteId: f.clienteId || null,
      horario: f.horario || null,
      duracao: Number(f.duracao) || null,
      ...avisoData(f),
    };
    if (!patch.titulo) return;
    if (id) {
      const oldDate = form.dataset.oldDate;
      const newDate = f.data || oldDate;
      const t = findTask(id, oldDate);
      patch.data = newDate;
      // Tempo corrigido à mão: substitui o acumulado (e reinicia a contagem se estiver rodando).
      const tempo = form.elements.tempoMin;
      if (tempo && tempo.value !== '' && tempo.value !== tempo.dataset.orig) {
        patch.tempoGasto = Math.max(0, Math.round(Number(tempo.value) * 60));
        if (t && isRunning(t)) patch.cronometroInicio = Date.now();
      }
      if (t) {
        Object.assign(t, patch);
        if (newDate !== oldDate) {
          S.days[oldDate] = S.days[oldDate].filter((x) => x !== t);
          S.days[newDate]?.push(t);
        }
      }
      persist(db.update('dailyTasks', id, patch));
    } else {
      const t = { id: U.newId(), ...patch, data: f.data, concluido: false, origem: 'avulsa', recurringTaskId: null, removido: false };
      S.days[t.data]?.push(t);
      persist(db.set('dailyTasks', t.id, t));
    }
    closeModal();
    render();
  },

  async rec(form) {
    const f = formData(form);
    const dias = new FormData(form).getAll('dias').map(Number).sort();
    if (!dias.length) return toast('Escolha pelo menos um dia da semana.');
    const data = {
      titulo: f.titulo.trim(),
      categoriaId: f.categoriaId || null,
      clienteId: f.clienteId || null,
      horario: f.horario || null,
      duracao: Number(f.duracao) || null,
      ...avisoData(f),
      diasDaSemana: dias,
      ativo: true,
    };
    if (!data.titulo) return;
    if (!data.horario) return toast('Na rotina semanal o horário é obrigatório.');
    const id = form.dataset.id;
    const today = U.todayStr();
    closeModal();
    if (id) {
      Object.assign(S.recurring.find((r) => r.id === id) || {}, data);
      // Atualiza as tarefas já geradas de hoje em diante que ainda não foram concluídas.
      const inst = await db.where('dailyTasks', 'recurringTaskId', '==', id);
      const { diasDaSemana, ativo, ...fields } = data;
      const ops = [{ type: 'update', col: 'recurringTasks', id, data }];
      for (const t of inst) {
        if (t.data < today || t.concluido) continue;
        if (!dias.includes(U.weekdayOf(t.data))) ops.push({ type: 'delete', col: 'dailyTasks', id: t.id });
        else ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: fields });
      }
      persist(db.batch(ops));
    } else {
      const r = { id: U.newId(), ...data, inicio: today };
      S.recurring.push(r);
      persist(db.set('recurringTasks', r.id, r));
    }
    invalidateFrom(today);
    render();
  },

  client(form) {
    const f = formData(form);
    const data = { nome: f.nome.trim(), categoriaId: f.categoriaId, observacoes: f.observacoes.trim() };
    if (!data.nome) return;
    const id = form.dataset.id;
    if (id) {
      Object.assign(S.clients.find((c) => c.id === id) || {}, data);
      persist(db.update('clients', id, data));
    } else {
      const c = { id: U.newId(), ...data };
      S.clients.push(c);
      persist(db.set('clients', c.id, c));
    }
    closeModal();
    render();
  },

  acesso(form) {
    const f = formData(form);
    const email = f.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return toast('Digite um e-mail válido.');
    const data = { admin: f.admin === 'on', liberadoPor: S.user.email, liberadoEm: Date.now() };
    const existing = S.acessos.find((a) => a.email === email);
    if (existing) Object.assign(existing, data);
    else S.acessos.push({ email, ...data });
    S.acessos.sort((a, b) => a.email.localeCompare(b.email));
    persist(access.set(email, data), () => (S.acessos = null));
    toast(`${email} liberado.`);
    render();
  },

  cat(form) {
    const f = formData(form);
    const data = { nome: f.nome.trim(), cor: f.cor === 'custom' ? f.corLivre : f.cor };
    if (!data.nome) return;
    const id = form.dataset.id;
    if (id) {
      Object.assign(catById(id) || {}, data);
      persist(db.update('categories', id, data));
    } else {
      const c = { id: U.newId(), ...data, ordem: S.categories.length ? Math.max(...S.categories.map((x) => x.ordem ?? 0)) + 1 : 0 };
      S.categories.push(c);
      persist(db.set('categories', c.id, c));
    }
    sortCats();
    closeModal();
    render();
  },
};

function saveSetting(el) {
  const name = el.name;
  if (!(name in DEFAULT_PROFILE)) return;
  let val = el.type === 'checkbox' ? el.checked : el.value;
  if (['agendaInicio', 'agendaFim', 'duracaoPadrao', 'avisoAntes'].includes(name)) val = Number(val);
  if (name === 'apelido') val = val.trim();
  if (name === 'notifPendentesHora' && !val) return;
  S.profile[name] = val;
  if (name === 'agendaInicio' && S.profile.agendaFim <= val) S.profile.agendaFim = Math.min(24, val + 1);
  if (name === 'agendaFim' && S.profile.agendaInicio >= val) S.profile.agendaInicio = Math.max(0, val - 1);
  persist(
    db.setProfile({
      [name]: val,
      agendaInicio: S.profile.agendaInicio,
      agendaFim: S.profile.agendaFim,
    }),
  );
  if (name === 'tema') applyTheme();
  if (name.startsWith('agenda') || el.type === 'checkbox') render();
  toast('Ajuste salvo.');
}

// ---------------------------------------------------------------------------
// Ações (cliques)
// ---------------------------------------------------------------------------

const ACTIONS = {
  login: async () => {
    try {
      await signIn();
    } catch (err) {
      toast(errMsg(err));
    }
  },
  logout: async () => {
    if (!(await ask('Sair da sua conta neste dispositivo?', 'Sair', false))) return;
    await unregisterPush(); // este aparelho para de receber os avisos desta conta
    lsSet('on', null);
    await signOut();
  },

  'logout-now': () => signOut(),

  'acesso-admin': ({ email }) => {
    const a = S.acessos?.find((x) => x.email === email);
    if (!a) return;
    a.admin = !a.admin;
    persist(access.set(email, { admin: a.admin }), () => (a.admin = !a.admin));
    render();
  },
  'acesso-remover': async ({ email }) => {
    if (!(await ask(`Remover o acesso de ${email}? A pessoa não consegue mais entrar (os dados dela ficam guardados).`, 'Remover'))) return;
    S.acessos = S.acessos.filter((x) => x.email !== email);
    persist(access.remove(email), () => (S.acessos = null));
    render();
  },

  'notif-on': async () => {
    if (!notifSupported()) return toast('Este navegador não suporta notificações.');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      render();
      return toast('Permissão não concedida.');
    }
    lsSet('on', '1');
    render();
    try {
      const ok = await registerPush();
      toast(ok ? 'Pronto! Os avisos chegam mesmo com o app fechado.' : 'Pronto! Avisos ativados com o app aberto.');
    } catch (err) {
      console.error(err);
      toast(`Avisos ativados com o app aberto. Não foi possível ativar com ele fechado: ${err.message || err}`);
    }
    render();
    notifTick();
  },
  'notif-off': async () => {
    lsSet('on', null);
    await unregisterPush();
    render();
    toast('Notificações desativadas neste aparelho.');
  },
  'notif-test': () =>
    showLocal('Teste de notificação', { body: 'Tudo certo! É assim que os avisos vão aparecer.', tag: 'teste' }).catch((err) =>
      toast(errMsg(err)),
    ),

  'filtro-status': ({ status }) => {
    S.filtro.status = status;
    render();
  },
  'filtro-limpar': () => {
    S.filtro = { status: 'todas', cat: '', cli: '' };
    render();
  },
  more: () => $('#more').classList.toggle('open'),

  go: ({ route, date }) => {
    if (date) S.date = date;
    if (location.hash === `#/${route}`) render();
    else location.hash = `#/${route}`;
  },
  'day-shift': ({ n }) => {
    S.date = U.addDays(S.date, Number(n));
    render();
  },
  'day-today': () => {
    S.date = U.todayStr();
    render();
  },

  toggle: ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    const ops = [];
    if (!t.concluido && isRunning(t)) stopTimer(t, ops); // concluiu: o cronômetro para
    t.concluido = !t.concluido;
    ops.push({ type: 'update', col: 'dailyTasks', id, data: { concluido: t.concluido } });
    render();
    persist(db.batch(ops), () => (t.concluido = !t.concluido));
  },
  timer: ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    const ops = [];
    if (isRunning(t)) {
      stopTimer(t, ops);
    } else {
      // Uma coisa de cada vez: pausa o que estiver rodando.
      for (const list of Object.values(S.days)) for (const o of list || []) if (o !== t && isRunning(o)) stopTimer(o, ops);
      t.cronometroInicio = Date.now();
      ops.push({ type: 'update', col: 'dailyTasks', id, data: { cronometroInicio: t.cronometroInicio } });
    }
    render();
    persist(db.batch(ops));
  },
  'new-daily': ({ date, cat, cli }) => openDailyForm({ data: date || S.date, categoriaId: cat, clienteId: cli }),
  'edit-daily': ({ id, date }) => {
    const t = findTask(id, date);
    if (t) openDailyForm(t);
  },
  'remove-daily': async ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    const msg =
      t.origem === 'fixa'
        ? `Remover “${t.titulo}” só deste dia? A rotina semanal continua igual.`
        : `Remover “${t.titulo}” deste dia?`;
    if (!(await ask(msg, 'Remover'))) return;
    if (t.origem === 'fixa') {
      t.removido = true;
      persist(db.update('dailyTasks', id, { removido: true }));
    } else {
      S.days[date] = S.days[date].filter((x) => x !== t);
      persist(db.remove('dailyTasks', id));
    }
    render();
  },
  restore: ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    t.removido = false;
    persist(db.update('dailyTasks', id, { removido: false }));
    render();
  },

  'cal-shift': ({ n }) => {
    S.calMonth = U.addMonths(S.calMonth, Number(n));
    render();
  },
  'cal-today': () => {
    S.calSel = U.todayStr();
    S.calMonth = S.calSel.slice(0, 7);
    render();
  },
  'cal-pick': ({ date }) => {
    S.calSel = date;
    if (date.slice(0, 7) !== S.calMonth) S.calMonth = date.slice(0, 7);
    render();
    if (!isWide()) $('#day-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  },
  'cal-open': ({ date }) => {
    S.calSel = date;
    S.calMonth = date.slice(0, 7);
    location.hash = '#/calendario';
  },

  'rotina-dia': ({ d }) => {
    S.rotinaDia = d === 'all' ? 'all' : Number(d);
    render();
  },
  'new-rec': ({ cat, cli }) =>
    openRecForm({
      categoriaId: cat,
      clienteId: cli,
      diasDaSemana: S.rotinaDia === 'all' ? [1, 2, 3, 4, 5] : [S.rotinaDia],
    }),
  'edit-rec': ({ id }) => {
    const r = S.recurring.find((x) => x.id === id);
    if (r) openRecForm(r);
  },
  'delete-rec': async ({ id }) => {
    const r = S.recurring.find((x) => x.id === id);
    if (!r || !(await ask(`Excluir “${r.titulo}” da rotina? Ela sai dos próximos dias; o histórico dos dias passados fica.`))) return;
    const today = U.todayStr();
    S.recurring = S.recurring.filter((x) => x !== r);
    const inst = await db.where('dailyTasks', 'recurringTaskId', '==', id);
    persist(
      db.batch([
        { type: 'delete', col: 'recurringTasks', id },
        ...inst.filter((t) => t.data >= today && !t.concluido).map((t) => ({ type: 'delete', col: 'dailyTasks', id: t.id })),
      ]),
    );
    invalidateFrom(today);
    render();
  },
  'days-preset': ({ preset }, el) => {
    const set = preset.split(',').map(Number);
    el.closest('form')
      .querySelectorAll('input[name="dias"]')
      .forEach((i) => (i.checked = set.includes(Number(i.value))));
  },

  'new-client': () => openClientForm({}),
  'edit-client': ({ id }) => openClientForm(cliById(id) || {}),
  'delete-client': async ({ id }) => {
    const c = cliById(id);
    if (!c || !(await ask(`Excluir o cliente “${c.nome}”? As tarefas dele continuam, mas sem cliente.`))) return;
    S.clients = S.clients.filter((x) => x !== c);
    persist(db.remove('clients', id));
    render();
  },

  'new-cat': () => openCatForm({}),
  'edit-cat': ({ id }) => openCatForm(catById(id) || {}),
  'delete-cat': async ({ id }) => {
    const c = catById(id);
    if (!c || !(await ask(`Excluir a categoria “${c.nome}”? Tarefas e clientes dela ficarão como “Sem categoria”.`))) return;
    S.categories = S.categories.filter((x) => x !== c);
    persist(db.remove('categories', id));
    render();
  },
  'cat-move': ({ id, n }) => {
    const i = S.categories.findIndex((c) => c.id === id);
    const j = i + Number(n);
    if (i < 0 || j < 0 || j >= S.categories.length) return;
    [S.categories[i], S.categories[j]] = [S.categories[j], S.categories[i]];
    S.categories.forEach((c, k) => (c.ordem = k));
    persist(db.batch(S.categories.map((c) => ({ type: 'update', col: 'categories', id: c.id, data: { ordem: c.ordem } }))));
    render();
  },

  'close-modal': () => closeModal(),
  'ask-yes': () => {
    const r = askResolver;
    askResolver = null;
    closeModal();
    r?.(true);
  },
  'ask-no': () => closeModal(),

  install: async () => {
    if (!S.installEvt) return;
    S.installEvt.prompt();
    await S.installEvt.userChoice;
    S.installEvt = null;
    render();
  },
  'reset-demo': async () => {
    if (!(await ask('Apagar todos os dados de demonstração deste navegador?', 'Apagar'))) return;
    resetDemo();
    location.reload();
  },
};

// ---------------------------------------------------------------------------
// Eventos globais
// ---------------------------------------------------------------------------

document.addEventListener('click', async (e) => {
  const sheet = $('#more');
  if (sheet?.classList.contains('open') && !e.target.closest('[data-action="more"]') && !e.target.closest('.sheet-panel')) {
    sheet.classList.remove('open');
  }
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = ACTIONS[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  try {
    await fn(el.dataset, el, e);
  } catch (err) {
    console.error(err);
    toast(errMsg(err));
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  try {
    await FORMS[form.dataset.form](form);
  } catch (err) {
    console.error(err);
    toast(errMsg(err));
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-cat-select]')) {
    const field = t.form.querySelector('[data-client-field]');
    field.hidden = !clientsOf(t.value).length;
    field.querySelector('select').innerHTML = clientOptions(t.value, '');
  } else if (t.name === 'corLivre') {
    const radio = t.form.querySelector('input[name="cor"][value="custom"]');
    radio.checked = true;
    radio.closest('.sw').style.setProperty('--c', t.value);
  } else if (t.matches('[data-filter]')) {
    S.filtro[t.dataset.filter] = t.value;
    if (t.dataset.filter === 'cat') S.filtro.cli = '';
    render();
  } else if (t.closest('[data-settings]')) {
    saveSetting(t);
  }
});

// Na lista do dia, duração e aviso só aparecem quando a tarefa tem horário.
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-horario]')) {
    const group = e.target.form.querySelector('[data-aviso-group]');
    if (group) group.hidden = !e.target.value;
  }
});

window.addEventListener('hashchange', () => {
  $('#more')?.classList.remove('open');
  closeModal();
  render();
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  S.installEvt = e;
});

// A cada minuto: atualiza a linha do "agora" e vira o dia à meia-noite.
setInterval(() => {
  const t = U.todayStr();
  if (t !== S.lastToday) {
    if (S.date === S.lastToday) S.date = t;
    S.lastToday = t;
  }
  const typing = document.activeElement?.closest?.('#view') && document.activeElement.matches('input, select, textarea');
  if (S.user && S.ready && !modal.open && !document.hidden && !typing && ['painel', 'hoje', 'horarios'].includes(currentRoute())) {
    render();
  }
}, 60_000);

setInterval(notifTick, 30_000);

// Cronômetros rodando: atualiza só o número na tela, a cada segundo.
setInterval(() => {
  document.querySelectorAll('[data-live]').forEach((el) => {
    el.textContent = U.fmtRelogio(Number(el.dataset.base) + (Date.now() - Number(el.dataset.start)) / 1000);
  });
}, 1000);

// Voltando ao app depois de um tempo: recarrega os dias (pode ter mudado em outro aparelho).
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (S.user && S.ready && Date.now() - hiddenAt > 5 * 60_000) {
    S.days = {};
    S.ensured = new Set();
    S.ranges = new Set();
    if (!modal.open) render();
  }
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// ---------------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------------

initBackend(async (user) => {
  closeModal();
  resetState();
  S.user = user;
  if (user) {
    render();
    try {
      await checkAccess();
      if (S.blocked) return render();
      await loadAll();
    } catch (err) {
      console.error(err);
      root.innerHTML = `<div class="login"><div class="login-card">${LOGO}<h1>Não foi possível carregar</h1>
        <p class="lead">${esc(errMsg(err))}</p><button class="btn primary" onclick="location.reload()">Tentar de novo</button></div></div>`;
      return;
    }
  }
  render();
}).catch((err) => {
  console.error(err);
  root.innerHTML = `<div class="login"><div class="login-card">${LOGO}<h1>Erro ao iniciar</h1><p class="lead">${esc(err.message || err)}</p></div></div>`;
});
