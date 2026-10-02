// Funções utilitárias: datas, horários, texto.

const pad = (n) => String(n).padStart(2, '0');

export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const parseYmd = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const addDays = (s, n) => {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
};

export const addMonths = (yyyyMm, n) => {
  const [y, m] = yyyyMm.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

export const todayStr = () => ymd(new Date());

export const weekdayOf = (s) => parseYmd(s).getDay();

export const DIAS_CURTO = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const DIAS_LETRA = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];
// Ordem de exibição da semana: segunda a domingo.
export const ORDEM_SEMANA = [1, 2, 3, 4, 5, 6, 0];

export const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const fmtLongo = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtMesAno = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' });

export const fmtDiaLongo = (s) => cap(fmtLongo.format(parseYmd(s)));
export const fmtMes = (yyyyMm) => cap(fmtMesAno.format(parseYmd(`${yyyyMm}-01`)));

export const relativo = (s) => {
  const diff = Math.round((parseYmd(s) - parseYmd(todayStr())) / 86400000);
  if (diff === 0) return 'Hoje';
  if (diff === 1) return 'Amanhã';
  if (diff === -1) return 'Ontem';
  return diff > 0 ? `Daqui a ${diff} dias` : `Há ${-diff} dias`;
};

export const toMin = (hhmm) => {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export const fromMin = (min) => `${pad(Math.floor(min / 60) % 24)}:${pad(min % 60)}`;

export const nowMin = () => {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
};

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const newId = () => {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
};

export const byHorarioTitulo = (a, b) =>
  (a.horario || '99:99').localeCompare(b.horario || '99:99') || (a.titulo || '').localeCompare(b.titulo || '', 'pt-BR');

export const byNome = (a, b) => (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
