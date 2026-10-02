// Envia os avisos do app Rotina para os aparelhos de cada pessoa.
// Roda no GitHub Actions a cada ~5 minutos (.github/workflows/notificacoes.yml).
//
// Para cada usuário com aparelhos cadastrados (users/{uid}/devices):
//   - calcula as tarefas de hoje no fuso horário da pessoa (rotina fixa + tarefas do dia);
//   - manda "Em X min: tarefa" para tarefas com horário e aviso ligado;
//   - manda o lembrete de pendências no horário escolhido, se estiver ligado.
// Cada aviso vira um documento em users/{uid}/notifLog, para nunca ser enviado duas vezes
// (nem pelo servidor, nem pelo app aberto).

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

// O GitHub pode atrasar a execução; avisos atrasados até este limite ainda são enviados.
const TOLERANCIA_MIN = 30;

const PADRAO = {
  notifTarefas: true,
  avisoAntes: 10,
  notifPendentes: false,
  notifPendentesHora: '21:00',
  fuso: 'America/Sao_Paulo',
};

const credencial = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!credencial) {
  console.log('Secret FIREBASE_SERVICE_ACCOUNT não configurado. Nada a fazer.');
  process.exit(0);
}

initializeApp({ credential: cert(JSON.parse(credencial)) });
const db = getFirestore();
const fcm = getMessaging();

const toMin = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};

function agoraNoFuso(fuso) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: fuso,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  const data = `${partes.year}-${partes.month}-${partes.day}`;
  return {
    data,
    min: Number(partes.hour) * 60 + Number(partes.minute),
    diaSemana: new Date(`${data}T12:00:00Z`).getUTCDay(),
  };
}

function diasAtras(data, n) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const fusoValido = (fuso) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: fuso });
    return true;
  } catch {
    return false;
  }
};

// Mesma regra do app (js/app.js): tarefas já geradas do dia + as da rotina que ainda não foram geradas.
function tarefasDoDia(recorrentes, doDia, data, diaSemana) {
  const jaGeradas = new Set(doDia.map((t) => t.recurringTaskId).filter(Boolean));
  const virtuais = recorrentes
    .filter(
      (r) =>
        r.ativo !== false &&
        (r.diasDaSemana || []).includes(diaSemana) &&
        (!r.inicio || data >= r.inicio) &&
        !jaGeradas.has(r.id),
    )
    .map((r) => ({
      id: `${r.id}_${data}`,
      titulo: r.titulo,
      categoriaId: r.categoriaId,
      clienteId: r.clienteId || null,
      horario: r.horario || null,
      aviso: r.aviso ?? null,
      avisoAntes: r.avisoAntes ?? null,
      concluido: false,
      removido: false,
    }));
  return [...doDia, ...virtuais].filter((t) => !t.removido);
}

async function processarUsuario(userDoc) {
  const ref = userDoc.ref;
  const aparelhos = (await ref.collection('devices').get()).docs.filter((d) => d.get('token'));
  if (!aparelhos.length) return 0;

  const p = { ...PADRAO, ...userDoc.data() };
  const fuso = fusoValido(p.fuso) ? p.fuso : PADRAO.fuso;
  const { data, min, diaSemana } = agoraNoFuso(fuso);

  const lista = (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  const [recorrentes, doDia] = await Promise.all([
    ref.collection('recurringTasks').get().then(lista),
    ref.collection('dailyTasks').where('data', '==', data).get().then(lista),
  ]);
  const tarefas = tarefasDoDia(recorrentes, doDia, data, diaSemana);

  const avisos = [];
  if (p.notifTarefas) {
    for (const t of tarefas) {
      if (t.concluido || !t.horario || t.aviso === false) continue;
      const antes = Number.isFinite(t.avisoAntes) ? t.avisoAntes : Number(p.avisoAntes) || 0;
      const disparo = toMin(t.horario) - antes;
      if (min >= disparo && min - disparo <= TOLERANCIA_MIN) {
        avisos.push({ chave: `${data}_${t.id}_tarefa`, tipo: 'tarefa', tarefa: t, antes });
      }
    }
  }
  const pendentes = tarefas.filter((t) => !t.concluido);
  if (p.notifPendentes && p.notifPendentesHora && pendentes.length) {
    const disparo = toMin(p.notifPendentesHora);
    if (min >= disparo && min - disparo <= TOLERANCIA_MIN) {
      const n = pendentes.length;
      avisos.push({
        chave: `${data}_pendentes`,
        tipo: 'pendentes',
        title: n === 1 ? 'Ainda falta 1 tarefa hoje' : `Ainda faltam ${n} tarefas hoje`,
        body: pendentes.slice(0, 3).map((t) => t.titulo).join(', ') + (n > 3 ? ` e mais ${n - 3}` : ''),
      });
    }
  }

  // Limpa o histórico de avisos com mais de 2 dias.
  const antigos = await ref.collection('notifLog').where('data', '<', diasAtras(data, 2)).limit(400).get();
  if (!antigos.empty) {
    const b = db.batch();
    antigos.docs.forEach((d) => b.delete(d.ref));
    await b.commit();
  }

  if (!avisos.length) return 0;

  // Nomes de categoria e cliente para o texto do aviso.
  const [cats, clis] = await Promise.all([
    ref.collection('categories').get().then(lista),
    ref.collection('clients').get().then(lista),
  ]);
  const nome = (arr, id) => arr.find((x) => x.id === id)?.nome;

  let enviados = 0;
  for (const a of avisos) {
    // create() falha se o documento já existe: garante que cada aviso só sai uma vez.
    try {
      await ref.collection('notifLog').doc(a.chave).create({ data, tipo: a.tipo, origem: 'servidor', criadoEm: FieldValue.serverTimestamp() });
    } catch (err) {
      if (err.code === 6) continue; // já enviado (pelo servidor ou pelo app aberto)
      throw err;
    }

    let { title, body } = a;
    if (a.tipo === 'tarefa') {
      const t = a.tarefa;
      title = a.antes > 0 ? `Em ${a.antes} min: ${t.titulo}` : `Agora: ${t.titulo}`;
      body = [t.horario, nome(cats, t.categoriaId), nome(clis, t.clienteId)].filter(Boolean).join(' · ');
    }

    const res = await fcm.sendEachForMulticast({
      tokens: aparelhos.map((d) => d.get('token')),
      data: { title, body, tag: a.chave, url: './#/hoje' },
      webpush: { headers: { Urgency: 'high', TTL: String(TOLERANCIA_MIN * 60) } },
    });

    // Aparelhos que desinstalaram o app ou bloquearam os avisos saem da lista.
    await Promise.all(
      res.responses.map((r, i) =>
        !r.success &&
        ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(r.error?.code)
          ? aparelhos[i].ref.delete()
          : null,
      ),
    );
    enviados += res.successCount;
  }
  return enviados;
}

const usuarios = await db.collection('users').get();
let total = 0;
let falhas = 0;
for (const u of usuarios.docs) {
  try {
    total += await processarUsuario(u);
  } catch (err) {
    falhas++;
    console.error(`Erro no usuário ${u.id}:`, err.message);
  }
}
console.log(`${usuarios.size} usuário(s) verificados, ${total} aviso(s) enviados.`);
if (falhas && falhas === usuarios.size) process.exit(1);
