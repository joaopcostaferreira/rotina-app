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
import { createFin } from './financas.js';
import { createExtras } from './extras.js';

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
  // Relatório "Seu dia": o sono não conta; do acordar até a 1ª tarefa é "Acordou → 1ª tarefa".
  acordar: '07:00',
  comecoAte: '08:00',
  dormir: '23:30',
  abrirEm: 'painel', // tela que abre quando o app começa
  navOrdem: [], // ordem das áreas no menu (vazio = padrão)
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
  relPeriodo: 'semana', // Relatórios: 'ontem' | 'hoje' | 'semana' | 'mes' | 'custom'
  relMes: U.todayStr().slice(0, 7),
  relDe: U.addDays(U.todayStr(), -6), // Personalizado: de… até… (a mesma data nos dois = um dia só)
  relAte: U.todayStr(),
  pedirConclusao: null, // tarefa pausada em Hoje: mostra o ✓ "Finalizou?" ao lado do cronômetro
  diarioDate: null, // dia aberto no Diário (null = lista de anotações)
  journal: null, // entradas do Diário (data -> { texto })
  journalBusca: '',
  lastToday: U.todayStr(),
  installEvt: null,
  ready: false,
  blocked: false, // e-mail não está na lista de permitidos
  isAdmin: false, // pode liberar outros e-mails (tela Acessos)
  acessos: null, // lista carregada na tela Acessos
};
const pending = { days: {}, ranges: {} };

const NAV = [
  { id: 'financas', label: 'Finanças', fin: true },
  { id: 'painel', label: 'Painel' },
  { id: 'calendario', label: 'Calendário' },
  { id: 'diario', label: 'Diário' },
  { id: 'rotina', label: 'Rotina' },
  { id: 'clientes', label: 'Clientes' },
  { id: 'relatorios', label: 'Relatórios' },
  { id: 'aniversarios', label: 'Datas importantes' },
  { id: 'categorias', label: 'Categorias' },
  { id: 'ajustes', label: 'Ajustes' },
  { id: 'acessos', label: 'Acessos', admin: true },
];
// Finanças: para todo mundo que tem acesso (cada pessoa com as próprias contas, começando do zero).
const finOK = () => true;
const TABS_BASE = ['calendario', 'painel', 'diario'];
let TABS = TABS_BASE;
// Na ordem escolhida em Ajustes (as que não estão na lista vão para o fim, na ordem padrão).
const navItems = () => {
  const ord = Array.isArray(S.profile.navOrdem) ? S.profile.navOrdem : [];
  const pos = (id) => (ord.includes(id) ? ord.indexOf(id) : 100 + NAV.findIndex((n) => n.id === id));
  return NAV.filter((n) => (!n.admin || S.isAdmin) && (!n.fin || finOK())).sort((x, y) => pos(x.id) - pos(y.id));
};
const navLabel = (id) => NAV.find((n) => n.id === id)?.label || '';
const inicioRoute = () => (VIEWS[S.profile.abrirEm] && navItems().some((n) => n.id === S.profile.abrirEm) ? S.profile.abrirEm : 'painel');

// ---------------------------------------------------------------------------
// Utilidades de interface
// ---------------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const root = document.getElementById('root');
const modal = document.getElementById('modal');

const catById = (id) => S.categories.find((c) => c.id === id);
const cliById = (id) => S.clients.find((c) => c.id === id);
const colorOf = (t) => catById(t.categoriaId)?.cor || '#94a3b8';
// Clientes são só do Trabalho: a categoria com "trabalho" no nome (ou, se ela foi renomeada, a que tiver clientes).
const workCatId = () =>
  S.categories.find((c) => /trabalho/i.test(c.nome))?.id ||
  S.categories.find((c) => S.clients.some((x) => x.categoriaId === c.id))?.id ||
  null;
const isWork = (catId) => !!catId && catId === workCatId();
const workColor = () => catById(workCatId())?.cor || '#0ea5e9';
const clientsOf = (catId) => (isWork(catId) ? [...S.clients].sort(U.byNome) : []);
// Cliente ativo ou finalizado. "Só financeiro" (ex.: sociedade) não aparece no ▶, porque não gasta horas.
// "Pede o nome" (ex.: Fotografia): ao iniciar, pergunta o nome da pessoa atendida.
const isAtivo = (c) => (c?.status || 'ativo') !== 'finalizado';
const startClients = () => S.clients.filter((c) => isAtivo(c) && !c.soFinanceiro).sort(U.byNome);
const servicosOf = (c) => (c?.servicos || []).filter(Boolean);
// Categorias com lista própria (ex.: Cursos → Inglês, Fotografia) e tarefas opcionais ao iniciar (ex.: Estudar, Praticar).
const allItens = (cat) => (cat && !isWork(cat.id) ? (cat.itens || []).filter((i) => i?.nome) : []);
const itensOf = (cat) => allItens(cat).filter((i) => !i.oculto);
const listCats = () => S.categories.filter((c) => itensOf(c).length);
const itemOf = (t) => (t?.itemId ? allItens(catById(t.categoriaId)).find((i) => i.id === t.itemId) : null);
const subsOf = (cat) => (cat?.subtarefas || []).filter(Boolean);
const visible = (tasks) => (tasks || []).filter((t) => !t.removido);
// Tarefa resolvida: concluída ou marcada com X (não feita). Nenhuma das duas fica como pendente.
const fechada = (t) => !!(t.concluido || t.naoFeito);
// Já tem algo feito nela (terminada, rodando, tempo, sessões ou notas): mudar a rotina não pode apagar isso.
const temRegistro = (t) => fechada(t) || !!t.cronometroInicio || t.tempoGasto > 0 || !!t.sessoes?.length || !!String(t.notas || '').trim();
const duracao = (t) => t.duracao || (t.fimAberto ? 90 : S.profile.duracaoPadrao || 30); // sem hora de fim: só para desenhar a agenda
const firstName = () => S.profile.apelido || (S.user?.nome || '').split(' ')[0] || 'você';
const sortCats = () =>
  S.categories.sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || U.byNome(a, b));

function progress(tasks) {
  const v = visible(tasks);
  const done = v.filter((t) => t.concluido).length;
  const nao = v.filter((t) => t.naoFeito).length;
  return { done, nao, total: v.length, pct: v.length ? Math.round((done * 100) / v.length) : 0 };
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

// Salvamento automático de textos (notas e diário): espera a pessoa parar de digitar.
const pendingSaves = new Map();
function debounceSave(key, fn, ms = 700) {
  const p = pendingSaves.get(key);
  if (p) clearTimeout(p.timer);
  pendingSaves.set(key, {
    fn,
    timer: setTimeout(() => {
      pendingSaves.delete(key);
      fn();
    }, ms),
  });
}
function flushSaves() {
  for (const p of pendingSaves.values()) {
    clearTimeout(p.timer);
    p.fn();
  }
  pendingSaves.clear();
}
const setStatus = (sel, text) => document.querySelectorAll(sel).forEach((el) => (el.textContent = text));

let askResolver = null;
function openModal(html) {
  flushSaves();
  delete modal.dataset.detail;
  modal.innerHTML = html;
  if (!modal.open) modal.showModal();
  const focus = modal.querySelector('[autofocus]');
  if (focus && matchMedia('(hover: hover)').matches) focus.focus();
}
function closeModal() {
  if (modal.open) modal.close();
}
modal.addEventListener('close', () => {
  // Fechou e já abriu outra janela (ex.: concluiu e veio a pergunta de sobrescrever): o aviso atrasado não vale para a nova.
  if (modal.open) return;
  flushSaves();
  delete modal.dataset.detail;
  if (askResolver) {
    const r = askResolver;
    askResolver = null;
    r(false);
  }
  // Voltou ao app com a janela aberta: agora que fechou, busca os dias de novo (depois do que estava em andamento).
  if (recarregarDias) setTimeout(() => !modal.open && recarregarDias && recarregaDias(), 300);
});
// Busca os dias de novo (ex.: o app ficou escondido e outro aparelho pode ter mudado algo).
let recarregarDias = false;
function recarregaDias() {
  recarregarDias = false;
  S.days = {};
  S.ensured = new Set();
  S.ranges = new Set();
  render();
}
let fundoDown = false;
modal.addEventListener('pointerdown', (e) => {
  fundoDown = e.target === modal;
});
modal.addEventListener('click', (e) => {
  if (e.target === modal && fundoDown) closeModal();
  fundoDown = false;
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

// Repete toda semana (dias da semana) ou todo mês (um dia do mês; em mês curto, cai no último dia).
const lastDayOf = (date) => Number(U.addDays(`${U.addMonths(date.slice(0, 7), 1)}-01`, -1).slice(8));
function repeatsOn(r, date) {
  if (r.repete === 'mes') return Number(date.slice(8)) === Math.min(r.diaDoMes || 1, lastDayOf(date));
  return (r.diasDaSemana || []).includes(U.weekdayOf(date));
}
const recurringApplies = (r, date) => r.ativo !== false && repeatsOn(r, date) && (!r.inicio || date >= r.inicio);
const isMensal = (r) => r.repete === 'mes';

// O id é fixo (rotina + data): gerar duas vezes nunca duplica a tarefa.
const instanceFrom = (r, date) => ({
  id: `${r.id}_${date}`,
  titulo: r.titulo,
  categoriaId: r.categoriaId,
  clienteId: r.clienteId || null,
  itemId: r.itemId || null,
  data: date,
  horario: r.horario || null,
  duracao: r.duracao || null,
  fimAberto: !!r.fimAberto,
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
    // Grava juntando (merge) e sem "concluido/removido": se outro aparelho já criou e mexeu nessa tarefa
    // (sem internet aqui, por exemplo), o que foi feito lá não é apagado.
    persist(db.batch(created.map(({ concluido, removido, ...data }) => ({ type: 'merge', col: 'dailyTasks', id: data.id, data }))));
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
  FIN.reset();
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
    diarioDate: null,
    journal: null,
    journalBusca: '',
    // Ao trocar de conta nada da anterior pode ficar na memória (datas importantes, avisos da tela).
    anivs: null,
    datasCats: null,
    anivBusca: '',
    anivCat: 'todas',
    pedirConclusao: null,
    diaPop: null,
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
  return inicioRoute();
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
  if (!$('.app', root)) {
    TABS = finOK() ? ['financas', 'painel', 'calendario', 'diario'] : TABS_BASE;
    root.innerHTML = shellHTML();
  }

  // Link antigo da tela Hoje (ou de um aviso): abre a agenda do dia como pop-up por cima.
  if (/^#\/?(hoje|horarios)$/.test(location.hash)) {
    S.diaPop = true;
    history.replaceState(null, '', `#/${lastRoute || inicioRoute()}`);
  }
  const r = currentRoute();
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = a.dataset.nav === r;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  // Celular: a barra de baixo arrasta; deixa a tela aberta à vista.
  const bar = $('.tabbar');
  const on = bar?.querySelector('.nav-link.active');
  if (on && bar.scrollWidth > bar.clientWidth) {
    const b = bar.getBoundingClientRect();
    const o = on.getBoundingClientRect();
    if (o.left < b.left || o.right > b.right) bar.scrollLeft += o.left - b.left - (b.width - o.width) / 2;
  }

  if (r === 'diario' && lastRoute !== 'diario') S.diarioDate = null;
  const view = $('#view');
  view.innerHTML = VIEWS[r]();
  document.title = `${navLabel(r)} · Segundo Cérebro`;

  if (r !== lastRoute) {
    window.scrollTo(0, 0);
    S.scrolledNow = false;
  }
  lastRoute = r;
  afterRender(r);
  renderDiaPop();
}

// "Abrir o dia": a agenda do dia (o antigo Hoje) num pop-up por cima da tela, sem trocar de página.
function renderDiaPop() {
  const pop = $('#daypop');
  if (!pop) return;
  if (!S.diaPop) {
    if (!pop.hidden) {
      pop.hidden = true;
      pop.innerHTML = '';
      document.body.classList.remove('pop-aberto');
    }
    return;
  }
  if (pop.hidden || !pop.firstElementChild) {
    pop.innerHTML = `<div class="daypop-card" role="dialog" aria-modal="true" aria-label="Agenda do dia">
      <button type="button" class="icon-btn daypop-x" data-action="dia-fechar" aria-label="Fechar" title="Fechar">${icon('x')}</button>
      <div class="daypop-body"></div></div>`;
    pop.hidden = false;
    document.body.classList.add('pop-aberto');
    S.scrolledNow = false;
  }
  pop.querySelector('.daypop-body').innerHTML = viewHoje();
  if (!S.scrolledNow) {
    const line = pop.querySelector('.now-line');
    if (line) {
      line.scrollIntoView({ block: 'center' });
      S.scrolledNow = true;
    }
  }
}

function afterRender(r) {
  if (r === 'hoje' && !S.scrolledNow) {
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
      <a class="brand" href="#/painel">${LOGO}<span>Segundo Cérebro</span></a>
      <nav class="nav" aria-label="Principal">${navItems().map(link).join('')}</nav>
      <div class="side-user">${avatar}<div><strong>${esc(u.nome || 'Você')}</strong><small>${esc(u.email)}</small></div></div>
    </aside>
    <main class="main">
      ${isDemo ? `<div class="demo-banner">${icon('sparkle')}<span>Modo demonstração: os dados ficam só neste navegador.</span><a href="#/ajustes">Ativar login Google</a></div>` : ''}
      <div id="view" class="view"></div>
    </main>
    <nav class="tabbar" aria-label="Principal">${navItems().map(link).join('')}</nav>
    <div id="daypop" class="daypop" hidden></div>
  </div>`;
}

function loginHTML() {
  return `
  <div class="login">
    <div class="login-card">
      ${LOGO}
      <h1>Segundo Cérebro</h1>
      <p class="lead">Sua to-do list diária por categorias, com clientes, rotina semanal e a agenda do dia com horários.</p>
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
      <span class="eyebrow">${esc(U.relativo(date))}${isToday ? ` · ${clockHTML()}` : ` · hoje é ${agoraHTML()}`}</span>
      <h1>${esc(U.fmtDiaLongo(date))}</h1>
    </div>
    <button type="button" class="icon-btn" data-action="day-shift" data-n="1" aria-label="Próximo dia">${icon('right')}</button>
    ${isToday ? '' : '<button type="button" class="btn ghost sm" data-action="day-today">Ir para hoje</button>'}
  </div>`;
}

// Passou do horário (ou o dia já passou) e ainda não foi concluída: continua pendente, marcada como atrasada.
function isLate(t) {
  if (fechada(t) || isRunning(t)) return false;
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
// Marcada com X: o tempo planejado que ficou sem fazer vira tempo desperdiçado (segundos).
// Só conta tarefa com horário e fim; o que chegou a ser cronometrado sai da conta.
const desperdicio = (t) => (t.naoFeito && t.horario && !t.fimAberto ? Math.max(0, duracao(t) * 60 - elapsed(t)) : 0);
const sumDesperdicio = (list) => list.reduce((a, t) => a + desperdicio(t), 0);

// Cada play → pausa vira uma sessão { i: início, f: fim, obs: o que fez } em t.sessoes (horários em ms).
// Pausa: soma o tempo corrido ao acumulado e fecha a sessão aberta.
// fim: quando parou (padrão agora; "Comecei às…" em outra tarefa para esta no horário dito).
function stopTimer(t, ops, fim = Date.now()) {
  const ini = t.cronometroInicio;
  if (ini) fim = Math.max(fim, ini);
  t.tempoGasto = Math.round((t.tempoGasto || 0) + (ini ? (fim - ini) / 1000 : 0));
  t.cronometroInicio = null;
  const last = t.sessoes?.[t.sessoes.length - 1];
  if (last && !last.f) last.f = fim;
  const data = { tempoGasto: t.tempoGasto, cronometroInicio: null };
  if (t.sessoes) data.sessoes = t.sessoes;
  ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data });
}

// Play: uma coisa de cada vez, então pausa o que estiver rodando e abre uma sessão nova.
// inicio: "Comecei às…" (padrão agora). Nunca antes do fim da sessão anterior desta tarefa.
// Se já está rodando, só acerta o começo da sessão aberta.
function startTimer(t, ops, inicio = Date.now()) {
  const ss = t.sessoes || [];
  const aberta = isRunning(t) && ss.length && !ss[ss.length - 1].f ? ss[ss.length - 1] : null;
  const anterior = aberta ? ss[ss.length - 2] : ss[ss.length - 1];
  let ini = Math.min(inicio, Date.now());
  if (anterior?.f) ini = Math.max(ini, anterior.f);
  // A que estava rodando para no horário em que esta começou (se começou depois dela); senão, agora.
  for (const list of Object.values(S.days))
    for (const o of list || []) if (o !== t && isRunning(o)) stopTimer(o, ops, ini > o.cronometroInicio ? ini : Date.now());
  t.cronometroInicio = ini;
  if (aberta) aberta.i = ini;
  else t.sessoes = [...ss, { i: ini }];
  ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: { cronometroInicio: ini, sessoes: t.sessoes } });
}

// Cronômetro ligado em outro dia: " de ontem" ou " do dia 23/11" (hoje: nada).
const desdeDia = (ms) => {
  const d = U.ymd(new Date(ms));
  if (d === U.todayStr()) return '';
  return d === U.addDays(U.todayStr(), -1) ? ' de ontem' : ` do dia ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
// Momento (ms) de um horário num dia: "2026-11-04" + 570 min → 04/11 09:30.
const tsOf = (date, min) => U.parseYmd(date).getTime() + min * 60_000;
// Primeiro horário (min do dia) em que algo foi feito: começo da 1ª sessão; sem sessões, o horário da tarefa.
function startMinOf(t) {
  const s = (t.sessoes || []).find((x) => x.i);
  if (s) return Math.round((s.i - U.parseYmd(t.data).getTime()) / 60_000);
  return elapsed(t) >= 60 && t.horario ? U.toMin(t.horario) : null;
}

// Horário real de uma tarefa, em minutos desde a meia-noite do dia dela (passa de 1440 quando atravessa a meia-noite).
// Com sessões: do começo da 1ª ao fim da última (rodando = agora). Sem sessões: o horário planejado.
// vis = para desenhar na tela: tarefa ainda não concluída cujo fim planejado vem depois do que já rodou
// vai até o fim planejado (ex.: era até 10h30, mudou para 11h30 → o bloco cresce).
function spanOf(t, vis = false) {
  const ss = (t.sessoes || []).filter((x) => x.i);
  if (ss.length) {
    const base = U.parseYmd(t.data).getTime();
    const run = isRunning(t);
    const i = Math.min(...ss.map((x) => x.i));
    const f = Math.max(...ss.map((x) => x.f || (run ? Date.now() : x.i)));
    const s = Math.floor((i - base) / 60_000);
    let e = Math.max(s + 1, Math.round((f - base) / 60_000));
    let aberto = run;
    if (vis && !t.concluido && t.horario && !t.fimAberto) {
      const ps = U.toMin(t.horario);
      const pe = ps + duracao(t);
      if (ps <= e && pe > e) (e = pe), (aberto = false);
    }
    return { s, e, real: true, aberto };
  }
  if (!t.horario) return null;
  const s = U.toMin(t.horario);
  return { s, e: s + duracao(t), real: false, aberto: !!t.fimAberto };
}
const minTxt = (m) => U.fromMin(((Math.round(m) % 1440) + 1440) % 1440);
// "09:00–10:30", "20:00–02:00 (+1 dia)", "14:00–agora", "19:00 · sem hora de fim".
function spanTxt(sp) {
  if (!sp) return '';
  if (sp.aberto) return sp.real ? `${minTxt(sp.s)}–agora` : `${minTxt(sp.s)} · sem hora de fim`;
  const dias = Math.floor((sp.e - 1) / 1440) - Math.floor(sp.s / 1440);
  return `${minTxt(sp.s)}–${minTxt(sp.e)}${dias > 0 ? ` (+${dias} dia${dias > 1 ? 's' : ''})` : ''}`;
}
// Cronômetros rodando em qualquer dia já carregado (ex.: começou ontem às 20h e ainda não parou).
const runningTasks = () => Object.values(S.days).flatMap((l) => (l || []).filter((t) => !t.removido && isRunning(t)));
// Tarefas de até 3 dias antes que atravessaram a meia-noite e ainda tomam parte de `date`.
function carryOver(date) {
  const out = [];
  for (let k = 1; k <= 3; k++) {
    for (const t of visible(S.days[U.addDays(date, -k)])) {
      const sp = spanOf(t);
      if (sp?.real && sp.e > k * 1440) out.push({ t, off: k * 1440 });
    }
  }
  return out;
}
const pararBtn = (t, cls = '') =>
  `<button type="button" class="btn primary parar ${cls}" data-action="parar" data-id="${t.id}" data-date="${t.data}" title="Parar: ${esc(t.titulo)}">${icon('stop')}<span>Parar</span></button>`;

// Nome na tela: sempre a categoria na frente, uma bolinha e o que é.
// Ex.: "Cursos • Aula de inglês", "Cursos • Fotografia", "Trabalho • Ronald - Edição de vídeo", "Religião • Igreja".
function nomePartes(t) {
  const cat = catById(t.categoriaId);
  const cli = cliById(t.clienteId);
  const tit = (t.titulo || '').trim();
  const n = norm(tit);
  const gen = !n || n === norm(cat?.nome || '') || n === 'trabalho';
  let resto;
  if (cli) {
    const serv = (t.servico || (gen || n === norm(cli.nome) ? '' : tit)).trim();
    resto = [cli.nome, serv && norm(serv) !== norm(cli.nome) ? serv : ''].filter(Boolean).join(' - ');
    if (t.pessoa && !norm(resto).includes(norm(t.pessoa))) resto += ` · ${t.pessoa}`;
  } else resto = gen ? itemOf(t)?.nome || '' : tit;
  if (!cat) return { cat: '', resto: resto || tit };
  return { cat: cat.nome, resto };
}
const nomeTxt = (t) => {
  const { cat, resto } = nomePartes(t);
  return [cat, resto].filter(Boolean).join(' • ') || t.titulo || '';
};
const nomeHTML = (t) => {
  const { cat, resto } = nomePartes(t);
  if (cat && resto) return `${esc(cat)}<i class="t-dot" aria-hidden="true"></i>${esc(resto)}`;
  return esc(cat || resto || t.titulo || '');
};

// Subtítulo de uma tarefa: categoria · cliente/curso · pessoa.
const taskSub = (t) => [catById(t.categoriaId)?.nome, cliById(t.clienteId)?.nome, itemOf(t)?.nome].filter(Boolean).join(' · ');

// Texto que se atualiza a cada segundo enquanto o cronômetro roda.
const liveAttrs = (t) => `data-live data-base="${t.tempoGasto || 0}" data-start="${t.cronometroInicio}"`;

function timerHTML(t) {
  const run = isRunning(t);
  const sec = elapsed(t);
  if (t.naoFeito) return '';
  if (t.concluido) return sec >= 60 ? `<span class="timer-chip" title="Tempo gasto">${icon('cronometro')}${U.fmtDur(sec)}</span>` : '';
  const label = run ? `<span ${liveAttrs(t)}>${U.fmtRelogio(sec)}</span>` : sec ? `<span>${U.fmtDur(sec)}</span>` : '';
  return `<button type="button" class="timer${run ? ' running' : ''}" data-action="timer" data-id="${t.id}" data-date="${t.data}"
    aria-label="${run ? 'Pausar' : sec ? 'Continuar' : 'Iniciar'} cronômetro" title="${run ? 'Pausar' : 'Iniciar'} cronômetro">${icon(run ? 'pause' : 'play')}${label}</button>`;
}

// X ao lado do play e da nota: marca que não foi feita (tocar de novo desfaz).
const xBtn = (t) =>
  t.concluido
    ? ''
    : `<button type="button" class="icon-btn xs nf-btn${t.naoFeito ? ' on' : ''}" data-action="nao-feito" data-id="${t.id}" data-date="${t.data}"
      aria-pressed="${!!t.naoFeito}" aria-label="${t.naoFeito ? 'Desfazer não feito' : 'Marcar como não feito'}: ${esc(t.titulo)}" title="${t.naoFeito ? 'Desfazer não feito' : 'Não fiz'}">${icon('x')}</button>`;

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
    spanOf(t, true) ? `<span class="chip">${icon('horarios')}${spanTxt(spanOf(t, true))}</span>` : '',
    t.horario && avisoAtivo(t) && !fechada(t)
      ? `<span class="chip muted" title="Aviso ${avisoMin(t) ? `${avisoMin(t)} min antes` : 'na hora'}">${icon('sino')}${avisoMin(t) ? `${avisoMin(t)} min` : 'na hora'}</span>`
      : '',
    t.origem === 'fixa' ? `<span class="chip muted" title="Vem da rotina">${icon('rotina')}Rotina</span>` : '',
    t.notas?.trim() ? `<span class="chip muted" title="Tem notas">${icon('nota')}Notas</span>` : '',
  ].join('');
  return `<li class="task${t.concluido ? ' done' : ''}${t.naoFeito ? ' nf' : ''}${late ? ' late' : ''}${isRunning(t) ? ' running' : ''}" style="--c:${colorOf(t)}">
    <button type="button" class="check" role="checkbox" aria-checked="${!!t.concluido}" aria-label="Concluir ${esc(t.titulo)}"
      data-action="toggle" data-id="${t.id}" data-date="${t.data}">${icon('check')}</button>
    <div class="task-main" data-action="open-task" data-id="${t.id}" data-date="${t.data}" title="Abrir notas e cronômetro">
      <span class="task-title">${nomeHTML(t)}</span>
      ${meta ? `<span class="task-meta">${meta}</span>` : ''}
    </div>
    ${S.pedirConclusao === t.id && !t.concluido ? `<button type="button" class="b-done" data-action="toggle" data-id="${t.id}" data-date="${t.data}">${icon('check')}<span>Finalizou?</span></button>` : ''}
    ${timerHTML(t)}
    ${xBtn(t)}
    <div class="task-actions">
      <button type="button" class="icon-btn sm" data-action="edit-daily" data-id="${t.id}" data-date="${t.data}" aria-label="Editar">${icon('edit')}</button>
      <button type="button" class="icon-btn sm" data-action="remove-daily" data-id="${t.id}" data-date="${t.data}" aria-label="Remover deste dia">${icon('trash')}</button>
    </div>
  </li>`;
}

function emptyState(title, text) {
  return `<div class="empty">${icon('hoje')}<h3>${title}</h3><p>${text}</p></div>`;
}

function dayDots(dias, cls = '') {
  return `<span class="day-dots ${cls}" aria-label="${U.ORDEM_SEMANA.filter((d) => dias.includes(d)).map((d) => U.DIAS_CURTO[d]).join(', ')}">${U.ORDEM_SEMANA.map(
    (d) => `<i class="${dias.includes(d) ? 'on' : ''}">${U.DIAS_LETRA[d]}</i>`,
  ).join('')}</span>`;
}

function ringDia(p, atras) {
  const c = 2 * Math.PI * 42;
  const segs = [
    ['ok', p.done],
    ['nf', p.nao],
    ['late', atras],
    ['fut', Math.max(0, p.total - p.done - p.nao - atras)],
  ].filter(([, n]) => n > 0);
  let off = 0;
  const arcs = segs
    .map(([cls, n]) => {
      const len = (n / p.total) * c;
      const gap = segs.length > 1 ? Math.min(3, len / 3) : 0;
      const arc = `<circle cx="50" cy="50" r="42" class="ring-seg ${cls}" stroke-dasharray="${(len - gap).toFixed(2)} ${c.toFixed(2)}" stroke-dashoffset="${(-off).toFixed(2)}"/>`;
      off += len;
      return arc;
    })
    .join('');
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" class="ring-track"/>${arcs}</svg>`;
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
  const aberta = (t) => !fechada(t) && !isRunning(t);
  const agora = timed.filter((t) => aberta(t) && U.toMin(t.horario) <= now && now < U.toMin(t.horario) + duracao(t));
  // A que acabou de ser pausada continua à vista (com o ▶ para continuar).
  const pausada = S.pedirConclusao ? v.find((t) => t.id === S.pedirConclusao && aberta(t)) : null;
  if (pausada && !agora.includes(pausada)) agora.unshift(pausada);
  const prox = timed.find((t) => aberta(t) && !agora.includes(t) && U.toMin(t.horario) > now);
  const pend = v.filter((t) => !fechada(t)).sort(U.byHorarioTitulo);
  const atras = v.filter(isLate).length;
  const porVir = Math.max(0, p.total - p.done - p.nao - atras);
  const h = new Date().getHours();
  const saud = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';

  const from = U.addDays(today, -6);
  const weekOk = ensureRange(from, today);
  const week = Array.from({ length: 7 }, (_, i) => U.addDays(from, i));
  const weekStats = week.map((d) => (weekOk ? progress(statsTasks(d)) : null));
  const withTasks = weekStats.filter((s) => s && s.total);
  const media = withTasks.length ? Math.round(withTasks.reduce((a, s) => a + s.pct, 0) / withTasks.length) : null;

  // "Faltam" conta só o que ainda está por vir; as atrasadas aparecem à parte (em amarelo no anel).
  const msg =
    p.total === 0
      ? 'Nenhuma tarefa para hoje.'
      : p.done === p.total
        ? 'Tudo feito hoje. 🎉'
        : `${porVir ? `${porVir > 1 ? 'Faltam' : 'Falta'} ${porVir}.` : 'Nada mais por vir hoje.'}${atras ? ` <span class="late-txt">${atras} atrasada${atras > 1 ? 's' : ''}.</span>` : ''}`;
  const leg = [
    ['ok', p.done, 'feita', 'feitas'],
    ['nf', p.nao, 'não feita', 'não feitas'],
    ['late', atras, 'atrasada', 'atrasadas'],
    ['fut', porVir, 'por vir', 'por vir'],
  ]
    .filter(([, n]) => n)
    .map(([c, n, um, varios]) => `<span class="rl ${c}"><i></i>${n} ${n === 1 ? um : varios}</span>`)
    .join('');

  // Cada linha: abre o dia (pop-up) e tem ▶ (iniciar/continuar), ✕ (não fiz) e ✏️ (editar).
  const blockLine = (t) =>
    `<div class="now-item${isLate(t) ? ' late' : ''}" style="--c:${colorOf(t)}">
      <button type="button" class="now-open" data-action="dia-abrir" data-date="${today}" title="Abrir o dia">
        <span class="now-time">${t.horario}–${U.fromMin(U.toMin(t.horario) + duracao(t))}${isLate(t) ? ' · atrasada' : ''}</span>
        <span class="now-title${t.concluido ? ' done' : ''}">${nomeHTML(t)}</span>
      </button>
      <span class="now-tools">
        <button type="button" class="icon-btn sm" data-action="timer" data-id="${t.id}" data-date="${t.data}" aria-label="${elapsed(t) ? 'Continuar' : 'Iniciar'} ${esc(t.titulo)}" title="${elapsed(t) ? 'Continuar' : 'Iniciar'}">${icon('play')}</button>
        ${xBtn(t)}
        <button type="button" class="icon-btn xs" data-action="edit-daily" data-id="${t.id}" data-date="${t.data}" aria-label="Editar ${esc(t.titulo)}" title="Editar">${icon('edit')}</button>
      </span>
    </div>`;

  const catRows = S.categories
    .map((c) => {
      const cp = progress(v.filter((t) => t.categoriaId === c.id));
      if (!cp.total) return '';
      return `<li style="--c:${c.cor}"><i class="dot"></i><span class="name">${esc(c.nome)}</span>
        <span class="bar"><i style="width:${cp.pct}%"></i></span><span class="count">${cp.done}/${cp.total}</span></li>`;
    })
    .join('');

  // Clientes e listas (ex.: Cursos): ▶ ao lado de cada um para começar na hora.
  const rodando = runningTasks();
  const startRow = ({ nome, cor, pred, attrs }) => {
    const run = rodando.find(pred);
    const sec = sumTime(v.filter(pred));
    return `<li style="--c:${cor}"><i class="dot"></i><span class="name">${esc(nome)}</span>
      ${
        run
          ? `<span class="st-time on" ${liveAttrs(run)}>${U.fmtRelogio(elapsed(run))}</span>
             <button type="button" class="play-btn running" data-action="timer" data-id="${run.id}" data-date="${run.data}" aria-label="Pausar ${esc(nome)}" title="Pausar">${icon('pause')}</button>`
          : `<span class="st-time">${sec >= 60 ? U.fmtDur(sec) : ''}</span>
             <button type="button" class="play-btn" data-action="start-pick" ${attrs} aria-label="Iniciar ${esc(nome)}" title="Iniciar">${icon('play')}</button>`
      }</li>`;
  };
  const clis = startClients();
  const cliCard = `<section class="card start-card cli-card">
    <h2 class="card-title">${icon('clientes')}Clientes<span class="grow"></span>
      <button type="button" class="icon-btn sm" data-action="new-client" aria-label="Novo cliente" title="Novo cliente">${icon('plus')}</button></h2>
    ${
      clis.length
        ? `<ul class="starts">${clis.map((c) => startRow({ nome: c.nome, cor: workColor(), pred: (t) => t.clienteId === c.id, attrs: `data-cli="${c.id}"` })).join('')}</ul>`
        : '<p class="muted">Nenhum cliente ativo. <a href="#/clientes">Ver clientes</a></p>'
    }
  </section>`;
  const listCards = listCats()
    .map(
      (cat) => `<section class="card start-card">
      <h2 class="card-title">${icon('diario')}${esc(cat.nome)}<span class="grow"></span>
        <button type="button" class="icon-btn sm" data-action="edit-cat" data-id="${cat.id}" aria-label="Editar a lista de ${esc(cat.nome)}" title="Adicionar ou mudar a lista">${icon('plus')}</button></h2>
      <ul class="starts">${itensOf(cat)
        .map((it) => startRow({ nome: it.nome, cor: cat.cor, pred: (t) => t.categoriaId === cat.id && t.itemId === it.id, attrs: `data-cat="${cat.id}" data-item="${it.id}"` }))
        .join('')}</ul>
    </section>`,
    )
    .join('');

  return `
  <header class="page-head">
    <div><p class="eyebrow">${esc(U.fmtDiaLongo(today))} · ${clockHTML()}</p><h1>${saud}, ${esc(firstName())}</h1></div>
    <div class="head-btns">
      <button type="button" class="btn soft" data-action="new-daily" data-date="${today}">${icon('plus')}<span>Tarefa</span></button>
      ${rodando.length ? pararBtn(rodando[0]) : `<button type="button" class="btn primary" data-action="start-pick">${icon('play')}<span>Iniciar</span></button>`}
    </div>
  </header>
  <div class="dash">
    <section class="card hero">
      <div class="ring-wrap">${ringDia(p, atras)}<span class="ring-label">${p.pct}%</span></div>
      <div>
        <h2>${p.done} de ${p.total} concluídas</h2>
        <p class="muted">${msg}</p>
        ${leg ? `<p class="ring-leg">${leg}</p>` : ''}
        ${sumTime(v) >= 60 ? `<p class="muted sm hero-time">${icon('cronometro')}Tempo registrado hoje: <strong>${U.fmtDur(sumTime(v))}</strong> · <a href="#/relatorios">ver relatórios</a></p>` : ''}
        <button type="button" class="btn soft sm" data-action="dia-abrir" data-date="${today}">${icon('horarios')}Abrir o dia</button>
      </div>
    </section>
    <section class="card now">
      <h2 class="card-title">${icon('horarios')}Agora</h2>
      ${rodando
        .map(
          (t) => `<div class="running-now" style="--c:${colorOf(t)}">
            <span class="running-icon">${icon('cronometro')}</span>
            <div><span class="now-title">${nomeHTML(t)}</span><span class="now-sub">desde ${hhmm(t.cronometroInicio)}${desdeDia(t.cronometroInicio)} · <strong ${liveAttrs(t)}>${U.fmtRelogio(elapsed(t))}</strong></span></div>
            <button type="button" class="icon-btn sm" data-action="timer" data-id="${t.id}" data-date="${t.data}" aria-label="Pausar cronômetro" title="Pausar">${icon('pause')}</button>
            <button type="button" class="icon-btn sm stop-btn" data-action="parar" data-id="${t.id}" data-date="${t.data}" aria-label="Parar e concluir" title="Parar">${icon('stop')}</button>
            ${xBtn(t)}
          </div>`,
        )
        .join('')}
      ${agora.length ? agora.map(blockLine).join('') : rodando.length ? '' : '<p class="muted">Nada planejado para este horário.</p>'}
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
    ${cliCard}
    <div class="dash-lists">${listCards}</div>
    <section class="card pend">
      <h2 class="card-title">${icon('hoje')}Pendentes hoje <span class="count">${pend.length}</span></h2>
      ${pend.length ? `<ul class="tasks">${pend.slice(0, 8).map((t) => taskRow(t, { showCat: true })).join('')}</ul>` : '<p class="muted">Nenhuma pendência. 👏</p>'}
      ${pend.length > 8 ? `<button type="button" class="more-link" data-action="dia-abrir" data-date="${today}">Ver todas (${pend.length})</button>` : ''}
    </section>
    <div class="dash-side">
      <section class="card">
        <h2 class="card-title">${icon('categorias')}Categorias</h2>
        ${catRows ? `<ul class="meters">${catRows}</ul>` : '<p class="muted">Sem tarefas hoje.</p>'}
      </section>
    </div>
  </div>`;
}

// Relógio no horário de Brasília (atualizado a cada segundo pelo mesmo intervalo dos cronômetros).
const clockHTML = () => `<span class="clock" data-clock>${U.horaBR()}</span>`;
// "Quarta-feira, 11 de novembro · 14:32": o dia e a hora no alto de todas as telas.
const agoraHTML = () => `<span data-hoje>${esc(U.fmtDiaLongo(U.todayStr()))}</span> · ${clockHTML()}`;

// Hoje: a agenda do dia com os horários. Em cada bloco: ✓ concluir, cronômetro (play/pausa) e notas.
// As horas com tarefa ficam altas (cabem os botões) e as horas vazias ficam baixinhas.
const ALTURA_HORA_CHEIA = 150; // px por hora com tarefa (15 min = 37 px)
const ALTURA_HORA_VAZIA = 34; // px por hora sem nada

function blockTools(t, { compact = false } = {}) {
  const pedir = S.pedirConclusao === t.id && !t.concluido;
  return `<div class="b-tools">
    ${pedir ? `<button type="button" class="b-done" data-action="toggle" data-id="${t.id}" data-date="${t.data}" title="Marcar como concluída">${icon('check')}${compact ? '' : '<span>Finalizou?</span>'}</button>` : ''}
    ${timerHTML(t)}
    <button type="button" class="icon-btn xs${t.notas?.trim() ? ' has-notes' : ''}" data-action="open-task" data-id="${t.id}" data-date="${t.data}"
      aria-label="Notas de ${esc(t.titulo)}" title="${t.notas?.trim() ? 'Ver notas' : 'Escrever uma nota'}">${icon('nota')}</button>
    ${xBtn(t)}
  </div>`;
}

// Resumo do dia (ao lado da agenda): cada tarefa com o horário, a situação e o tempo gasto.
function resumoRow({ t, vinda }) {
  const sp = spanOf(t, true);
  const sec = elapsed(t);
  const run = isRunning(t);
  const estado = t.concluido ? 'Feita' : t.naoFeito ? 'Não feita' : run ? 'Rodando' : isLate(t) ? 'Atrasada' : 'Pendente';
  const meta = [sp ? spanTxt(sp) : 'Sem horário', vinda ? `começou ${U.relativo(t.data).toLowerCase()}` : ''].filter(Boolean).join(' · ');
  return `<li class="rs${t.concluido ? ' done' : ''}${t.naoFeito ? ' nf' : ''}${run ? ' running' : ''}" style="--c:${colorOf(t)}">
    <button type="button" class="check" role="checkbox" aria-checked="${!!t.concluido}" aria-label="Concluir ${esc(t.titulo)}"
      data-action="toggle" data-id="${t.id}" data-date="${t.data}">${icon('check')}</button>
    <button type="button" class="rs-main" data-action="open-task" data-id="${t.id}" data-date="${t.data}" title="Abrir">
      <span class="rs-title">${nomeHTML(t)}</span>
      <span class="rs-meta">${esc(meta)} · <b class="rs-st">${estado}</b></span>
    </button>
    <span class="rs-time${run ? ' on' : sec >= 60 ? '' : ' none'}" ${run ? liveAttrs(t) : ''} title="Tempo gasto">${run ? U.fmtRelogio(sec) : sec >= 60 ? U.fmtDur(sec) : '—'}</span>
  </li>`;
}

function viewHoje() {
  const tasks = dayTasks(S.date);
  const today = U.todayStr();
  const rodando = runningTasks();
  const head = `<header class="page-head">${dayNav(S.date)}
    <div class="head-btns">
      <button type="button" class="btn ${S.date === today ? 'soft' : 'primary'}" data-action="new-daily" data-date="${S.date}">${icon('plus')}<span>Tarefa</span></button>
      ${S.date === today ? (rodando.length ? pararBtn(rodando[0]) : `<button type="button" class="btn primary" data-action="start-pick">${icon('play')}<span>Iniciar</span></button>`) : ''}
    </div></header>`;
  if (!tasks) return head + loading();
  // Os dias de antes: uma tarefa que começou ontem e passou da meia-noite aparece aqui também.
  if (S.date <= today) ensureRange(U.addDays(S.date, -3), U.addDays(S.date, -1));
  const v = visible(tasks);
  const vindas = carryOver(S.date);
  if (!v.length && !vindas.length) {
    return head + emptyState('Nada para este dia', 'Monte sua <a href="#/rotina">rotina semanal</a> ou adicione uma tarefa só para este dia.');
  }
  const p = progress(tasks);
  const isToday = S.date === today;
  const now = U.nowMin();

  // Cada tarefa no horário em que foi feita (sessões do cronômetro) ou, se ainda não foi, no planejado.
  const items = [];
  for (const t of v) {
    const sp = spanOf(t, true);
    if (!sp) continue;
    const s = Math.max(0, sp.s);
    const e = Math.min(1440, sp.e);
    if (e > s) items.push({ t, s, e, sp });
  }
  for (const { t, off } of vindas) {
    const sp = spanOf(t, true);
    const s = Math.max(0, sp.s - off);
    const e = Math.min(1440, sp.e - off);
    if (e > s) items.push({ t, s, e, sp, vinda: true, off });
  }
  // Iniciou outra coisa no horário de um bloco planejado (ex.: era Curso, iniciou Trabalho):
  // o tempo que a outra rodou sai do bloco planejado. Se sobrar nada, o bloco sai da agenda.
  // Conta só o tempo que de fato rodou (até agora), não o fim planejado da outra tarefa.
  const reais = items.filter((x) => x.sp.real).map((x) => {
    const r = spanOf(x.t);
    const off = x.off || 0;
    return { t: x.t, s: Math.max(0, r.s - off), e: Math.min(1440, r.e - off) };
  });
  for (const x of items.filter((y) => !y.sp.real && !y.t.manter)) {
    let partes = [[x.s, x.e]];
    for (const r of reais) {
      if (r.t === x.t) continue;
      partes = partes.flatMap(([a, b]) => (r.e <= a || r.s >= b ? [[a, b]] : [[a, r.s], [r.e, b]]).filter(([c, d]) => d - c >= 5));
    }
    if (partes.length === 1 && partes[0][0] === x.s && partes[0][1] === x.e) continue;
    items.splice(items.indexOf(x), 1, ...partes.map(([a, b]) => ({ ...x, s: a, e: b, cortado: true })));
  }
  items.sort((a, b) => a.s - b.s || a.e - b.e || (a.t.titulo || '').localeCompare(b.t.titulo || '', 'pt-BR'));
  const naAgenda = new Set(items.map((x) => x.t));

  let start = (S.profile.agendaInicio ?? 6) * 60;
  let end = Math.max((S.profile.agendaFim ?? 23) * 60, start + 60);
  for (const x of items) {
    start = Math.min(start, Math.floor(x.s / 60) * 60);
    end = Math.max(end, Math.min(24 * 60, Math.ceil(x.e / 60) * 60));
  }

  // Altura de cada hora e a posição (px) de cada minuto.
  const hours = [];
  let top = 0;
  for (let h = start; h < end; h += 60) {
    const cheia = items.some((x) => x.s < h + 60 && x.e > h);
    const alt = cheia ? ALTURA_HORA_CHEIA : ALTURA_HORA_VAZIA;
    hours.push({ h, top, alt });
    top += alt;
  }
  const total = top;
  const y = (min) => {
    if (min >= end) return total;
    const hr = hours[Math.max(0, Math.floor((min - start) / 60))];
    return hr.top + ((min - hr.h) / 60) * hr.alt;
  };

  // Distribui em colunas os blocos que se sobrepõem.
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

  const blocks = items
    .map(({ t, s, e, sp, vinda, cortado, col, cols }) => {
      const cli = cliById(t.clienteId);
      const isNow = isToday && s <= now && now < e;
      const altura = y(e) - y(s);
      const short = altura < 60;
      const late = isLate(t);
      const sub = [vinda ? `começou ${U.relativo(t.data).toLowerCase()}` : '', late ? 'Atrasada' : '', t.naoFeito ? 'Não feito' : ''].filter(Boolean).join(' · ');
      const quando = vinda ? `${U.fromMin(s)}–${sp.aberto ? 'agora' : minTxt(e)}` : cortado ? `${minTxt(s)}–${minTxt(e)}` : spanTxt(sp);
      return `<div class="block${t.concluido ? ' done' : ''}${t.naoFeito ? ' nf' : ''}${isNow ? ' is-now' : ''}${short ? ' short' : ''}${late ? ' late' : ''}${isRunning(t) ? ' running' : ''}${cols > 1 ? ' narrow' : ''}"
        style="--c:${colorOf(t)};top:${y(s)}px;height:${altura}px;left:calc(${col} / ${cols} * 100%);width:calc(100% / ${cols})">
        <button type="button" class="check b-check" role="checkbox" aria-checked="${!!t.concluido}" aria-label="Concluir ${esc(t.titulo)}"
          data-action="toggle" data-id="${t.id}" data-date="${t.data}">${icon('check')}</button>
        <div class="b-text" data-action="open-task" data-id="${t.id}" data-date="${t.data}" title="Abrir cronômetro e notas">
          <span class="block-time">${quando}</span>
          <span class="block-title">${nomeHTML(t)}</span>
          ${sub ? `<span class="block-sub">${esc(sub)}</span>` : ''}
        </div>
        ${blockTools(t, { compact: short || cols > 1 })}
      </div>`;
    })
    .join('');

  const hourLines = hours
    .map(({ h, top: tp, alt }) => `<div class="hour${alt === ALTURA_HORA_VAZIA ? ' free' : ''}" style="top:${tp}px"><span>${U.fromMin(h)}</span></div>`)
    .join('') + `<div class="hour" style="top:${total}px"><span>${U.fromMin(end)}</span></div>`;
  const nowLine =
    isToday && now >= start && now <= end
      ? `<div class="now-line" style="top:${y(now)}px"><span>${U.fromMin(now)}</span></div>`
      : '';
  const tempo = sumTime(v);
  const perdido = sumDesperdicio(v);
  const resumo = [...vindas.map(({ t }) => ({ t, vinda: true })), ...v.map((t) => ({ t }))].sort((a, b) => {
    const x = spanOf(a.t, true);
    const z = spanOf(b.t, true);
    const sa = x ? x.s - (a.vinda ? 99_999 : 0) : 99_999;
    const sb = z ? z.s - (b.vinda ? 99_999 : 0) : 99_999;
    return sa - sb || (a.t.titulo || '').localeCompare(b.t.titulo || '', 'pt-BR');
  });
  const pend = v.filter((t) => !fechada(t)).length;

  return `${head}
  <div class="progress-line"><span class="bar"><i style="width:${p.pct}%"></i></span>
    <span>${p.done} de ${p.total} concluídas${p.nao ? ` · <span class="nf-txt">${p.nao} não feita${p.nao > 1 ? 's' : ''}</span>` : ''}${tempo >= 60 ? ` · ${icon('cronometro')}${U.fmtDur(tempo)}` : ''}</span></div>
  ${perdido >= 60 ? `<p class="nf-aviso">${icon('x')}<span>Tempo desperdiçado ${isToday ? 'hoje' : 'neste dia'}: <strong>${U.fmtDur(perdido)}</strong> · ${p.nao} tarefa${p.nao > 1 ? 's' : ''} não feita${p.nao > 1 ? 's' : ''}. Entra nos <a href="#/relatorios">relatórios</a>.</span></p>` : ''}
  <div class="agenda-wrap">
    <div class="card timeline-card">
      ${
        items.length
          ? `<div class="timeline" style="height:${total}px">${hourLines}<div class="blocks">${blocks}</div>${nowLine}</div>`
          : '<p class="muted">Nenhuma tarefa com horário neste dia.</p>'
      }
    </div>
    <aside class="card untimed resumo">
      <h2 class="card-title">${icon('hoje')}Resumo do dia <span class="count">${resumo.length}</span></h2>
      <p class="rs-tot"><span class="ok">${icon('check')}${p.done} feita${p.done === 1 ? '' : 's'}</span>${p.nao ? `<span class="nf">${icon('x')}${p.nao} não feita${p.nao === 1 ? '' : 's'}</span>` : ''}${pend ? `<span>${pend} pendente${pend === 1 ? '' : 's'}</span>` : ''}${tempo >= 60 ? `<span>${icon('cronometro')}${U.fmtDur(tempo)}</span>` : ''}</p>
      <ul class="rs-list">${resumo.map(resumoRow).join('')}</ul>
      ${v.some((t) => !naAgenda.has(t)) ? '<p class="muted sm">Sem horário: toque no ▶ ou no ✓ e diga a hora para ela entrar na agenda.</p>' : ''}
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
      p && p.total && p.done + p.nao === p.total ? 'marcado' : '',
      d < today ? 'past' : '',
    ].join(' ');
    cells += `<button type="button" class="${cls}" data-action="cal-pick" data-date="${d}"
      aria-label="${esc(U.fmtDiaLongo(d))}${p && p.total ? `, ${p.done} de ${p.total} concluídas${p.nao ? `, ${p.nao} não feitas` : ''}` : ''}">
      <span class="cal-num">${Number(d.slice(8))}</span>
      ${p && p.total ? `<span class="cal-meter"><i class="ok" style="width:${(p.done * 100) / p.total}%"></i><i class="nf" style="width:${(p.nao * 100) / p.total}%"></i></span><span class="cal-count">${p.done}/${p.total}</span>` : ''}
    </button>`;
  }

  const tasks = dayTasks(S.calSel);
  let panel = loading();
  if (tasks) {
    const v = visible(tasks).sort((a, b) => (spanOf(a, true)?.s ?? 99_999) - (spanOf(b, true)?.s ?? 99_999) || U.byHorarioTitulo(a, b));
    const removed = tasks.filter((t) => t.removido);
    const pp = progress(tasks);
    const tt = sumTime(v);
    panel = `
      ${v.length ? `<p class="rs-tot"><span class="ok">${icon('check')}${pp.done} de ${pp.total} feita${pp.done === 1 ? '' : 's'}</span>${pp.nao ? `<span class="nf">${icon('x')}${pp.nao} não feita${pp.nao === 1 ? '' : 's'}</span>` : ''}${tt >= 60 ? `<span>${icon('cronometro')}${U.fmtDur(tt)}</span>` : ''}</p>` : ''}
      ${v.length ? `<ul class="tasks">${v.map((t) => taskRow(t, { showCat: true })).join('')}</ul>` : '<p class="muted day-empty">Nenhuma tarefa neste dia.</p>'}
      ${
        removed.length
          ? `<details class="removed"><summary>${removed.length} tarefa${removed.length > 1 ? 's' : ''} removida${removed.length > 1 ? 's' : ''} deste dia</summary>
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
      <div class="daynav-title"><span class="eyebrow">Calendário · ${agoraHTML()}</span><h1>${esc(U.fmtMes(S.calMonth))}</h1></div>
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
        <button type="button" class="btn soft sm" data-action="dia-abrir" data-date="${S.calSel}" title="Abrir a agenda do dia (ou dois cliques no dia)">${icon('horarios')}Abrir o dia</button>
      </header>
      <div class="day-acts">
        <button type="button" class="btn soft sm" data-action="new-daily" data-date="${S.calSel}">${icon('plus')}<span>Tarefa</span></button>
        ${
          S.calSel === today
            ? runningTasks().length
              ? pararBtn(runningTasks()[0], 'sm')
              : `<button type="button" class="btn primary sm" data-action="start-pick">${icon('play')}<span>Iniciar</span></button>`
            : ''
        }
      </div>
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
        ${r.horario ? `<span class="chip">${icon('horarios')}${r.horario}${r.fimAberto ? ' · sem fim' : r.duracao ? ` · ${r.duracao} min` : ''}</span>` : '<span class="chip muted">Sem horário</span>'}
        ${cli ? `<span class="chip">${icon('clientes')}${esc(cli.nome)}</span>` : ''}
        ${itemOf(r) ? `<span class="chip">${icon('diario')}${esc(itemOf(r).nome)}</span>` : ''}
      </span>
    </button>
    ${isMensal(r) ? `<span class="chip month-chip">${icon('calendario')}Todo dia ${r.diaDoMes}</span>` : dayDots(r.diasDaSemana || [])}
  </li>`;
}

function viewRotina() {
  const sel = S.rotinaDia;
  const semanais = S.recurring.filter((r) => !isMensal(r));
  const mensais = S.recurring.filter(isMensal);
  const count = (d) => semanais.filter((r) => (r.diasDaSemana || []).includes(d)).length;
  const list = (sel === 'all' ? S.recurring : sel === 'mes' ? mensais : semanais.filter((r) => (r.diasDaSemana || []).includes(sel)))
    .sort((a, b) => (isMensal(a) && isMensal(b) ? a.diaDoMes - b.diaDoMes : 0) || U.byHorarioTitulo(a, b));
  const groups = [...S.categories, { id: '_sem', nome: 'Sem categoria', cor: '#94a3b8' }];
  const keyOf = (r) => (catById(r.categoriaId) ? r.categoriaId : '_sem');
  const chip = (d, label, n) =>
    `<button type="button" class="tab-chip${sel === d ? ' on' : ''}" data-action="rotina-dia" data-d="${d}">${label}<span>${n}</span></button>`;

  return `
  <header class="page-head">
    <div><p class="eyebrow">Tarefas fixas · ${agoraHTML()}</p><h1>Rotina</h1></div>
    <button type="button" class="btn primary" data-action="new-rec">${icon('plus')}<span>Tarefa fixa</span></button>
  </header>
  <p class="muted intro">Estas tarefas se repetem toda semana (ou todo mês) e aparecem sozinhas na lista de cada dia. Para mudar só um dia específico, use o <a href="#/calendario">calendário</a>.</p>
  <div class="tab-chips" role="tablist">
    ${chip('all', 'Todas', S.recurring.length)}
    ${U.ORDEM_SEMANA.map((d) => chip(d, U.DIAS_CURTO[d], count(d))).join('')}
    ${chip('mes', 'Mensal', mensais.length)}
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
          sel === 'all' ? 'Sua rotina está vazia' : sel === 'mes' ? 'Nenhuma tarefa mensal' : `Nada fixo na ${U.DIAS_CURTO[sel].toLowerCase()}`,
          'Crie tarefas que se repetem, como “Oração da manhã” todos os dias ou “Relatório” às sextas.',
        )
  }`;
}

function viewClientes() {
  const todayTasks = visible(dayTasks(U.todayStr()) || []);

  const card = (cli) => {
    const recs = S.recurring.filter((r) => r.clienteId === cli.id).sort(U.byHorarioTitulo);
    const tt = todayTasks.filter((t) => t.clienteId === cli.id);
    const sec = sumTime(tt);
    const servs = servicosOf(cli);
    const podeIniciar = isAtivo(cli) && !cli.soFinanceiro;
    const pend = tt.filter((t) => !fechada(t)).length;
    const rodando = runningTasks().some((t) => t.clienteId === cli.id);
    const status = !isAtivo(cli)
      ? 'Finalizado'
      : cli.soFinanceiro
        ? 'Só financeiro'
        : `${rodando ? 'Rodando agora · ' : ''}${pend ? `${pend} pendente${pend > 1 ? 's' : ''} hoje` : tt.length ? 'Tudo feito hoje' : rodando ? 'nada mais hoje' : 'Nada hoje'}`;
    return `<article class="card client-card${isAtivo(cli) ? '' : ' off'}" style="--c:${workColor()}">
      <header>
        <div><h3>${esc(cli.nome)}</h3>
        <p class="muted sm">${esc(status)}${sec >= 60 ? ` · ${U.fmtDur(sec)} hoje` : ''}</p></div>
        <button type="button" class="icon-btn sm" data-action="edit-client" data-id="${cli.id}" aria-label="Editar cliente">${icon('edit')}</button>
      </header>
      ${cli.observacoes ? `<p class="obs">${esc(cli.observacoes)}</p>` : ''}
      ${
        cli.soFinanceiro
          ? ''
          : `<div class="serv-chips">${
              servs.length ? servs.map((s) => `<span class="chip">${esc(s)}</span>`).join('') : '<span class="muted sm">Sem serviços cadastrados.</span>'
            }${cli.pedeNome ? '<span class="chip muted">Pede o nome da pessoa</span>' : ''}</div>`
      }
      ${
        recs.length
          ? `<ul class="mini">${recs
              .map(
                (r) => `<li><button type="button" data-action="edit-rec" data-id="${r.id}">
                <span>${esc(r.titulo)}${r.horario ? ` <small>${r.horario}</small>` : ''}</span>${isMensal(r) ? `<small class="muted">todo dia ${r.diaDoMes}</small>` : dayDots(r.diasDaSemana || [], 'sm')}</button></li>`,
              )
              .join('')}</ul>`
          : ''
      }
      <footer>
        ${podeIniciar ? `<button type="button" class="btn primary sm" data-action="start-pick" data-cli="${cli.id}">${icon('play')}Iniciar</button>` : ''}
        ${podeIniciar ? `<button type="button" class="btn ghost sm" data-action="new-daily" data-date="${U.todayStr()}" data-cat="${workCatId() || ''}" data-cli="${cli.id}">${icon('plus')}Tarefa</button>` : ''}
        <button type="button" class="btn ghost sm" data-action="client-history" data-id="${cli.id}">${icon('nota')}Histórico</button>
      </footer>
    </article>`;
  };

  const cs = [...S.clients].sort(U.byNome);
  const ativos = cs.filter((c) => isAtivo(c) && !c.soFinanceiro);
  const fin = cs.filter((c) => isAtivo(c) && c.soFinanceiro);
  const off = cs.filter((c) => !isAtivo(c));
  const grid = (arr) => `<div class="client-grid">${arr.map(card).join('')}</div>`;

  return `
  <header class="page-head">
    <div><p class="eyebrow">Trabalho · ${agoraHTML()}</p><h1>Clientes</h1></div>
    <button type="button" class="btn primary" data-action="new-client">${icon('plus')}<span>Cliente</span></button>
  </header>
  ${
    cs.length
      ? `${ativos.length ? grid(ativos) : '<p class="muted">Nenhum cliente ativo.</p>'}
        ${fin.length ? `<h2 class="section-title">Só financeiro <span class="count">${fin.length}</span></h2>${grid(fin)}` : ''}
        ${off.length ? `<details class="off-clients"><summary>Finalizados <span class="count">${off.length}</span></summary>${grid(off)}</details>` : ''}`
      : emptyState('Nenhum cliente ainda', 'Cadastre seus clientes e os serviços que você faz para cada um. Depois é só dar ▶ no Painel.')
  }`;
}

function viewCategorias() {
  const rows = S.categories
    .map((c, i) => {
      const nCli = S.clients.length;
      const nRec = S.recurring.filter((x) => x.categoriaId === c.id).length;
      return `<li class="cat-row" style="--c:${c.cor}">
        <span class="swatch"></span>
        <div class="cat-info"><strong>${esc(c.nome)}</strong>
          <small class="muted">${nRec} tarefa${nRec === 1 ? '' : 's'} fixa${nRec === 1 ? '' : 's'}${isWork(c.id) ? ` · ${nCli} cliente${nCli === 1 ? '' : 's'}` : ''}${
            itensOf(c).length ? ` · lista: ${esc(itensOf(c).map((i) => i.nome).join(', '))}` : ''
          }</small></div>
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
    <div><p class="eyebrow">Cadastros · ${agoraHTML()}</p><h1>Categorias</h1></div>
    <button type="button" class="btn primary" data-action="new-cat">${icon('plus')}<span>Categoria</span></button>
  </header>
  <p class="muted intro">A ordem aqui é a ordem em que as categorias aparecem na lista do dia. Uma categoria pode ter a própria lista (ex.: Cursos → Inglês, Fotografia), que ganha o ▶ no Painel.</p>
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
  <header class="page-head"><div><p class="eyebrow">Sua conta · ${agoraHTML()}</p><h1>Ajustes</h1></div></header>
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
      <h2 class="card-title">${icon('painel')}Telas</h2>
      <label class="field"><span>Abrir o app em</span>
        <select name="abrirEm">${navItems()
          .filter((n) => n.id !== 'acessos')
          .map((n) => `<option value="${n.id}" ${n.id === inicioRoute() ? 'selected' : ''}>${esc(n.label)}</option>`)
          .join('')}</select></label>
      <button type="button" class="btn soft" data-action="nav-ordem">${icon('filtro')}Ordem das áreas</button>
      <p class="hint">A agenda do dia abre pelo botão “Abrir o dia” (no Painel e no Calendário).</p>
    </section>

    <section class="card">
      <h2 class="card-title">Aparência</h2>
      <div class="seg">${tema('auto', 'Automático')}${tema('claro', 'Claro')}${tema('escuro', 'Escuro')}</div>
    </section>

    <section class="card">
      <h2 class="card-title">Agenda do dia (Hoje)</h2>
      <div class="row2">
        <label class="field"><span>Dia começa às</span><select name="agendaInicio">${hourOpts(0, 22, p.agendaInicio)}</select></label>
        <label class="field"><span>Dia termina às</span><select name="agendaFim">${hourOpts(1, 24, p.agendaFim)}</select></label>
      </div>
      <label class="field"><span>Duração padrão de um bloco</span>
        <select name="duracaoPadrao">${DURACOES.map((d) => `<option value="${d}" ${d === p.duracaoPadrao ? 'selected' : ''}>${d} min</option>`).join('')}</select></label>
    </section>

    <section class="card">
      <h2 class="card-title">${icon('horarios')}Seu dia (Relatórios)</h2>
      <div class="row2">
        <label class="field"><span>Acordo às</span><input type="time" name="acordar" value="${esc(p.acordar)}"></label>
        <label class="field"><span>Durmo às</span><input type="time" name="dormir" value="${esc(p.dormir)}"></label>
      </div>
      <p class="hint">O sono não entra na conta. Do horário de acordar até a primeira tarefa aparece como "Acordou → 1ª tarefa"; os buracos entre uma tarefa e outra, como "Pausa entre tarefas"; e da última tarefa até dormir, como lazer.</p>
    </section>

    ${notifCard()}

    ${importCard()}

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

// ---------------------------------------------------------------------------
// Bloco de notas de cada tarefa (com o cronômetro)
// ---------------------------------------------------------------------------

const NOTAS_MODELO = '✅ O que foi feito:\n\n\n⚠️ Onde errei / o que travou:\n\n\n💡 O que melhorar na próxima vez:\n';

function openTaskDetail(t) {
  const cat = catById(t.categoriaId);
  const cli = cliById(t.clienteId);
  const run = isRunning(t);
  const sec = elapsed(t);
  openModal(`<div class="modal-body detail" style="--c:${colorOf(t)}">
    <header class="modal-head">
      <div class="detail-title">
        <p class="eyebrow">${esc([U.fmtDiaLongo(t.data), spanTxt(spanOf(t, true))].filter(Boolean).join(' · '))}</p>
        <h2>${nomeHTML(t)}</h2>
      </div>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button>
    </header>
    <section class="detail-timer${run ? ' running' : ''}">
      <div>
        <span class="eyebrow">${icon('cronometro')}Tempo gasto</span>
        <strong class="detail-clock" ${run ? liveAttrs(t) : ''}>${U.fmtRelogio(sec)}</strong>
      </div>
      ${
        t.concluido || t.naoFeito
          ? `<span class="muted sm">${t.concluido ? 'Tarefa concluída' : 'Marcada como não feita'}</span>`
          : `<span class="detail-btns"><button type="button" class="btn soft" data-action="timer" data-id="${t.id}" data-date="${t.data}">
              ${icon(run ? 'pause' : 'play')}${run ? 'Pausar' : sec ? 'Continuar' : 'Iniciar'}</button>${run ? pararBtn(t, 'sm-btn') : ''}</span>`
      }
    </section>
    ${sessionsHTML(t)}
    <label class="field notes-field"><span>${icon('nota')}Notas <em>só você vê</em></span>
      <textarea rows="9" data-notes data-id="${t.id}" data-date="${t.data}"
        placeholder="O que foi feito, onde errei, o que funcionou, próximos passos…">${esc(t.notas || '')}</textarea></label>
    <div class="notes-bar">
      ${t.notas?.trim() ? '' : `<button type="button" class="link" data-action="notes-template">Usar modelo</button>`}
      <span class="muted sm" data-notes-status></span>
    </div>
    <footer class="modal-actions">
      <button type="button" class="btn ghost sm" data-action="edit-daily" data-id="${t.id}" data-date="${t.data}">${icon('edit')}Editar</button>
      ${!run && (t.concluido || t.sessoes?.length) ? `<button type="button" class="btn ghost sm" data-action="ajustar-hora" data-id="${t.id}" data-date="${t.data}">${icon('horarios')}Ajustar horário</button>` : ''}
      <span class="grow"></span>
      ${t.concluido ? '' : `<button type="button" class="btn ghost${t.naoFeito ? ' nf-on' : ''}" data-action="nao-feito" data-id="${t.id}" data-date="${t.data}">${icon(t.naoFeito ? 'undo' : 'x')}${t.naoFeito ? 'Desfazer não feito' : 'Não fiz'}</button>`}
      <button type="button" class="btn ${t.concluido ? 'ghost' : 'primary'}" data-action="toggle" data-id="${t.id}" data-date="${t.data}">
        ${icon(t.concluido ? 'undo' : 'check')}${t.concluido ? 'Reabrir' : 'Concluir'}</button>
    </footer>
  </div>`);
  modal.dataset.detail = t.id;
}

// Cada vez que o cronômetro rodou: horário, duração e o que foi feito (dá para escrever ou corrigir depois).
function sessionsHTML(t) {
  const ss = t.sessoes || [];
  if (!ss.length) return '';
  const rows = ss
    .map((s, k) => {
      const fim = s.f || null;
      const dur = ((fim || Date.now()) - s.i) / 1000;
      return `<li class="sess${fim ? '' : ' on'}">
        <span class="sess-time">${hhmm(s.i)}–${fim ? hhmm(fim) : 'agora'}</span>
        <span class="sess-dur">${fim ? U.fmtDur(dur) : 'rodando'}</span>
        <input class="sess-obs" data-sess-obs data-id="${t.id}" data-date="${t.data}" data-k="${k}" value="${esc(s.obs || '')}"
          placeholder="O que fez? (ex.: 5 vídeos)" maxlength="300" aria-label="O que fez das ${hhmm(s.i)}">
      </li>`;
    })
    .join('');
  return `<section class="sessions"><h3 class="eyebrow">${icon('nota')}Sessões</h3><ul>${rows}</ul></section>`;
}

// Ao pausar: pergunta o que foi feito naquele pedaço de tempo (opcional).
// "Terminei:" em branco = a hora em que pausou; com hora (ex.: 17:00), a sessão termina ali (esqueceu de pausar).
function openObsPrompt(t, { concluiu = false } = {}) {
  const s = t.sessoes?.[t.sessoes.length - 1];
  if (!s?.f) return;
  openModal(`<form class="modal-body obs-prompt" data-form="obs" data-id="${t.id}" data-date="${t.data}" style="--c:${colorOf(t)}">
    ${modalHead(`${concluiu ? 'Concluída' : 'Pausado'} · ${esc(t.titulo)}`)}
    <p class="muted sm">${esc(taskSub(t))}${taskSub(t) ? ' · ' : ''}${hhmm(s.i)}–${hhmm(s.f)} · ${U.fmtDur((s.f - s.i) / 1000)}</p>
    <label class="comecei-campo"><span>Terminei:</span><input type="time" name="fim" data-terminei aria-label="Horário em que terminou"></label>
    <p class="muted sm terminei-dica">Em branco: ${hhmm(s.f)}, quando você ${concluiu ? 'concluiu' : 'pausou'}. Esqueceu de pausar? Coloque a hora em que parou.</p>
    <label class="field"><span>O que você fez? <em>opcional</em></span>
      <textarea name="obs" rows="3" maxlength="300" placeholder="Ex.: 5 vídeos editados">${esc(s.obs || '')}</textarea></label>
    <footer class="modal-actions">
      <button type="button" class="btn ghost" data-action="close-modal">Pular</button>
      <span class="grow"></span>
      ${concluiu ? '' : `<button type="button" class="btn soft" data-action="obs-concluir">${icon('check')}Salvar e concluir</button>`}
      <button type="submit" class="btn primary">Salvar</button>
    </footer>
  </form>`);
}

// Devolve false quando a hora de "Terminei" não serve (a janela fica aberta).
function saveObs(form) {
  const t = findTask(form.dataset.id, form.dataset.date);
  const s = t?.sessoes?.[t.sessoes.length - 1];
  if (!s) return null;
  const data = {};
  const v = form.elements.fim?.value;
  if (v && s.f) {
    let f = tsOf(t.data, U.toMin(v));
    if (f <= s.i && f + 86_400_000 <= s.f) f += 86_400_000; // passou da meia-noite
    if (f <= s.i) {
      toast(`Essa hora é antes do começo (${hhmm(s.i)}).`);
      return false;
    }
    if (f > s.f + 60_000) {
      toast(`Essa hora é depois de ${hhmm(s.f)}. Para contar mais tempo, edite a tarefa.`);
      return false;
    }
    if (f < s.f) {
      t.tempoGasto = Math.max(0, Math.round((t.tempoGasto || 0) - (s.f - f) / 1000));
      s.f = f;
      data.tempoGasto = t.tempoGasto;
    }
  }
  const obs = form.elements.obs.value.trim();
  if (obs) s.obs = obs;
  else delete s.obs;
  persist(db.update('dailyTasks', t.id, { sessoes: t.sessoes, ...data }));
  if (data.tempoGasto != null) {
    render();
    toast(`Terminou às ${hhmm(s.f)} · ${U.fmtDur(elapsed(t))} no total.`);
  }
  return t;
}

// Ao concluir (✓): Trabalho pede o cliente e o serviço (e o nome da pessoa, se o cliente pede);
// categoria com lista (ex.: Cursos) pede qual. Obrigatório: sem responder, a tarefa não é concluída.
const nomeGenerico = (t, c) => {
  const n = norm(t.titulo || '');
  return !n || n === 'trabalho' || n === norm(catById(t.categoriaId)?.nome || '') || (!!c && n === norm(c.nome));
};
function identFalta(t) {
  if (!t || t.concluido) return false;
  if (isWork(t.categoriaId)) {
    const c = cliById(t.clienteId);
    if (!c) return startClients().length > 0;
    return (!t.servico && nomeGenerico(t, c)) || (!!c.pedeNome && !t.pessoa);
  }
  return !t.itemId && itensOf(catById(t.categoriaId)).length > 0;
}
const servOptions = (c, sel) =>
  `<option value="">Escolha o serviço</option>${servicosOf(c)
    .map((x) => `<option value="${esc(x)}" ${norm(x) === norm(sel) ? 'selected' : ''}>${esc(x)}</option>`)
    .join('')}<option value="__outro" ${sel && !servicosOf(c).some((x) => norm(x) === norm(sel)) ? 'selected' : ''}>Outro serviço…</option>`;
let identNext = null;
function openIdent(t, next) {
  identNext = next;
  const work = isWork(t.categoriaId);
  const c = cliById(t.clienteId);
  const k = catById(t.categoriaId);
  // Nome que já diz o serviço (ex.: "Edição") vem escolhido; nome genérico ("Trabalho") pede para escolher.
  const servAtual = t.servico || (nomeGenerico(t, c) ? '' : t.titulo.trim());
  const campos = work
    ? `${
        c
          ? `<p class="muted sm">Cliente: <strong>${esc(c.nome)}</strong></p>`
          : `<label class="field"><span>Qual cliente?</span><select name="cli" data-ident-cli>
          <option value="">Escolha o cliente</option>${startClients().map((x) => `<option value="${x.id}">${esc(x.nome)}</option>`).join('')}</select></label>`
      }
      <label class="field" data-ident-serv-sel><span>O que você fez?</span><select name="servSel" data-ident-serv>${servOptions(c, servAtual)}</select></label>
      <label class="field" data-ident-serv-novo><span>Qual serviço?</span><input name="servNovo" maxlength="60" autocomplete="off" placeholder="Ex.: Edição de vídeo" value="${esc(servicosOf(c).some((x) => norm(x) === norm(servAtual)) ? '' : servAtual)}"></label>
      <label class="field" data-ident-pessoa hidden><span>Nome da pessoa</span>
        <input name="pessoa" maxlength="80" autocomplete="off" list="dl-ident-pessoas" value="${esc(t.pessoa || '')}" placeholder="Ex.: Maria">
        <datalist id="dl-ident-pessoas"></datalist></label>`
    : `<label class="field"><span>${/curso/i.test(k?.nome || '') ? 'Qual curso?' : `Qual de ${esc(k?.nome || '')}?`}</span><select name="itemId">
        <option value="">Escolha</option>${itensOf(k).map((i) => `<option value="${i.id}">${esc(i.nome)}</option>`).join('')}</select></label>`;
  openModal(`<form class="modal-body" data-form="ident" data-id="${t.id}" data-date="${t.data}" style="--c:${colorOf(t)}">
    ${modalHead(`Concluir · ${esc(t.titulo)}`)}
    ${campos}
    <footer class="modal-actions">
      <button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>
      <span class="grow"></span>
      <button type="submit" class="btn primary">Continuar</button>
    </footer>
  </form>`);
  identSync(modal.querySelector('form'));
}
// Troca de cliente: atualiza a lista de serviços e mostra o nome da pessoa quando o cliente pede.
function identSync(form) {
  const t = findTask(form.dataset.id, form.dataset.date);
  const c = cliById(form.elements.cli ? form.elements.cli.value : t?.clienteId);
  const sel = form.elements.servSel;
  if (!sel) return;
  if (form.elements.cli && sel.dataset.para !== (c?.id || '')) {
    const atual = sel.value === '__outro' ? form.elements.servNovo.value : sel.value;
    sel.innerHTML = servOptions(c, atual);
    sel.dataset.para = c?.id || '';
  }
  const temLista = servicosOf(c).length > 0;
  form.querySelector('[data-ident-serv-sel]').hidden = !temLista;
  form.querySelector('[data-ident-serv-novo]').hidden = temLista && sel.value !== '__outro';
  const pf = form.querySelector('[data-ident-pessoa]');
  pf.hidden = !c?.pedeNome;
  form.querySelector('#dl-ident-pessoas').innerHTML = (c?.pessoas || []).map((x) => `<option value="${esc(x)}">`).join('');
}

// Concluir (ou ajustar depois): Início, Tempo gasto e Término.
// Mudar o tempo gasto muda o término; mudar o término (ou o início) muda o tempo gasto. Só OK: conclui com as horas marcadas.
// modo: 'concluir' | 'parar' (botão Parar, com "Só pausar") | 'ajustar' (tarefa já feita: só salva as horas).
function openFinish(t, { modo = 'concluir' } = {}) {
  const ss = (t.sessoes || []).filter((x) => x.i);
  const run = isRunning(t);
  const nowRel = Math.floor((Date.now() - U.parseYmd(t.data).getTime()) / 60_000);
  const isToday = t.data === U.todayStr();
  let ini = null; // minutos desde a meia-noite do dia da tarefa
  let fim = null;
  let gasto = null; // minutos
  if (ss.length) {
    const sp = spanOf(t);
    ini = sp.s;
    fim = run ? nowRel : sp.e;
    gasto = Math.max(1, Math.round(elapsed(t) / 60));
  } else if (t.horario) {
    ini = U.toMin(t.horario);
    fim = t.fimAberto ? null : ini + duracao(t);
    // Hoje, no meio do horário (ou sem hora de fim): terminou agora.
    if (isToday && nowRel > ini && (fim == null || fim > nowRel)) fim = nowRel;
    gasto = fim == null ? null : fim - ini;
  } else if (isToday) {
    fim = nowRel;
    ini = Math.max(0, fim - duracao(t));
    gasto = fim - ini;
  }
  const pausas = ss.length > 1 && fim - ini - gasto > 1;
  const lastObs = ss[ss.length - 1]?.obs || '';
  const titulo = modo === 'ajustar' ? 'Ajustar horário' : modo === 'parar' ? 'Parar' : 'Concluir';
  openModal(`<form class="modal-body finish" data-form="finish" data-id="${t.id}" data-date="${t.data}" data-modo="${modo}"
      data-off="${ini == null ? 0 : Math.floor(ini / 1440)}" style="--c:${colorOf(t)}">
    ${modalHead(`${titulo} · ${esc(t.titulo)}`)}
    ${taskSub(t) ? `<p class="muted sm"><i class="dot"></i>${esc(taskSub(t))}</p>` : ''}
    <div class="fin3">
      <label class="field"><span>Início</span><input type="time" name="ini" required data-fin="ini" value="${ini == null ? '' : minTxt(ini)}"></label>
      <div class="field"><span>Tempo gasto</span>
        <div class="dur-in">
          <input type="number" name="gh" min="0" max="99" step="1" inputmode="numeric" data-fin="g" aria-label="Horas" value="${gasto == null ? '' : Math.floor(gasto / 60)}"><b>h</b>
          <input type="number" name="gm" min="0" max="59" step="1" inputmode="numeric" data-fin="g" aria-label="Minutos" value="${gasto == null ? '' : gasto % 60}"><b>min</b>
        </div></div>
      <label class="field"><span>Término</span><input type="time" name="fim" required data-fin="fim" value="${fim == null ? '' : minTxt(fim)}" ${fim == null ? 'autofocus' : ''}></label>
    </div>
    <p class="muted sm fin-dica" data-fin-dica>${pausas ? `Com pausas: ${U.fmtDur((fim - ini) * 60)} do começo ao fim, ${U.fmtDur(gasto * 60)} de trabalho. ` : ''}</p>
    <label class="field"><span>O que você fez? <em>opcional</em></span>
      <textarea name="obs" rows="2" maxlength="300" placeholder="Ex.: 5 vídeos editados">${esc(lastObs)}</textarea></label>
    ${
      modo === 'ajustar'
        ? ''
        : `<label class="field notes-field"><span>${icon('nota')}Notas <em>opcional, só você vê</em></span>
      <textarea rows="4" data-notes data-id="${t.id}" data-date="${t.data}" placeholder="O que foi feito, onde errei, o que funcionou, próximos passos…">${esc(t.notas || '')}</textarea></label>
    <div class="notes-bar">
      ${t.notas?.trim() ? '' : `<button type="button" class="link" data-action="notes-template">Usar modelo</button>`}
      <span class="muted sm" data-notes-status></span>
    </div>`
    }
    <footer class="modal-actions">
      ${modo === 'parar' ? `<button type="button" class="btn ghost" data-action="so-pausar" data-id="${t.id}" data-date="${t.data}">${icon('pause')}Só pausar</button>` : ''}
      ${modo === 'concluir' && !ss.length ? `<button type="button" class="btn ghost" data-action="check-semtempo" data-id="${t.id}" data-date="${t.data}">Concluir sem tempo</button>` : ''}
      ${modo === 'ajustar' ? '<button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>' : ''}
      <span class="grow"></span>
      <button type="submit" class="btn primary">${icon('check')}${modo === 'ajustar' ? 'Salvar' : 'Concluir'}</button>
    </footer>
  </form>`);
  finDica(modal.querySelector('form'));
}
const finGasto = (el) => (el.gh.value === '' && el.gm.value === '' ? null : (Number(el.gh.value) || 0) * 60 + (Number(el.gm.value) || 0));
function finDica(form) {
  const el = form.elements;
  const ini = U.toMin(el.ini.value);
  const g = finGasto(el);
  const box = form.querySelector('[data-fin-dica]');
  if (!box || ini == null || g == null) return;
  const pausa = box.dataset.pausa ?? (box.dataset.pausa = box.textContent);
  const avisos = [];
  if (!form.dataset.mexeu && pausa) avisos.push(pausa.trim());
  if (form.dataset.mexeu) avisos.push(`${U.fmtDur(g * 60)} no total.`);
  const diasDepois = Math.floor((ini + g) / 1440);
  if (diasDepois === 1) avisos.push('Termina no dia seguinte.');
  else if (diasDepois > 1) avisos.push(`Termina ${diasDepois} dias depois.`);
  if (g > 16 * 60) avisos.push('Confira: mais de 16 horas.');
  box.textContent = avisos.join(' ');
}
// Mexeu num dos três campos: acerta o outro.
function finSync(form, campo) {
  const el = form.elements;
  form.dataset.mexeu = '1';
  const ini = U.toMin(el.ini.value);
  const fim = U.toMin(el.fim.value);
  const g = finGasto(el);
  if (campo === 'g') {
    if (ini != null && g != null) el.fim.value = minTxt(ini + g);
    else if (fim != null && g != null) el.ini.value = minTxt(fim - g);
  } else if (ini != null && fim != null) {
    let d = fim - ini;
    if (d <= 0) d += 1440; // passou da meia-noite
    el.gh.value = Math.floor(d / 60);
    el.gm.value = d % 60;
  } else if (campo === 'ini' && ini != null && g != null) el.fim.value = minTxt(ini + g);
  finDica(form);
}

// Marca como concluída (ou reabre). Concluir para o cronômetro.
function setDone(t, done, extra = {}, ops = []) {
  if (done && isRunning(t)) stopTimer(t, ops);
  if (done && t.naoFeito) extra = { ...extra, naoFeito: false };
  t.concluido = done;
  Object.assign(t, extra);
  if (S.pedirConclusao === t.id) S.pedirConclusao = null;
  ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: { concluido: done, ...extra } });
  render();
  refreshDetail(t.id, t.data);
  persist(db.batch(ops), () => (t.concluido = !done));
}

// ---------------------------------------------------------------------------
// Iniciar tarefa: cliente → serviço (obrigatório) ou lista → tarefa opcional (ex.: Inglês → Estudar).
// Cria (ou continua) a tarefa de hoje e liga o cronômetro.
// ---------------------------------------------------------------------------

function openStart({ cli, cat, item, bloco, dia } = {}) {
  dia = dia && dia !== U.todayStr() ? dia : '';
  const c = cliById(cli);
  const k = catById(cat);
  const it = itensOf(k).find((x) => x.id === item);
  const voltarPara = (attrs = '') => `<button type="button" class="icon-btn" data-action="start-pick" ${attrs} data-bloco="${bloco || ''}" data-dia="${dia}" aria-label="Voltar">${icon('left')}</button>`;
  const back = voltarPara();
  const grid = (btns) => `<div class="pick-grid">${btns}</div>`;
  const fechar = `<button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button>`;

  if (c) {
    const servs = servicosOf(c);
    openModal(`<div class="modal-body start" data-start-cli="${c.id}" data-start-bloco="${bloco || ''}" data-start-dia="${dia}">
      <header class="modal-head">${voltarPara(`data-cat="${workCatId() || ''}"`)}<h2>${esc(c.nome)}</h2>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></header>
      ${
        c.pedeNome
          ? `<label class="field"><span>Nome da pessoa</span>
          <input data-start-pessoa list="dl-pessoas" maxlength="80" autocomplete="off" placeholder="Ex.: Maria" autofocus>
          <datalist id="dl-pessoas">${(c.pessoas || []).map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>`
          : ''
      }
      <h3 class="pick-title">O que você vai fazer?</h3>
      ${servs.length ? grid(servs.map((s) => `<button type="button" class="pick" data-action="start-go" data-serv="${esc(s)}">${icon('play')}${esc(s)}</button>`).join('')) : ''}
      <form class="pick-new" data-form="start-novo">
        <input name="servico" maxlength="60" autocomplete="off" placeholder="${servs.length ? 'Outro serviço' : 'Qual serviço? (ex.: Edição de vídeo)'}" ${servs.length || c.pedeNome ? '' : 'autofocus'}>
        <button type="submit" class="btn soft">${icon('plus')}Adicionar e iniciar</button>
      </form>
    </div>`);
    return;
  }
  if (k && it) {
    const subs = subsOf(k);
    if (!subs.length) return askComecei({ catId: k.id, itemId: it.id, bloco, dia });
    openModal(`<div class="modal-body start" data-start-cat="${k.id}" data-start-item="${it.id}" data-start-bloco="${bloco || ''}" data-start-dia="${dia}">
      <header class="modal-head">${voltarPara(`data-cat="${k.id}"`)}<h2>${esc(it.nome)}</h2>
        <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></header>
      <h3 class="pick-title">O que vai fazer? <em>opcional</em></h3>
      ${grid(
        subs.map((s) => `<button type="button" class="pick" data-action="start-go" data-serv="${esc(s)}">${icon('play')}${esc(s)}</button>`).join('') +
          `<button type="button" class="pick soft" data-action="start-go" data-serv="">${icon('play')}Só iniciar</button>`,
      )}
    </div>`);
    return;
  }
  if (k) {
    // Trabalho: os clientes. Categoria com lista (ex.: Cursos): os itens dela.
    if (isWork(k.id) || itensOf(k).length) {
      const clis = isWork(k.id) ? startClients() : [];
      const btns = isWork(k.id)
        ? clis.map((x) => `<button type="button" class="pick" data-action="start-pick" data-cli="${x.id}" data-bloco="${bloco || ''}" data-dia="${dia}"><i class="dot" style="--c:${k.cor}"></i>${esc(x.nome)}</button>`).join('')
        : itensOf(k).map((x) => `<button type="button" class="pick" data-action="start-pick" data-cat="${k.id}" data-item="${x.id}" data-bloco="${bloco || ''}" data-dia="${dia}"><i class="dot" style="--c:${k.cor}"></i>${esc(x.nome)}</button>`).join('');
      openModal(`<div class="modal-body start">
        <header class="modal-head">${back}<h2>${esc(k.nome)}</h2>${fechar}</header>
        <h3 class="pick-title">${isWork(k.id) ? 'Qual cliente?' : 'Qual?'}</h3>
        ${btns ? grid(btns) : '<p class="muted">Nenhum cliente ativo. Cadastre em Clientes.</p>'}
      </div>`);
      return;
    }
    // Categoria sem lista (ex.: Religião, Saúde): o que vai fazer? Os nomes usados antes viram botões.
    const sug = (k.sugestoes || []).filter(Boolean);
    openModal(`<div class="modal-body start" data-start-cat="${k.id}" data-start-bloco="${bloco || ''}" data-start-dia="${dia}">
      <header class="modal-head">${back}<h2>${esc(k.nome)}</h2>${fechar}</header>
      <h3 class="pick-title">O que você vai fazer?</h3>
      ${sug.length ? grid(sug.map((x) => `<button type="button" class="pick" data-action="start-go" data-serv="${esc(x)}">${icon('play')}${esc(x)}</button>`).join('')) : ''}
      <form class="pick-new" data-form="start-livre">
        <input name="nome" maxlength="60" autocomplete="off" placeholder="${sug.length ? 'Outra coisa' : 'Ex.: Igreja'}" ${sug.length ? '' : 'autofocus'}>
        <button type="submit" class="btn soft">${icon('plus')}Criar e iniciar</button>
      </form>
      <button type="button" class="pick soft start-so" data-action="start-go" data-serv="">${icon('play')}Não, só iniciar ${esc(k.nome)}</button>
    </div>`);
    return;
  }
  // Escolha inicial: todas as categorias.
  const cats = S.categories.filter((cc) => !isWork(cc.id) || startClients().length);
  openModal(`<div class="modal-body start">
    ${modalHead('Iniciar tarefa')}
    <h3 class="pick-title">O que você vai fazer?</h3>
    ${
      cats.length
        ? grid(cats.map((cc) => `<button type="button" class="pick" data-action="start-pick" data-cat="${cc.id}" data-bloco="${bloco || ''}" data-dia="${dia}"><i class="dot" style="--c:${cc.cor}"></i>${esc(cc.nome)}</button>`).join(''))
        : '<p class="muted">Crie uma categoria para iniciar por aqui.</p>'
    }
  </div>`);
}

// Último passo antes do play: "Comecei:" com a hora em branco e o botão "Comecei agora" (vira "OK" com a hora preenchida).
function askComecei(p) {
  const t = p.taskId ? findTask(p.taskId, p.date) : null;
  const c = cliById(t ? t.clienteId : p.cliId);
  const k = catById(p.catId);
  const it = itensOf(k).find((x) => x.id === p.itemId);
  const nome = t ? t.titulo : c ? [p.servico || c.nome, p.pessoa].filter(Boolean).join(' · ') : [it?.nome, p.servico].filter(Boolean).join(' · ') || k?.nome || '';
  const sub = t ? taskSub(t) : c && p.servico ? c.nome : !it && p.servico ? k?.nome || '' : '';
  const voltar = t ? '' : c ? `data-cli="${c.id}"` : `data-cat="${p.catId || ''}" data-item="${p.itemId || ''}"`;
  // Dia em que a tarefa fica (o da tarefa ou do bloco; sem nada, hoje). Dia passado: a hora não vem com a de agora.
  const dia = t?.data || p.dia || U.todayStr();
  const passado = dia < U.todayStr();
  // Tarefa marcada para um horário que já passou: um toque coloca esse horário.
  const tb = t || (p.bloco ? findTask(p.bloco, dia) : null);
  const marcado = tb?.horario && (passado || (tb.data === U.todayStr() && U.toMin(tb.horario) < U.nowMin())) ? tb.horario : '';
  const agora = passado ? marcado : U.fromMin(U.nowMin());
  openModal(`<form class="modal-body start comecei" data-form="comecei" data-p="${esc(JSON.stringify(p))}">
    <header class="modal-head">
      ${t ? '' : `<button type="button" class="icon-btn" data-action="start-pick" ${voltar} data-bloco="${p.bloco || ''}" aria-label="Voltar">${icon('left')}</button>`}
      <h2>${esc(nome)}</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></header>
    ${sub ? `<p class="muted sm comecei-sub">${esc(sub)}</p>` : ''}
    ${passado ? `<p class="comecei-dia">${icon('calendario')}Começou em <b>${esc(U.fmtDiaLongo(dia))}</b></p>` : ''}
    <label class="comecei-campo"><span>Comecei:</span><input type="time" name="ini" data-comecei value="${agora}" aria-label="Horário em que começou"></label>
    ${marcado ? `<button type="button" class="btn ghost sm comecei-marcado" data-action="comecei-hora" data-hora="${marcado}">Comecei às ${marcado} (horário da tarefa)</button>` : ''}
    <p class="muted sm">${passado ? 'Coloque a hora em que começou nesse dia.' : 'Já vem com a hora de agora. Se começou antes, mude.'} O fim fica em aberto: o cronômetro vai rodando.</p>
    <footer class="modal-actions">
      <button type="submit" class="btn primary comecei-btn" data-comecei-btn>${icon('play')}<span>Iniciar</span></button>
    </footer>
  </form>`);
}

async function startTask({ cliId, catId, itemId, servico = '', pessoa = '', bloco = '', inicio = null, fim = null, dia = '' }) {
  const today = dia && inicio ? dia : U.todayStr(); // dia da tarefa (outro dia só com a hora de início dita)
  const list = await ensureDay(today);
  const c = cliById(cliId);
  const categoriaId = c ? workCatId() || c.categoriaId || null : catId;
  const it = itensOf(catById(categoriaId)).find((x) => x.id === itemId);
  servico = servico.trim();
  pessoa = pessoa.trim();
  const titulo = c
    ? [servico || c.nome, pessoa].filter(Boolean).join(' · ')
    : [it?.nome, servico].filter(Boolean).join(' · ') || catById(categoriaId)?.nome || 'Tarefa';
  const livre = !c && !it; // categoria sem lista (ex.: Religião → Igreja)
  const ops = [];
  // Mesmo cliente/curso + mesmo serviço já aberto hoje: continua a mesma tarefa.
  let t = visible(list).find(
    (x) =>
      !fechada(x) &&
      !(fim && inicio && isRunning(x)) && // "Já terminei" de um bloco passado não entra na tarefa que está rodando
      x.categoriaId === categoriaId &&
      (x.clienteId || null) === (c?.id || null) &&
      (x.itemId || null) === (it?.id || null) &&
      (c
        ? norm(x.servico || x.titulo) === norm(servico) && norm(x.pessoa) === norm(pessoa)
        : livre
          ? norm(x.titulo) === norm(titulo)
          : norm(x.servico) === norm(servico) && !x.horario),
  );
  // ▶ no próprio bloco (ex.: "Cursos 10h30–12h") ou bloco da mesma categoria marcado para agora, ainda sem nada escolhido:
  // o bloco vira a tarefa (não cria outro card nem conclui o bloco).
  const minIni = Math.floor(((inicio || Date.now()) - U.parseYmd(today).getTime()) / 60_000);
  const livreDoBloco = (x) =>
    x && !x.removido && !fechada(x) && !isRunning(x) && x.categoriaId === categoriaId &&
    (!x.clienteId || x.clienteId === c?.id) && (!x.itemId || x.itemId === it?.id);
  let b = bloco ? list.find((x) => x.id === bloco) : null;
  if (!livreDoBloco(b)) b = null;
  if (!b && !t) {
    b = visible(list)
      .filter((x) => livreDoBloco(x) && !x.clienteId && !x.itemId && !elapsed(x) && x.horario &&
        U.toMin(x.horario) - 60 <= minIni && minIni < U.toMin(x.horario) + duracao(x))
      .sort((x, y) => Math.abs(U.toMin(x.horario) - minIni) - Math.abs(U.toMin(y.horario) - minIni))[0];
  }
  if (b) {
    const patch = { clienteId: c?.id || null, itemId: it?.id || null, servico: servico || null, pessoa: pessoa || null };
    if (nomeGenerico(b, c)) patch.titulo = titulo;
    Object.assign(b, patch);
    ops.push({ type: 'update', col: 'dailyTasks', id: b.id, data: patch });
    t = b;
  }
  if (!t) {
    t = {
      id: U.newId(), titulo, categoriaId, clienteId: c?.id || null, itemId: it?.id || null, servico: servico || null, pessoa: pessoa || null,
      data: today, horario: null, duracao: null, aviso: false, concluido: false, origem: 'avulsa', recurringTaskId: null, removido: false,
    };
    list.push(t);
    ops.push({ type: 'set', col: 'dailyTasks', id: t.id, data: t });
  }
  if (c) {
    // Serviço novo e nome novo ficam guardados no cliente para a próxima vez.
    const patch = {};
    if (servico && !servicosOf(c).some((s) => norm(s) === norm(servico))) patch.servicos = c.servicos = [...servicosOf(c), servico];
    if (pessoa && !(c.pessoas || []).some((p) => norm(p) === norm(pessoa))) patch.pessoas = c.pessoas = [pessoa, ...(c.pessoas || [])].slice(0, 60);
    if (Object.keys(patch).length) ops.push({ type: 'update', col: 'clients', id: c.id, data: patch });
  }
  if (fim && inicio) return feitoEntre(t, inicio, fim, ops);
  if (!isRunning(t) || inicio) startTimer(t, ops, inicio || Date.now());
  closeModal();
  render();
  persist(db.batch(ops));
  toast(`Cronômetro ligado${inicio ? ` desde ${hhmm(t.cronometroInicio)}` : ''}: ${nomeTxt(t)}`);
}

// Depois de play/pausa/concluir, atualiza o painel da tarefa se ele estiver aberto.
function refreshDetail(id, date) {
  if (modal.open && modal.dataset.detail === id) {
    const t = findTask(id, date);
    if (t) openTaskDetail(t);
  }
}

function saveNotes(t) {
  persist(db.update('dailyTasks', t.id, { notas: t.notas || '' }));
  setStatus('[data-notes-status]', 'Salvo ✓');
}

// O que foi anotado em cada sessão (ao pausar).
const sessObsHTML = (t) => {
  const ss = (t.sessoes || []).filter((s) => s.obs);
  return ss.length
    ? `<ul class="hist-sess">${ss.map((s) => `<li><span class="muted">${hhmm(s.i)}${s.f ? `–${hhmm(s.f)}` : ''}</span> ${esc(s.obs)}</li>`).join('')}</ul>`
    : '';
};

// Histórico de um cliente: tudo que foi feito, quanto tempo levou e as notas.
async function openClientHistory(cli) {
  openModal(`<div class="modal-body">${modalHead(`Histórico · ${esc(cli.nome)}`)}${loading()}</div>`);
  let rows;
  try {
    rows = await db.where('dailyTasks', 'clienteId', '==', cli.id);
  } catch (err) {
    closeModal();
    return toast(errMsg(err));
  }
  // Usa a versão em memória quando o dia já está aberto (pode ter mudanças ainda sendo salvas).
  rows = rows.map((r) => findTask(r.id, r.data) || r);
  const items = rows
    .filter((t) => !t.removido && (t.notas?.trim() || elapsed(t) >= 60 || t.concluido || t.sessoes?.some((s) => s.obs)))
    .sort((a, b) => b.data.localeCompare(a.data) || U.byHorarioTitulo(a, b))
    .slice(0, 150);
  const total = sumTime(items);
  const feitas = items.filter((t) => t.concluido).length;
  const list = items
    .map(
      (t) => `<li class="hist-item">
        <div class="hist-head">
          <span class="hist-date">${esc(U.fmtDiaCurto(t.data))}</span>
          <strong>${t.concluido ? `<span class="hist-ok">${icon('check')}</span>` : ''}${esc(t.titulo)}</strong>
          ${elapsed(t) >= 60 ? `<span class="timer-chip">${icon('cronometro')}${U.fmtDur(elapsed(t))}</span>` : ''}
        </div>
        ${sessObsHTML(t)}
        ${t.notas?.trim() ? `<p class="hist-notes">${esc(t.notas.trim())}</p>` : ''}
      </li>`,
    )
    .join('');
  if (!modal.open) return;
  openModal(`<div class="modal-body history">
    ${modalHead(`Histórico · ${esc(cli.nome)}`)}
    <div class="hist-summary">
      <div><strong>${feitas}</strong><span>${feitas === 1 ? 'tarefa concluída' : 'tarefas concluídas'}</span></div>
      <div><strong>${U.fmtDur(total)}</strong><span>tempo registrado</span></div>
      <div><strong>${items.filter((t) => t.notas?.trim()).length}</strong><span>com notas</span></div>
    </div>
    ${list ? `<ul class="hist-list">${list}</ul>` : '<p class="muted">Ainda não há tarefas concluídas, tempo ou notas para este cliente.</p>'}
  </div>`);
}

// ---------------------------------------------------------------------------
// Relatórios: quanto tempo (do cronômetro) foi para cada categoria, cliente e tarefa
// ---------------------------------------------------------------------------

const SEM_COR = '#94a3b8';
const MAX_FATIAS = 6; // acima disso a pizza fica ilegível: o resto vira "Outros"
const MAX_CORES_CLI = 8;

// Cor de cada cliente: posição fixa na lista (por nome) de todos os clientes, nunca pelo tempo do período.
const cliColor = (id) => {
  const i = [...S.clients].sort(U.byNome).findIndex((c) => c.id === id);
  return i >= 0 && i < MAX_CORES_CLI ? `var(--serie-${i + 1})` : SEM_COR;
};

// Para contar nos relatórios: tarefa fora da lista que leva o nome de um item dela junto de "aula", "curso"
// ou "estudo" (ex.: "Aula de inglês") conta como aquele item (Cursos → Inglês). Na lista do dia ela continua separada.
function contaComo(t) {
  const k = catById(t.categoriaId);
  if (allItens(k).length || isWork(t.categoriaId) || t.clienteId) return { cat: k, item: itemOf(t) };
  const txt = ` ${norm(`${t.titulo || ''} ${k?.nome || ''}`).replace(/[^a-z0-9]+/g, ' ')} `;
  if (!/ (aula|aulas|curso|cursos|estudo|estudar|estudos|licao|licoes) /.test(txt)) return { cat: k, item: null };
  for (const lk of S.categories) {
    const it = allItens(lk).find((i) => {
      const n = norm(i.nome).replace(/[^a-z0-9]+/g, ' ').trim();
      return n.length >= 3 && txt.includes(` ${n} `);
    });
    if (it) return { cat: lk, item: it };
  }
  return { cat: k, item: null };
}

function relRange() {
  const today = U.todayStr();
  if (S.relPeriodo === 'hoje') return { from: today, to: today, label: 'Hoje' };
  if (S.relPeriodo === 'ontem') {
    const d = U.addDays(today, -1);
    return { from: d, to: d, label: 'Ontem' };
  }
  if (S.relPeriodo === 'custom') {
    let [from, to] = [S.relDe || today, S.relAte || S.relDe || today];
    if (to < from) [from, to] = [to, from];
    if (U.addDays(from, 366) < to) to = U.addDays(from, 366); // até 1 ano por vez
    const dm = (d) => `${d.slice(8)}/${d.slice(5, 7)}${d.slice(0, 4) === today.slice(0, 4) ? '' : `/${d.slice(0, 4)}`}`;
    return { from, to, label: from === to ? U.fmtDiaCurto(from) : `${dm(from)} a ${dm(to)}` };
  }
  if (S.relPeriodo === 'mes') {
    const from = `${S.relMes}-01`;
    const to = U.addDays(`${U.addMonths(S.relMes, 1)}-01`, -1);
    return { from, to, label: U.fmtMes(S.relMes) };
  }
  return { from: U.addDays(today, -6), to: today, label: 'Últimos 7 dias' };
}

// Junta o que é pequeno demais em "Outros" e calcula a %.
function slices(map, total) {
  const all = [...map.values()].filter((x) => x.sec >= 1).sort((a, b) => b.sec - a.sec);
  let list = all;
  if (all.length > MAX_FATIAS) {
    const rest = all.slice(MAX_FATIAS - 1);
    list = [
      ...all.slice(0, MAX_FATIAS - 1),
      { key: '_outros', label: `Outros (${rest.length})`, cor: SEM_COR, sec: rest.reduce((a, x) => a + x.sec, 0) },
    ];
  }
  return list.map((x) => ({ ...x, pct: total ? (x.sec * 100) / total : 0 }));
}

const pctTxt = (p) => (p >= 10 || p === 0 ? `${Math.round(p)}%` : `${p.toFixed(1).replace('.', ',')}%`);
const tipOf = (x) => `${x.label}: ${U.fmtDur(x.sec)} (${pctTxt(x.pct)})`;

// Pizza em anel (SVG), com o total no meio. Passar o mouse numa fatia ou na legenda mostra o valor dela.
function donutHTML(id, items, total, clica = false) {
  const R = 80;
  const r = 50;
  const C = 100;
  const pt = (rad, a) => `${(C + rad * Math.sin(a)).toFixed(2)} ${(C - rad * Math.cos(a)).toFixed(2)}`;
  let a0 = 0;
  const paths = items
    .map((x) => {
      const attrs = `data-rk="${id}:${x.key}" fill="${x.cor}"`;
      if (items.length === 1) {
        return `<path ${attrs} fill-rule="evenodd" d="M ${pt(R, 0)} A ${R} ${R} 0 1 1 ${pt(R, Math.PI)} A ${R} ${R} 0 1 1 ${pt(R, 0)} Z M ${pt(r, 0)} A ${r} ${r} 0 1 0 ${pt(r, Math.PI)} A ${r} ${r} 0 1 0 ${pt(r, 0)} Z"><title>${esc(tipOf(x))}</title></path>`;
      }
      const a1 = a0 + (x.sec / total) * Math.PI * 2;
      const big = a1 - a0 > Math.PI ? 1 : 0;
      const d = `M ${pt(R, a0)} A ${R} ${R} 0 ${big} 1 ${pt(R, a1)} L ${pt(r, a1)} A ${r} ${r} 0 ${big} 0 ${pt(r, a0)} Z`;
      a0 = a1;
      return `<path ${attrs} d="${d}"><title>${esc(tipOf(x))}</title></path>`;
    })
    .join('');
  const abre = (x) => (clica && x.key !== '_outros' ? ` data-action="rel-dias" data-ch="${id}" data-key="${esc(x.key)}" role="button" tabindex="0" title="Ver os dias"` : '');
  const legend = items
    .map(
      (x) => `<li data-rk="${id}:${x.key}"${abre(x)}>
        <span class="sw" style="background:${x.cor}"></span>
        <span class="name">${esc(x.label)}</span>
        <span class="val">${U.fmtDur(x.sec)}</span>
        <span class="pct">${pctTxt(x.pct)}</span>
      </li>`,
    )
    .join('');
  return `<div class="donut-wrap${clica ? ' clica' : ''}" data-chart="${id}">
    <div class="donut">
      <svg viewBox="0 0 200 200" role="img" aria-label="Gráfico de pizza">${paths}</svg>
      <div class="donut-center" data-total="${esc(U.fmtDur(total))}"><strong>${U.fmtDur(total)}</strong><span>total</span></div>
    </div>
    <ul class="legend">${legend}</ul>
  </div>`;
}

function viewRelatorios() {
  const today = U.todayStr();
  const { from, to, label } = relRange();
  const mes = S.relPeriodo === 'mes';
  const chip = (p, txt) =>
    `<button type="button" class="tab-chip${S.relPeriodo === p ? ' on' : ''}" data-action="rel-periodo" data-p="${p}">${txt}</button>`;
  const head = `
  <header class="page-head">
    <div class="daynav">
      ${mes ? `<button type="button" class="icon-btn" data-action="rel-mes" data-n="-1" aria-label="Mês anterior">${icon('left')}</button>` : ''}
      <div class="daynav-title"><span class="eyebrow">Relatórios · ${agoraHTML()}</span><h1>${esc(label)}</h1></div>
      ${mes && S.relMes < today.slice(0, 7) ? `<button type="button" class="icon-btn" data-action="rel-mes" data-n="1" aria-label="Próximo mês">${icon('right')}</button>` : ''}
    </div>
  </header>
  <div class="tab-chips" role="tablist">${chip('ontem', 'Ontem')}${chip('hoje', 'Hoje')}${chip('semana', '7 dias')}${chip('mes', 'Mês')}${chip('custom', 'Personalizado')}</div>
  ${
    S.relPeriodo === 'custom'
      ? `<div class="card rel-datas">
      <label class="field"><span>De</span><input type="date" value="${from}" data-rel-data="relDe"></label>
      <label class="field"><span>Até</span><input type="date" value="${to}" data-rel-data="relAte"></label>
      <p class="muted sm">Para ver um dia só, coloque a mesma data nos dois.</p>
    </div>`
      : ''
  }`;

  if (!ensureRange(from, to)) return head + loading();

  const tasks = [];
  const porDia = [];
  for (let d = from; d <= to; d = U.addDays(d, 1)) {
    const v = visible(S.days[d] || []);
    tasks.push(...v);
    porDia.push({ d, sec: sumTime(v) });
  }
  const timed = tasks.filter((t) => elapsed(t) >= 1);
  const total = sumTime(timed);
  const naoFeitas = tasks.filter((t) => t.naoFeito);
  const perdido = sumDesperdicio(naoFeitas);
  const nfCard = naoFeitoCard(naoFeitas, perdido);

  if (total < 60) {
    return `${head}${
      naoFeitas.length
        ? `<div class="rel-grid">${nfCard}</div>`
        : emptyState(
            'Ainda não há tempo registrado neste período',
            'Aperte o play nas tarefas da tela Hoje para cronometrar. O tempo de cada tarefa entra aqui, separado por categoria e por cliente.',
          )
    }`;
  }

  // Por categoria
  const cats = new Map();
  for (const t of timed) {
    const c = contaComo(t).cat;
    const key = c ? c.id : '_sem';
    const x = cats.get(key) || { key, label: c ? c.nome : 'Sem categoria', cor: c ? c.cor : SEM_COR, sec: 0 };
    x.sec += elapsed(t);
    cats.set(key, x);
  }

  // Por cliente (só Trabalho)
  const wid = workCatId();
  const wnome = esc(catById(wid)?.nome || 'Trabalho');
  const work = timed.filter((t) => wid && t.categoriaId === wid);
  const workTotal = sumTime(work);
  const clis = new Map();
  for (const t of work) {
    const c = cliById(t.clienteId);
    const key = c ? c.id : '_sem';
    const x = clis.get(key) || { key, label: c ? c.nome : 'Sem cliente', cor: c ? cliColor(c.id) : SEM_COR, sec: 0 };
    x.sec += elapsed(t);
    clis.set(key, x);
  }

  const dias = porDia.filter((x) => x.d <= today).length || 1;
  const comTempo = porDia.filter((x) => x.sec >= 60).length;
  const feitas = timed.filter((t) => t.concluido).length;
  const tiles = [
    [U.fmtDur(total), 'tempo registrado'],
    from === to ? null : [U.fmtDur(total / dias), `média por dia · ${comTempo} de ${dias} dia${dias === 1 ? '' : 's'} com tempo`],
    [`${feitas} de ${timed.length}`, `tarefa${timed.length === 1 ? '' : 's'} cronometrada${timed.length === 1 ? '' : 's'} concluída${feitas === 1 ? '' : 's'}`],
    wid ? [pctTxt((workTotal * 100) / total), `do tempo em ${wnome} · ${U.fmtDur(workTotal)}`] : null,
    naoFeitas.length ? [perdido >= 60 ? U.fmtDur(perdido) : naoFeitas.length, perdido >= 60 ? `desperdiçado · ${naoFeitas.length} não feita${naoFeitas.length > 1 ? 's' : ''}` : `não feita${naoFeitas.length > 1 ? 's' : ''}`, 'nf'] : null,
  ].filter(Boolean);

  // Barras por dia (7 dias ou mês)
  let barras = '';
  if (from !== to) {
    const longo = porDia.length > 7;
    const max = Math.max(...porDia.map((x) => x.sec), 1);
    barras = `<section class="card rel-card">
      <h2 class="card-title">${icon('calendario')}Tempo por dia</h2>
      <div class="day-bars${longo ? ' mes' : ''}">
        ${porDia
          .map((x) => {
            const dnum = Number(x.d.slice(8));
            const lbl = longo ? (dnum === 1 || dnum % 5 === 0 ? dnum : '') : U.DIAS_CURTO[U.weekdayOf(x.d)];
            const tip = `${U.fmtDiaCurto(x.d)}: ${U.fmtDur(x.sec)}`;
            return `<button type="button" class="day-bar${x.d === today ? ' today' : ''}" data-action="cal-open" data-date="${x.d}" title="${esc(tip)}" aria-label="${esc(tip)}">
              <span class="bar-area"><i style="height:${x.sec >= 60 ? Math.max(3, (x.sec * 100) / max) : 0}%">${x.sec >= 60 ? `<b class="bar-val">${barTxt(x.sec, longo)}</b>` : ''}</i></span>
              <small>${lbl}</small>
            </button>`;
          })
          .join('')}
      </div>
      <p class="muted sm">Maior dia: <strong>${U.fmtDur(max)}</strong>. Toque numa barra para abrir o dia.</p>
    </section>`;
  }

  const cliCard = !wid
    ? ''
    : `<section class="card rel-card">
      <h2 class="card-title">${icon('clientes')}Por cliente <small class="muted">(${wnome} · toque para ver os dias)</small></h2>
      ${
        workTotal >= 60
          ? donutHTML('cli', slices(clis, workTotal), workTotal, true)
          : `<p class="muted sm">Nenhum tempo em ${wnome} neste período. Ligue o cronômetro nas tarefas com cliente para ver a divisão aqui.</p>`
      }
    </section>`;

  // Por item de cada lista (ex.: Cursos → Inglês, Fotografia…)
  const listaCards = S.categories
    .filter((k) => allItens(k).length)
    .map((k) => {
      const its = timed.filter((t) => contaComo(t).cat?.id === k.id);
      const tot = sumTime(its);
      if (tot < 60) return '';
      const m = new Map();
      its.forEach((t) => {
        const it = contaComo(t).item;
        const key = it ? it.id : '_sem';
        const x = m.get(key) || { key, label: it ? it.nome : 'Sem escolher', cor: it ? `var(--serie-${(allItens(k).indexOf(it) % MAX_CORES_CLI) + 1})` : SEM_COR, sec: 0 };
        x.sec += elapsed(t);
        m.set(key, x);
      });
      return `<section class="card rel-card">
        <h2 class="card-title"><i class="dot" style="--c:${k.cor}"></i>${esc(k.nome)}</h2>
        ${donutHTML(`it${k.id}`, slices(m, tot), tot, true)}
      </section>`;
    })
    .join('');

  return `${head}
  <div class="rel-tiles">${tiles.map(([v, l, c]) => `<div class="card rel-tile${c ? ` ${c}` : ''}"><strong>${v}</strong><span>${l}</span></div>`).join('')}</div>
  <div class="rel-grid">
    <section class="card rel-card">
      <h2 class="card-title">${icon('categorias')}Por categoria</h2>
      ${donutHTML('cat', slices(cats, total), total)}
    </section>
    ${cliCard}
    ${listaCards}
    ${nfCard}
    ${seuDiaCard(from, to)}
  </div>
  ${barras}`;
}

// Número em cima da barra: "4h30" (7 dias) ou "4,5" horas (mês, barras finas).
function barTxt(sec, longo) {
  const min = Math.round(sec / 60);
  if (longo) {
    const h = min / 60;
    return h >= 10 ? `${Math.round(h)}` : h.toFixed(1).replace('.', ',').replace(',0', '');
  }
  return min < 60 ? `${min}min` : `${Math.floor(min / 60)}h${min % 60 ? String(min % 60).padStart(2, '0') : ''}`;
}

// Pop-up de um cliente, item ou parte do "Seu dia": cada dia do período (mais recente em cima), com as horas.
function openRelDias(ch, key) {
  const { from, to, label } = relRange();
  const today = U.todayStr();
  const ult = to < today ? to : today;
  const linhas = [];
  let titulo = '';
  let cor = SEM_COR;
  const unicos = (l) => [...new Set(l.filter(Boolean))].join(' · ');
  const porTarefa = (pred, det) => {
    for (let d = ult; d >= from; d = U.addDays(d, -1)) {
      const ts = visible(S.days[d] || []).filter((t) => elapsed(t) >= 1 && pred(t));
      const sec = sumTime(ts);
      if (sec >= 60) linhas.push({ d, sec, det: unicos(ts.map(det)) });
    }
  };
  if (ch === 'cli') {
    const wid = workCatId();
    const c = cliById(key);
    titulo = c ? c.nome : 'Sem cliente';
    cor = c ? cliColor(c.id) : SEM_COR;
    porTarefa((t) => t.categoriaId === wid && (cliById(t.clienteId)?.id || '_sem') === key, (t) => t.servico || t.titulo);
  } else if (ch.startsWith('it')) {
    const k = catById(ch.slice(2));
    const it = allItens(k).find((i) => i.id === key);
    titulo = `${k?.nome || ''} • ${it ? it.nome : 'Sem escolher'}`;
    cor = k?.cor || SEM_COR;
    porTarefa((t) => contaComo(t).cat?.id === k?.id && (contaComo(t).item?.id || '_sem') === key, (t) => t.servico || (norm(t.titulo) === norm(it?.nome || '') ? '' : t.titulo));
  } else if (ch === 'dia') {
    const parte = SEU_DIA.find(([k]) => k === key);
    const c = key.startsWith('c') ? catById(key.slice(1)) : null;
    titulo = parte ? parte[1] : c ? c.nome : 'Sem categoria';
    cor = parte ? parte[2] : c ? c.cor : SEM_COR;
    for (let d = ult; d >= from; d = U.addDays(d, -1)) {
      const r = seuDiaDoDia(d);
      if (!r || r.vazio) continue;
      const min = parte ? r.g[key] : r.cat.get(key.slice(1)) || 0;
      if (min < 1) continue;
      let det = '';
      if (key === 'desperdicado') det = r.nf.map((t) => `${nomeTxt(t)}${t.horario ? ` (${t.horario})` : ''}`).join(' · ');
      else if (key === 'acordou') det = r.first != null ? `1ª tarefa às ${minTxt(r.first)}` : 'Nada cronometrado';
      else if (key === 'entre') {
        const ps = r.pausas.filter(([x, y]) => y - x >= 1);
        det = ps.slice(0, 6).map(([x, y]) => `${minTxt(x)}–${minTxt(y)}`).join(' · ') + (ps.length > 6 ? ` +${ps.length - 6}` : '');
      } else if (key === 'lazer' && r.last != null) det = `Última tarefa até ${minTxt(r.last)}`;
      linhas.push({ d, sec: min * 60, det });
    }
  }
  const total = linhas.reduce((s, x) => s + x.sec, 0);
  openModal(`<div class="modal-body rel-dias" style="--c:${cor}">
    ${modalHead(`<i class="dot"></i>${esc(titulo)}`)}
    <p class="muted sm">${esc(label)} · ${linhas.length} dia${linhas.length === 1 ? '' : 's'}${total >= 60 ? ` · <strong>${U.fmtDur(total)}</strong> no total` : ''}</p>
    ${
      linhas.length
        ? `<ul class="rd-lista">${linhas
            .map(
              (x) => `<li><div class="rd-txt"><strong>${esc(U.fmtDiaCurto(x.d))}</strong>${x.det ? `<small class="muted">${esc(x.det)}</small>` : ''}</div>
              <span class="rd-h">${U.fmtDur(x.sec)}</span>
              <button type="button" class="btn ghost sm" data-action="dia-abrir" data-date="${x.d}">Ir para o dia</button></li>`,
            )
            .join('')}</ul>`
        : '<p class="muted">Nada neste período.</p>'
    }
  </div>`);
}

// Não feito (X): quanto tempo planejado ficou sem fazer, por categoria, e quais tarefas.
function naoFeitoCard(lista, perdido) {
  if (!lista.length) return '';
  const m = new Map();
  for (const t of lista) {
    const c = catById(t.categoriaId);
    const key = c ? c.id : '_sem';
    const x = m.get(key) || { nome: c ? c.nome : 'Sem categoria', cor: c ? c.cor : SEM_COR, sec: 0, n: 0 };
    x.sec += desperdicio(t);
    x.n += 1;
    m.set(key, x);
  }
  const cats = [...m.values()].sort((a, b) => b.sec - a.sec || b.n - a.n);
  const max = cats[0]?.sec || 1;
  const tarefas = [...lista].sort((a, b) => (b.data + (b.horario || '')).localeCompare(a.data + (a.horario || ''))).slice(0, 8);
  return `<section class="card rel-card nf-card">
    <h2 class="card-title">${icon('x')}Não feito <small class="muted">(tempo desperdiçado)</small></h2>
    <p class="nf-total"><strong>${perdido >= 60 ? U.fmtDur(perdido) : '—'}</strong><span>${lista.length} tarefa${lista.length > 1 ? 's' : ''} marcada${lista.length > 1 ? 's' : ''} com X</span></p>
    <ul class="task-bars">${cats
      .map(
        (x) => `<li>
        <div class="tb-head"><span class="name"><i class="dot" style="--c:${x.cor}"></i>${esc(x.nome)} <small class="muted">· ${x.n}x</small></span>
        <span class="val">${x.sec >= 60 ? U.fmtDur(x.sec) : '—'}</span></div>
        <span class="tb-track"><i style="width:${x.sec >= 60 ? Math.max(1.5, (x.sec * 100) / max) : 0}%;background:var(--danger)"></i></span>
      </li>`,
      )
      .join('')}</ul>
    <ul class="nf-lista">${tarefas
      .map((t) => `<li><span>${esc(t.titulo)}</span><small class="muted">${esc(U.fmtDiaCurto(t.data))}${t.horario ? ` · ${t.horario}` : ''}${desperdicio(t) >= 60 ? ` · ${U.fmtDur(desperdicio(t))}` : ''}</small></li>`)
      .join('')}</ul>
    <p class="muted sm">Conta o horário planejado de cada tarefa marcada com X (menos o que chegou a ser cronometrado).</p>
  </section>`;
}

// "Seu dia": do acordar ao dormir (o sono não conta), quanto foi marcado e onde ficou sem marcação.
// Do acordar até a 1ª tarefa: "Acordou → 1ª tarefa". Buracos entre tarefas: pausa.
// Depois da última tarefa: sem marcação, provavelmente lazer.
// O tempo com cronômetro aparece dividido por categoria (Trabalho, Cursos, Religião...), na cor de cada uma.
// As faixas sem marcação ficam em tons de cinza, para não confundir com as categorias.
const SEU_DIA = [
  ['desperdicado', 'Tempo desperdiçado (marcado com X)', '#ef4444'],
  ['acordou', 'Acordou → 1ª tarefa', '#64748b'],
  ['entre', 'Pausa entre tarefas', '#94a3b8'],
  ['lazer', 'Depois da última tarefa (provavelmente lazer)', '#cbd5e1'],
];

// A conta de um dia (minutos): marcado, desperdiçado, acordou → 1ª tarefa, pausas e depois da última.
// null = dia que não entra (ainda não chegou); { vazio: true } = nada marcado.
function seuDiaDoDia(d) {
  const p = S.profile;
  const W0 = U.toMin(p.acordar || '07:00');
  let W1 = U.toMin(p.dormir || '23:30');
  if (W1 <= W0) W1 += 1440;
  const today = U.todayStr();
  if (d > today) return null;
  const end = d === today ? Math.min(U.nowMin(), W1) : W1;
  if (end <= W0) return null;
  const base = U.parseYmd(d).getTime();
  const iv = [];
  let solto = 0; // tempo sem horário (cronômetro antigo, sem sessões)
  const brutoCat = new Map(); // minutos de cada categoria no dia, para dividir o marcado
  const somaCat = (t, m) => {
    const k = contaComo(t).cat?.id || '_sem';
    brutoCat.set(k, (brutoCat.get(k) || 0) + m);
  };
  for (const t of visible(S.days[d] || [])) {
    const ss = (t.sessoes || []).filter((s) => s.i);
    if (!ss.length) {
      solto += elapsed(t) / 60;
      somaCat(t, elapsed(t) / 60);
      continue;
    }
    for (const s of ss) {
      const a = Math.max(W0, (s.i - base) / 60_000);
      const b = Math.min(end, ((s.f || Date.now()) - base) / 60_000);
      if (b > a) {
        iv.push([a, b]);
        somaCat(t, b - a);
      }
    }
  }
  iv.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const x of iv) {
    const last = merged[merged.length - 1];
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1]);
    else merged.push([...x]);
  }
  // Blocos marcados com X: o horário planejado deles vira tempo desperdiçado.
  const xs = [];
  const nf = [];
  for (const t of visible(S.days[d] || [])) {
    if (!t.naoFeito) continue;
    nf.push(t);
    if (!t.horario || t.fimAberto) continue;
    const a = Math.max(W0, U.toMin(t.horario));
    const b = Math.min(end, U.toMin(t.horario) + duracao(t));
    if (b > a) xs.push([a, b]);
  }
  // Dia sem nada marcado não entra (senão o dia inteiro vira "sem marcação").
  if (!merged.length && solto < 1 && !xs.length) return { vazio: true };
  const marcado = merged.reduce((a, [s, e]) => a + e - s, 0);
  const first = merged.length ? merged[0][0] : end;
  const lastEnd = merged.length ? merged[merged.length - 1][1] : end;
  const g = {
    marcado,
    acordou: Math.max(0, Math.min(first, end) - W0),
    entre: merged.slice(1).reduce((a, x, k) => a + x[0] - merged[k][1], 0),
    lazer: Math.max(0, end - lastEnd),
    desperdicado: 0,
  };
  // O X tira tempo de onde ele caiu (manhã, entre tarefas, depois da última...), nunca do que foi cronometrado.
  const sobrep = (a, b) => (b > a ? xs.reduce((s, [x, y]) => s + Math.max(0, Math.min(y, b) - Math.max(x, a)), 0) : 0);
  const xu = [];
  for (const x of xs.sort((p1, q) => p1[0] - q[0])) {
    const l = xu[xu.length - 1];
    if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]);
    else xu.push([...x]);
  }
  xs.splice(0, xs.length, ...xu);
  const pausas = merged.slice(1).map((x, k) => [merged[k][1], x[0]]);
  const regioes = {
    acordou: [[W0, Math.min(first, end)]],
    entre: pausas,
    lazer: [[lastEnd, end]],
  };
  for (const [k, lista] of Object.entries(regioes)) {
    const tira = Math.min(g[k], lista.reduce((s, [a, b]) => s + sobrep(a, b), 0));
    g[k] -= tira;
    g.desperdicado += tira;
  }
  // Tempo sem horário: entra como marcado e sai do que estava sem marcação.
  for (const k of ['lazer', 'entre', 'acordou']) {
    const tira = Math.min(solto, g[k]);
    g[k] -= tira;
    g.marcado += tira;
    solto -= tira;
  }
  // O marcado do dia, dividido entre as categorias na proporção do cronômetro de cada uma.
  const cat = new Map();
  const bruto = [...brutoCat.values()].reduce((a, b) => a + b, 0);
  if (bruto > 0) for (const [k, m] of brutoCat) cat.set(k, (g.marcado * m) / bruto);
  return { g, cat, first: merged.length ? merged[0][0] : null, last: merged.length ? lastEnd : null, pausas, nf };
}

function seuDiaCard(from, to) {
  const p = S.profile;
  const tot = Object.fromEntries([['marcado'], ...SEU_DIA].map(([k]) => [k, 0]));
  const porCat = new Map(); // id da categoria → segundos com cronômetro
  let dias = 0;
  let vazios = 0;
  for (let d = from; d <= to; d = U.addDays(d, 1)) {
    const r = seuDiaDoDia(d);
    if (!r) continue;
    if (r.vazio) {
      vazios++;
      continue;
    }
    dias++;
    for (const k in r.g) tot[k] += r.g[k] * 60;
    for (const [k, m] of r.cat) porCat.set(k, (porCat.get(k) || 0) + m * 60);
  }
  const soma = Object.values(tot).reduce((a, b) => a + b, 0);
  if (!dias || soma < 60) return '';
  const cats = [...porCat.entries()]
    .map(([id, sec]) => {
      const c = catById(id);
      return { key: `c${id}`, label: c ? c.nome : 'Sem categoria', cor: c ? c.cor : '#78716c', sec };
    })
    .sort((a, b) => b.sec - a.sec);
  const resto = SEU_DIA.map(([key, label, cor]) => ({ key, label, cor, sec: tot[key] }));
  const items = [...cats, ...resto].filter((x) => x.sec >= 1).map((x) => ({ ...x, pct: (x.sec * 100) / soma }));
  return `<section class="card rel-card">
    <h2 class="card-title">${icon('horarios')}Seu dia <small class="muted">(acordado${dias > 1 ? `, ${dias} dias` : ''} · toque para ver os dias)</small></h2>
    ${donutHTML('dia', items, soma, true)}
    <p class="muted sm">Das ${esc(p.acordar || '07:00')} às ${esc(p.dormir || '23:30')}; o sono não entra.${dias > 1 ? ` Com cronômetro, por dia: <strong>${U.fmtDur(tot.marcado / dias)}</strong>.` : ''}${vazios ? ` ${vazios} dia${vazios > 1 ? 's' : ''} sem nada marcado ${vazios > 1 ? 'ficaram' : 'ficou'} de fora.` : ''} Mude os horários nos <a href="#/ajustes">Ajustes</a>.</p>
  </section>`;
}

// Destaca a fatia (e a linha da legenda) sob o mouse e mostra o valor dela no meio da pizza.
function relHover(e) {
  const el = e.target.closest?.('[data-rk]');
  document.querySelectorAll('.donut-wrap.hl').forEach((w) => {
    if (el && w.contains(el)) return;
    w.classList.remove('hl');
    w.querySelectorAll('.on').forEach((x) => x.classList.remove('on'));
    const c = w.querySelector('.donut-center');
    c.innerHTML = `<strong>${c.dataset.total}</strong><span>total</span>`;
  });
  if (!el) return;
  const wrap = el.closest('.donut-wrap');
  const key = el.dataset.rk;
  wrap.classList.add('hl');
  wrap.querySelectorAll('[data-rk]').forEach((x) => x.classList.toggle('on', x.dataset.rk === key));
  const li = wrap.querySelector(`li[data-rk="${CSS.escape(key)}"]`);
  if (li) {
    wrap.querySelector('.donut-center').innerHTML = `<strong>${li.querySelector('.val').textContent}</strong><span>${esc(
      li.querySelector('.name').textContent,
    )} · ${li.querySelector('.pct').textContent}</span>`;
  }
}
document.addEventListener('pointerover', relHover);

// ---------------------------------------------------------------------------
// Diário: uma folha por dia para ideias, brainstorming, o que quiser
// ---------------------------------------------------------------------------

const palavras = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// Nome da anotação: a primeira linha do texto (curta).
const journalTitulo = (txt) => {
  const l = txt.trim().split('\n')[0].trim();
  return l.length > 70 ? `${l.slice(0, 68).trimEnd()}…` : l;
};

function journalListHTML() {
  const q = (S.journalBusca || '').trim().toLowerCase();
  const entries = Object.values(S.journal || {})
    .filter((e) => e.texto?.trim() && (!q || e.texto.toLowerCase().includes(q)))
    .sort((a, b) => b.id.localeCompare(a.id));
  if (!entries.length) return `<p class="muted sm journal-vazio">${q ? 'Nada encontrado.' : 'Suas anotações aparecem aqui. Toque em “Nova” para escrever a de hoje.'}</p>`;
  return entries
    .map((e) => {
      const txt = e.texto.trim();
      const titulo = journalTitulo(txt);
      // Trecho: o que vem depois do nome, ou em volta da palavra buscada.
      const resto = txt.slice(txt.split('\n')[0].length).trim();
      const base = q && !resto.toLowerCase().includes(q) ? txt : resto;
      const i = q ? Math.max(0, base.toLowerCase().indexOf(q)) : 0;
      const from = Math.max(0, i - 40);
      const to = from + 120;
      const snippet = base ? (from > 0 ? '…' : '') + base.slice(from, to) + (to < base.length ? '…' : '') : '';
      const rel = U.relativo(e.id);
      return `<li><button type="button" class="journal-item${e.id === S.diarioDate ? ' on' : ''}" data-action="diario-open" data-date="${e.id}">
        <span class="journal-tit">${esc(titulo)}</span>
        <span class="journal-date">${esc(U.fmtDiaCurto(e.id))}${/^(Hoje|Ontem)$/.test(rel) ? ` · ${rel}` : ''}</span>
        ${snippet ? `<span class="journal-snippet">${esc(snippet)}</span>` : ''}</button></li>`;
    })
    .join('');
}

function viewDiario() {
  if (!S.journal) {
    db.list('journal')
      .then((rows) => {
        S.journal = Object.fromEntries(rows.map((r) => [r.id, r]));
        render();
      })
      .catch((err) => toast(errMsg(err)));
    return loading();
  }
  const d = S.diarioDate;
  const busca = `<label class="journal-search">${icon('busca')}<input type="search" data-journal-search placeholder="Buscar no diário" value="${esc(S.journalBusca || '')}" aria-label="Buscar no diário"></label>`;
  // Sem dia aberto: a lista de todas as anotações, mais novas primeiro.
  if (!d) {
    const n = Object.values(S.journal).filter((e) => e.texto?.trim()).length;
    return `
  <header class="page-head">
    <div><p class="eyebrow">Diário · Hoje · ${agoraHTML()}</p><h1>Anotações</h1></div>
    <div class="head-btns"><button type="button" class="btn primary" data-action="diario-novo">${icon('plus')}<span>Nova<span class="so-largo"> anotação</span></span></button></div>
  </header>
  <section class="card journal-index">
    ${busca}
    <p class="muted sm journal-conta">${n} anotaç${n === 1 ? 'ão' : 'ões'}</p>
    <ul class="journal-list" id="journal-list">${journalListHTML()}</ul>
  </section>`;
  }
  const texto = S.journal[d]?.texto || '';
  const isToday = d === U.todayStr();
  return `
  <header class="page-head">
    <div class="daynav">
      <button type="button" class="icon-btn" data-action="diario-lista" aria-label="Voltar para as anotações" title="Todas as anotações">${icon('left')}</button>
      <div class="daynav-title"><span class="eyebrow">Diário · ${esc(U.relativo(d))} · ${isToday ? clockHTML() : `hoje é ${agoraHTML()}`}</span><h1>${esc(U.fmtDiaLongo(d))}</h1></div>
      <button type="button" class="btn ghost sm diario-todas" data-action="diario-lista" aria-label="Todas as anotações" title="Todas as anotações">${icon('diario')}<span>Todas as anotações</span></button>
    </div>
  </header>
  <div class="journal-layout">
    <section class="card journal-page">
      <textarea data-journal data-date="${d}" aria-label="Diário de ${esc(U.fmtDiaLongo(d))}"
        placeholder="A primeira linha vira o nome da anotação.&#10;Depois, escreva livremente: ideias, brainstorming, aprendizados, como foi o dia…">${esc(texto)}</textarea>
      <footer class="journal-foot"><span data-journal-count>${palavras(texto)} palavra${palavras(texto) === 1 ? '' : 's'}</span><span data-journal-status></span></footer>
    </section>
    <aside class="card journal-side">
      ${busca}
      <ul class="journal-list" id="journal-list">${journalListHTML()}</ul>
    </aside>
  </div>`;
}

function saveJournal(d) {
  const texto = S.journal?.[d]?.texto || '';
  if (texto.trim()) persist(db.set('journal', d, { data: d, texto, atualizadoEm: Date.now() }));
  else {
    delete S.journal[d];
    persist(db.remove('journal', d));
  }
  setStatus('[data-journal-status]', 'Salvo ✓');
  const list = $('#journal-list');
  if (list) list.innerHTML = journalListHTML();
}

// ---------------------------------------------------------------------------
// Importar e exportar (arquivo .json no formato "rotina-import"; o formato está no README)
// ---------------------------------------------------------------------------

const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();

const DIA_CODIGO = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIA_NOMES = {
  dom: 0, domingo: 0,
  seg: 1, segunda: 1, 'segunda-feira': 1,
  ter: 2, terca: 2, 'terca-feira': 2,
  qua: 3, quarta: 3, 'quarta-feira': 3,
  qui: 4, quinta: 4, 'quinta-feira': 4,
  sex: 5, sexta: 5, 'sexta-feira': 5,
  sab: 6, sabado: 6,
};

// Aceita [1,3,5], ["seg","qua"], "seg, qua, sex", "todos", "uteis", "fds". Retorna null se não entender.
function parseDias(v) {
  const list = Array.isArray(v) ? v : String(v ?? '').split(/[,;]+/);
  const out = new Set();
  for (const raw of list) {
    if (typeof raw === 'number') {
      if (raw >= 0 && raw <= 6) out.add(raw);
      else return null;
      continue;
    }
    const k = norm(raw);
    if (!k) continue;
    if (['todos', 'todos os dias', 'diario', 'diariamente'].includes(k)) [0, 1, 2, 3, 4, 5, 6].forEach((d) => out.add(d));
    else if (['uteis', 'dias uteis', 'seg-sex', 'seg a sex'].includes(k)) [1, 2, 3, 4, 5].forEach((d) => out.add(d));
    else if (['fds', 'fim de semana', 'fins de semana'].includes(k)) [0, 6].forEach((d) => out.add(d));
    else if (k in DIA_NOMES) out.add(DIA_NOMES[k]);
    else if (/^[0-6]$/.test(k)) out.add(Number(k));
    else return null;
  }
  return out.size ? [...out].sort() : null;
}

// "6:30", "06:30", "6h30", "18h" -> "06:30" / "18:00". Retorna null se não for um horário.
function parseHora(v) {
  if (v == null || v === '') return null;
  const m = String(v).trim().toLowerCase().match(/^(\d{1,2})\s*(?::|h)\s*(\d{2})?\s*$/) || String(v).trim().match(/^(\d{1,2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] || 0);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const isCor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim());
const numOuNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
const hashId = (s) => {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
};

// Lê o arquivo e monta o plano do que vai entrar, sem gravar nada ainda.
async function planImport(data) {
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data.trim().replace(/^```(?:json)?\s*|```\s*$/g, ''));
    } catch {
      throw new Error('O conteúdo não é um arquivo de importação válido (JSON).');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Arquivo de importação inválido.');

  const plan = { cats: [], clis: [], upd: [], recs: [], tasks: [], diario: [], avisos: [], erros: [] };
  const catMap = new Map(S.categories.map((c) => [norm(c.nome), c]));
  const cliMap = new Map(S.clients.map((c) => [norm(c.nome), c]));
  let ordem = S.categories.length ? Math.max(...S.categories.map((c) => c.ordem ?? 0)) + 1 : 0;

  const getCat = (nome, cor) => {
    if (!String(nome ?? '').trim()) return null;
    let c = catMap.get(norm(nome));
    if (!c) {
      c = { id: U.newId(), nome: String(nome).trim(), cor: isCor(cor) ? cor.trim() : PALETA[(S.categories.length + plan.cats.length) % PALETA.length], ordem: ordem++ };
      catMap.set(norm(nome), c);
      plan.cats.push(c);
    }
    return c;
  };
  const getCli = (nome, catNome, obs) => {
    if (!String(nome ?? '').trim()) return null;
    let c = cliMap.get(norm(nome));
    if (!c) {
      const cat = getCat(catNome || 'Trabalho');
      c = { id: U.newId(), nome: String(nome).trim(), categoriaId: cat.id, observacoes: String(obs ?? '').trim() };
      cliMap.set(norm(nome), c);
      plan.clis.push(c);
    }
    return c;
  };
  const aviso = (it) => ({
    aviso: it.aviso === false || norm(it.aviso) === 'nao' ? false : true,
    avisoAntes: numOuNull(it.avisoAntes ?? it.avisarAntes),
  });

  // Mudança num cadastro que já existe (lista, serviços, situação): vira um "update".
  const upd = (col, x, data, rotulo) => {
    const novo = plan.cats.includes(x) || plan.clis.includes(x);
    const mudou = Object.entries(data).filter(([k, v]) => JSON.stringify(x[k] ?? null) !== JSON.stringify(v));
    if (!mudou.length) return;
    const patch = Object.fromEntries(mudou);
    if (novo) return Object.assign(x, patch);
    const u = plan.upd.find((y) => y.id === x.id);
    if (u) Object.assign(u.data, patch);
    else plan.upd.push({ col, id: x.id, nome: x.nome, rotulo, data: patch });
  };
  const listaTxt = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;\n]+/) : []).map((x) => String(x).trim()).filter(Boolean);
  // Estado do cadastro já com o que está para mudar.
  const atual = (x) => ({ ...x, ...(plan.upd.find((y) => y.id === x.id)?.data || {}) });

  for (const c of Array.isArray(data.categorias) ? data.categorias : []) {
    const nome = typeof c === 'string' ? c : c?.nome;
    const cat = getCat(nome, c?.cor);
    if (!cat) { plan.erros.push('Categoria sem nome ignorada.'); continue; }
    const itens = listaTxt(c?.itens ?? c?.lista);
    const subs = listaTxt(c?.subtarefas);
    if (itens.length || subs.length) {
      const old = allItens(atual(cat));
      const novos = itens.filter((n) => !old.some((o) => norm(o.nome) === norm(n))).map((n) => ({ id: U.newId(), nome: n }));
      // Item que estava oculto e voltou na lista: aparece de novo.
      const lista = old.map((o) => (o.oculto && itens.some((n) => norm(n) === norm(o.nome)) ? { id: o.id, nome: o.nome } : o));
      const sub2 = [...subsOf(atual(cat))];
      subs.forEach((x) => sub2.some((y) => norm(y) === norm(x)) || sub2.push(x));
      upd('categories', cat, { itens: [...lista, ...novos], subtarefas: sub2 }, 'lista');
    }
  }
  for (const c of Array.isArray(data.clientes) ? data.clientes : []) {
    const nome = typeof c === 'string' ? c : c?.nome;
    const cli = getCli(nome, c?.categoria, c?.observacoes);
    if (!cli) { plan.erros.push('Cliente sem nome ignorado.'); continue; }
    if (typeof c !== 'object') continue;
    const d = {};
    const servs = listaTxt(c.servicos);
    if (servs.length) {
      const all = [...servicosOf(atual(cli))];
      servs.forEach((x) => all.some((y) => norm(y) === norm(x)) || all.push(x));
      d.servicos = all;
    }
    if (c.status != null) d.status = norm(c.status).startsWith('final') ? 'finalizado' : 'ativo';
    if (c.soFinanceiro != null) d.soFinanceiro = !!c.soFinanceiro;
    if (c.pedeNome != null) d.pedeNome = !!c.pedeNome;
    upd('clients', cli, d, 'cadastro');
  }
  // Itens das listas como vão ficar (para achar "item" na rotina e nas tarefas).
  const itensDe = (cat) => allItens(atual(cat));

  const recKeys = new Set();
  const recKey = (r) => [norm(r.titulo), r.categoriaId, r.clienteId || '', r.horario, r.repete === 'mes' ? `m${r.diaDoMes}` : (r.diasDaSemana || []).join(',')].join('|');
  S.recurring.forEach((r) => recKeys.add(recKey(r)));
  for (const it of Array.isArray(data.rotina) ? data.rotina : []) {
    const titulo = String(it?.titulo ?? '').trim();
    const rotulo = titulo || '(sem título)';
    if (!titulo) { plan.erros.push('Tarefa fixa sem título ignorada.'); continue; }
    const mensal = norm(it.repete) === 'mes' || it.diaDoMes != null;
    const diaDoMes = Math.round(Number(it.diaDoMes));
    if (mensal && !(diaDoMes >= 1 && diaDoMes <= 31)) { plan.erros.push(`“${rotulo}”: dia do mês inválido.`); continue; }
    const dias = mensal ? [] : parseDias(it.dias ?? it.diasDaSemana);
    if (!dias) { plan.erros.push(`“${rotulo}”: dias da semana não entendidos (${JSON.stringify(it.dias ?? '')}).`); continue; }
    const horario = parseHora(it.horario);
    if (!horario) { plan.erros.push(`“${rotulo}”: na rotina o horário é obrigatório.`); continue; }
    if (!it.categoria) plan.avisos.push(`“${rotulo}”: sem categoria, ficou em “Geral”.`);
    const cat = getCat(it.categoria || 'Geral');
    const cli = getCli(it.cliente, it.categoria);
    const item = it.item ? itensDe(cat).find((x) => norm(x.nome) === norm(it.item)) : null;
    if (it.item && !item) plan.avisos.push(`“${rotulo}”: “${it.item}” não está na lista de ${cat.nome}.`);
    const aberto = !!(it.semFim ?? it.fimAberto);
    const r = {
      id: U.newId(), titulo, categoriaId: cat.id, clienteId: cli?.id || null, itemId: item?.id || null,
      repete: mensal ? 'mes' : 'semana', diaDoMes: mensal ? diaDoMes : null, diasDaSemana: dias,
      horario, duracao: aberto ? null : numOuNull(it.duracao), fimAberto: aberto, ...aviso(it), ativo: true, inicio: U.todayStr(),
    };
    const k = recKey(r);
    r._duplicada = recKeys.has(k);
    recKeys.add(k);
    plan.recs.push(r);
  }

  for (const it of Array.isArray(data.tarefas) ? data.tarefas : []) {
    const titulo = String(it?.titulo ?? '').trim();
    if (!titulo) { plan.erros.push('Tarefa avulsa sem título ignorada.'); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it.data ?? ''))) { plan.erros.push(`“${titulo}”: data inválida (use AAAA-MM-DD).`); continue; }
    if (it.horario && !parseHora(it.horario)) plan.avisos.push(`“${titulo}”: horário não entendido, ficou sem horário.`);
    const cat = getCat(it.categoria || 'Geral');
    const cli = getCli(it.cliente, it.categoria);
    // id fixo: importar o mesmo arquivo de novo atualiza a tarefa em vez de duplicar.
    // Duas com o mesmo nome no mesmo dia (horários diferentes) ganham ids diferentes, para nenhuma sumir.
    let id = `imp_${hashId(`${it.data}|${norm(titulo)}|${cli?.id || ''}`)}`;
    if (plan.tasks.some((x) => x.id === id)) id = `imp_${hashId(`${it.data}|${norm(titulo)}|${cli?.id || ''}|${it.horario || ''}|${plan.tasks.length}`)}`;
    plan.tasks.push({
      id,
      titulo, data: it.data, categoriaId: cat.id, clienteId: cli?.id || null,
      itemId: (it.item && itensDe(cat).find((x) => norm(x.nome) === norm(it.item))?.id) || null,
      servico: cli ? String(it.servico ?? titulo).trim() : null,
      horario: parseHora(it.horario), duracao: numOuNull(it.duracao), ...aviso(it),
      notas: String(it.notas ?? ''), concluido: !!it.concluido, origem: 'avulsa', recurringTaskId: null, removido: false,
    });
  }

  const diario = Array.isArray(data.diario) ? data.diario : [];
  if (diario.length) {
    const atuais = Object.fromEntries((await db.list('journal')).map((j) => [j.id, j.texto || '']));
    for (const it of diario) {
      const texto = String(it?.texto ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(it?.data ?? '')) || !texto) { plan.erros.push('Entrada do diário sem data ou sem texto ignorada.'); continue; }
      const atual = atuais[it.data] || '';
      if (atual.includes(texto)) continue;
      plan.diario.push({ data: it.data, texto: atual.trim() ? `${atual.trimEnd()}\n\n${texto}` : texto });
    }
  }
  return plan;
}

let pendingImport = null;

function openImportPreview(plan) {
  pendingImport = plan;
  const novas = plan.recs.filter((r) => !r._duplicada);
  const dup = plan.recs.length - novas.length;
  const lista = (arr, fmt) => `<ul class="imp-list">${arr.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>`;
  const catNome = (id) => esc((catById(id) || plan.cats.find((c) => c.id === id))?.nome || '');
  const cliNome = (id) => esc((cliById(id) || plan.clis.find((c) => c.id === id))?.nome || '');
  const nada = !plan.cats.length && !plan.clis.length && !plan.upd.length && !plan.recs.length && !plan.tasks.length && !plan.diario.length;
  const porDia = U.ORDEM_SEMANA.map((d) => `${U.DIAS_CURTO[d]} ${plan.recs.filter((r) => r.diasDaSemana.includes(d)).length}`).join(' · ') +
    (plan.recs.some(isMensal) ? ` · Mensal ${plan.recs.filter(isMensal).length}` : '');
  const cliInfo = (c) => [c.status === 'finalizado' && 'finalizado', c.soFinanceiro && 'só financeiro', c.pedeNome && 'pede nome', servicosOf(c).join(', ')].filter(Boolean).join(' · ');

  openModal(`<div class="modal-body import-preview">
    ${modalHead('Importar')}
    ${nada ? '<p class="note">Não encontrei nada para importar neste arquivo.</p>' : ''}
    ${plan.cats.length ? `<section><h3>${plan.cats.length} categoria${plan.cats.length > 1 ? 's' : ''} nova${plan.cats.length > 1 ? 's' : ''}</h3>${lista(plan.cats, (c) => `<i class="dot" style="--c:${c.cor}"></i>${esc(c.nome)}`)}</section>` : ''}
    ${plan.clis.length ? `<section><h3>${plan.clis.length} cliente${plan.clis.length > 1 ? 's' : ''} novo${plan.clis.length > 1 ? 's' : ''}</h3>${lista(plan.clis, (c) => `${esc(c.nome)} <small class="muted">${esc(cliInfo(c)) || catNome(c.categoriaId)}</small>`)}</section>` : ''}
    ${plan.upd.length ? `<section><h3>${plan.upd.length} cadastro${plan.upd.length > 1 ? 's' : ''} atualizado${plan.upd.length > 1 ? 's' : ''}</h3>${lista(plan.upd, (u) => `${esc(u.nome)} <small class="muted">${esc(u.col === 'clients' ? cliInfo({ ...cliById(u.id), ...u.data }) : itensOf({ ...catById(u.id), ...u.data }).map((i) => i.nome).join(', '))}</small>`)}</section>` : ''}
    ${
      plan.recs.length
        ? `<section><h3>${plan.recs.length} tarefa${plan.recs.length > 1 ? 's' : ''} da rotina</h3>
        <p class="muted sm">${porDia}</p>
        ${lista(
          [...plan.recs].sort(U.byHorarioTitulo),
          (r) => `<span class="imp-time">${r.horario}</span>${esc(r.titulo)} <small class="muted">${catNome(r.categoriaId)}${r.clienteId ? ` · ${cliNome(r.clienteId)}` : ''}${r.fimAberto ? ' · sem hora de fim' : ''}</small> ${isMensal(r) ? `<span class="chip month-chip">Todo dia ${r.diaDoMes}</span>` : dayDots(r.diasDaSemana, 'sm')}${r._duplicada ? ' <small class="muted">(já existe)</small>' : ''}`,
        )}</section>`
        : ''
    }
    ${plan.tasks.length ? `<section><h3>${plan.tasks.length} tarefa${plan.tasks.length > 1 ? 's' : ''} avulsa${plan.tasks.length > 1 ? 's' : ''}</h3>${lista([...plan.tasks].sort((a, b) => a.data.localeCompare(b.data)), (t) => `<span class="imp-time">${esc(U.fmtDiaCurto(t.data))}</span>${esc(t.titulo)}`)}</section>` : ''}
    ${plan.diario.length ? `<section><h3>${plan.diario.length} dia${plan.diario.length > 1 ? 's' : ''} de diário</h3></section>` : ''}
    ${plan.avisos.length ? `<section class="imp-warn"><h3>Observações</h3>${lista(plan.avisos, esc)}</section>` : ''}
    ${plan.erros.length ? `<section class="imp-err"><h3>Ignorados</h3>${lista(plan.erros, esc)}</section>` : ''}
    ${
      plan.recs.length && S.recurring.length
        ? `<label class="switch-row imp-replace"><input type="checkbox" data-import-replace><span class="switch" aria-hidden="true"></span>
        <span>Substituir minha rotina semanal atual <small class="muted">(remove as ${S.recurring.length} tarefas fixas de hoje em diante; o histórico fica)</small></span></label>
        ${dup ? `<p class="hint">${dup} tarefa${dup > 1 ? 's' : ''} igua${dup > 1 ? 'is' : 'l'} às que você já tem ${dup > 1 ? 'serão puladas' : 'será pulada'}, a não ser que você substitua a rotina.</p>` : ''}`
        : ''
    }
    <footer class="modal-actions"><span class="grow"></span>
      <button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>
      ${nada ? '' : `<button type="button" class="btn primary" data-action="import-confirm">${icon('check')}Importar</button>`}
    </footer>
  </div>`);
}

async function applyImport(plan, substituir) {
  const today = U.todayStr();
  const ops = [];
  const set = (col, x) => {
    const { _duplicada, ...data } = x;
    ops.push({ type: 'set', col, id: x.id, data });
  };

  if (substituir) {
    // Mesma regra de excluir uma tarefa fixa: some dos próximos dias, o passado e o concluído ficam.
    const futuras = await db.range('dailyTasks', 'data', today, '9999-12-31');
    futuras.filter((t) => t.origem === 'fixa' && !temRegistro(t)).forEach((t) => ops.push({ type: 'delete', col: 'dailyTasks', id: t.id }));
    S.recurring.forEach((r) => ops.push({ type: 'delete', col: 'recurringTasks', id: r.id }));
    S.recurring = [];
  }
  const recs = plan.recs.filter((r) => substituir || !r._duplicada);

  plan.cats.forEach((c) => set('categories', c));
  plan.clis.forEach((c) => set('clients', c));
  plan.upd.forEach((u) => {
    ops.push({ type: 'update', col: u.col, id: u.id, data: u.data });
    Object.assign((u.col === 'clients' ? cliById : catById)(u.id) || {}, u.data);
  });
  recs.forEach((r) => set('recurringTasks', r));
  // Junta (merge) com a tarefa que já existir: o tempo, as sessões e o que já foi concluído no app não se perdem.
  plan.tasks.forEach(({ concluido, removido, notas, ...t }) =>
    ops.push({ type: 'merge', col: 'dailyTasks', id: t.id, data: { ...t, ...(concluido ? { concluido } : {}), ...(notas ? { notas } : {}) } }));
  plan.diario.forEach((j) => ops.push({ type: 'set', col: 'journal', id: j.data, data: { data: j.data, texto: j.texto, atualizadoEm: Date.now() } }));

  S.categories.push(...plan.cats);
  sortCats();
  S.clients.push(...plan.clis);
  S.recurring.push(...recs.map(({ _duplicada, ...r }) => r));
  S.days = {};
  S.ensured = new Set();
  S.ranges = new Set();
  S.journal = null;
  persist(db.batch(ops));

  const partes = [
    plan.cats.length && `${plan.cats.length} categoria(s)`,
    plan.clis.length && `${plan.clis.length} cliente(s)`,
    plan.upd.length && `${plan.upd.length} cadastro(s) atualizado(s)`,
    recs.length && `${recs.length} tarefa(s) da rotina`,
    plan.tasks.length && `${plan.tasks.length} tarefa(s) avulsa(s)`,
    plan.diario.length && `${plan.diario.length} dia(s) de diário`,
  ].filter(Boolean);
  closeModal();
  toast(partes.length ? `Importado: ${partes.join(', ')}.` : 'Nada novo para importar.');
  location.hash = recs.length ? '#/rotina' : '#/calendario';
  render();
}

// Backup de tudo, no mesmo formato da importação (mais o histórico, que serve só para guardar).
async function exportData() {
  const [tarefas, diario] = await Promise.all([db.list('dailyTasks'), db.list('journal')]);
  const catNome = (id) => catById(id)?.nome || null;
  const cliNome = (id) => cliById(id)?.nome || null;
  const limpa = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== ''));
  const data = {
    formato: 'rotina-import',
    versao: 1,
    exportadoEm: new Date().toISOString(),
    categorias: S.categories.map((c) =>
      limpa({ nome: c.nome, cor: c.cor, itens: itensOf(c).length ? itensOf(c).map((i) => i.nome) : null, subtarefas: subsOf(c).length ? subsOf(c) : null }),
    ),
    clientes: S.clients.map((c) =>
      limpa({
        nome: c.nome, categoria: catNome(c.categoriaId), observacoes: c.observacoes, servicos: servicosOf(c).length ? servicosOf(c) : null,
        status: isAtivo(c) ? null : 'finalizado', soFinanceiro: c.soFinanceiro || null, pedeNome: c.pedeNome || null,
      }),
    ),
    rotina: [...S.recurring].sort(U.byHorarioTitulo).map((r) =>
      limpa({
        titulo: r.titulo, categoria: catNome(r.categoriaId), cliente: cliNome(r.clienteId), item: itemOf(r)?.nome,
        dias: isMensal(r) ? null : (r.diasDaSemana || []).map((d) => DIA_CODIGO[d]),
        repete: isMensal(r) ? 'mes' : null, diaDoMes: isMensal(r) ? r.diaDoMes : null,
        horario: r.horario, duracao: r.duracao, semFim: r.fimAberto || null,
        aviso: r.aviso === false ? false : undefined, avisoAntes: r.avisoAntes,
      }),
    ),
    tarefas: tarefas
      .filter((t) => t.origem !== 'fixa' && !t.removido)
      .sort((a, b) => a.data.localeCompare(b.data))
      .map((t) => limpa({ titulo: t.titulo, data: t.data, categoria: catNome(t.categoriaId), cliente: cliNome(t.clienteId), item: itemOf(t)?.nome, servico: t.servico, horario: t.horario, duracao: t.duracao, notas: t.notas, concluido: t.concluido || undefined })),
    financas: finOK() ? await FIN.backup() : undefined,
    diario: diario.filter((j) => j.texto?.trim()).sort((a, b) => a.id.localeCompare(b.id)).map((j) => ({ data: j.id, texto: j.texto })),
    historico: tarefas
      .filter((t) => !t.removido && (t.concluido || t.tempoGasto || t.notas?.trim() || t.sessoes?.length))
      .sort((a, b) => a.data.localeCompare(b.data))
      .map((t) =>
        limpa({
          data: t.data, titulo: t.titulo, categoria: catNome(t.categoriaId), cliente: cliNome(t.clienteId), item: itemOf(t)?.nome, servico: t.servico, pessoa: t.pessoa,
          concluido: t.concluido || undefined, minutos: t.tempoGasto ? Math.round(t.tempoGasto / 60) : undefined, notas: t.notas,
          sessoes: t.sessoes?.length ? t.sessoes.map((x) => limpa({ inicio: x.i ? new Date(x.i).toISOString() : null, fim: x.f ? new Date(x.f).toISOString() : null, obs: x.obs })) : undefined,
        }),
      ),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `rotina-backup-${U.todayStr()}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Backup baixado.');
}

function importCard() {
  return `<section class="card">
    <h2 class="card-title">${icon('download')}Importar e exportar</h2>
    <p class="muted sm">Importe uma rotina pronta (o arquivo que o Claude monta para você) ou baixe um backup de tudo.</p>
    <div class="btn-row">
      <label class="btn primary">${icon('plus')}Importar arquivo<input type="file" accept=".json,.txt,application/json,text/plain" data-import-file hidden></label>
      <button type="button" class="btn ghost" data-action="export">${icon('download')}Baixar backup</button>
    </div>
    <details class="imp-paste">
      <summary>Ou cole o conteúdo aqui</summary>
      <textarea rows="6" data-import-text placeholder='{ "formato": "rotina-import", ... }' spellcheck="false"></textarea>
      <button type="button" class="btn soft sm" data-action="import-text">Ver o que será importado</button>
    </details>
  </section>`;
}

async function startImport(content) {
  try {
    // Arquivo de finanças (histórico do Notion): vai para a aba Finanças.
    let json = null;
    try {
      json = typeof content === 'string' ? JSON.parse(content) : content;
    } catch {}
    if (json?.formato === 'financas-import') {
      if (!finOK()) return toast('As finanças não estão liberadas nesta conta.');
      return await FIN.importar(json);
    }
    openImportPreview(await planImport(content));
  } catch (err) {
    console.error(err);
    toast(err.message || errMsg(err));
  }
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
  <header class="page-head"><div><p class="eyebrow">Administração · ${agoraHTML()}</p><h1>Acessos</h1></div></header>
  <p class="muted intro">Só os e-mails desta lista conseguem entrar no app. Cada pessoa usa o app inteiro (rotina, clientes, cursos, finanças, relatórios...), começando do zero e vendo apenas os próprios dados. Esta lista fica guardada no Firebase e não aparece no GitHub.</p>
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
        if (fechada(t) || !avisoAtivo(t)) continue;
        const antes = avisoMin(t);
        const fire = U.toMin(t.horario) - antes;
        if (now >= fire && now - fire <= 2) due.push({ key: `${today}_${t.id}_tarefa`, tipo: 'tarefa', ...textoTarefa(t, antes) });
      }
    }
    const pend = tasks.filter((t) => !fechada(t));
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
  calendario: viewCalendario,
  rotina: viewRotina,
  clientes: viewClientes,
  relatorios: viewRelatorios,
  categorias: viewCategorias,
  ajustes: viewAjustes,
  acessos: viewAcessos,
  diario: viewDiario,
  financas: () => FIN.view(),
  aniversarios: () => EXTRAS.view(),
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

// Clientes finalizados e "só financeiro" ficam fora da lista (a não ser o que já está escolhido).
const clientOptions = (catId, sel, obrig = false) =>
  `<option value="">${obrig ? 'Escolha o cliente' : 'Nenhum'}</option>` +
  clientsOf(catId)
    .filter((c) => c.id === sel || (isAtivo(c) && !c.soFinanceiro))
    .map((c) => `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>${esc(c.nome)}${isAtivo(c) ? '' : ' (finalizado)'}</option>`)
    .join('');

const itemOptions = (catId, sel, obrig = false) => {
  const k = catById(catId);
  const list = allItens(k).filter((i) => !i.oculto || i.id === sel);
  return `<option value="">${obrig ? 'Escolha' : 'Escolher na hora'}</option>${list.map((i) => `<option value="${i.id}" ${i.id === sel ? 'selected' : ''}>${esc(i.nome)}</option>`).join('')}`;
};

// obrig: tarefa do dia (cliente e "qual" obrigatórios). Na rotina fixa continuam opcionais (pergunta ao concluir).
function catClientFields(catId, cliId, itemId, obrig = false) {
  const temLista = itensOf(catById(catId)).length > 0;
  const itemField = `<label class="field" data-item-field ${temLista ? '' : 'hidden'}><span>Qual${obrig ? '' : ' <em>opcional</em>'}</span>
      <select name="itemId">${itemOptions(catId, itemId, obrig)}</select></label>`;
  return catClientFieldsBase(catId, cliId, obrig) + itemField;
}

function catClientFieldsBase(catId, cliId, obrig = false) {
  if (!S.categories.length) return `<p class="note">Crie uma <a href="#/categorias">categoria</a> primeiro.</p>`;
  return `<div class="row2">
    <label class="field"><span>Categoria</span>
      <select name="categoriaId" data-cat-select required>${S.categories
        .map((c) => `<option value="${c.id}" ${c.id === catId ? 'selected' : ''}>${esc(c.nome)}</option>`)
        .join('')}</select></label>
    <label class="field" data-client-field ${isWork(catId) ? '' : 'hidden'}><span>Cliente${obrig ? '' : ' <em>opcional</em>'}</span>
      <select name="clienteId">${clientOptions(catId, cliId, obrig)}</select>
      ${S.clients.length ? '' : '<small class="hint">Nenhum cliente ainda. Cadastre em <a href="#/clientes">Clientes</a>.</small>'}</label>
  </div>`;
}

const durLabel = (d) => (d < 60 ? `${d} min` : `${Math.floor(d / 60)}h${d % 60 ? ` ${d % 60}min` : ''}`);

// Hora que termina (no lugar de escolher a duração). A duração aparece embaixo, calculada.
const fimDe = (t) => (t.horario && !t.fimAberto ? U.fromMin(U.toMin(t.horario) + (t.duracao || S.profile.duracaoPadrao || 30)) : '');
const fimField = (t) =>
  `<label class="field"><span>Termina</span><input type="time" name="fim" value="${fimDe(t)}" data-fim ${t.fimAberto ? 'disabled' : ''}></label>`;
const durInfo = (t) =>
  `<p class="hint dur-info" data-dur-info>${durTexto(t.fimAberto ? null : t.duracao || (t.horario ? S.profile.duracaoPadrao || 30 : null), t.fimAberto)}</p>`;
function durTexto(min, aberto) {
  if (aberto) return 'Sem hora de fim: termina quando terminar.';
  return min ? `Duração: <b>${durLabel(min)}</b>` : 'Coloque a hora que começa e a que termina.';
}
// Minutos entre o começo e o fim do formulário (passa da meia-noite se o fim for menor).
function durDoForm(form) {
  const ini = U.toMin(form.elements.horario?.value);
  let fim = U.toMin(form.elements.fim?.value);
  if (ini == null || fim == null) return null;
  if (fim <= ini) fim += 1440;
  return fim - ini;
}
function atualizaDur(form) {
  const info = form.querySelector('[data-dur-info]');
  const aberto = !!form.elements.semFim?.checked;
  if (info) info.innerHTML = durTexto(aberto ? null : durDoForm(form), aberto);
}

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
  // Tarefa já feita ou com cronômetro: o formulário mostra o horário em que ela foi feita (ou começou), não o planejado.
  // Aí mudar o Início não arrasta o fim junto: o fim continua sendo quando terminou.
  const sp = t.id && (t.concluido || (t.sessoes || []).some((x) => x.i)) ? spanOf(t, true) : null;
  const real = !!(sp?.real && sp.s >= 0 && sp.s < 1440);
  const run = isRunning(t);
  if (real) t = { ...t, horario: U.fromMin(sp.s), duracao: Math.max(1, sp.e - sp.s), fimAberto: false };
  const editing = !!t.id;
  const fixa = editing && t.origem === 'fixa';
  const catId = t.categoriaId || (t.clienteId ? workCatId() : '') || defaultCat(false);
  const fim0 = real ? fimDe(t) : '';
  const gasto = Math.round(elapsed(t) / 60);
  const pausas = real && !run && t.duracao - gasto > 1;
  const camposHora = real
    ? `<label class="field"><span>Dia</span><input type="date" name="data" required value="${t.data}" ${fixa ? 'disabled' : ''}></label>
    <div class="fin3">
      <label class="field"><span>Início</span><input type="time" name="horario" required value="${t.horario}" data-horario></label>
      <label class="field"><span>Tempo gasto <em>min</em></span><input type="number" name="tempoMin" min="0" max="1440" step="1" inputmode="numeric" value="${gasto}" data-orig="${gasto}" data-tempo></label>
      <label class="field"><span>Término</span><input type="time" name="fim" value="${fim0}" data-fim></label>
    </div>
    <p class="hint">${
      run
        ? 'O cronômetro continua rodando. Término depois de agora: até quando vai o bloco. Término antes de agora ou tempo gasto mudado: para nessa hora.'
        : `${pausas ? `Com pausas: ${U.fmtDur(t.duracao * 60)} do começo ao fim, ${U.fmtDur(gasto * 60)} de tempo gasto. ` : ''}Mudar o tempo gasto muda o término, e o contrário também. Ao salvar, fica um registro só: do início ao término.`
    }</p>
    <div hidden>${avisoFields(t)}</div>`
    : `<div class="row2">
      <label class="field"><span>Dia</span><input type="date" name="data" required value="${t.data}" ${fixa ? 'disabled' : ''}></label>
      <label class="field"><span>Horário <em>opcional</em></span><input type="time" name="horario" value="${t.horario || ''}" data-horario></label>
    </div>
    <div data-aviso-group ${t.horario ? '' : 'hidden'}>
      ${fimField(t)}
      ${durInfo(t)}
      ${avisoFields(t)}
    </div>
    ${
      editing
        ? `<label class="field"><span>${icon('cronometro')}Tempo gasto <em>(minutos, para corrigir o cronômetro)</em></span>
      <input type="number" name="tempoMin" min="0" max="1440" step="1" inputmode="numeric" value="${gasto}" data-orig="${gasto}"></label>`
        : ''
    }`;
  openModal(`<form class="modal-body" data-form="daily" data-id="${t.id || ''}" data-old-date="${t.data}" data-dur="${t.duracao || ''}"${real ? ` data-real="1" data-ini0="${t.horario}" data-dur0="${t.duracao}" data-fim0="${fim0}"${run ? ' data-run="1"' : ''}` : ''}>
    ${modalHead(editing ? 'Editar tarefa' : 'Nova tarefa')}
    ${fixa ? '<p class="note">Esta tarefa veio da rotina. Mudanças aqui valem só para este dia.</p>' : ''}
    <label class="field"><span data-titulo-lbl>${isWork(catId) ? 'Serviço' : 'Título'}</span>
      <input name="titulo" required maxlength="120" autocomplete="off" value="${esc(t.titulo || '')}" list="dl-serv" autofocus>
      <datalist id="dl-serv"></datalist></label>
    ${catClientFields(catId, t.clienteId, t.itemId, true)}
    <label class="field" data-pessoa-field hidden><span>Nome da pessoa</span>
      <input name="pessoa" maxlength="80" autocomplete="off" value="${esc(t.pessoa || '')}" list="dl-pessoas2">
      <datalist id="dl-pessoas2"></datalist></label>
    ${camposHora}
    ${modalFoot(editing ? 'remove-daily' : '', t.id)}
  </form>`);
  if (editing) modal.querySelector('[data-action="remove-daily"]').dataset.date = t.data;
  servicosList(modal.querySelector('form'));
}

// Título da tarefa sugere os serviços do cliente escolhido (ou as tarefas da lista); cliente que pede nome mostra o campo.
function servicosList(form) {
  const dl = form?.querySelector('#dl-serv');
  if (!dl) return;
  const cat = catById(form.elements.categoriaId?.value);
  const c = isWork(cat?.id) ? cliById(form.elements.clienteId?.value) : null;
  const sugest = c ? servicosOf(c) : subsOf(cat);
  dl.innerHTML = sugest.map((x) => `<option value="${esc(x)}">`).join('');
  const pf = form.querySelector('[data-pessoa-field]');
  if (pf) {
    pf.hidden = !c?.pedeNome;
    pf.querySelector('datalist').innerHTML = (c?.pessoas || []).map((x) => `<option value="${esc(x)}">`).join('');
  }
}

function openRecForm(r) {
  const editing = !!r.id;
  const dias = r.diasDaSemana || [1, 2, 3, 4, 5];
  const catId = r.categoriaId || defaultCat(!!r.clienteId);
  const mensal = isMensal(r);
  openModal(`<form class="modal-body" data-form="rec" data-id="${r.id || ''}" data-dur="${r.duracao || ''}">
    ${modalHead(editing ? 'Editar tarefa fixa' : 'Nova tarefa fixa')}
    <label class="field"><span>Título</span>
      <input name="titulo" required maxlength="120" autocomplete="off" value="${esc(r.titulo || '')}" autofocus></label>
    ${catClientFields(catId, r.clienteId, r.itemId)}
    <fieldset class="field">
      <legend>Repete</legend>
      <div class="seg">
        <label class="seg-opt"><input type="radio" name="repete" value="semana" data-repete ${mensal ? '' : 'checked'}><span>Dias da semana</span></label>
        <label class="seg-opt"><input type="radio" name="repete" value="mes" data-repete ${mensal ? 'checked' : ''}><span>Todo mês</span></label>
      </div>
    </fieldset>
    <label class="field" data-rep-mes ${mensal ? '' : 'hidden'}><span>Dia do mês</span>
      <input type="number" name="diaDoMes" min="1" max="31" inputmode="numeric" value="${r.diaDoMes || Number(U.todayStr().slice(8))}">
      <small class="hint">Em mês mais curto (ex.: dia 31 em abril), cai no último dia.</small></label>
    <fieldset class="field" data-rep-semana ${mensal ? 'hidden' : ''}>
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
      <label class="field"><span>Começa</span><input type="time" name="horario" required value="${r.horario || ''}" data-horario></label>
      ${fimField(r)}
    </div>
    ${durInfo(r)}
    <label class="switch-row sem-fim"><input type="checkbox" name="semFim" data-sem-fim ${r.fimAberto ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
      <span>Sem hora de fim <small class="muted">(ex.: igreja, termina quando termina)</small></span></label>
    ${avisoFields(r)}
    <p class="hint">O horário organiza a agenda do dia e os avisos. Você pode concluir a tarefa a qualquer hora do dia.</p>
    ${modalFoot(editing ? 'delete-rec' : '', r.id)}
  </form>`);
}

function openClientForm(c) {
  const editing = !!c.id;
  openModal(`<form class="modal-body" data-form="client" data-id="${c.id || ''}">
    ${modalHead(editing ? 'Editar cliente' : 'Novo cliente')}
    <label class="field"><span>Nome</span><input name="nome" required maxlength="80" autocomplete="off" value="${esc(c.nome || '')}" autofocus></label>
    <fieldset class="field"><legend>Situação</legend>
      <div class="seg">
        <label class="seg-opt"><input type="radio" name="status" value="ativo" ${isAtivo(c) ? 'checked' : ''}><span>Ativo</span></label>
        <label class="seg-opt"><input type="radio" name="status" value="finalizado" ${isAtivo(c) ? '' : 'checked'}><span>Finalizado</span></label>
      </div>
      <small class="hint">Finalizado sai das listas, mas continua no histórico e pode voltar.</small>
    </fieldset>
    <label class="field"><span>Serviços <em>um por linha</em></span>
      <textarea name="servicos" rows="3" maxlength="800" placeholder="Edição de vídeo&#10;Contas">${esc(servicosOf(c).join('\n'))}</textarea>
      <small class="hint">Aparecem ao apertar ▶ neste cliente. Dá para criar outro na hora.</small></label>
    <div class="setting-rows">
      <label class="switch-row"><input type="checkbox" name="soFinanceiro" ${c.soFinanceiro ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
        <span>Só financeiro <small class="muted">(não aparece no ▶, só no dinheiro)</small></span></label>
      <label class="switch-row"><input type="checkbox" name="pedeNome" ${c.pedeNome ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
        <span>Pedir o nome da pessoa ao iniciar <small class="muted">(ex.: Fotografia)</small></span></label>
    </div>
    <label class="field"><span>Observações <em>opcional</em></span><textarea name="observacoes" rows="2" maxlength="500">${esc(c.observacoes || '')}</textarea></label>
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
    ${
      editing && isWork(c.id)
        ? '<p class="hint">Esta é a categoria dos clientes: os serviços ficam em cada cliente.</p>'
        : `<label class="field"><span>Lista <em>opcional, um por linha</em></span>
      <textarea name="itens" rows="3" maxlength="800" placeholder="Inglês&#10;Fotografia&#10;Instagram">${esc(itensOf(c).map((i) => i.nome).join('\n'))}</textarea>
      <small class="hint">Ex.: em Cursos, cada curso. Ao apertar ▶ você escolhe qual, e os relatórios mostram o tempo de cada um.</small></label>
    <label class="field"><span>Tarefas da lista <em>opcional, um por linha</em></span>
      <textarea name="subtarefas" rows="2" maxlength="400" placeholder="Estudar&#10;Praticar">${esc(subsOf(c).join('\n'))}</textarea>
      <small class="hint">Perguntadas ao iniciar (dá para pular com “Só iniciar”).</small></label>`
    }
    ${modalFoot(editing ? 'delete-cat' : '', c.id)}
  </form>`);
}

// ---------------------------------------------------------------------------
// Encaixe: tarefa nova num horário já ocupado (ex.: cortar o cabelo no meio do Trabalho).
// As outras tarefas daquele dia se ajustam; a rotina dos outros dias fica igual.
// ---------------------------------------------------------------------------

const faixa = (ini, fim) => `${U.fromMin(ini)}–${U.fromMin(fim)}`;

function planoEncaixe(nova, dia) {
  const s = U.toMin(nova.horario);
  if (s == null || !nova.duracao) return [];
  const e = s + nova.duracao;
  const plano = [];
  for (const o of visible(dia)) {
    // Concluída, rodando, com cronômetro, sem hora de fim (igreja) ou já mantida lado a lado não se mexe.
    if (o.id === nova.id || o.concluido || !o.horario || o.fimAberto || isRunning(o) || o.manter || (o.sessoes || []).some((x) => x.i)) continue;
    const os = U.toMin(o.horario);
    const oe = os + duracao(o);
    if (oe <= s || os >= e) continue;
    if (s <= os && e >= oe) plano.push({ o, tipo: 'tira', txt: `${nomeTxt(o)} (${faixa(os, oe)}) some deste dia` });
    else if (s <= os) plano.push({ o, tipo: 'muda', ini: e, fim: oe, txt: `${nomeTxt(o)} fica só ${faixa(e, oe)}` });
    else if (e >= oe) plano.push({ o, tipo: 'muda', ini: os, fim: s, txt: `${nomeTxt(o)} fica só ${faixa(os, s)}` });
    else plano.push({ o, tipo: 'divide', ini: os, fim: s, ini2: e, fim2: oe, txt: `${nomeTxt(o)} fica ${faixa(os, s)} e ${faixa(e, oe)}` });
  }
  return plano;
}

// Resposta: 'sob' (sobrescrever), 'manter' (as duas lado a lado) ou null (fechou sem escolher).
function perguntaEncaixe(nova, plano) {
  const s = U.toMin(nova.horario);
  return new Promise((resolve) => {
    openModal(`<div class="modal-body confirm">
      <p><b>${esc(nova.nome || nomeTxt(nova))}</b> (${faixa(s, s + nova.duracao)}) cai no horário de outra tarefa. O que fazer?</p>
      <p class="muted sm">Se sobrescrever:</p>
      <ul class="encaixe-lista">${plano.map((p) => `<li>${esc(p.txt)}</li>`).join('')}</ul>
      <p class="hint">Sobrescrever: a outra some nesse horário e não conta como não feita. Manter as duas: ficam lado a lado. Vale só para este dia.</p>
      <footer class="modal-actions"><span class="grow"></span>
        <button type="button" class="btn ghost" data-action="ask-manter">Manter as duas</button>
        <button type="button" class="btn primary" data-action="ask-yes" autofocus>Sobrescrever</button>
      </footer></div>`);
    askResolver = (v) => resolve(v === true ? 'sob' : v === 'manter' ? 'manter' : null);
  });
}

// Confere o dia e, se a tarefa cair em cima de outra, pergunta. Devolve true se perguntou.
async function resolveEncaixe(nova, date, antes = null) {
  const dia = await ensureDay(date).catch(() => null);
  if (!dia) return false;
  if (nova.data && !dia.some((x) => x.id === nova.id)) dia.push(nova);
  // O que já se cruzava com o horário planejado continua como estava (não pergunta de novo).
  const plano = planoEncaixe(nova, dia).filter((p) => {
    if (!antes) return true;
    const os = U.toMin(p.o.horario);
    return !(os < antes.e && os + duracao(p.o) > antes.s);
  });
  if (!plano.length) return false;
  const r = await perguntaEncaixe(nova, plano);
  if (r === 'sob') {
    aplicaEncaixe(plano, date);
    toast('Sobrescrito: a outra tarefa saiu desse horário.');
  } else if (r === 'manter') {
    const ops = plano.map((p) => {
      p.o.manter = true;
      return { type: 'update', col: 'dailyTasks', id: p.o.id, data: { manter: true } };
    });
    persist(db.batch(ops));
  }
  render();
  return true;
}

// Bloco da rotina ainda intocado, da mesma categoria e sem cliente/curso (ou com o mesmo) da tarefa t.
const blocoLivre = (b, t) =>
  b !== t && !b.removido && !fechada(b) && !isRunning(b) && !elapsed(b) && !(b.sessoes || []).some((x) => x.i) &&
  b.origem === 'fixa' && b.horario && !b.fimAberto && b.categoriaId === t.categoriaId &&
  (!b.clienteId || b.clienteId === t.clienteId) && (!b.itemId || b.itemId === t.itemId) && tituloGenerico(b);
// Bloco "genérico": sem título próprio (vazio, o nome da categoria, do cliente ou do item). "Responder e-mails" não é.
function tituloGenerico(b) {
  const n = norm((b.titulo || '').trim());
  return !n || n === 'trabalho' || [catById(b.categoriaId)?.nome, cliById(b.clienteId)?.nome, itemOf(b)?.nome].some((x) => x && norm(x) === n);
}

// Depois de concluir com horário: o bloco da rotina da mesma categoria que cai no horário feito some
// (ex.: trabalhou 7h30–15h, o bloco "Trabalho 13h–17h30" não fica sobrando 15h–17h30; vira pausa).
// Depois, se cair em cima de outra tarefa, pergunta: sobrescrever ou manter as duas.
// Horário planejado da tarefa (antes de virar o horário feito).
const planoDe = (t) => {
  const s = t.horario && !t.fimAberto ? U.toMin(t.horario) : null;
  return s == null ? null : { s, e: s + duracao(t) };
};
async function depoisDeFeito(t, antes = null) {
  const sp = spanOf(t);
  const dia = S.days[t.data];
  if (!sp?.real || sp.s < 0 || sp.s >= 1440 || !dia) return;
  const ops = [];
  for (const b of visible(dia)) {
    if (!blocoLivre(b, t)) continue;
    const bs = U.toMin(b.horario);
    if (bs + duracao(b) <= sp.s || bs >= sp.e) continue;
    b.removido = true;
    b.absorvidoPor = t.id;
    ops.push({ type: 'update', col: 'dailyTasks', id: b.id, data: { removido: true, absorvidoPor: t.id } });
  }
  if (ops.length) {
    persist(db.batch(ops));
    render();
  }
  const nome = nomeTxt(t);
  await resolveEncaixe({ id: t.id, nome, titulo: t.titulo, categoriaId: t.categoriaId, horario: U.fromMin(sp.s), duracao: Math.min(1440, sp.e) - sp.s }, t.data, antes);
  // Virou a madrugada: o pedaço depois da meia-noite também confere as tarefas dos dias seguintes.
  for (let k = 1; k <= 3 && sp.e > 1440 * k; k++) {
    await resolveEncaixe({ id: t.id, nome, titulo: t.titulo, categoriaId: t.categoriaId, horario: '00:00', duracao: Math.min(1440, sp.e - 1440 * k) }, U.addDays(t.data, k));
  }
}

// Registra que a tarefa foi feita de i até f (ms) e conclui.
function feitoEntre(t, i, f, ops = []) {
  const antes = t.cronometroInicio || (t.sessoes || []).some((x) => x.i) ? null : planoDe(t);
  if (isRunning(t)) stopTimer(t, ops);
  t.sessoes = [...(t.sessoes || []).filter((x) => x.i), { i, f, manual: true }];
  t.tempoGasto = Math.round((t.tempoGasto || 0) + (f - i) / 1000);
  const extra = { sessoes: t.sessoes, tempoGasto: t.tempoGasto, cronometroInicio: null };
  const sp = spanOf(t);
  if (sp && sp.s >= 0 && sp.s < 1440) {
    Object.assign(extra, { horario: U.fromMin(sp.s), duracao: Math.max(1, sp.e - sp.s), fimAberto: false });
    if (t.origem === 'fixa') extra.ajustado = true;
  }
  closeModal();
  setDone(t, true, extra, ops);
  toast(`Concluída: ${spanTxt(spanOf(t))} · ${U.fmtDur(elapsed(t))}.`);
  depoisDeFeito(t, antes);
}

function aplicaEncaixe(plano, date) {
  const ops = [];
  for (const p of plano) {
    const o = p.o;
    if (p.tipo === 'tira') {
      // Some do dia (dá para restaurar no Calendário). Não conta como não feita.
      o.removido = true;
      ops.push({ type: 'update', col: 'dailyTasks', id: o.id, data: { removido: true } });
      continue;
    }
    // "ajustado": se a rotina for editada depois, o horário deste dia não volta ao da rotina.
    const patch = { horario: U.fromMin(p.ini), duracao: p.fim - p.ini, ajustado: true };
    Object.assign(o, patch);
    ops.push({ type: 'update', col: 'dailyTasks', id: o.id, data: patch });
    if (p.tipo === 'divide') {
      const c = {
        id: U.newId(), titulo: o.titulo, categoriaId: o.categoriaId || null, clienteId: o.clienteId || null, itemId: o.itemId || null,
        servico: o.servico || null, pessoa: o.pessoa || null, aviso: o.aviso ?? null, avisoAntes: o.avisoAntes ?? null,
        data: date, horario: U.fromMin(p.ini2), duracao: p.fim2 - p.ini2, fimAberto: false,
        concluido: false, origem: 'avulsa', recurringTaskId: null, removido: false, ajustado: true,
      };
      S.days[date].push(c);
      ops.push({ type: 'set', col: 'dailyTasks', id: c.id, data: c });
    }
  }
  persist(db.batch(ops));
}

const formData = (form) => Object.fromEntries(new FormData(form));
// Texto "um por linha" → lista sem vazios nem repetidos.
const linhas = (txt) => {
  const out = [];
  for (const l of String(txt || '').split('\n')) {
    const v = l.trim().slice(0, 60);
    if (v && !out.some((o) => norm(o) === norm(v))) out.push(v);
  }
  return out.slice(0, 40);
};
const avisoData = (f) => ({ aviso: f.aviso === 'on', avisoAntes: Number(f.avisoAntes) || 0 });

// Liga o cronômetro (da tarefa ou de uma nova) a partir de ini (ms; null = agora).
function iniciaDe(p, ini) {
  const t = p.taskId ? findTask(p.taskId, p.date) : null;
  if (p.taskId) {
    if (!t) return closeModal();
    const ops = [];
    if (S.pedirConclusao === t.id) S.pedirConclusao = null;
    startTimer(t, ops, ini || Date.now());
    closeModal();
    render();
    persist(db.batch(ops));
    return toast(`Cronômetro ligado${ini ? ` desde ${hhmm(t.cronometroInicio)}` : ''}: ${t.titulo}`);
  }
  if (ini) p.inicio = ini;
  return startTask(p);
}

// Começou no passado e o horário da tarefa já acabou (ou faz mais de 3 h): ainda está fazendo ou já terminou?
function perguntaTerminou(p, ini, tb, fimPl) {
  const desde = U.fmtDur((Date.now() - ini) / 1000);
  // Começou em outro dia: escolhe também em que dia terminou (do dia do início até hoje).
  const dIni = U.ymd(new Date(ini));
  const dias = [];
  for (let d = dIni; d <= U.todayStr() && dias.length < 8; d = U.addDays(d, 1)) dias.push(d);
  const dFim = fimPl && fimPl <= Date.now() ? U.ymd(new Date(fimPl)) : dIni;
  const diaSel =
    dias.length > 1
      ? `<label class="comecei-campo"><span>No dia:</span><select name="fimDia" aria-label="Dia em que terminou">${dias
          .map((d) => `<option value="${d}" ${d === dFim ? 'selected' : ''}>${esc(U.fmtDiaCurto(d))}</option>`)
          .join('')}</select></label>`
      : '';
  const pl = tb?.horario ? faixa(U.toMin(tb.horario), U.toMin(tb.horario) + duracao(tb)) : '';
  openModal(`<form class="modal-body start comecei terminou" data-form="terminou" data-p="${esc(JSON.stringify({ ...p, inicio: ini }))}">
    <header class="modal-head"><h2>Ainda está fazendo?</h2>
      <button type="button" class="icon-btn" data-action="close-modal" aria-label="Fechar">${icon('x')}</button></header>
    <p>${
      fimPl && tb
        ? `<b>${esc(nomeTxt(tb))}</b> estava marcada para ${pl}, e esse horário já passou.`
        : `Você começou às ${hhmm(ini)}, faz ${desde}.`
    }</p>
    <button type="button" class="btn soft full" data-action="comecei-seguindo">${icon('play')}Ainda estou fazendo <small class="muted">(desde ${hhmm(ini)})</small></button>
    <div class="terminou-fim">
      ${diaSel}
      <label class="comecei-campo"><span>Terminei às:</span><input type="time" name="fim" required value="${fimPl ? hhmm(fimPl) : ''}" aria-label="Horário em que terminou" ${fimPl ? '' : 'autofocus'}></label>
      <button type="submit" class="btn primary">${icon('check')}Já terminei</button>
    </div>
  </form>`);
}

const FORMS = {
  obs(form) {
    if (saveObs(form) === false) return;
    closeModal();
  },

  ident(form) {
    const t = findTask(form.dataset.id, form.dataset.date);
    if (!t) return closeModal();
    const el = form.elements;
    const data = {};
    const ops = [];
    if (el.itemId) {
      if (!el.itemId.value) return toast('Escolha qual foi.'), el.itemId.focus();
      data.itemId = el.itemId.value;
    }
    if (isWork(t.categoriaId)) {
      const c = cliById(el.cli ? el.cli.value : t.clienteId);
      if (el.cli && !c) return toast('Escolha o cliente.'), el.cli.focus();
      const usaLista = !form.querySelector('[data-ident-serv-sel]').hidden && el.servSel.value !== '__outro';
      const servico = (usaLista ? el.servSel.value : el.servNovo.value).trim();
      if (!servico) return toast('Diga o que você fez.'), (usaLista ? el.servSel : el.servNovo).focus();
      const pedePessoa = !form.querySelector('[data-ident-pessoa]').hidden;
      const pessoa = pedePessoa ? el.pessoa.value.trim() : t.pessoa || '';
      if (pedePessoa && !pessoa) return toast('Escreva o nome da pessoa.'), el.pessoa.focus();
      Object.assign(data, { clienteId: c?.id || null, servico, pessoa: pessoa || null, titulo: [servico, pessoa].filter(Boolean).join(' · ') });
      if (c) {
        // Serviço novo e nome novo ficam guardados no cliente para a próxima vez.
        const patch = {};
        if (!servicosOf(c).some((x) => norm(x) === norm(servico))) patch.servicos = c.servicos = [...servicosOf(c), servico];
        if (pessoa && !(c.pessoas || []).some((x) => norm(x) === norm(pessoa))) patch.pessoas = c.pessoas = [pessoa, ...(c.pessoas || [])].slice(0, 60);
        if (Object.keys(patch).length) ops.push({ type: 'update', col: 'clients', id: c.id, data: patch });
      }
    }
    Object.assign(t, data);
    ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data });
    persist(db.batch(ops));
    const next = identNext;
    identNext = null;
    closeModal();
    render();
    next?.(t);
  },

  finish(form) {
    const t = findTask(form.dataset.id, form.dataset.date);
    if (!t) return closeModal();
    const modo = form.dataset.modo;
    const el = form.elements;
    const obs = el.obs.value.trim();
    const temSess = (t.sessoes || []).some((x) => x.i);
    const refazer = !!form.dataset.mexeu || !temSess;
    let i = null;
    let g = null;
    if (refazer) {
      const ini = U.toMin(el.ini.value);
      g = finGasto(el);
      if (ini == null || g == null || el.fim.value === '') return toast('Preencha o início e o término.');
      if (g <= 0) return toast('O tempo gasto precisa ser maior que zero.'), el.gh.focus();
      i = tsOf(t.data, (Number(form.dataset.off) || 0) * 1440 + ini);
    }
    const ops = [];
    if (isRunning(t)) stopTimer(t, ops);
    const extra = {};
    if (refazer) {
      // As horas ditas aqui passam a ser o registro do que foi feito.
      const antes = (t.sessoes || []).map((x) => x.obs).filter(Boolean).join(' · ');
      const nota = obs || antes;
      t.sessoes = [{ i, f: i + g * 60_000, ...(nota ? { obs: nota } : {}), manual: true }];
      t.tempoGasto = g * 60;
      Object.assign(extra, { sessoes: t.sessoes, tempoGasto: t.tempoGasto, cronometroInicio: null });
    } else {
      const last = t.sessoes[t.sessoes.length - 1];
      if (obs !== (last.obs || '')) {
        if (obs) last.obs = obs;
        else delete last.obs;
      }
      extra.sessoes = t.sessoes;
    }
    // A tarefa passa a ficar no horário em que foi feita (na agenda e no calendário).
    const antes = planoDe(t);
    const sp = spanOf(t);
    if (sp && sp.s >= 0 && sp.s < 1440) {
      Object.assign(extra, { horario: U.fromMin(sp.s), duracao: Math.max(1, sp.e - sp.s), fimAberto: false });
      if (t.origem === 'fixa') extra.ajustado = true;
    }
    closeModal();
    if (modo === 'ajustar') {
      Object.assign(t, extra);
      ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: extra });
      render();
      persist(db.batch(ops));
      toast(`Horário ajustado: ${spanTxt(spanOf(t))} · ${U.fmtDur(elapsed(t))}.`);
      return depoisDeFeito(t, antes);
    }
    setDone(t, true, extra, ops);
    toast(`Concluída: ${spanTxt(spanOf(t))} · ${U.fmtDur(elapsed(t))}.`);
    depoisDeFeito(t, antes);
  },

  'start-novo'(form) {
    const servico = form.elements.servico.value.trim();
    if (!servico) return form.elements.servico.focus();
    const box = form.closest('.modal-body');
    const pessoa = box.querySelector('[data-start-pessoa]');
    if (pessoa && !pessoa.value.trim()) {
      pessoa.focus();
      return toast('Escreva o nome da pessoa.');
    }
    return askComecei({ cliId: box.dataset.startCli, servico, pessoa: pessoa?.value || '', bloco: box.dataset.startBloco, dia: box.dataset.startDia });
  },

  comecei(form) {
    let p = {};
    try {
      p = JSON.parse(form.dataset.p || '{}');
    } catch {}
    const t = p.taskId ? findTask(p.taskId, p.date) : null;
    const v = form.elements.ini.value;
    const dia = t?.data || p.dia || U.todayStr();
    if (!v && dia < U.todayStr()) return form.elements.ini.focus(), toast('Coloque a hora em que começou.');
    let ini = null;
    if (v) {
      ini = tsOf(dia, U.toMin(v));
      if (ini > Date.now() + 60_000) {
        form.elements.ini.focus();
        return toast('Esse horário ainda não chegou.');
      }
      // Hora de agora (sem mudar): começa no segundo exato, não no minuto cheio.
      if (Date.now() - ini < 60_000) ini = null;
    }
    if (ini && !p.seguindo) {
      const tb = t || (p.bloco ? findTask(p.bloco, dia) : null);
      const fimPl = tb?.horario && !tb.fimAberto ? tsOf(tb.data, U.toMin(tb.horario) + duracao(tb)) : null;
      if ((fimPl && fimPl <= Date.now()) || Date.now() - ini >= 3 * 3600_000) return perguntaTerminou(p, ini, tb, fimPl);
    }
    return iniciaDe(p, ini);
  },

  terminou(form) {
    let p = {};
    try {
      p = JSON.parse(form.dataset.p || '{}');
    } catch {}
    const t = p.taskId ? findTask(p.taskId, p.date) : null;
    const ini = Number(p.inicio);
    const v = form.elements.fim.value;
    if (!v || !ini) return form.elements.fim.focus();
    const fimDia = form.elements.fimDia?.value;
    let fim = tsOf(fimDia || t?.data || p.dia || U.todayStr(), U.toMin(v));
    if (fim <= ini && !fimDia) fim += 86_400_000; // passou da meia-noite
    if (fim <= ini) return toast('O fim tem que ser depois do início.'), form.elements.fim.focus();
    if (fim > Date.now() + 60_000) return toast('Esse horário ainda não chegou.'), form.elements.fim.focus();
    if (p.taskId) {
      if (!t) return closeModal();
      return feitoEntre(t, ini, fim);
    }
    return startTask({ ...p, inicio: ini, fim });
  },

  'start-livre'(form) {
    const box = form.closest('.modal-body');
    const k = catById(box.dataset.startCat);
    const nome = form.elements.nome.value.trim();
    if (!nome) return form.elements.nome.focus();
    if (k && !(k.sugestoes || []).some((x) => norm(x) === norm(nome))) {
      k.sugestoes = [nome, ...(k.sugestoes || [])].slice(0, 20);
      persist(db.update('categories', k.id, { sugestoes: k.sugestoes }));
    }
    return askComecei({ catId: box.dataset.startCat, servico: nome, bloco: box.dataset.startBloco, dia: box.dataset.startDia });
  },

  async daily(form) {
    const f = formData(form);
    const id = form.dataset.id;
    let salva = null; // a tarefa como ficou, para conferir o encaixe
    let mudouHora = !id;
    if (form.dataset.salvando) return; // evita salvar duas vezes enquanto confere o dia
    const cli = isWork(f.categoriaId) ? cliById(f.clienteId) : null;
    // Trabalho sempre com cliente; categoria com lista (ex.: Cursos) sempre com qual.
    if (isWork(f.categoriaId) && !cli && startClients().length) return toast('Escolha o cliente.'), form.elements.clienteId.focus();
    if (itensOf(catById(f.categoriaId)).length && !f.itemId) return toast('Escolha qual (ex.: o curso).'), form.elements.itemId.focus();
    form.dataset.salvando = '1';
    const patch = {
      titulo: f.titulo.trim(),
      categoriaId: f.categoriaId || null,
      clienteId: cli?.id || null,
      itemId: (itensOf(catById(f.categoriaId)).length && f.itemId) || null,
      servico: cli ? f.titulo.trim() : null,
      pessoa: (cli?.pedeNome && f.pessoa?.trim()) || null,
      horario: f.horario || null,
      duracao: (f.horario && durDoForm(form)) || null,
      ...avisoData(f),
    };
    // Nome só com espaços: avisa e libera o Salvar de novo (antes o botão ficava travado).
    if (!patch.titulo) {
      delete form.dataset.salvando;
      return toast('Dê um nome para a tarefa.'), form.elements.titulo?.focus();
    }
    // Serviço novo fica guardado no cliente para a próxima vez.
    if (cli && !servicosOf(cli).some((x) => norm(x) === norm(patch.titulo))) {
      cli.servicos = [...servicosOf(cli), patch.titulo];
      persist(db.update('clients', cli.id, { servicos: cli.servicos }));
    }
    // Nome novo (ex.: Fotografia) fica guardado no cliente para a próxima vez.
    if (patch.pessoa && !(cli.pessoas || []).some((x) => norm(x) === norm(patch.pessoa))) {
      cli.pessoas = [patch.pessoa, ...(cli.pessoas || [])].slice(0, 60);
      persist(db.update('clients', cli.id, { pessoas: cli.pessoas }));
    }
    if (id) {
      const oldDate = form.dataset.oldDate;
      const newDate = f.data || oldDate;
      const t = findTask(id, oldDate);
      patch.data = newDate;
      const tempo = form.elements.tempoMin;
      let refeito = false;
      if (form.dataset.real && t && newDate === oldDate) {
        // Com cronômetro ou já feita: Início, Tempo gasto e Término andam juntos.
        const ini = U.toMin(patch.horario);
        const g = tempo.value === '' ? null : Math.max(0, Math.round(Number(tempo.value)));
        const mexeuIni = patch.horario !== form.dataset.ini0;
        const mexeuFim = (f.fim || '') !== (form.dataset.fim0 || '');
        const mexeuG = tempo.value !== tempo.dataset.orig;
        const nowRel = Math.floor((Date.now() - U.parseYmd(oldDate).getTime()) / 60_000);
        let fa = U.toMin(f.fim);
        if (fa != null && ini != null && fa <= ini) fa += 1440;
        if (!mexeuIni && !mexeuFim && !mexeuG) {
          // Nada mudou nas horas: o planejado da tarefa fica como estava.
          Object.assign(patch, { horario: t.horario, duracao: t.duracao || null });
        } else if (isRunning(t) && !mexeuG && (!mexeuFim || fa == null || fa > nowRel)) {
          // Continua rodando. Mudar o Início muda quando ele começou (ex.: "comecei 10h30").
          const ss = (t.sessoes || []).filter((x) => x.i);
          if (mexeuIni && ini != null && ss.length) {
            const first = ss.reduce((x, y) => (x.i <= y.i ? x : y));
            const novo = tsOf(newDate, ini);
            const anterior = ss.filter((x) => x !== first && x.f && x.f <= first.i).reduce((m, x) => Math.max(m, x.f), 0);
            if (novo < (first.f || Date.now()) && novo >= anterior) {
              const dif = first.i - novo;
              first.i = novo;
              if (first.f) patch.tempoGasto = Math.max(0, Math.round((t.tempoGasto || 0) + dif / 1000));
              else patch.cronometroInicio = novo; // sessão aberta: conta desde o novo começo
              patch.sessoes = t.sessoes;
            }
          }
        } else if (ini != null && g) {
          // Um registro só: do início até início + tempo gasto (para o cronômetro, se estiver rodando).
          const i = tsOf(newDate, ini);
          const nota = (t.sessoes || []).map((x) => x.obs).filter(Boolean).join(' · ');
          Object.assign(patch, {
            sessoes: [{ i, f: i + g * 60_000, ...(nota ? { obs: nota } : {}), manual: true }],
            tempoGasto: g * 60, cronometroInicio: null, duracao: g, fimAberto: false,
          });
          if (S.pedirConclusao === t.id) S.pedirConclusao = null;
          refeito = true;
        }
      } else if (tempo && tempo.value !== '' && tempo.value !== tempo.dataset.orig) {
        // Tempo corrigido à mão: substitui o acumulado (e reinicia a contagem se estiver rodando).
        patch.tempoGasto = Math.max(0, Math.round(Number(tempo.value) * 60));
        if (t && isRunning(t)) patch.cronometroInicio = Date.now();
      }
      if (t) {
        mudouHora = t.horario !== patch.horario || (t.duracao || null) !== patch.duracao || newDate !== oldDate;
        if (mudouHora && t.origem === 'fixa') patch.ajustado = true;
        // Tarefa já feita: mudar o horário, o fim ou o tempo gasto muda também o registro (agenda, calendário e relatórios).
        const mexeuTempo = patch.tempoGasto != null;
        if (!refeito && !(form.dataset.real && newDate === oldDate) && t.concluido && !isRunning(t) && patch.horario && (mudouHora || mexeuTempo)) {
          const mudouPlano = t.horario !== patch.horario || (t.duracao || null) !== patch.duracao;
          const g = Math.max(1, mexeuTempo ? Math.round(patch.tempoGasto / 60) : mudouPlano && patch.duracao ? patch.duracao : Math.round(elapsed(t) / 60));
          const i = tsOf(newDate, U.toMin(patch.horario));
          const nota = (t.sessoes || []).map((x) => x.obs).filter(Boolean).join(' · ');
          Object.assign(patch, { sessoes: [{ i, f: i + g * 60_000, ...(nota ? { obs: nota } : {}), manual: true }], tempoGasto: g * 60, duracao: g, fimAberto: false });
        }
        Object.assign(t, patch);
        if (newDate !== oldDate) {
          S.days[oldDate] = S.days[oldDate].filter((x) => x !== t);
          S.days[newDate]?.push(t);
        }
      }
      persist(db.update('dailyTasks', id, patch));
      salva = t ? t : { ...patch, id };
    } else {
      const t = { id: U.newId(), ...patch, data: f.data, concluido: false, origem: 'avulsa', recurringTaskId: null, removido: false };
      S.days[t.data]?.push(t);
      persist(db.set('dailyTasks', t.id, t));
      salva = t;
    }
    render();
    // Caiu em cima de outra tarefa? Pergunta: sobrescrever ou manter as duas.
    if (mudouHora && salva.horario && salva.duracao) {
      if (!(await resolveEncaixe(salva, salva.data))) closeModal();
      render();
      return;
    }
    closeModal();
  },

  async rec(form) {
    const f = formData(form);
    const mensal = f.repete === 'mes';
    const dias = new FormData(form).getAll('dias').map(Number).sort();
    const diaDoMes = Math.min(31, Math.max(1, Math.round(Number(f.diaDoMes) || 0)));
    if (mensal && !Number(f.diaDoMes)) return toast('Escolha o dia do mês.');
    if (!mensal && !dias.length) return toast('Escolha pelo menos um dia da semana.');
    const aberto = f.semFim === 'on';
    const data = {
      titulo: f.titulo.trim(),
      categoriaId: f.categoriaId || null,
      clienteId: (isWork(f.categoriaId) && f.clienteId) || null,
      itemId: (itensOf(catById(f.categoriaId)).length && f.itemId) || null,
      horario: f.horario || null,
      duracao: aberto ? null : durDoForm(form),
      fimAberto: aberto,
      ...avisoData(f),
      repete: mensal ? 'mes' : 'semana',
      diaDoMes: mensal ? diaDoMes : null,
      diasDaSemana: mensal ? [] : dias,
      ativo: true,
    };
    if (!data.titulo) return;
    if (!data.horario) return toast('Na rotina o horário é obrigatório.');
    const id = form.dataset.id;
    const today = U.todayStr();
    closeModal();
    if (id) {
      Object.assign(S.recurring.find((r) => r.id === id) || {}, data);
      // Atualiza as tarefas já geradas de hoje em diante que ainda não foram concluídas.
      const inst = await db.where('dailyTasks', 'recurringTaskId', '==', id);
      const { diasDaSemana, ativo, repete, diaDoMes: _d, ...fields } = data;
      const ops = [{ type: 'update', col: 'recurringTasks', id, data }];
      for (const t of inst) {
        if (t.data < today || fechada(t)) continue;
        // Com algo feito (tempo, sessões, notas): nunca apaga; só leva o nome/categoria novos, mantendo o horário do dia.
        if (!repeatsOn(data, t.data) && !temRegistro(t)) ops.push({ type: 'delete', col: 'dailyTasks', id: t.id });
        else if (!repeatsOn(data, t.data)) continue;
        else if (t.ajustado || temRegistro(t)) {
          // Dia com horário ajustado à mão (encaixe): mantém o horário daquele dia.
          const { horario, duracao: _dur, fimAberto, ...resto } = fields;
          ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: resto });
        } else ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: fields });
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
    const data = {
      nome: f.nome.trim(),
      categoriaId: workCatId(),
      observacoes: f.observacoes.trim(),
      status: f.status === 'finalizado' ? 'finalizado' : 'ativo',
      servicos: linhas(f.servicos),
      soFinanceiro: f.soFinanceiro === 'on',
      pedeNome: f.pedeNome === 'on',
    };
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
    if ('itens' in f) {
      // Mantém o id de cada item pelo nome, para o histórico continuar ligado.
      // Item tirado da lista fica guardado como oculto (o histórico dele continua com nome).
      const old = allItens(catById(id));
      const novos = linhas(f.itens).map((nome) => ({ id: old.find((o) => norm(o.nome) === norm(nome))?.id || U.newId(), nome }));
      data.itens = [...novos, ...old.filter((o) => !novos.some((n) => n.id === o.id)).map((o) => ({ ...o, oculto: true }))];
      data.subtarefas = linhas(f.subtarefas);
    }
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

// Ordem das áreas: lista com a alça (duas linhas) para arrastar, ou as setas.
function openNavOrdem() {
  openModal(`<div class="modal-body nav-ordem">
    ${modalHead('Ordem das áreas')}
    <p class="muted sm">Arraste pela alça (as duas linhas) para mudar a ordem do menu e da barra de baixo.</p>
    <ul class="ordem-lista" data-ordem>${navItems()
      .map(
        (n) => `<li data-id="${n.id}"><span class="ordem-alca" title="Arrastar" aria-hidden="true"><i></i><i></i></span>${icon(n.id)}<span class="grow">${esc(n.label)}</span>
        <button type="button" class="icon-btn xs" data-action="ordem-mover" data-n="-1" aria-label="Subir ${esc(n.label)}">${icon('up')}</button>
        <button type="button" class="icon-btn xs" data-action="ordem-mover" data-n="1" aria-label="Descer ${esc(n.label)}">${icon('down')}</button></li>`,
      )
      .join('')}</ul>
    <footer class="modal-actions">
      <button type="button" class="btn ghost" data-action="nav-ordem-padrao">Voltar ao padrão</button>
      <span class="grow"></span>
      <button type="button" class="btn primary" data-action="nav-ordem-salvar">${icon('check')}Salvar</button>
    </footer>
  </div>`);
}
function salvaOrdem(ids) {
  S.profile.navOrdem = ids;
  persist(db.setProfile({ navOrdem: ids }));
  closeModal();
  root.innerHTML = ''; // refaz o menu na ordem nova
  render();
}
let arrasto = null;
document.addEventListener('pointerdown', (e) => {
  const alca = e.target.closest?.('.ordem-alca');
  if (!alca) return;
  e.preventDefault();
  arrasto = alca.closest('li');
  arrasto.classList.add('arrastando');
  alca.setPointerCapture?.(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (!arrasto) return;
  const ul = arrasto.parentElement;
  const depois = [...ul.children].find((x) => x !== arrasto && e.clientY < x.getBoundingClientRect().top + x.offsetHeight / 2);
  if (depois) {
    if (arrasto.nextElementSibling !== depois) ul.insertBefore(arrasto, depois);
  } else if (ul.lastElementChild !== arrasto) ul.appendChild(arrasto);
});
document.addEventListener('pointerup', () => {
  arrasto?.classList.remove('arrastando');
  arrasto = null;
});

// Pop-up do dia: fecha no X, no Esc ou tocando fora (apertou e soltou fora).
let popDown = false;
document.addEventListener('pointerdown', (e) => {
  popDown = e.target.id === 'daypop';
});
document.addEventListener('click', (e) => {
  if (e.target.id === 'daypop' && popDown && S.diaPop) ACTIONS['dia-fechar']();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.diaPop && !modal.open) ACTIONS['dia-fechar']();
});
// Dois cliques num dia do calendário: abre a agenda dele.
document.addEventListener('dblclick', (e) => {
  const c = e.target.closest?.('.cal-cell[data-date]');
  if (c) ACTIONS['dia-abrir']({ date: c.dataset.date });
});

function saveSetting(el) {
  const name = el.name;
  if (!(name in DEFAULT_PROFILE)) return;
  let val = el.type === 'checkbox' ? el.checked : el.value;
  if (['agendaInicio', 'agendaFim', 'duracaoPadrao', 'avisoAntes'].includes(name)) val = Number(val);
  if (name === 'apelido') val = val.trim();
  if (['notifPendentesHora', 'acordar', 'comecoAte', 'dormir'].includes(name) && !val) return;
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

  more: () => $('#more').classList.toggle('open'),

  'dia-abrir': ({ date }) => {
    S.date = date || U.todayStr();
    S.diaPop = true;
    closeModal();
    render();
  },
  'dia-fechar': () => {
    S.diaPop = null;
    render();
  },
  'nav-ordem': () => openNavOrdem(),
  'ordem-mover': ({ n }, el) => {
    const li = el.closest('li');
    if (Number(n) < 0 && li.previousElementSibling) li.parentElement.insertBefore(li, li.previousElementSibling);
    else if (Number(n) > 0 && li.nextElementSibling) li.parentElement.insertBefore(li.nextElementSibling, li);
    el.focus();
  },
  'nav-ordem-salvar': () => {
    const ids = [...modal.querySelectorAll('[data-ordem] li')].map((li) => li.dataset.id);
    salvaOrdem(ids);
    toast('Ordem das áreas salva.');
  },
  'nav-ordem-padrao': () => {
    salvaOrdem([]);
    toast('Ordem padrão de volta.');
  },
  go: ({ route, date }) => {
    if (route === 'hoje') return ACTIONS['dia-abrir']({ date });
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
    if (t.concluido) return setDone(t, false);
    // 1º: Trabalho sem cliente/serviço ou curso sem qual → pergunta (obrigatório) e depois segue daqui.
    if (identFalta(t)) return openIdent(t, () => ACTIONS.toggle({ id, date }));
    // 2º: Início, Tempo gasto e Término (já preenchidos). Só não pergunta em tarefa simples sem horário e sem tempo.
    const pedeTempo = !!t.horario || isWork(t.categoriaId) || itensOf(catById(t.categoriaId)).length > 0;
    if (isRunning(t) || elapsed(t) >= 60 || t.sessoes?.length || pedeTempo) return openFinish(t);
    setDone(t, true);
  },
  parar: ({ id, date }) => {
    const t = findTask(id, date) || runningTasks()[0];
    if (!t) return render();
    if (identFalta(t)) return openIdent(t, (x) => openFinish(x, { modo: 'parar' }));
    openFinish(t, { modo: 'parar' });
  },
  'so-pausar': ({ id, date }) => {
    closeModal();
    const t = findTask(id, date);
    if (t && isRunning(t)) ACTIONS.timer({ id, date });
  },
  'ajustar-hora': ({ id, date }) => {
    const t = findTask(id, date);
    if (t) openFinish(t, { modo: 'ajustar' });
  },
  'nao-feito': ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    const ops = [];
    const marcar = !t.naoFeito;
    if (marcar && isRunning(t)) stopTimer(t, ops);
    t.naoFeito = marcar;
    if (marcar) t.concluido = false;
    if (S.pedirConclusao === t.id) S.pedirConclusao = null;
    ops.push({ type: 'update', col: 'dailyTasks', id: t.id, data: marcar ? { naoFeito: true, concluido: false } : { naoFeito: false } });
    render();
    refreshDetail(id, date);
    persist(db.batch(ops), () => (t.naoFeito = !marcar));
    const w = desperdicio(t);
    toast(marcar ? `Não feito${w >= 60 ? ` · ${U.fmtDur(w)} de tempo desperdiçado` : ''}.` : 'Voltou a ficar pendente.');
  },
  'check-semtempo': ({ id, date }) => {
    const t = findTask(id, date);
    closeModal();
    if (t) setDone(t, true);
  },
  'obs-concluir': (_, el) => {
    const t = saveObs(el.closest('form'));
    if (t === false) return;
    closeModal();
    if (t && identFalta(t)) return openIdent(t, (x) => openFinish(x));
    if (t) openFinish(t);
  },
  'start-pick': ({ cli, cat, item, bloco, dia }) => openStart({ cli, cat, item, bloco, dia }),
  'comecei-seguindo': (_, el) => {
    let p = {};
    try {
      p = JSON.parse(el.closest('form').dataset.p || '{}');
    } catch {}
    const ini = Number(p.inicio) || null;
    delete p.inicio;
    return iniciaDe({ ...p, seguindo: true }, ini);
  },
  'comecei-hora': ({ hora }) => {
    const inp = modal.querySelector('[data-comecei]');
    if (!inp) return;
    inp.value = hora;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
  },
  'start-go': ({ serv }, el) => {
    const box = el.closest('.modal-body');
    const pessoa = box.querySelector('[data-start-pessoa]');
    if (box.dataset.startCli) {
      if (pessoa && !pessoa.value.trim()) {
        pessoa.focus();
        return toast('Escreva o nome da pessoa.');
      }
      return askComecei({ cliId: box.dataset.startCli, servico: serv, pessoa: pessoa?.value || '', bloco: box.dataset.startBloco, dia: box.dataset.startDia });
    }
    return askComecei({ catId: box.dataset.startCat, itemId: box.dataset.startItem, servico: serv, bloco: box.dataset.startBloco, dia: box.dataset.startDia });
  },
  'open-task': ({ id, date }) => {
    const t = findTask(id, date);
    if (t) openTaskDetail(t);
  },
  'notes-template': (_, el) => {
    const ta = modal.querySelector('[data-notes]');
    if (!ta) return;
    ta.value = ta.value.trim() ? `${ta.value.trimEnd()}\n\n${NOTAS_MODELO}` : NOTAS_MODELO;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    el.remove();
    ta.focus();
    ta.setSelectionRange(NOTAS_MODELO.indexOf('\n') + 1, NOTAS_MODELO.indexOf('\n') + 1);
  },
  'rel-dias': ({ ch, key }) => openRelDias(ch, key),
  'client-history': ({ id }) => {
    const cli = cliById(id);
    if (cli) openClientHistory(cli);
  },
  'diario-shift': ({ n }) => {
    flushSaves();
    S.diarioDate = U.addDays(S.diarioDate, Number(n));
    render();
  },
  'diario-today': () => {
    flushSaves();
    S.diarioDate = U.todayStr();
    render();
  },
  'diario-novo': () => {
    flushSaves();
    S.diarioDate = U.todayStr();
    render();
    window.scrollTo(0, 0);
    const ta = $('[data-journal]');
    if (ta) {
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  },
  'diario-lista': () => {
    flushSaves();
    S.diarioDate = null;
    render();
  },
  'diario-open': ({ date }) => {
    flushSaves();
    S.diarioDate = date;
    render();
    if (!isWide()) window.scrollTo({ top: 0, behavior: 'smooth' });
  },
  timer: ({ id, date }) => {
    const t = findTask(id, date);
    if (!t) return;
    const ops = [];
    const run = isRunning(t);
    // Bloco da rotina de Cursos (lista) ou de Trabalho sem cliente: primeiro escolhe o curso ou o cliente.
    const escolher = itensOf(catById(t.categoriaId)).length || (isWork(t.categoriaId) && !t.clienteId && startClients().length);
    if (!run && !t.itemId && !elapsed(t) && escolher) return openStart({ cat: t.categoriaId, bloco: t.id, dia: t.data });
    if (!run && !elapsed(t)) return askComecei({ taskId: t.id, date: t.data });
    const detailOpen = modal.open && modal.dataset.detail === id;
    if (run) {
      stopTimer(t, ops);
      S.pedirConclusao = id; // aparece o ✓ "Finalizou?" ao lado do cronômetro
    } else {
      if (S.pedirConclusao === id) S.pedirConclusao = null;
      startTimer(t, ops); // uma coisa de cada vez: pausa o que estiver rodando
    }
    render();
    refreshDetail(id, date);
    persist(db.batch(ops));
    if (run) {
      // Pausou: pergunta o que foi feito. Com a tarefa aberta, o campo da sessão já fica ali.
      if (detailOpen) modal.querySelector('.sess:last-child .sess-obs')?.focus();
      else openObsPrompt(t);
    }
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

  'rel-periodo': ({ p }) => {
    S.relPeriodo = p;
    if (p === 'mes') S.relMes = U.todayStr().slice(0, 7);
    render();
  },
  'rel-mes': ({ n }) => {
    S.relMes = U.addMonths(S.relMes, Number(n));
    render();
  },

  'rotina-dia': ({ d }) => {
    S.rotinaDia = d === 'all' || d === 'mes' ? d : Number(d);
    render();
  },
  'new-rec': ({ cat, cli }) =>
    openRecForm({
      categoriaId: cat,
      clienteId: cli,
      repete: S.rotinaDia === 'mes' ? 'mes' : 'semana',
      diasDaSemana: typeof S.rotinaDia === 'number' ? [S.rotinaDia] : [1, 2, 3, 4, 5],
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
        ...inst.filter((t) => t.data >= today && !temRegistro(t)).map((t) => ({ type: 'delete', col: 'dailyTasks', id: t.id })),
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
  'ask-manter': () => {
    const r = askResolver;
    askResolver = null;
    closeModal();
    r?.('manter');
  },

  install: async () => {
    if (!S.installEvt) return;
    S.installEvt.prompt();
    await S.installEvt.userChoice;
    S.installEvt = null;
    render();
  },
  'import-text': () => {
    const txt = $('[data-import-text]')?.value || '';
    if (!txt.trim()) return toast('Cole o conteúdo do arquivo primeiro.');
    startImport(txt);
  },
  'import-confirm': () => {
    if (!pendingImport) return;
    const plan = pendingImport;
    pendingImport = null;
    return applyImport(plan, !!modal.querySelector('[data-import-replace]')?.checked);
  },
  export: () => exportData(),
  'reset-demo': async () => {
    if (!(await ask('Apagar todos os dados de demonstração deste navegador?', 'Apagar'))) return;
    resetDemo();
    location.reload();
  },
};

// Finanças (js/financas.js): ações e formulários próprios.
const FIN = createFin({
  S, db, U, esc, icon, openModal, closeModal, toast, persist, render, ask, modalHead, modalFoot, isAtivo, norm, workCatId,
  ensureRange, elapsed, visible, agora: agoraHTML,
});
Object.assign(ACTIONS, FIN.ACTIONS);
Object.assign(FORMS, FIN.FORMS);
const EXTRAS = createExtras({
  S, db, U, esc, icon, openModal, closeModal, toast, persist, render, ask, modalHead, modalFoot, norm, errMsg, loading, agora: agoraHTML,
});
Object.assign(ACTIONS, EXTRAS.ACTIONS);
Object.assign(FORMS, EXTRAS.FORMS);

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
  if (FIN.onChange(t)) return;
  if (t.matches('[data-comecei]')) {
    const b = t.form.querySelector('[data-comecei-btn] span');
    if (b) b.textContent = t.value ? 'Iniciar' : 'Comecei agora';
    return;
  }
  if (t.matches('[data-import-file]')) {
    const file = t.files?.[0];
    t.value = '';
    if (!file) return;
    if (file.size > 5_000_000) return toast('Arquivo grande demais para importar.');
    file.text().then(startImport, (err) => toast(errMsg(err)));
  } else if (t.matches('[data-rel-data]')) {
    if (!t.value) return;
    S[t.dataset.relData] = t.value;
    render();
  } else if (t.matches('[data-ident-cli], [data-ident-serv]')) {
    identSync(t.form);
  } else if (t.matches('[data-cat-select]')) {
    const obrig = t.form.dataset.form === 'daily';
    const field = t.form.querySelector('[data-client-field]');
    field.hidden = !isWork(t.value);
    field.querySelector('select').innerHTML = clientOptions(t.value, '', obrig);
    const item = t.form.querySelector('[data-item-field]');
    if (item) {
      item.hidden = !itensOf(catById(t.value)).length;
      item.querySelector('select').innerHTML = itemOptions(t.value, '', obrig);
    }
    const lbl = t.form.querySelector('[data-titulo-lbl]');
    if (lbl) lbl.textContent = isWork(t.value) ? 'Serviço' : 'Título';
    servicosList(t.form);
  } else if (t.matches('select[name="clienteId"]')) {
    servicosList(t.form);
  } else if (t.matches('[data-sem-fim]')) {
    t.form.elements.fim.disabled = t.checked;
    atualizaDur(t.form);
  } else if (t.matches('[data-repete]')) {
    const mes = t.value === 'mes';
    t.form.querySelector('[data-rep-mes]').hidden = !mes;
    t.form.querySelector('[data-rep-semana]').hidden = mes;
  } else if (t.name === 'corLivre') {
    const radio = t.form.querySelector('input[name="cor"][value="custom"]');
    radio.checked = true;
    radio.closest('.sw').style.setProperty('--c', t.value);
  } else if (t.closest('[data-settings]')) {
    saveSetting(t);
  }
});

// Editar tarefa com cronômetro: mexeu no Início, no Tempo gasto ou no Término, acerta o outro.
// Rodando, o tempo vai só até agora (o Término depois de agora é até quando vai o bloco).
function realSync(form, campo) {
  const el = form.elements;
  const ini = U.toMin(el.horario.value);
  const fim = U.toMin(el.fim.value);
  const g = el.tempoMin.value === '' ? null : Number(el.tempoMin.value);
  if (campo === 'g') {
    if (ini != null && g != null) el.fim.value = minTxt(ini + g);
  } else if (ini != null && fim != null) {
    let fa = fim;
    if (fa <= ini) fa += 1440;
    const nowRel = Math.floor((Date.now() - U.parseYmd(form.dataset.oldDate).getTime()) / 60_000);
    const ate = form.dataset.run ? Math.min(fa, nowRel) : fa;
    el.tempoMin.value = Math.max(0, ate - ini);
  }
  form.dataset.dur = durDoForm(form) || '';
}

// Na lista do dia, duração e aviso só aparecem quando a tarefa tem horário.
document.addEventListener('input', (e) => {
  const el = e.target;
  if (FIN.onInput(el)) return;
  if (el.matches('[data-comecei]')) {
    const b = el.form.querySelector('[data-comecei-btn] span');
    if (b) b.textContent = el.value ? 'Iniciar' : 'Comecei agora';
  } else if (el.matches('[data-fin]')) {
    finSync(el.form, el.dataset.fin);
  } else if (el.matches('[data-tempo]')) {
    realSync(el.form, 'g');
  } else if (el.matches('[data-horario]') && el.form.dataset.real) {
    realSync(el.form, 'ini');
  } else if (el.matches('[data-fim]') && el.form.dataset.real) {
    realSync(el.form, 'fim');
  } else if (el.matches('[data-horario]')) {
    const form = el.form;
    const group = form.querySelector('[data-aviso-group]');
    if (group) group.hidden = !el.value;
    // Mudou o começo: o fim anda junto, mantendo a duração que já estava.
    const fim = form.elements.fim;
    const dur = Number(form.dataset.dur) || (fim?.value ? null : S.profile.duracaoPadrao || 30);
    if (fim && el.value && dur && !form.dataset.real) fim.value = U.fromMin(U.toMin(el.value) + dur);
    atualizaDur(form);
  } else if (el.matches('[data-fim]')) {
    el.form.dataset.dur = durDoForm(el.form) || '';
    atualizaDur(el.form);
  } else if (el.matches('[data-notes]')) {
    // Notas da tarefa: guarda na memória na hora e salva quando a pessoa para de digitar.
    const t = findTask(el.dataset.id, el.dataset.date);
    if (!t) return;
    t.notas = el.value;
    setStatus('[data-notes-status]', 'Salvando…');
    debounceSave(`notas:${t.id}`, () => saveNotes(t));
  } else if (el.matches('[data-sess-obs]')) {
    const t = findTask(el.dataset.id, el.dataset.date);
    const s = t?.sessoes?.[Number(el.dataset.k)];
    if (!s) return;
    const v = el.value.trim();
    if (v) s.obs = v;
    else delete s.obs;
    setStatus('[data-notes-status]', 'Salvando…');
    debounceSave(`sess:${t.id}`, () => {
      persist(db.update('dailyTasks', t.id, { sessoes: t.sessoes }));
      setStatus('[data-notes-status]', 'Salvo ✓');
    });
  } else if (el.matches('[data-journal]')) {
    const d = el.dataset.date;
    S.journal[d] = { ...S.journal[d], id: d, texto: el.value };
    const n = palavras(el.value);
    setStatus('[data-journal-count]', `${n} palavra${n === 1 ? '' : 's'}`);
    setStatus('[data-journal-status]', 'Salvando…');
    debounceSave(`diario:${d}`, () => saveJournal(d), 900);
  } else if (el.matches('[data-journal-search]')) {
    S.journalBusca = el.value;
    $('#journal-list').innerHTML = journalListHTML();
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li[data-action="rel-dias"]')) {
    e.preventDefault();
    e.target.click();
  }
});

// Ao sair da página ou do app, salva o que ainda estiver sendo digitado.
window.addEventListener('pagehide', flushSaves);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) flushSaves();
});

window.addEventListener('hashchange', () => {
  if (!/^#\/?(hoje|horarios)$/.test(location.hash)) S.diaPop = null;
  flushSaves();
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
  if (S.user && S.ready && !modal.open && !document.hidden && !typing && (S.diaPop || ['painel', 'calendario', 'relatorios'].includes(currentRoute()))) {
    render();
  }
}, 60_000);

setInterval(notifTick, 30_000);

// Cronômetros rodando e o relógio: atualiza só o número na tela, a cada segundo.
setInterval(() => {
  document.querySelectorAll('[data-live]').forEach((el) => {
    el.textContent = U.fmtRelogio(Number(el.dataset.base) + (Date.now() - Number(el.dataset.start)) / 1000);
  });
  const hora = U.horaBR();
  document.querySelectorAll('[data-clock]').forEach((el) => {
    if (el.textContent !== hora) el.textContent = hora;
  });
  const dia = U.fmtDiaLongo(U.todayStr());
  document.querySelectorAll('[data-hoje]').forEach((el) => {
    if (el.textContent !== dia) el.textContent = dia;
  });
}, 1000);

// Voltando ao app depois de um tempo: recarrega os dias (pode ter mudado em outro aparelho).
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    hiddenAt = Date.now();
  } else if (S.user && S.ready && Date.now() - hiddenAt > 5 * 60_000) {
    // Com uma janela aberta (notas, Concluir…), recarrega só quando ela fechar: senão a janela perde a tarefa.
    if (modal.open) recarregarDias = true;
    else recarregaDias();
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
