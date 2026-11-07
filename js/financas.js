// Finanças: contas, cartões, entradas, saídas, transferências, fluxo de caixa e estimativa de gastos.
// Os dados ficam em users/{uid}/fin* e só carregam quando a aba é aberta.
//
// Regras (iguais às do Notion de onde o histórico veio):
// - Saldo de uma conta = lançamentos realizados dela + transferências realizadas.
// - Compra no cartão entra na data de vencimento da fatura e fica "prevista" até a fatura ser paga.
//   Limite usado = compras do cartão ainda não pagas.

const COLS = {
  contas: 'finContas',
  cartoes: 'finCartoes',
  cats: 'finCats',
  tx: 'finTx',
  transf: 'finTransf',
  estim: 'finEstim',
};
const GRUPOS = [
  ['entrada', 'Entrada'],
  ['fixo', 'Custo fixo'],
  ['variavel', 'Custo variável'],
  ['aporte', 'Aporte'],
];
const CORES = ['#8b5cf6', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#f97316', '#ef4444', '#ec4899', '#06b6d4', '#64748b'];
const TABS = [
  ['resumo', 'Resumo'],
  ['extrato', 'Extrato'],
  ['receitas', 'Receitas'],
  ['despesas', 'Despesas'],
  ['transf', 'Transferências'],
  ['contas', 'Contas'],
  ['estimativa', 'Estimativa'],
  ['hora', 'Por hora'],
];

export function createFin(ctx) {
  const { S, db, U, esc, icon, openModal, closeModal, toast, persist, render, ask, modalHead, modalFoot, isAtivo, norm } = ctx;
  const { workCatId, ensureRange, elapsed, visible } = ctx;

  // -------------------------------------------------------------------------
  // Estado e dados
  // -------------------------------------------------------------------------

  S.fin = null;
  S.finMes = U.todayStr().slice(0, 7);
  S.finTab = 'resumo';
  S.finSemana = null; // segunda-feira da semana aberta no calendário de gastos
  S.finDia = null;
  S.finHoraPer = 'mes';
  S.finExt = { tipo: '', onde: '', n: 60 }; // Extrato: filtros e quantos itens mostrar
  S.finF = {
    receitas: { per: 'mes', de: '', ate: '', cli: '', cat: '', q: '' },
    despesas: { per: 'mes', de: '', ate: '', cat: '', onde: '', q: '' },
  };
  let carregando = null;

  function load(force = false) {
    if (carregando && !force) return carregando;
    carregando = Promise.all(Object.values(COLS).map((c) => db.list(c)))
      .then(([contas, cartoes, cats, tx, transf, estim]) => {
        const porNome = (a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
        S.fin = {
          contas: contas.sort(porNome),
          cartoes: cartoes.sort(porNome),
          cats: cats.sort(porNome),
          tx,
          transf,
          estim: estim.sort((a, b) => (a.dia || 99) - (b.dia || 99) || (a.motivo || '').localeCompare(b.motivo || '', 'pt-BR')),
        };
        render();
      })
      .catch((err) => {
        carregando = null;
        console.error(err);
        toast('Não foi possível carregar as finanças.');
      });
    return carregando;
  }

  const F = () => S.fin;
  const contaById = (id) => F().contas.find((c) => c.id === id);
  const cartaoById = (id) => F().cartoes.find((c) => c.id === id);
  const catFin = (id) => F().cats.find((c) => c.id === id);
  const cliById = (id) => S.clients.find((c) => c.id === id);
  const cliNome = (id) => cliById(id)?.nome || '';
  const sinal = (t) => (t.tipo === 'entrada' ? 1 : -1);
  const r2 = (v) => Math.round(v * 100) / 100;

  // -------------------------------------------------------------------------
  // Dinheiro e datas
  // -------------------------------------------------------------------------

  const fmtBRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
  const fmtBRL0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
  const brl = (v) => fmtBRL.format(r2(v) || 0).replace(/ /g, ' ');
  const brlCurto = (v) => fmtBRL0.format(Math.round(v) || 0).replace(/ /g, ' ');
  const comSinal = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + brl(Math.abs(v));

  // "1.234,56", "1234,56", "1234.56" e "R$ 50" viram número.
  function valorDe(txt) {
    let s = String(txt ?? '').replace(/[R$\s ]/g, '');
    if (!s) return NaN;
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    else if ((s.match(/\./g) || []).length > 1 || /\.\d{3}$/.test(s)) s = s.replace(/\./g, '');
    return r2(Math.abs(Number(s)));
  }
  const valorInput = (v) => (v ? String(r2(v).toFixed(2)).replace('.', ',') : '');

  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const mesCurto = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]}/${ym.slice(2, 4)}`;
  const diaMes = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  const fimDoMes = (ym) => U.addDays(`${U.addMonths(ym, 1)}-01`, -1);
  const diaNoMes = (ym, dia) => {
    const ult = Number(fimDoMes(ym).slice(8));
    return `${ym}-${String(Math.min(Math.max(1, dia || 1), ult)).padStart(2, '0')}`;
  };
  const segundaDe = (d) => U.addDays(d, -((U.weekdayOf(d) + 6) % 7));

  // Fatura em que cai uma compra feita hoje (fecha no dia "fecha", vence no dia "venc").
  function faturaPadrao(k, hoje = U.todayStr()) {
    const ym = hoje.slice(0, 7);
    const fecha = k.fecha || 3;
    const venc = k.venc || 10;
    let mesFecha = Number(hoje.slice(8)) <= fecha ? ym : U.addMonths(ym, 1);
    return venc > fecha ? mesFecha : U.addMonths(mesFecha, 1);
  }

  // -------------------------------------------------------------------------
  // Contas
  // -------------------------------------------------------------------------

  function saldos() {
    const m = {};
    for (const c of F().contas) m[c.id] = 0;
    for (const t of F().tx) if (t.realizado && t.contaId in m) m[t.contaId] += sinal(t) * t.valor;
    for (const t of F().transf) {
      if (!t.realizado) continue;
      if (t.paraId in m) m[t.paraId] += t.valor;
      if (t.deId in m) m[t.deId] -= t.valor;
    }
    for (const k in m) m[k] = r2(m[k]) || 0; // sem "-0,00" de arredondamento
    return m;
  }
  const soma = (arr) => r2(arr.reduce((s, t) => s + t.valor, 0));
  const doMes = (ym) => F().tx.filter((t) => t.data?.startsWith(ym));
  const doCartao = (id) => F().tx.filter((t) => t.cartaoId === id);
  const usado = (k) => soma(doCartao(k.id).filter((t) => !t.realizado && t.tipo === 'saida'));
  const fatura = (k, ym) => doCartao(k.id).filter((t) => t.data?.startsWith(ym) && t.tipo === 'saida');
  const ondeTxt = (t) => {
    const k = t.cartaoId && cartaoById(t.cartaoId);
    return k ? k.nome : contaById(t.contaId)?.nome || 'Sem conta';
  };
  const corDe = (t) => (t.cartaoId && cartaoById(t.cartaoId)?.cor) || contaById(t.contaId)?.cor || '#94a3b8';

  // -------------------------------------------------------------------------
  // Tela
  // -------------------------------------------------------------------------

  function view() {
    if (!S.fin) {
      load();
      return `<header class="page-head"><div><p class="eyebrow">Dinheiro</p><h1>Finanças</h1></div></header>
        <div class="loading"><span></span><span></span><span></span></div>`;
    }
    // No celular as abas rolam para o lado: deixa a aba aberta à vista depois de desenhar.
    setTimeout(() => {
      const nav = document.querySelector('.fin-tabs');
      const on = nav?.querySelector('.fin-tab.on');
      if (!on) return;
      const n = nav.getBoundingClientRect();
      const o = on.getBoundingClientRect();
      if (o.right > n.right || o.left < n.left) nav.scrollLeft += o.left - n.left - (n.width - o.width) / 2;
    });
    const corpo = { resumo: resumoHTML, receitas: () => listaPage('receitas'), despesas: () => listaPage('despesas'), contas: contasHTML, estimativa: estimHTML, hora: horaHTML, extrato: extratoHTML, transf: transfHTML }[S.finTab] || resumoHTML;
    return `
    <header class="page-head fin-head">
      <div><p class="eyebrow">Dinheiro</p><h1>Finanças</h1></div>
      <div class="fin-mes">
        <button type="button" class="icon-btn" data-action="fin-mes" data-n="-1" aria-label="Mês anterior">${icon('left')}</button>
        <button type="button" class="fin-mes-nome" data-action="fin-mes" data-n="0" title="Voltar para este mês">${esc(U.fmtMes(S.finMes))}</button>
        <button type="button" class="icon-btn" data-action="fin-mes" data-n="1" aria-label="Próximo mês">${icon('right')}</button>
      </div>
    </header>
    <div class="fin-quick">
      <button type="button" class="fin-q in" data-action="fin-new-tx" data-tipo="entrada">${icon('plus')}<span>Entrada</span></button>
      <button type="button" class="fin-q out" data-action="fin-new-tx" data-tipo="saida">${icon('menos')}<span>Saída</span></button>
      <button type="button" class="fin-q tr" data-action="fin-new-transf">${icon('transferir')}<span>Transferir</span></button>
    </div>
    <nav class="fin-tabs" aria-label="Partes das finanças">
      ${TABS.map(([id, l]) => `<button type="button" class="fin-tab${S.finTab === id ? ' on' : ''}" data-action="fin-tab" data-tab="${id}" ${S.finTab === id ? 'aria-current="page"' : ''}>${l}</button>`).join('')}
    </nav>
    ${F().contas.length || F().tx.length ? corpo() : vazioHTML()}`;
  }

  function vazioHTML() {
    return `<section class="card fin-vazio">
      <h2 class="card-title">${icon('financas')}Comece pelas contas</h2>
      <p class="muted">Cadastre seus bancos e cartões, ou importe o histórico do Notion (o arquivo que o Claude monta).</p>
      <div class="btn-row">
        <button type="button" class="btn primary" data-action="fin-new-conta">${icon('plus')}Conta</button>
        <button type="button" class="btn ghost" data-action="fin-new-cartao">${icon('plus')}Cartão</button>
        <label class="btn ghost">${icon('download')}Importar arquivo<input type="file" accept=".json,application/json" data-import-file hidden></label>
      </div>
    </section>`;
  }

  // Linha de um lançamento, no estilo de lista do Notion.
  const horaDe = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  function txRow(t, { data = true, lancado = 0 } = {}) {
    // No cartão a "data" é o vencimento da fatura; o dia da compra aparece à parte.
    const quando = t.cartaoId ? (t.dataCompra ? `compra ${diaMes(t.dataCompra)}` : '') : data ? diaMes(t.data) : '';
    const fat = t.cartaoId && data ? `fatura ${mesCurto(t.data.slice(0, 7))}` : '';
    const nItens = t.itens?.length > 1 ? `${t.itens.length} gastos` : '';
    const meta = [lancado ? `lançado ${horaDe(lancado)}` : '', quando, fat, catFin(t.catId)?.nome, nItens, ondeTxt(t), cliNome(t.clienteId), t.parcela ? `${t.parcela}/${t.parcelas}` : '']
      .filter(Boolean)
      .map(esc)
      .join(' · ');
    const rotulo = t.tipo === 'entrada' ? (t.realizado ? 'Recebido' : 'Marcar como recebido') : t.realizado ? 'Pago' : 'Marcar como pago';
    return `<li class="tx${t.realizado ? '' : ' prev'}" style="--c:${corDe(t)}">
      <button type="button" class="tx-check${t.realizado ? ' on' : ''}" data-action="fin-toggle" data-id="${t.id}" aria-label="${rotulo}" title="${rotulo}">${icon('check')}</button>
      <button type="button" class="tx-main" data-action="fin-edit-tx" data-id="${t.id}">
        <span class="tx-nome">${esc(t.nome)}${t.realizado ? '' : ' <small class="chip tx-prev">previsto</small>'}</span>
        <span class="tx-meta">${meta}</span>
      </button>
      <span class="tx-val ${t.tipo === 'entrada' ? 'in' : 'out'}">${t.tipo === 'entrada' ? '+' : '−'}${brl(t.valor)}</span>
    </li>`;
  }
  const ordemTx = (a, b) => b.data.localeCompare(a.data) || (a.nome || '').localeCompare(b.nome || '', 'pt-BR');

  // ---------- Resumo ----------

  function resumoHTML() {
    const sal = saldos();
    const total = r2(Object.values(sal).reduce((s, v) => s + v, 0));
    const ym = S.finMes;
    const mes = doMes(ym).filter((t) => t.contaId || t.cartaoId);
    const ent = mes.filter((t) => t.tipo === 'entrada');
    const sai = mes.filter((t) => t.tipo === 'saida');
    const fim = fimDoMes(ym);
    // Previsto até o fim do mês aberto: saldo de hoje + o que ainda não aconteceu até lá.
    const pendentes = F().tx.filter((t) => !t.realizado && t.contaId && t.data <= fim);
    const previsto = r2(total + pendentes.reduce((s, t) => s + sinal(t) * t.valor, 0));

    const contas = F().contas.filter((c) => !c.arquivada || Math.abs(sal[c.id]) > 0.004);
    const linhaConta = (c) => `<li><button type="button" data-action="fin-edit-conta" data-id="${c.id}">
      <span class="dot" style="--c:${c.cor || '#64748b'}"></span><span class="grow">${esc(c.nome)}</span>
      <strong class="${sal[c.id] < 0 ? 'neg' : ''}">${brl(sal[c.id])}</strong></button></li>`;

    return `<div class="fin-grid">
      <section class="card fin-saldo">
        <p class="muted sm">Saldo total</p>
        <p class="fin-big ${total < 0 ? 'neg' : ''}">${brl(total)}</p>
        <p class="muted sm">Previsto no fim de ${esc(mesCurto(ym))}: <strong>${brl(previsto)}</strong></p>
        <ul class="fin-contas">${contas.map(linhaConta).join('')}</ul>
      </section>

      <section class="card fin-mesbox">
        <h2 class="card-title">${icon('calendario')}${esc(U.fmtMes(ym))}</h2>
        <div class="fin-kpis">
          ${kpi('Entradas', soma(ent.filter((t) => t.realizado)), soma(ent), 'in')}
          ${kpi('Saídas', soma(sai.filter((t) => t.realizado)), soma(sai), 'out')}
          ${kpi('Resultado', r2(soma(ent.filter((t) => t.realizado)) - soma(sai.filter((t) => t.realizado))), r2(soma(ent) - soma(sai)), 'res')}
        </div>
        ${categoriasDoMes(sai, ent)}
      </section>

      ${F().cartoes.length ? `<section class="card fin-cartoes"><h2 class="card-title">${icon('cartao')}Cartões</h2>${F().cartoes.map(cartaoCard).join('')}</section>` : ''}

      ${semanaHTML()}

      ${fluxoHTML()}
    </div>`;
  }

  function kpi(rotulo, real, prev, cls) {
    const v = cls === 'res' ? comSinal(real) : brl(real);
    const p = cls === 'res' ? comSinal(prev) : brl(prev);
    return `<div class="kpi ${cls}${cls === 'res' && real < 0 ? ' neg' : ''}"><span class="muted sm">${rotulo}</span><strong>${v}</strong>
      ${Math.abs(prev - real) > 0.004 ? `<small class="muted">previsto ${p}</small>` : '<small class="muted">&nbsp;</small>'}</div>`;
  }

  // Saldo por categoria: abre numa janela, para não empurrar os cartões para baixo.
  function categoriasDoMes(sai, ent) {
    if (!sai.length && !ent.length) return '';
    return `<button type="button" class="fin-cats-btn" data-action="fin-cats-mes">${icon('right')}Por categoria</button>`;
  }
  function openCatsMes() {
    const mes = doMes(S.finMes).filter((t) => t.contaId || t.cartaoId);
    const por = new Map();
    for (const t of mes) {
      const k = (t.catId && catFin(t.catId)?.nome) || 'Sem descrição';
      por.set(k, r2((por.get(k) || 0) + sinal(t) * t.valor));
    }
    const linhas = [...por.entries()].sort((a, b) => b[1] - a[1]);
    const lista = (arr) => arr.map(([n, v]) => `<li><span>${esc(n)}</span><strong class="${v < 0 ? 'neg' : 'pos'}">${comSinal(v)}</strong></li>`).join('');
    const ganhos = linhas.filter(([, v]) => v > 0);
    const gastos = linhas.filter(([, v]) => v <= 0).reverse();
    openModal(`<div class="modal-body fin-form">
      ${modalHead(`Por categoria · ${esc(mesCurto(S.finMes))}`)}
      ${ganhos.length ? `<p class="fin-grupo pos">Ganhos</p><ul class="fin-cats-lista">${lista(ganhos)}</ul>` : ''}
      ${gastos.length ? `<p class="fin-grupo neg">Gastos</p><ul class="fin-cats-lista">${lista(gastos)}</ul>` : ''}
      ${linhas.length ? '' : '<p class="muted">Nada neste mês.</p>'}
    </div>`);
  }

  function cartaoCard(k) {
    const u = usado(k);
    const pct = k.limite ? Math.min(100, Math.round((u * 100) / k.limite)) : 0;
    const fat = fatura(k, S.finMes);
    const valorFat = soma(fat);
    const aberta = fat.filter((t) => !t.realizado);
    const estado = !fat.length ? 'Sem compras' : aberta.length ? `vence ${String(k.venc || 10).padStart(2, '0')}/${S.finMes.slice(5)}` : 'Paga';
    return `<div class="fin-cartao" style="--c:${k.cor || '#8b5cf6'}">
      <div class="fin-cartao-top">
        <button type="button" class="link-plain" data-action="fin-edit-cartao" data-id="${k.id}"><span class="dot"></span><strong>${esc(k.nome)}</strong></button>
        <span class="muted sm">Fatura de ${esc(mesCurto(S.finMes))}: <strong>${brl(valorFat)}</strong> · ${estado}</span>
      </div>
      <div class="bar" role="img" aria-label="${pct}% do limite usado"><span style="width:${pct}%"></span></div>
      <div class="fin-cartao-foot muted sm">
        <span>Usado ${brl(u)} de ${brl(k.limite || 0)}</span><span>Disponível <strong>${brl((k.limite || 0) - u)}</strong></span>
      </div>
      <div class="btn-row">
        <button type="button" class="btn soft sm" data-action="fin-gasto-cartao" data-id="${k.id}">${icon('plus')}Adicionar gasto</button>
        <button type="button" class="btn ghost sm" data-action="fin-fatura" data-id="${k.id}">${icon('nota')}Ver fatura</button>
        ${aberta.length ? `<button type="button" class="btn ghost sm" data-action="fin-pagar" data-id="${k.id}">${icon('check')}Pagar fatura</button>` : ''}
      </div>
    </div>`;
  }

  // Calendário semanal de gastos.
  function semanaHTML() {
    const hoje = U.todayStr();
    if (!S.finSemana) S.finSemana = segundaDe(S.finMes === hoje.slice(0, 7) ? hoje : `${S.finMes}-01`);
    const dias = Array.from({ length: 7 }, (_, i) => U.addDays(S.finSemana, i));
    const gastos = (d) => F().tx.filter((t) => t.data === d && t.tipo === 'saida');
    const totais = dias.map((d) => soma(gastos(d)));
    const max = Math.max(...totais, 1);
    const sel = S.finDia && dias.includes(S.finDia) ? S.finDia : null;
    const lista = sel ? F().tx.filter((t) => t.data === sel).sort(ordemTx) : [];
    return `<section class="card fin-semana">
      <header class="fin-sec-head">
        <h2 class="card-title">${icon('relatorios')}Gastos da semana</h2>
        <div class="fin-mes sm">
          <button type="button" class="icon-btn sm" data-action="fin-semana" data-n="-7" aria-label="Semana anterior">${icon('left')}</button>
          <span class="muted sm">${diaMes(dias[0])} a ${diaMes(dias[6])}</span>
          <button type="button" class="icon-btn sm" data-action="fin-semana" data-n="7" aria-label="Próxima semana">${icon('right')}</button>
        </div>
      </header>
      <div class="fin-week">
        ${dias
          .map(
            (d, i) => `<button type="button" class="fin-day${d === hoje ? ' today' : ''}${d === sel ? ' on' : ''}" data-action="fin-dia" data-date="${d}">
            <span class="fin-day-n">${U.DIAS_CURTO[U.weekdayOf(d)]} ${d.slice(8)}</span>
            <span class="fin-day-bar"><span style="height:${Math.round((totais[i] * 100) / max)}%"></span></span>
            <span class="fin-day-v">${totais[i] ? brlCurto(totais[i]) : '–'}</span></button>`,
          )
          .join('')}
      </div>
      <p class="muted sm">Total da semana: <strong>${brl(totais.reduce((s, v) => s + v, 0))}</strong>${sel ? '' : ' · toque num dia para ver os lançamentos'}</p>
      ${sel ? (lista.length ? `<ul class="tx-list">${lista.map((t) => txRow(t, { data: false })).join('')}</ul>` : '<p class="muted sm">Nada neste dia.</p>') : ''}
    </section>`;
  }

  // Balanço mensal: 5 meses antes até 6 depois do mês aberto, com o saldo no fim de cada mês.
  function fluxoHTML() {
    const meses = Array.from({ length: 12 }, (_, i) => U.addMonths(S.finMes, i - 5));
    const comConta = F().tx.filter((t) => t.contaId);
    const sal = saldos();
    const hojeTotal = Object.values(sal).reduce((s, v) => s + v, 0);
    const hoje = U.todayStr();
    // Saldo no fim do mês = saldo de hoje ± o que ainda vai acontecer (ou já aconteceu) até lá.
    const saldoFim = (ym) => {
      const fim = fimDoMes(ym);
      let v = hojeTotal;
      for (const t of comConta) {
        if (!t.realizado && t.data <= fim) v += sinal(t) * t.valor;
        if (t.realizado && t.data > fim && fim < hoje) v -= sinal(t) * t.valor;
      }
      return r2(v);
    };
    const linhas = meses.map((ym) => {
      const ts = comConta.filter((t) => t.data.startsWith(ym));
      const e = soma(ts.filter((t) => t.tipo === 'entrada'));
      const s = soma(ts.filter((t) => t.tipo === 'saida'));
      return { ym, e, s, r: r2(e - s), fim: saldoFim(ym) };
    });
    const max = Math.max(...linhas.map((l) => Math.max(l.e, l.s)), 1);
    return `<section class="card fin-fluxo">
      <h2 class="card-title">${icon('rotina')}Balanço mensal</h2>
      <div class="fluxo">
        <div class="fluxo-row fluxo-head muted sm"><span>Mês</span><span>Entradas</span><span>Saídas</span><span>Saldo no fim</span></div>
        ${linhas
          .map(
            (l) => `<button type="button" class="fluxo-row${l.ym === S.finMes ? ' on' : ''}${l.ym > hoje.slice(0, 7) ? ' futuro' : ''}" data-action="fin-ir-mes" data-mes="${l.ym}">
            <span>${esc(mesCurto(l.ym))}</span>
            <span class="pos"><i class="fbar in" style="width:${Math.round((l.e * 100) / max)}%"></i>${brlCurto(l.e)}</span>
            <span class="neg"><i class="fbar out" style="width:${Math.round((l.s * 100) / max)}%"></i>${brlCurto(l.s)}</span>
            <span class="${l.fim < 0 ? 'neg' : ''}"><strong>${brlCurto(l.fim)}</strong><small class="${l.r < 0 ? 'neg' : 'pos'}">${l.r < 0 ? '−' : '+'}${brlCurto(Math.abs(l.r))}</small></span>
          </button>`,
          )
          .join('')}
      </div>
      <p class="muted sm">Meses futuros mostram o que já está lançado como previsto (parcelas, contas fixas).</p>
    </section>`;
  }

  // ---------- Extrato: o que foi lançado, do último para o primeiro ----------
  // Serve para conferir com o app do banco/cartão o que já foi lançado e o que falta.

  function extratoHTML() {
    const f = S.finExt;
    // O histórico importado tem o mesmo "criadoEm" para tudo: vai num bloco só, no fim, por data.
    const lote = new Map();
    for (const t of F().tx) lote.set(t.criadoEm || 0, (lote.get(t.criadoEm || 0) || 0) + 1);
    const veioDoNotion = (t) => !t.mexidoEm && (!!t.importado || !t.criadoEm || lote.get(t.criadoEm) >= 20);
    const quandoLancou = (t) => t.mexidoEm || t.criadoEm || 0;
    const dataOrd = (t) => t.dataCompra || t.data || '';
    const hoje = U.todayStr();
    const ontem = U.addDays(hoje, -1);
    // Futuras: o que vence depois deste mês (histórico do Notion) e as parcelas 2, 3… do que foi lançado aqui.
    // Ficam fora da lista normal e aparecem só no botão "Futuras".
    const limite = fimDoMes(hoje.slice(0, 7));
    const nivel = (t) => (!veioDoNotion(t) ? (t.parcela > 1 ? 2 : 0) : (t.data || '') <= limite ? 1 : 2);
    const futuras = f.tipo === 'futuras';
    const daOnde = (t) => !f.onde || f.onde === (t.cartaoId ? `k:${t.cartaoId}` : `c:${t.contaId}`);
    const nFut = F().tx.filter((t) => nivel(t) === 2 && daOnde(t)).length;
    const ts = F()
      .tx.filter((t) => daOnde(t) && (futuras ? nivel(t) === 2 : nivel(t) !== 2 && (!f.tipo || t.tipo === f.tipo)))
      .sort((a, b) => {
        const na = nivel(a);
        const nb = nivel(b);
        if (na !== nb) return na - nb;
        if (!na && quandoLancou(b) !== quandoLancou(a)) return quandoLancou(b) - quandoLancou(a);
        const d = na === 2 ? (a.data || '').localeCompare(b.data || '') : dataOrd(b).localeCompare(dataOrd(a));
        return d || (a.nome || '').localeCompare(b.nome || '', 'pt-BR');
      });
    const grupoDe = (t) => {
      const n = nivel(t);
      if (n === 2) return `Vence em ${U.fmtMes(t.data.slice(0, 7))}`;
      if (n === 1) return 'Histórico do Notion (por data)';
      const d = U.ymd(new Date(quandoLancou(t)));
      return d === hoje ? 'Lançado hoje' : d === ontem ? 'Lançado ontem' : `Lançado ${U.fmtDiaCurto(d)}`;
    };
    const mostra = ts.slice(0, f.n);
    let atual = '';
    const linhas = [];
    for (const t of mostra) {
      const g = grupoDe(t);
      if (g !== atual) {
        atual = g;
        linhas.push(`<li class="tx-dia"><span>${esc(g)}</span><span></span></li>`);
      }
      linhas.push(txRow(t, { lancado: nivel(t) === 0 ? quandoLancou(t) : 0 }));
    }
    const chip = (v, l, cls = '') => `<button type="button" class="tab-chip${cls}${f.tipo === v ? ' on' : ''}" data-action="fin-ext" data-v="${v}">${l}</button>`;
    const novosHoje = ts.filter((t) => !veioDoNotion(t) && U.ymd(new Date(quandoLancou(t))) === hoje);
    return `<section class="card fin-filtros">
      <div class="fin-f-row fin-ext-f">
        <div class="tab-chips">${chip('', 'Tudo')}${chip('saida', 'Saídas')}${chip('entrada', 'Entradas')}${chip('futuras', `Futuras${nFut ? ` (${nFut})` : ''}`, ' fut')}</div>
        <label class="field"><span>Conta ou cartão</span><select data-fin-ext="onde">${opt('', 'Todos', f.onde)}${F()
          .contas.map((c) => opt(`c:${c.id}`, c.nome, f.onde))
          .join('')}${F()
          .cartoes.map((k) => opt(`k:${k.id}`, k.nome, f.onde))
          .join('')}</select></label>
      </div>
      <p class="muted sm">${
        futuras
          ? 'Parcelas e contas que vencem nos próximos meses, da mais próxima à mais distante.'
          : `O último lançado fica em cima, para conferir com o app do banco ou do cartão.${
              novosHoje.length ? ` Hoje: <strong>${novosHoje.length}</strong> lançamento${novosHoje.length === 1 ? '' : 's'}.` : ''
            }`
      }</p>
    </section>
    ${ts.length ? `<ul class="tx-list card">${linhas.join('')}</ul>` : `<p class="muted fin-nada">${futuras ? 'Nada para os próximos meses.' : 'Nada lançado ainda.'}</p>`}
    ${ts.length > mostra.length ? `<div class="btn-row fin-mais"><button type="button" class="btn ghost" data-action="fin-ext-mais">Mostrar mais (${ts.length - mostra.length})</button></div>` : ''}`;
  }

  // ---------- Transferências do mês: de qual conta para qual, data e valor ----------

  function transfHTML() {
    const ts = F()
      .transf.filter((t) => t.data?.startsWith(S.finMes))
      .sort((a, b) => b.data.localeCompare(a.data) || (b.criadoEm || 0) - (a.criadoEm || 0));
    const linhas = [];
    let dia = '';
    for (const t of ts) {
      if (t.data !== dia) {
        dia = t.data;
        linhas.push(`<li class="tx-dia"><span>${esc(U.fmtDiaCurto(t.data))}</span><span></span></li>`);
      }
      linhas.push(`<li class="tx${t.realizado ? '' : ' prev'}">
        <span class="tx-check on" aria-hidden="true">${icon('transferir')}</span>
        <button type="button" class="tx-main" data-action="fin-edit-transf" data-id="${t.id}">
          <span class="tx-nome">${esc(t.nome)}${t.realizado ? '' : ' <small class="chip tx-prev">previsto</small>'}</span>
          <span class="tx-meta">${diaMes(t.data)} · ${esc(contaById(t.deId)?.nome || '?')} → ${esc(contaById(t.paraId)?.nome || '?')}</span>
        </button>
        <span class="tx-val">${brl(t.valor)}</span></li>`);
    }
    return `<section class="card fin-saldo">
        <p class="muted sm">Transferido em ${esc(mesCurto(S.finMes))}</p>
        <p class="fin-big">${brl(soma(ts))}</p>
        <p class="muted sm">${ts.length} transferência${ts.length === 1 ? '' : 's'}. Use as setas do mês lá em cima para ver outros meses.</p>
        <div class="btn-row"><button type="button" class="btn primary sm" data-action="fin-new-transf">${icon('plus')}Transferir</button></div>
      </section>
      ${ts.length ? `<ul class="tx-list card">${linhas.join('')}</ul>` : '<p class="muted fin-nada">Nenhuma transferência neste mês.</p>'}`;
  }

  // ---------- Receitas e despesas ----------

  function filtrados(kind) {
    const f = S.finF[kind];
    const tipo = kind === 'receitas' ? 'entrada' : 'saida';
    const q = norm(f.q || '');
    return F()
      .tx.filter((t) => {
        if (t.tipo !== tipo) return false;
        if (f.per === 'mes' && !t.data.startsWith(S.finMes)) return false;
        if (f.per === 'intervalo' && ((f.de && t.data < f.de) || (f.ate && t.data > f.ate))) return false;
        if (f.cli && (f.cli === '-' ? t.clienteId : t.clienteId !== f.cli)) return false;
        if (f.cat && (f.cat === '-' ? t.catId : t.catId !== f.cat)) return false;
        if (f.onde && f.onde !== (t.cartaoId ? `k:${t.cartaoId}` : `c:${t.contaId}`)) return false;
        if (q && !norm(`${t.nome} ${t.obs || ''} ${catFin(t.catId)?.nome || ''} ${cliNome(t.clienteId)}`).includes(q)) return false;
        return true;
      })
      .sort(ordemTx);
  }

  function listaPage(kind) {
    const f = S.finF[kind];
    const rec = kind === 'receitas';
    const usadas = new Set(F().tx.filter((t) => t.tipo === (rec ? 'entrada' : 'saida')).map((t) => t.catId));
    const cats = F().cats.filter((c) => usadas.has(c.id) || (rec ? c.grupo === 'entrada' : c.grupo !== 'entrada'));
    const opt = (v, l, sel) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`;
    const clis = [...new Set(F().tx.filter((t) => t.tipo === 'entrada' && t.clienteId).map((t) => t.clienteId))]
      .map(cliById)
      .filter(Boolean)
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
    return `<section class="card fin-filtros" data-fin-kind="${kind}">
      <div class="fin-f-row">
        <label class="field fin-busca">${icon('busca')}<input type="search" placeholder="${rec ? 'Buscar nome, descrição, cliente' : 'Buscar nome ou descrição'}" value="${esc(f.q)}" data-fin-f="q" autocomplete="off"></label>
      </div>
      <div class="fin-f-row">
        <label class="field"><span>Período</span><select data-fin-f="per">
          ${opt('mes', U.fmtMes(S.finMes), f.per)}${opt('tudo', 'Todo o período', f.per)}${opt('intervalo', 'Escolher datas', f.per)}</select></label>
        ${
          f.per === 'intervalo'
            ? `<label class="field"><span>De</span><input type="date" value="${f.de}" data-fin-f="de"></label>
               <label class="field"><span>Até</span><input type="date" value="${f.ate}" data-fin-f="ate"></label>`
            : ''
        }
        <label class="field"><span>Descrição</span><select data-fin-f="cat">${opt('', 'Todas', f.cat)}${opt('-', 'Sem descrição', f.cat)}${cats.map((c) => opt(c.id, c.nome, f.cat)).join('')}</select></label>
        ${
          rec
            ? `<label class="field"><span>Cliente</span><select data-fin-f="cli">${opt('', 'Todos', f.cli)}${opt('-', 'Sem cliente', f.cli)}${clis.map((c) => opt(c.id, c.nome, f.cli)).join('')}</select></label>`
            : `<label class="field"><span>Conta ou cartão</span><select data-fin-f="onde">${opt('', 'Todos', f.onde)}${F().contas.map((c) => opt(`c:${c.id}`, c.nome, f.onde)).join('')}${F().cartoes.map((k) => opt(`k:${k.id}`, k.nome, f.onde)).join('')}</select></label>`
        }
      </div>
    </section>
    <div data-fin-lista>${listaHTML(kind)}</div>`;
  }

  function listaHTML(kind) {
    const ts = filtrados(kind);
    const rec = kind === 'receitas';
    const real = soma(ts.filter((t) => t.realizado));
    const tot = soma(ts);
    const f = S.finF[kind];
    const limpo = !f.q && !f.cat && !f.cli && !f.onde && f.per === 'mes';
    // Agrupado por dia, como uma lista do Notion.
    const grupos = new Map();
    for (const t of ts) grupos.set(t.data, [...(grupos.get(t.data) || []), t]);
    const MAX = 300;
    let n = 0;
    const blocos = [];
    for (const [d, arr] of grupos) {
      if (n >= MAX) break;
      n += arr.length;
      blocos.push(`<li class="tx-dia"><span>${esc(U.fmtDiaCurto(d))}</span><span>${brl(soma(arr))}</span></li>${arr.map((t) => txRow(t, { data: false })).join('')}`);
    }
    return `<div class="fin-total">
        <div><span class="muted sm">${ts.length} ${rec ? 'entrada' : 'saída'}${ts.length === 1 ? '' : 's'}</span>
        <strong class="${rec ? 'pos' : 'neg'}">${brl(tot)}</strong>
        ${Math.abs(tot - real) > 0.004 ? `<small class="muted">${rec ? 'recebido' : 'pago'} ${brl(real)} · previsto ${brl(tot - real)}</small>` : ''}</div>
        ${limpo ? '' : `<button type="button" class="btn ghost sm" data-action="fin-limpa" data-kind="${kind}">${icon('x')}Limpar filtros</button>`}
      </div>
      ${ts.length ? `<ul class="tx-list card">${blocos.join('')}</ul>${n < ts.length ? `<p class="muted sm">Mostrando ${n} de ${ts.length}. Use os filtros para achar o resto.</p>` : ''}` : `<p class="muted fin-nada">Nada encontrado.</p>`}`;
  }

  // ---------- Contas, cartões, transferências e descrições ----------

  function contasHTML() {
    const sal = saldos();
    const transf = F().transf.filter((t) => t.data.startsWith(S.finMes)).sort((a, b) => b.data.localeCompare(a.data));
    const grupoNome = (g) => GRUPOS.find((x) => x[0] === g)?.[1] || 'Outro';
    return `<div class="fin-grid">
      <section class="card">
        <header class="fin-sec-head"><h2 class="card-title">${icon('financas')}Contas</h2>
          <button type="button" class="btn ghost sm" data-action="fin-new-conta">${icon('plus')}Conta</button></header>
        <ul class="fin-contas">${F()
          .contas.map(
            (c) => `<li><button type="button" data-action="fin-edit-conta" data-id="${c.id}"><span class="dot" style="--c:${c.cor || '#64748b'}"></span>
            <span class="grow">${esc(c.nome)}${c.arquivada ? ' <small class="muted">(arquivada)</small>' : ''}</span><strong class="${sal[c.id] < 0 ? 'neg' : ''}">${brl(sal[c.id])}</strong></button></li>`,
          )
          .join('')}</ul>
      </section>
      <section class="card">
        <header class="fin-sec-head"><h2 class="card-title">${icon('cartao')}Cartões</h2>
          <button type="button" class="btn ghost sm" data-action="fin-new-cartao">${icon('plus')}Cartão</button></header>
        ${F().cartoes.length ? F().cartoes.map(cartaoCard).join('') : '<p class="muted sm">Nenhum cartão.</p>'}
      </section>
      <section class="card">
        <header class="fin-sec-head"><h2 class="card-title">${icon('transferir')}Transferências de ${esc(mesCurto(S.finMes))}</h2>
          <button type="button" class="btn ghost sm" data-action="fin-new-transf">${icon('plus')}Transferir</button></header>
        ${
          transf.length
            ? `<ul class="tx-list">${transf
                .map(
                  (t) => `<li class="tx${t.realizado ? '' : ' prev'}"><span class="tx-check on" aria-hidden="true">${icon('transferir')}</span>
              <button type="button" class="tx-main" data-action="fin-edit-transf" data-id="${t.id}"><span class="tx-nome">${esc(t.nome)}</span>
              <span class="tx-meta">${diaMes(t.data)} · ${esc(contaById(t.deId)?.nome || '?')} → ${esc(contaById(t.paraId)?.nome || '?')}</span></button>
              <span class="tx-val">${brl(t.valor)}</span></li>`,
                )
                .join('')}</ul>`
            : '<p class="muted sm">Nenhuma transferência neste mês.</p>'
        }
      </section>
      <section class="card">
        <header class="fin-sec-head"><h2 class="card-title">${icon('categorias')}Descrições</h2>
          <button type="button" class="btn ghost sm" data-action="fin-new-cat">${icon('plus')}Descrição</button></header>
        ${descricoesHTML(grupoNome)}
      </section>
      ${clientesHTML()}
      <section class="card">
        <h2 class="card-title">${icon('download')}Notion</h2>
        <p class="muted sm">Baixe os lançamentos novos em planilha (CSV) para juntar ao Notion com “Merge with CSV”.</p>
        <div class="btn-row">
          <button type="button" class="btn primary sm" data-action="fin-export">${icon('download')}Exportar para o Notion</button>
          <label class="btn ghost sm">${icon('plus')}Importar arquivo<input type="file" accept=".json,application/json" data-import-file hidden></label>
        </div>
      </section>
    </div>`;
  }

  // Descrições: ganhos em cima (verde), gastos embaixo (vermelho).
  function descricoesHTML(grupoNome) {
    const ganho = (c) => c.grupo === 'entrada' || c.grupo === 'aporte';
    const linha = (c) => `<li><button type="button" data-action="fin-edit-cat" data-id="${c.id}"><span class="grow">${esc(c.nome)}</span>
            <small class="chip">${grupoNome(c.grupo)}</small></button></li>`;
    const ordem = (a, b) => GRUPOS.findIndex((g) => g[0] === a.grupo) - GRUPOS.findIndex((g) => g[0] === b.grupo) || a.nome.localeCompare(b.nome, 'pt-BR');
    const ganhos = F().cats.filter(ganho).sort(ordem);
    const gastos = F().cats.filter((c) => !ganho(c)).sort(ordem);
    if (!F().cats.length) return '<p class="muted sm">Nenhuma descrição.</p>';
    return `${ganhos.length ? `<p class="fin-grupo pos">Ganhos</p><ul class="fin-contas fin-desc pos">${ganhos.map(linha).join('')}</ul>` : ''}
      ${gastos.length ? `<p class="fin-grupo neg">Gastos</p><ul class="fin-contas fin-desc neg">${gastos.map(linha).join('')}</ul>` : ''}`;
  }

  // Clientes: criar e editar daqui mesmo, com o que entrou de cada um no mês.
  function clientesHTML() {
    const rec = new Map();
    for (const t of doMes(S.finMes)) if (t.tipo === 'entrada' && t.clienteId) rec.set(t.clienteId, r2((rec.get(t.clienteId) || 0) + t.valor));
    const nome = (a, b) => a.nome.localeCompare(b.nome, 'pt-BR');
    const ativos = S.clients.filter(isAtivo).sort((a, b) => (rec.get(b.id) || 0) - (rec.get(a.id) || 0) || nome(a, b));
    const fim = S.clients.filter((c) => !isAtivo(c)).sort(nome);
    const linha = (c) => `<li><button type="button" data-action="edit-client" data-id="${c.id}"><span class="grow">${esc(c.nome)}${
      c.soFinanceiro ? ' <small class="chip">Só financeiro</small>' : ''
    }</span>${rec.get(c.id) ? `<strong class="pos">${brl(rec.get(c.id))}</strong>` : '<small class="muted">—</small>'}</button></li>`;
    return `<section class="card">
        <header class="fin-sec-head"><h2 class="card-title">${icon('clientes')}Clientes</h2>
          <button type="button" class="btn ghost sm" data-action="new-client">${icon('plus')}Cliente</button></header>
        <p class="muted sm">Valor recebido em ${esc(mesCurto(S.finMes))}. Toque para editar.</p>
        ${ativos.length ? `<ul class="fin-contas">${ativos.map(linha).join('')}</ul>` : '<p class="muted sm">Nenhum cliente ativo.</p>'}
        ${fim.length ? `<details class="fin-fim"><summary>Finalizados (${fim.length})</summary><ul class="fin-contas">${fim.map(linha).join('')}</ul></details>` : ''}
      </section>`;
  }

  // ---------- Estimativa de gastos ----------

  function estimHTML() {
    const ym = S.finMes;
    const ativas = F().estim.filter((e) => !e.ultParcela || e.ultParcela >= ym);
    const grupos = [
      ['conta', 'Contas do mês', 'Pagas direto da conta'],
      ['cartao', 'No cartão', 'Já entram na fatura'],
    ];
    const total = soma(ativas);
    const real = soma(doMes(ym).filter((t) => t.tipo === 'saida' && (t.contaId || t.cartaoId)));
    const pct = total ? Math.round((real * 100) / total) : 0;
    return `<div class="fin-grid">
      <section class="card fin-saldo">
        <p class="muted sm">Gasto estimado por mês</p>
        <p class="fin-big">${brl(total)}</p>
        <p class="muted sm">Saídas lançadas em ${esc(mesCurto(ym))}: <strong>${brl(real)}</strong> (${pct}% da estimativa)</p>
        <div class="bar${pct > 100 ? ' over' : ''}"><span style="width:${Math.min(pct, 100)}%"></span></div>
        <div class="btn-row"><button type="button" class="btn primary sm" data-action="fin-new-estim">${icon('plus')}Gasto estimado</button></div>
      </section>
      ${grupos
        .map(([g, titulo, dica]) => {
          const arr = ativas.filter((e) => (e.onde || 'conta') === g);
          return `<section class="card">
          <header class="fin-sec-head"><h2 class="card-title">${titulo}</h2><strong>${brl(soma(arr))}</strong></header>
          <p class="muted sm">${dica}</p>
          ${
            arr.length
              ? `<ul class="fin-contas">${arr
                  .map(
                    (e) => `<li><button type="button" data-action="fin-edit-estim" data-id="${e.id}"><span class="fin-estim-dia">${e.dia ? `dia ${e.dia}` : '—'}</span>
                <span class="grow">${esc(e.motivo)}${e.ultParcela ? ` <small class="muted">até ${esc(mesCurto(e.ultParcela))}</small>` : ''}</span><strong>${brl(e.valor)}</strong></button></li>`,
                  )
                  .join('')}</ul>`
              : '<p class="muted sm">Nada aqui.</p>'
          }</section>`;
        })
        .join('')}
    </div>`;
  }

  // ---------- Valor da hora por cliente ----------
  // Receita do cliente no período ÷ horas do cronômetro nas tarefas dele no mesmo período.

  const PER_HORA = [
    ['mes', 'Mês', 1],
    ['3m', '3 meses', 3],
    ['12m', '12 meses', 12],
  ];
  const MIN_HORAS = 0.25; // menos de 15 min não dá um valor confiável

  function horaHTML() {
    const [per, , n] = PER_HORA.find((p) => p[0] === S.finHoraPer) || PER_HORA[0];
    const de = `${U.addMonths(S.finMes, 1 - n)}-01`;
    const ate = fimDoMes(S.finMes);
    const hoje = U.todayStr();
    const ateTempo = ate < hoje ? ate : hoje;
    const nomePer = n === 1 ? U.fmtMes(S.finMes) : `${mesCurto(de.slice(0, 7))} a ${mesCurto(S.finMes)}`;
    const chips = `<div class="tab-chips fin-hora-chips">${PER_HORA.map(
      ([id, l]) => `<button type="button" class="tab-chip${id === per ? ' on' : ''}" data-action="fin-hora-per" data-per="${id}">${l}</button>`,
    ).join('')}</div>`;

    // Tempo: só dá para somar até hoje (o futuro ainda não foi trabalhado).
    if (de <= ateTempo && !ensureRange(de, ateTempo)) {
      return `${chips}<div class="loading"><span></span><span></span><span></span></div>`;
    }
    const wid = workCatId();
    const linhas = new Map();
    const linha = (id) => {
      if (!linhas.has(id)) linhas.set(id, { id, seg: 0, rec: 0, aRec: 0 });
      return linhas.get(id);
    };
    let segTrabalho = 0;
    for (let d = de; d <= ateTempo; d = U.addDays(d, 1)) {
      for (const t of visible(S.days[d] || [])) {
        const seg = elapsed(t);
        if (seg < 1 || !(t.clienteId || (wid && t.categoriaId === wid))) continue;
        segTrabalho += seg;
        linha(t.clienteId || '_sem').seg += seg;
      }
    }
    for (const t of F().tx) {
      if (t.tipo !== 'entrada' || !t.clienteId || t.data < de || t.data > ate) continue;
      const x = linha(t.clienteId);
      if (t.realizado) x.rec += t.valor;
      else x.aRec += t.valor;
    }
    const lista = [...linhas.values()].map((x) => {
      const h = x.seg / 3600;
      const total = r2(x.rec + x.aRec);
      return { ...x, h, total, vh: h >= MIN_HORAS && x.id !== '_sem' ? total / h : null };
    });
    // A média só usa a receita de quem teve tempo marcado; o resto fica de fora e aparece no aviso.
    const recTotal = r2(lista.filter((x) => x.seg >= 60).reduce((s, x) => s + x.total, 0));
    const semTempo = r2(lista.filter((x) => x.seg < 60).reduce((s, x) => s + x.total, 0));
    const hTotal = segTrabalho / 3600;
    const media = hTotal >= MIN_HORAS ? recTotal / hTotal : null;
    const maxVh = Math.max(...lista.map((x) => x.vh || 0), 1);
    lista.sort((a, b) => (b.vh ?? -1) - (a.vh ?? -1) || b.total - a.total || b.seg - a.seg);
    const comHoras = lista.filter((x) => x.seg >= 60);
    const semHoras = lista.filter((x) => x.seg < 60 && x.total);

    const nomeCli = (id) => (id === '_sem' ? 'Sem cliente' : cliNome(id) || 'Cliente apagado');
    const row = (x) => {
      const sub = [
        x.seg >= 60 ? U.fmtDur(x.seg) : 'sem tempo marcado',
        x.total ? `${brl(x.total)}${x.aRec ? ` (${brl(x.aRec)} a receber)` : ''}` : x.id === '_sem' ? '' : 'nada recebido',
      ].filter(Boolean);
      const val = x.vh != null ? `${brlCurto(x.vh)}<small>/h</small>` : '—';
      const corpo = `<span class="fin-hora-top"><span class="grow">${esc(nomeCli(x.id))}</span><strong class="${x.vh === 0 ? 'neg' : ''}">${val}</strong></span>
        <span class="bar"><span style="width:${x.vh ? Math.max(2, Math.round((x.vh * 100) / maxVh)) : 0}%"></span></span>
        <span class="muted sm">${esc(sub.join(' · '))}</span>`;
      return x.id === '_sem'
        ? `<li><div class="fin-hora-row">${corpo}</div></li>`
        : `<li><button type="button" class="fin-hora-row" data-action="fin-hora-cli" data-cli="${x.id}" title="Ver as receitas deste cliente">${corpo}</button></li>`;
    };

    return `${chips}
    <div class="fin-grid">
      <section class="card fin-saldo">
        <p class="muted sm">Sua hora em ${esc(nomePer)}</p>
        <p class="fin-big">${media != null ? `${brl(media)}<small class="muted">/h</small>` : '—'}</p>
        <p class="muted sm">${brl(recTotal)} de clientes em <strong>${U.fmtDur(segTrabalho)}</strong> de trabalho no cronômetro.${semTempo ? ` Fora da conta: ${brl(semTempo)} de clientes sem tempo marcado.` : ''}</p>
      </section>
      <section class="card">
        <h2 class="card-title">${icon('clientes')}Por cliente</h2>
        ${comHoras.length ? `<ul class="fin-hora">${comHoras.map(row).join('')}</ul>` : `<p class="muted sm">Nenhum tempo de trabalho no cronômetro neste período.</p>`}
        ${
          semHoras.length
            ? `<details class="fin-cats"><summary>Sem tempo marcado (${semHoras.length}) · ${brl(semTempo)}</summary><ul class="fin-hora">${semHoras.map(row).join('')}</ul></details>`
            : ''
        }
        <p class="muted sm">Conta as entradas do cliente com data no período (recebidas e a receber) divididas pelas horas do cronômetro nas tarefas dele. Quando o pagamento cai num mês e o trabalho foi em outro, o mês sozinho distorce: veja em 3 meses.</p>
      </section>
    </div>`;
  }

  // -------------------------------------------------------------------------
  // Formulários
  // -------------------------------------------------------------------------

  const opt = (v, l, sel) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`;
  const corField = (cor) =>
    `<fieldset class="field"><legend>Cor</legend><div class="swatches">${CORES.map(
      (p) => `<label class="sw" style="--c:${p}"><input type="radio" name="cor" value="${p}" ${p === cor ? 'checked' : ''} aria-label="${p}"><span></span></label>`,
    ).join('')}</div></fieldset>`;

  function faturaOptions(k, sel) {
    const base = U.todayStr().slice(0, 7);
    const meses = new Set(Array.from({ length: 16 }, (_, i) => U.addMonths(base, i - 3)));
    if (sel) meses.add(sel);
    return [...meses].sort().map((m) => opt(m, `${U.fmtMes(m)} (vence dia ${k?.venc || 10})`, sel)).join('');
  }

  function catOptions(sel, tipo) {
    const lista = F().cats.filter((c) => c.id === sel || (tipo === 'entrada' ? c.grupo === 'entrada' || c.grupo === 'aporte' : c.grupo !== 'entrada'));
    return `<option value="">Sem descrição</option>${GRUPOS.map(([g, l]) => {
      const arr = lista.filter((c) => (c.grupo || 'variavel') === g);
      return arr.length ? `<optgroup label="${l}">${arr.map((c) => opt(c.id, c.nome, sel)).join('')}</optgroup>` : '';
    }).join('')}`;
  }

  function clienteOptions(sel) {
    const cs = [...S.clients].sort((a, b) => Number(!isAtivo(a)) - Number(!isAtivo(b)) || a.nome.localeCompare(b.nome, 'pt-BR'));
    return `<option value="">Nenhum</option>${cs.map((c) => opt(c.id, `${c.nome}${isAtivo(c) ? '' : ' (finalizado)'}`, sel)).join('')}`;
  }

  function ondeOptions(t, tipo) {
    const sel = t.cartaoId ? `k:${t.cartaoId}` : t.contaId ? `c:${t.contaId}` : '';
    const contas = F().contas.filter((c) => !c.arquivada || c.id === t.contaId);
    return `${sel ? '' : '<option value="">Escolha…</option>'}<optgroup label="Contas">${contas.map((c) => opt(`c:${c.id}`, c.nome, sel)).join('')}</optgroup>${
      F().cartoes.length ? `<optgroup label="Cartões" data-cartoes ${tipo === 'entrada' ? 'disabled' : ''}>${F().cartoes.map((k) => opt(`k:${k.id}`, k.nome, sel)).join('')}</optgroup>` : ''
    }`;
  }

  // Custo variável (ex.: Uber): vários gastos somados num lançamento só.
  const ehVariavel = (t) => catFin(t.catId)?.grupo === 'variavel';
  const itensDe = (t) => (t.itens?.length ? t.itens : [{ data: t.dataCompra || t.data, valor: t.valor, nota: '' }]);
  function itensHTML(t) {
    const itens = itensDe(t)
      .map((x, i) => ({ ...x, i }))
      .sort((a, b) => (b.data || '').localeCompare(a.data || ''));
    return `<p class="fin-itens-tit">Gastos dentro deste lançamento <small class="muted">(${itens.length} · ${brl(t.valor)})</small></p>
      <ul class="fin-itens-lista">${itens
        .map(
          (x) => `<li><span class="muted">${x.data ? diaMes(x.data) : '—'}</span><span class="grow">${esc(x.nota || '')}</span><strong>${brl(x.valor)}</strong>${
            itens.length > 1 ? `<button type="button" class="icon-btn sm" data-action="fin-item-del" data-i="${x.i}" aria-label="Tirar este gasto">${icon('x')}</button>` : ''
          }</li>`,
        )
        .join('')}</ul>
      <div class="fin-itens-add">
        <input type="date" name="itemData" value="${U.todayStr()}" aria-label="Data do gasto">
        <input name="itemValor" inputmode="decimal" autocomplete="off" placeholder="0,00" aria-label="Valor do gasto">
        <input name="itemNota" maxlength="80" autocomplete="off" placeholder="Nota (opcional)" aria-label="Nota do gasto">
        <button type="button" class="btn soft sm" data-action="fin-item-add">${icon('plus')}Adicionar custo</button>
      </div>`;
  }
  // Põe o gasto digitado no lançamento aberto e salva na hora. Devolve false se o valor for inválido.
  function addItem(form, avisa = true) {
    const t = F().tx.find((x) => x.id === form.dataset.id);
    const el = form.elements.itemValor;
    if (!t || !el) return false;
    const valor = valorDe(el.value);
    if (!(valor > 0)) {
      if (avisa) {
        el.focus();
        toast('Digite o valor do gasto, ex.: 23,90');
      }
      return false;
    }
    const itens = [...itensDe(t), { data: form.elements.itemData.value || U.todayStr(), valor, nota: form.elements.itemNota.value.trim() }];
    salvaItens(t, itens, form);
    toast(`Custo de ${brl(valor)} somado. Total: ${brl(t.valor)}.`);
    return true;
  }
  function salvaItens(t, itens, form) {
    t.itens = itens;
    t.valor = r2(itens.reduce((s, x) => s + x.valor, 0));
    t.mexidoEm = Date.now();
    persist(db.update(COLS.tx, t.id, { itens: t.itens, valor: t.valor, mexidoEm: t.mexidoEm }));
    if (form) {
      form.elements.valor.value = valorInput(t.valor);
      form.elements.valor.readOnly = true;
      const box = form.querySelector('[data-itens-box]');
      if (box) box.innerHTML = itensHTML(t);
    }
    render();
  }

  function openTx(t) {
    const editing = !!t.id;
    const tipo = t.tipo || 'saida';
    const k = t.cartaoId && cartaoById(t.cartaoId);
    const nomes = [...new Set(F().tx.filter((x) => x.tipo === tipo).sort(ordemTx).map((x) => x.nome.replace(/\s*\(\d+(\/\d+)?\)$/, '')))].slice(0, 150);
    const recentes = F().tx.filter((x) => x.tipo === tipo).sort(ordemTx).slice(0, 40);
    // Sugestão de "onde" e descrição: o último lançamento do mesmo tipo.
    const ult = recentes[0];
    const base = editing ? t : { ...t, contaId: t.contaId || (!t.cartaoId && ult?.contaId) || F().contas[0]?.id };
    openModal(`<form class="modal-body fin-form" data-form="fin-tx" data-id="${t.id || ''}">
      ${modalHead(editing ? 'Editar lançamento' : tipo === 'entrada' ? 'Nova entrada' : 'Nova saída')}
      <div class="seg fin-seg">
        <label class="seg-opt in"><input type="radio" name="tipo" value="entrada" data-fin-tipo ${tipo === 'entrada' ? 'checked' : ''}><span>Entrada</span></label>
        <label class="seg-opt out"><input type="radio" name="tipo" value="saida" data-fin-tipo ${tipo === 'saida' ? 'checked' : ''}><span>Saída</span></label>
      </div>
      <label class="field"><span>Nome</span><input name="nome" required maxlength="120" autocomplete="off" list="fin-nomes" value="${esc(t.nome || '')}" autofocus>
        <datalist id="fin-nomes">${nomes.map((n) => `<option value="${esc(n)}">`).join('')}</datalist></label>
      <div class="row2">
        <label class="field"><span data-valor-label>${t.parcelas > 1 && !editing ? 'Valor de cada parcela' : 'Valor'}</span>
          <input name="valor" required inputmode="decimal" autocomplete="off" placeholder="0,00" value="${valorInput(t.valor)}" ${t.itens?.length ? 'readonly title="Soma dos gastos abaixo"' : ''}></label>
        <label class="field"><span>${tipo === 'entrada' ? 'Entrou em' : 'Saiu de'}</span><select name="onde" required data-fin-onde>${ondeOptions(base, tipo)}</select></label>
      </div>
      <div class="row2" data-sem-cartao ${k ? 'hidden' : ''}>
        <label class="field"><span>Data</span><input type="date" name="data" value="${t.data || U.todayStr()}"></label>
        <span></span>
      </div>
      <div data-com-cartao ${k ? '' : 'hidden'}>
        <div class="row2">
          <label class="field"><span>Dia da compra</span><input type="date" name="compra" value="${t.dataCompra || (editing ? '' : U.todayStr())}" data-fin-compra></label>
          <label class="field"><span>Fatura</span><select name="fatura">${(() => {
            const kk = k || F().cartoes[0];
            return kk ? faturaOptions(kk, (editing && t.data?.slice(0, 7)) || faturaPadrao(kk, t.dataCompra || U.todayStr())) : '';
          })()}</select></label>
        </div>
        ${editing ? '' : `<div class="row2"><label class="field"><span>Parcelas</span><input type="number" name="parcelas" min="1" max="48" step="1" inputmode="numeric" value="1" data-fin-parcelas></label><span></span></div>`}
      </div>
      <div class="row2">
        <label class="field"><span>Descrição</span><select name="catId" data-fin-cat>${catOptions(t.catId || (!editing && ult?.catId) || '', tipo)}</select></label>
        <label class="field"><span>Cliente <em>opcional</em></span><select name="clienteId">${clienteOptions(t.clienteId || '')}</select></label>
      </div>
      <label class="switch-row"><input type="checkbox" name="realizado" ${(editing ? t.realizado : !k && (t.data || U.todayStr()) <= U.todayStr()) ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>
        <span data-real-label>${k ? 'Fatura já paga' : tipo === 'entrada' ? 'Já recebi' : 'Já paguei'}</span></label>
      <label class="field"><span>Observação <em>opcional</em></span><input name="obs" maxlength="300" autocomplete="off" value="${esc(t.obs || '')}"></label>
      ${editing && tipo === 'saida' && ehVariavel(t) ? `<div class="fin-itens" data-itens-box>${itensHTML(t)}</div>` : ''}
      ${t.grupo && editing ? `<p class="hint">Parcela ${t.parcela} de ${t.parcelas}. Mudanças valem só para esta parcela.</p>` : ''}
      ${modalFoot(editing ? 'fin-del' : '', t.id)}
    </form>`);
    if (editing) modalDel('tx');
  }

  // O botão Excluir do rodapé sabe qual coleção apagar.
  function modalDel(col) {
    const b = document.querySelector('#modal [data-action="fin-del"]');
    if (b) b.dataset.col = col;
  }

  // Muda o formulário de lançamento quando troca entrada/saída ou conta/cartão.
  function syncTxForm(form) {
    const tipo = form.elements.tipo.value;
    const onde = form.elements.onde;
    const grp = onde.querySelector('[data-cartoes]');
    if (grp) grp.disabled = tipo === 'entrada';
    if (tipo === 'entrada' && onde.value.startsWith('k:')) onde.value = onde.querySelector('option[value^="c:"]')?.value || '';
    const k = onde.value.startsWith('k:') && cartaoById(onde.value.slice(2));
    form.querySelector('[data-sem-cartao]').hidden = !!k;
    form.querySelector('[data-com-cartao]').hidden = !k;
    if (k) {
      const fat = form.elements.fatura;
      const compra = form.elements.compra?.value || U.todayStr();
      const atual = fat.value || faturaPadrao(k, compra);
      fat.innerHTML = faturaOptions(k, form.dataset.id ? atual : faturaPadrao(k, compra));
      if (!form.dataset.id) form.elements.realizado.checked = false;
    }
    const n = Number(form.elements.parcelas?.value) || 1;
    form.querySelector('[data-valor-label]').textContent = k && n > 1 ? 'Valor de cada parcela' : 'Valor';
    form.querySelector('[data-real-label]').textContent = k ? 'Fatura já paga' : tipo === 'entrada' ? 'Já recebi' : 'Já paguei';
    const ondeLbl = onde.closest('label').querySelector('span');
    ondeLbl.textContent = tipo === 'entrada' ? 'Entrou em' : 'Saiu de';
    const cat = form.elements.catId;
    const v = cat.value;
    cat.innerHTML = catOptions(v, tipo);
    const h = form.querySelector('.modal-head h2');
    if (!form.dataset.id) h.textContent = tipo === 'entrada' ? 'Nova entrada' : 'Nova saída';
  }

  function saveTx(form) {
    if (form.elements.itemValor?.value.trim() && !addItem(form)) return;
    const f = Object.fromEntries(new FormData(form));
    const id = form.dataset.id;
    const comItens = id && F().tx.find((x) => x.id === id)?.itens?.length;
    const valor = comItens ? F().tx.find((x) => x.id === id).valor : valorDe(f.valor);
    if (!(valor > 0)) {
      form.elements.valor.focus();
      return toast('Digite um valor, ex.: 150,00');
    }
    if (!f.onde) return toast(f.tipo === 'entrada' ? 'Escolha a conta em que entrou.' : 'Escolha de onde saiu.');
    const k = f.onde.startsWith('k:') ? cartaoById(f.onde.slice(2)) : null;
    const contaId = k ? k.contaId || null : f.onde.slice(2);
    const data = k ? diaNoMes(f.fatura || faturaPadrao(k), k.venc || 10) : f.data || U.todayStr();
    const base = {
      nome: f.nome.trim(),
      tipo: f.tipo === 'entrada' ? 'entrada' : 'saida',
      valor,
      data,
      contaId,
      cartaoId: k?.id || null,
      catId: f.catId || null,
      clienteId: f.clienteId || null,
      realizado: f.realizado === 'on',
      obs: f.obs?.trim() || null,
    };
    if (k) base.dataCompra = f.compra || (id ? null : U.todayStr());
    else if (id) base.dataCompra = null;
    if (!base.nome) return;
    const ops = [];
    if (id) {
      const t = F().tx.find((x) => x.id === id);
      Object.assign(t, base);
      ops.push({ type: 'update', col: COLS.tx, id, data: base });
    } else {
      const n = k ? Math.min(48, Math.max(1, Math.round(Number(f.parcelas) || 1))) : 1;
      const grupo = n > 1 ? U.newId() : null;
      for (let i = 0; i < n; i++) {
        const t = {
          id: U.newId(),
          ...base,
          nome: n > 1 ? `${base.nome} (${i + 1}/${n})` : base.nome,
          data: k ? diaNoMes(U.addMonths(data.slice(0, 7), i), k.venc || 10) : data,
          realizado: i === 0 ? base.realizado : false,
          grupo,
          parcela: n > 1 ? i + 1 : null,
          parcelas: n > 1 ? n : null,
          criadoEm: Date.now(),
        };
        F().tx.push(t);
        ops.push({ type: 'set', col: COLS.tx, id: t.id, data: t });
      }
      if (n > 1) toast(`${n} parcelas lançadas, de ${mesCurto(data.slice(0, 7))} a ${mesCurto(U.addMonths(data.slice(0, 7), n - 1))}.`);
    }
    persist(db.batch(ops));
    closeModal();
    render();
  }

  function openTransf(t) {
    const editing = !!t.id;
    const contas = F().contas.filter((c) => !c.arquivada || c.id === t.deId || c.id === t.paraId);
    const sel = (name, v) => `<select name="${name}" required>${v ? '' : '<option value="">Escolha…</option>'}${contas.map((c) => opt(c.id, c.nome, v)).join('')}</select>`;
    openModal(`<form class="modal-body fin-form" data-form="fin-transf" data-id="${t.id || ''}">
      ${modalHead(editing ? 'Editar transferência' : 'Transferir entre contas')}
      <label class="field"><span>Nome</span><input name="nome" maxlength="120" autocomplete="off" value="${esc(t.nome || 'Guardar dinheiro')}" autofocus></label>
      <div class="row2">
        <label class="field"><span>De</span>${sel('deId', t.deId)}</label>
        <label class="field"><span>Para</span>${sel('paraId', t.paraId)}</label>
      </div>
      <div class="row2">
        <label class="field"><span>Valor</span><input name="valor" required inputmode="decimal" autocomplete="off" placeholder="0,00" value="${valorInput(t.valor)}"></label>
        <label class="field"><span>Data</span><input type="date" name="data" value="${t.data || U.todayStr()}"></label>
      </div>
      <label class="switch-row"><input type="checkbox" name="realizado" ${t.realizado ?? true ? 'checked' : ''}><span class="switch" aria-hidden="true"></span><span>Já foi feita</span></label>
      ${modalFoot(editing ? 'fin-del' : '', t.id)}
    </form>`);
    if (editing) modalDel('transf');
  }

  function saveTransf(form) {
    const f = Object.fromEntries(new FormData(form));
    const valor = valorDe(f.valor);
    if (!(valor > 0)) return toast('Digite um valor, ex.: 150,00');
    if (!f.deId || !f.paraId || f.deId === f.paraId) return toast('Escolha duas contas diferentes.');
    const data = { nome: f.nome.trim() || 'Transferência', valor, data: f.data || U.todayStr(), deId: f.deId, paraId: f.paraId, realizado: f.realizado === 'on' };
    if (!form.dataset.id) data.criadoEm = Date.now();
    salvaDoc('transf', form.dataset.id, data);
  }

  function salvaDoc(chave, id, data) {
    const lista = F()[chave];
    if (id) {
      Object.assign(lista.find((x) => x.id === id) || {}, data);
      persist(db.update(COLS[chave], id, data));
    } else {
      const d = { id: U.newId(), ...data };
      lista.push(d);
      persist(db.set(COLS[chave], d.id, d));
    }
    closeModal();
    render();
  }

  function openConta(c) {
    const editing = !!c.id;
    openModal(`<form class="modal-body fin-form" data-form="fin-conta" data-id="${c.id || ''}">
      ${modalHead(editing ? 'Editar conta' : 'Nova conta')}
      <label class="field"><span>Nome</span><input name="nome" required maxlength="60" autocomplete="off" value="${esc(c.nome || '')}" placeholder="Ex.: Nubank, Dinheiro" autofocus></label>
      ${editing ? '' : `<label class="field"><span>Saldo de hoje <em>opcional</em></span><input name="saldo" inputmode="decimal" autocomplete="off" placeholder="0,00"><small class="hint">Entra como um lançamento “Saldo inicial”.</small></label>`}
      ${corField(c.cor || CORES[F().contas.length % CORES.length])}
      ${editing ? `<label class="switch-row"><input type="checkbox" name="arquivada" ${c.arquivada ? 'checked' : ''}><span class="switch" aria-hidden="true"></span><span>Arquivada <small class="muted">(some das escolhas; o histórico fica)</small></span></label>` : ''}
      ${modalFoot(editing ? 'fin-del' : '', c.id)}
    </form>`);
    if (editing) modalDel('contas');
  }

  function saveConta(form) {
    const f = Object.fromEntries(new FormData(form));
    const data = { nome: f.nome.trim(), cor: f.cor || CORES[0], arquivada: f.arquivada === 'on' };
    if (!data.nome) return;
    const id = form.dataset.id;
    if (id) return salvaDoc('contas', id, data);
    const c = { id: U.newId(), ...data, ordem: F().contas.length };
    F().contas.push(c);
    const ops = [{ type: 'set', col: COLS.contas, id: c.id, data: c }];
    const saldo = f.saldo ? Number(String(f.saldo).replace(/[R$\s.]/g, '').replace(',', '.')) : 0;
    if (saldo) {
      const t = { id: U.newId(), nome: 'Saldo inicial', tipo: saldo > 0 ? 'entrada' : 'saida', valor: r2(Math.abs(saldo)), data: U.todayStr(), contaId: c.id, cartaoId: null, catId: null, clienteId: null, realizado: true, criadoEm: Date.now() };
      F().tx.push(t);
      ops.push({ type: 'set', col: COLS.tx, id: t.id, data: t });
    }
    persist(db.batch(ops));
    closeModal();
    render();
  }

  function openCartao(k) {
    const editing = !!k.id;
    openModal(`<form class="modal-body fin-form" data-form="fin-cartao" data-id="${k.id || ''}">
      ${modalHead(editing ? 'Editar cartão' : 'Novo cartão')}
      <label class="field"><span>Nome</span><input name="nome" required maxlength="60" autocomplete="off" value="${esc(k.nome || '')}" placeholder="Ex.: Cartão Nubank" autofocus></label>
      <div class="row2">
        <label class="field"><span>Limite</span><input name="limite" inputmode="decimal" autocomplete="off" value="${valorInput(k.limite)}" placeholder="0,00"></label>
        <label class="field"><span>A fatura sai de</span><select name="contaId">${F().contas.map((c) => opt(c.id, c.nome, k.contaId)).join('')}</select></label>
      </div>
      <div class="row2">
        <label class="field"><span>Fecha no dia</span><input type="number" name="fecha" min="1" max="31" inputmode="numeric" value="${k.fecha || 3}"></label>
        <label class="field"><span>Vence no dia</span><input type="number" name="venc" min="1" max="31" inputmode="numeric" value="${k.venc || 10}"></label>
      </div>
      <p class="hint">Compra feita depois do fechamento cai na fatura seguinte.</p>
      ${corField(k.cor || CORES[0])}
      ${modalFoot(editing ? 'fin-del' : '', k.id)}
    </form>`);
    if (editing) modalDel('cartoes');
  }

  function saveCartao(form) {
    const f = Object.fromEntries(new FormData(form));
    const dia = (v, d) => Math.min(31, Math.max(1, Math.round(Number(v) || d)));
    const data = { nome: f.nome.trim(), limite: valorDe(f.limite) || 0, contaId: f.contaId || null, fecha: dia(f.fecha, 3), venc: dia(f.venc, 10), cor: f.cor || CORES[0] };
    if (!data.nome) return;
    salvaDoc('cartoes', form.dataset.id, data);
  }

  function openCat(c) {
    const editing = !!c.id;
    openModal(`<form class="modal-body fin-form" data-form="fin-cat" data-id="${c.id || ''}">
      ${modalHead(editing ? 'Editar descrição' : 'Nova descrição')}
      <label class="field"><span>Nome</span><input name="nome" required maxlength="60" autocomplete="off" value="${esc(c.nome || '')}" placeholder="Ex.: Mercado" autofocus></label>
      <label class="field"><span>Tipo</span><select name="grupo">${GRUPOS.map(([g, l]) => opt(g, l, c.grupo || 'variavel')).join('')}</select></label>
      ${modalFoot(editing ? 'fin-del' : '', c.id)}
    </form>`);
    if (editing) modalDel('cats');
  }

  function openEstim(e) {
    const editing = !!e.id;
    openModal(`<form class="modal-body fin-form" data-form="fin-estim" data-id="${e.id || ''}">
      ${modalHead(editing ? 'Editar gasto estimado' : 'Novo gasto estimado')}
      <label class="field"><span>Motivo</span><input name="motivo" required maxlength="80" autocomplete="off" value="${esc(e.motivo || '')}" placeholder="Ex.: Conta de luz" autofocus></label>
      <div class="row2">
        <label class="field"><span>Valor</span><input name="valor" required inputmode="decimal" autocomplete="off" value="${valorInput(e.valor)}" placeholder="0,00"></label>
        <label class="field"><span>Dia <em>opcional</em></span><input type="number" name="dia" min="1" max="31" inputmode="numeric" value="${e.dia || ''}"></label>
      </div>
      <div class="row2">
        <label class="field"><span>Onde</span><select name="onde">${opt('conta', 'Conta do mês', e.onde || 'conta')}${opt('cartao', 'No cartão', e.onde)}</select></label>
        <label class="field"><span>Última parcela <em>opcional</em></span><input type="month" name="ultParcela" value="${e.ultParcela || ''}"></label>
      </div>
      ${modalFoot(editing ? 'fin-del' : '', e.id)}
    </form>`);
    if (editing) modalDel('estim');
  }

  // Fatura de um cartão no mês aberto.
  // Filtro por descrição guardado enquanto a fatura do mesmo cartão estiver aberta.
  let fatFiltro = { id: '', cat: '' };
  const catDaTx = (t) => t.catId || '-';
  function faturaLista(k) {
    const todas = fatura(k, S.finMes);
    const fat = (fatFiltro.cat ? todas.filter((t) => catDaTx(t) === fatFiltro.cat) : todas).sort(
      (a, b) => (b.dataCompra || '').localeCompare(a.dataCompra || '') || b.valor - a.valor,
    );
    const total = fatFiltro.cat ? `${brl(soma(fat))} <small class="muted">de ${brl(soma(todas))}</small>` : brl(soma(fat));
    return `<p class="fin-big sm">${total}</p>
      ${fat.length ? `<ul class="tx-list">${fat.map((t) => txRow(t, { data: false })).join('')}</ul>` : '<p class="muted">Nenhuma compra nesta fatura.</p>'}`;
  }
  function openFatura(k) {
    if (fatFiltro.id !== k.id) fatFiltro = { id: k.id, cat: '' };
    const todas = fatura(k, S.finMes);
    const por = new Map();
    for (const t of todas) por.set(catDaTx(t), r2((por.get(catDaTx(t)) || 0) + t.valor));
    if (fatFiltro.cat && !por.has(fatFiltro.cat)) fatFiltro.cat = '';
    const cats = [...por.entries()].sort((a, b) => b[1] - a[1]);
    const nomeCat = (c) => (c === '-' ? 'Sem descrição' : catFin(c)?.nome || 'Sem descrição');
    openModal(`<div class="modal-body fin-form">
      ${modalHead(`${esc(k.nome)} · ${esc(mesCurto(S.finMes))}`)}
      ${
        cats.length > 1
          ? `<label class="field"><span>Descrição</span><select data-fin-fat-cat="${k.id}"><option value="">Todas (${todas.length})</option>${cats
              .map(([c, v]) => `<option value="${c}" ${c === fatFiltro.cat ? 'selected' : ''}>${esc(nomeCat(c))} · ${brl(v)}</option>`)
              .join('')}</select></label>`
          : ''
      }
      <div data-fat-lista>${faturaLista(k)}</div>
      <div class="btn-row"><button type="button" class="btn soft sm" data-action="fin-gasto-cartao" data-id="${k.id}">${icon('plus')}Adicionar gasto</button></div>
    </div>`);
  }

  // -------------------------------------------------------------------------
  // Exportar para o Notion (CSV com as colunas do banco "Transação")
  // -------------------------------------------------------------------------

  const csvCel = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = (linhas) => '﻿' + linhas.map((l) => l.map(csvCel).join(',')).join('\n');
  function baixar(nome, conteudo) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([conteudo], { type: 'text/csv;charset=utf-8' }));
    a.download = nome;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function openExport() {
    const novos = F().tx.filter((t) => !t.noNotion).length + F().transf.filter((t) => !t.noNotion).length;
    openModal(`<form class="modal-body fin-form" data-form="fin-export">
      ${modalHead('Exportar para o Notion')}
      <p class="muted sm">Baixa duas planilhas (lançamentos e transferências) com as mesmas colunas do seu Notion. No Notion, abra o banco, clique em ••• › <strong>Merge with CSV</strong> e escolha o arquivo.</p>
      <label class="switch-row"><input type="checkbox" name="soNovos" checked><span class="switch" aria-hidden="true"></span>
        <span>Só o que ainda não está no Notion <small class="muted">(${novos} itens)</small></span></label>
      <label class="switch-row"><input type="checkbox" name="marcar" checked><span class="switch" aria-hidden="true"></span>
        <span>Depois de baixar, marcar como já enviados</span></label>
      <footer class="modal-actions"><span class="grow"></span>
        <button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>
        <button type="submit" class="btn primary">${icon('download')}Baixar</button></footer>
    </form>`);
  }

  function doExport(form) {
    const soNovos = form.elements.soNovos.checked;
    const marcar = form.elements.marcar.checked;
    const tx = F().tx.filter((t) => !soNovos || !t.noNotion).sort((a, b) => a.data.localeCompare(b.data));
    const tr = F().transf.filter((t) => !soNovos || !t.noNotion).sort((a, b) => a.data.localeCompare(b.data));
    if (!tx.length && !tr.length) return toast('Nada novo para exportar.');
    const cliN = (id) => cliById(id)?.notionNome || cliNome(id);
    const num = (v) => r2(v).toFixed(2);
    if (tx.length) {
      baixar(
        `notion-transacoes-${U.todayStr()}.csv`,
        csv([
          ['Nome', 'Tipo', 'Valor', 'Data Pagamento', 'Data Vencimento', 'Realizado', 'Banco', 'Cartão de Crédito', 'Descrição', 'Cliente'],
          ...tx.map((t) => [t.nome, t.tipo === 'entrada' ? 'Entrada' : 'Saída', num(t.valor), t.data, t.venc || t.data, t.realizado ? 'Yes' : 'No', contaById(t.contaId)?.nome || '', cartaoById(t.cartaoId)?.nome || '', catFin(t.catId)?.nome || '', cliN(t.clienteId)]),
        ]),
      );
    }
    if (tr.length) {
      setTimeout(
        () =>
          baixar(
            `notion-transferencias-${U.todayStr()}.csv`,
            csv([['Transferência', 'Banco Saída', 'Banco Entrada', 'Data', 'Realizado', 'Valor'], ...tr.map((t) => [t.nome, contaById(t.deId)?.nome || '', contaById(t.paraId)?.nome || '', t.data, t.realizado ? 'Yes' : 'No', num(t.valor)])]),
          ),
        400,
      );
    }
    if (marcar) {
      const ops = [];
      for (const t of tx) if (!t.noNotion) (t.noNotion = true), ops.push({ type: 'update', col: COLS.tx, id: t.id, data: { noNotion: true } });
      for (const t of tr) if (!t.noNotion) (t.noNotion = true), ops.push({ type: 'update', col: COLS.transf, id: t.id, data: { noNotion: true } });
      persist(db.batch(ops));
    }
    closeModal();
    toast(`${tx.length} lançamento(s) e ${tr.length} transferência(s) baixados.`);
    render();
  }

  // -------------------------------------------------------------------------
  // Importar (arquivo "financas-import" montado a partir do Notion)
  // -------------------------------------------------------------------------

  let planoImport = null;

  async function importar(data) {
    if (!S.fin) await load();
    const req = ['contas', 'transacoes'];
    if (req.some((k) => !Array.isArray(data[k]))) throw new Error('Arquivo de finanças incompleto.');
    // Conferência do saldo antes de gravar.
    const sal = {};
    for (const t of data.transacoes) if (t.realizado && t.conta) sal[t.conta] = (sal[t.conta] || 0) + (t.tipo === 'entrada' ? 1 : -1) * t.valor;
    for (const t of data.transferencias || []) {
      if (!t.realizado) continue;
      sal[t.para] = (sal[t.para] || 0) + t.valor;
      sal[t.de] = (sal[t.de] || 0) - t.valor;
    }
    const total = r2(Object.values(sal).reduce((s, v) => s + v, 0));
    const achaCli = (nome) => S.clients.find((c) => norm(c.nome) === norm(nome));
    const clientes = (data.clientes || []).map((c) => ({ ...c, existe: !!achaCli(c.nome) }));
    const jaTem = F().tx.length + F().contas.length;
    planoImport = { data, total, clientes };
    const novos = clientes.filter((c) => !c.existe);
    const datas = data.transacoes.map((t) => t.data).filter(Boolean).sort();
    openModal(`<div class="modal-body fin-form">
      ${modalHead('Importar finanças')}
      <p class="muted sm">Origem: ${esc(data.origem || 'arquivo')}. Lançamentos de ${datas.length ? `${diaMes(datas[0])}/${datas[0].slice(0, 4)} a ${diaMes(datas.at(-1))}/${datas.at(-1).slice(0, 4)}` : '—'}.</p>
      <ul class="fin-contas imp-fin">
        <li><span class="grow">Lançamentos</span><strong>${data.transacoes.length}</strong></li>
        <li><span class="grow">Transferências</span><strong>${(data.transferencias || []).length}</strong></li>
        <li><span class="grow">Contas</span><strong>${data.contas.length}</strong></li>
        <li><span class="grow">Cartões</span><strong>${(data.cartoes || []).length}</strong></li>
        <li><span class="grow">Descrições</span><strong>${(data.categorias || []).length}</strong></li>
        <li><span class="grow">Gastos estimados</span><strong>${(data.estimativas || []).length}</strong></li>
        <li><span class="grow">Saldo total</span><strong>${brl(total)}</strong></li>
      </ul>
      ${data.conferir?.saldoTotal != null ? `<p class="note">${Math.abs(data.conferir.saldoTotal - total) < 0.01 ? '✓ O saldo bate com o de origem' : '⚠ O saldo não bate com o de origem'} (${brl(data.conferir.saldoTotal)}).</p>` : ''}
      <p class="muted sm">Clientes ligados: ${clientes.filter((c) => c.existe).length}.${novos.length ? ` Novos (entram como finalizados, só para o histórico): ${novos.map((c) => esc(c.nome)).join(', ')}.` : ''}</p>
      ${jaTem ? `<p class="note">Você já tem dados nas finanças. Importar vai <strong>substituir</strong> todas as contas, cartões e lançamentos atuais.</p>` : ''}
      <footer class="modal-actions"><span class="grow"></span>
        <button type="button" class="btn ghost" data-action="close-modal">Cancelar</button>
        <button type="button" class="btn ${jaTem ? 'danger' : 'primary'}" data-action="fin-import-ok">${jaTem ? 'Substituir e importar' : 'Importar'}</button></footer>
    </div>`);
  }

  async function aplicarImport() {
    const p = planoImport;
    if (!p) return;
    planoImport = null;
    const { data } = p;
    const ops = [];
    // Apaga o que existe (substituir).
    for (const [k, col] of Object.entries(COLS)) for (const d of F()[k]) ops.push({ type: 'delete', col, id: d.id });
    const id = {};
    const novo = (k, nome) => (id[`${k}:${nome}`] = U.newId());
    const ref = (k, nome) => (nome ? id[`${k}:${nome}`] || null : null);
    const fin = { contas: [], cartoes: [], cats: [], tx: [], transf: [], estim: [] };
    const add = (k, d) => {
      fin[k].push(d);
      ops.push({ type: 'set', col: COLS[k], id: d.id, data: d });
    };
    data.contas.forEach((c, ordem) => add('contas', { id: novo('conta', c.nome), nome: c.nome, cor: c.cor || CORES[ordem % CORES.length], ordem, arquivada: !!c.arquivada }));
    (data.cartoes || []).forEach((k, ordem) =>
      add('cartoes', { id: novo('cartao', k.nome), nome: k.nome, limite: k.limite || 0, contaId: ref('conta', k.conta), fecha: k.fecha || 3, venc: k.venc || 10, cor: k.cor || CORES[0], ordem }),
    );
    (data.categorias || []).forEach((c, ordem) => add('cats', { id: novo('cat', c.nome), nome: c.nome, grupo: c.grupo || 'variavel', ordem }));
    // Clientes: liga aos que já existem (pelo nome) e cria os que faltam como finalizados.
    const cliId = {};
    for (const c of p.clientes) {
      let cli = S.clients.find((x) => norm(x.nome) === norm(c.nome));
      if (!cli) {
        cli = { id: U.newId(), nome: c.nome, categoriaId: ctx.workCatId(), observacoes: 'Veio do financeiro do Notion.', status: 'finalizado', servicos: [], notionNome: c.notion || c.nome };
        S.clients.push(cli);
        ops.push({ type: 'set', col: 'clients', id: cli.id, data: cli });
      } else if (c.notion && cli.notionNome !== c.notion) {
        cli.notionNome = c.notion;
        ops.push({ type: 'update', col: 'clients', id: cli.id, data: { notionNome: c.notion } });
      }
      cliId[c.nome] = cli.id;
    }
    const agora = Date.now();
    for (const t of data.transacoes) {
      add('tx', {
        id: U.newId(), nome: t.nome, tipo: t.tipo === 'entrada' ? 'entrada' : 'saida', valor: r2(t.valor), data: t.data, venc: t.venc || null,
        contaId: ref('conta', t.conta), cartaoId: ref('cartao', t.cartao), catId: ref('cat', t.categoria), clienteId: (t.cliente && cliId[t.cliente]) || null,
        realizado: !!t.realizado, obs: t.obs || null, noNotion: true, importado: true, criadoEm: agora,
      });
    }
    for (const t of data.transferencias || []) {
      add('transf', { id: U.newId(), nome: t.nome, valor: r2(t.valor), data: t.data, deId: ref('conta', t.de), paraId: ref('conta', t.para), realizado: !!t.realizado, noNotion: true });
    }
    for (const e of data.estimativas || []) add('estim', { id: U.newId(), motivo: e.motivo, valor: r2(e.valor), dia: e.dia || null, onde: e.onde || 'conta', ultParcela: e.ultParcela || null });

    closeModal();
    toast('Importando… não feche o app.');
    try {
      await db.batch(ops);
    } catch (err) {
      console.error(err);
      toast('A importação falhou no meio. Abra Finanças de novo e importe outra vez.');
      S.fin = null;
      carregando = null;
      return render();
    }
    S.fin = null;
    carregando = null;
    await load(true);
    S.finTab = 'resumo';
    location.hash = '#/financas';
    toast(`Pronto: ${fin.tx.length} lançamentos importados. Saldo ${brl(r2(Object.values(saldos()).reduce((s, v) => s + v, 0)))}.`);
  }

  // Backup geral (JSON) inclui as finanças.
  async function backup() {
    if (!S.fin) await load();
    const { contas, cartoes, cats, tx, transf, estim } = F();
    return { contas, cartoes, descricoes: cats, lancamentos: tx, transferencias: transf, estimativas: estim };
  }

  // -------------------------------------------------------------------------
  // Ações e eventos
  // -------------------------------------------------------------------------

  const novoDoc = { tx: openTx, transf: openTransf, contas: openConta, cartoes: openCartao, cats: openCat, estim: openEstim };
  const achar = (k, id) => F()[k].find((x) => x.id === id);

  const ACTIONS = {
    'fin-tab': ({ tab }) => {
      S.finTab = tab;
      render();
    },
    'fin-mes': ({ n }) => {
      S.finMes = Number(n) ? U.addMonths(S.finMes, Number(n)) : U.todayStr().slice(0, 7);
      S.finSemana = null;
      S.finDia = null;
      render();
    },
    'fin-ir-mes': ({ mes }) => {
      S.finMes = mes;
      S.finSemana = null;
      S.finDia = null;
      render();
    },
    'fin-semana': ({ n }) => {
      S.finSemana = U.addDays(S.finSemana, Number(n));
      S.finDia = null;
      render();
    },
    'fin-dia': ({ date }) => {
      S.finDia = S.finDia === date ? null : date;
      render();
    },
    'fin-hora-per': ({ per }) => {
      S.finHoraPer = per;
      render();
    },
    // Abre as receitas do cliente no mesmo período da tela "Por hora".
    'fin-hora-cli': ({ cli }) => {
      const n = PER_HORA.find((p) => p[0] === S.finHoraPer)?.[2] || 1;
      S.finF.receitas = {
        ...S.finF.receitas, cli, q: '', cat: '',
        ...(n === 1 ? { per: 'mes' } : { per: 'intervalo', de: `${U.addMonths(S.finMes, 1 - n)}-01`, ate: fimDoMes(S.finMes) }),
      };
      S.finTab = 'receitas';
      render();
      scrollTo(0, 0);
    },
    'fin-limpa': ({ kind }) => {
      S.finF[kind] = { per: 'mes', de: '', ate: '', cli: '', cat: '', onde: '', q: '' };
      render();
    },
    'fin-new-tx': ({ tipo }) => openTx({ tipo, data: S.finMes === U.todayStr().slice(0, 7) ? U.todayStr() : `${S.finMes}-01` }),
    'fin-edit-tx': ({ id }) => {
      const t = achar('tx', id);
      if (t) openTx(t);
    },
    'fin-toggle': ({ id }) => {
      const t = achar('tx', id);
      if (!t) return;
      t.realizado = !t.realizado;
      persist(db.update(COLS.tx, id, { realizado: t.realizado }));
      render();
      if (document.querySelector('#modal[open]')) {
        const k = t.cartaoId && cartaoById(t.cartaoId);
        if (k) openFatura(k);
      }
    },
    'fin-new-transf': () => openTransf({ data: U.todayStr() }),
    'fin-edit-transf': ({ id }) => openTransf(achar('transf', id) || {}),
    'fin-new-conta': () => openConta({}),
    'fin-edit-conta': ({ id }) => openConta(achar('contas', id) || {}),
    'fin-new-cartao': () => (F().contas.length ? openCartao({ contaId: F().contas[0].id }) : toast('Cadastre antes a conta que paga a fatura.')),
    'fin-edit-cartao': ({ id }) => openCartao(achar('cartoes', id) || {}),
    'fin-new-cat': () => openCat({}),
    'fin-edit-cat': ({ id }) => openCat(achar('cats', id) || {}),
    'fin-new-estim': () => openEstim({}),
    'fin-edit-estim': ({ id }) => openEstim(achar('estim', id) || {}),
    'fin-fatura': ({ id }) => {
      const k = cartaoById(id);
      fatFiltro = { id: '', cat: '' };
      if (k) openFatura(k);
    },
    'fin-gasto-cartao': ({ id }) => {
      if (cartaoById(id)) openTx({ tipo: 'saida', cartaoId: id });
    },
    'fin-cats-mes': () => openCatsMes(),
    'fin-item-add': () => {
      const form = document.querySelector('#modal form[data-form="fin-tx"]');
      if (form) addItem(form);
    },
    'fin-item-del': async ({ i }) => {
      const form = document.querySelector('#modal form[data-form="fin-tx"]');
      const t = form && F().tx.find((x) => x.id === form.dataset.id);
      if (!t?.itens?.length) return;
      const x = t.itens[Number(i)];
      if (!x) return;
      salvaItens(t, t.itens.filter((_, j) => j !== Number(i)), form);
      toast(`Gasto de ${brl(x.valor)} tirado. Total: ${brl(t.valor)}.`);
    },
    'fin-ext': ({ v }) => {
      S.finExt.tipo = v || '';
      S.finExt.n = 60;
      render();
    },
    'fin-ext-mais': () => {
      S.finExt.n += 100;
      render();
    },
    'fin-pagar': async ({ id }) => {
      const k = cartaoById(id);
      const abertas = fatura(k, S.finMes).filter((t) => !t.realizado);
      if (!abertas.length) return;
      const conta = contaById(k.contaId)?.nome || 'a conta';
      if (!(await ask(`Pagar a fatura de ${mesCurto(S.finMes)} do ${k.nome}? ${brl(soma(abertas))} saem de ${conta}.`, 'Pagar fatura', false))) return;
      for (const t of abertas) t.realizado = true;
      persist(db.batch(abertas.map((t) => ({ type: 'update', col: COLS.tx, id: t.id, data: { realizado: true } }))));
      toast('Fatura paga.');
      render();
    },
    'fin-del': async ({ id, col }) => {
      const k = col || 'tx';
      const doc = achar(k, id);
      if (!doc) return closeModal();
      if (k === 'contas' && (F().tx.some((t) => t.contaId === id) || F().transf.some((t) => t.deId === id || t.paraId === id) || F().cartoes.some((c) => c.contaId === id))) {
        return toast('Esta conta tem lançamentos. Marque “Arquivada” em vez de excluir.');
      }
      if (k === 'cartoes' && F().tx.some((t) => t.cartaoId === id)) return toast('Este cartão tem lançamentos e não pode ser excluído.');
      const nome = doc.nome || doc.motivo || 'este item';
      if (!(await ask(`Excluir “${nome}”?`))) return openAgain(k, doc);
      F()[k] = F()[k].filter((x) => x !== doc);
      if (k === 'cats') for (const t of F().tx) if (t.catId === id) t.catId = null;
      persist(db.remove(COLS[k], id));
      render();
    },
    'fin-export': () => openExport(),
    'fin-import-ok': () => aplicarImport(),
  };
  const openAgain = (k, doc) => novoDoc[k]?.(doc);

  const FORMS = {
    'fin-tx': saveTx,
    'fin-transf': saveTransf,
    'fin-conta': saveConta,
    'fin-cartao': saveCartao,
    'fin-cat'(form) {
      const f = Object.fromEntries(new FormData(form));
      if (!f.nome.trim()) return;
      salvaDoc('cats', form.dataset.id, { nome: f.nome.trim(), grupo: f.grupo || 'variavel' });
    },
    'fin-estim'(form) {
      const f = Object.fromEntries(new FormData(form));
      const valor = valorDe(f.valor);
      if (!f.motivo.trim() || !(valor > 0)) return toast('Preencha o motivo e o valor.');
      salvaDoc('estim', form.dataset.id, { motivo: f.motivo.trim(), valor, dia: Number(f.dia) || null, onde: f.onde || 'conta', ultParcela: f.ultParcela || null });
      F().estim.sort((a, b) => (a.dia || 99) - (b.dia || 99));
    },
    'fin-export': doExport,
  };

  // Filtros: atualiza só a lista, para não perder o foco do campo de busca.
  let filtroTimer;
  function onFiltro(el) {
    const box = el.closest('[data-fin-kind]');
    if (!box) return false;
    const kind = box.dataset.finKind;
    S.finF[kind][el.dataset.finF] = el.value;
    if (el.dataset.finF === 'per') return render(), true;
    clearTimeout(filtroTimer);
    filtroTimer = setTimeout(() => {
      const lista = document.querySelector('[data-fin-lista]');
      if (lista) lista.innerHTML = listaHTML(kind);
    }, el.type === 'search' ? 200 : 0);
    return true;
  }

  function onChange(el) {
    if (el.matches('[data-fin-f]')) return el.type !== 'search' && onFiltro(el);
    if (el.matches('[data-fin-tipo], [data-fin-onde], [data-fin-parcelas]')) {
      syncTxForm(el.form);
      return true;
    }
    // Mudou o dia da compra: a fatura sugerida acompanha (só em lançamento novo).
    if (el.matches('[data-fin-compra]')) {
      const form = el.form;
      const k = form.elements.onde.value.startsWith('k:') && cartaoById(form.elements.onde.value.slice(2));
      if (k && !form.dataset.id && el.value) form.elements.fatura.innerHTML = faturaOptions(k, faturaPadrao(k, el.value));
      return true;
    }
    if (el.matches('[data-fin-fat-cat]')) {
      const k = cartaoById(el.dataset.finFatCat);
      fatFiltro = { id: k?.id || '', cat: el.value };
      const box = document.querySelector('[data-fat-lista]');
      if (k && box) box.innerHTML = faturaLista(k);
      return true;
    }
    if (el.matches('[data-fin-ext]')) {
      S.finExt[el.dataset.finExt] = el.value;
      S.finExt.n = 60;
      render();
      return true;
    }
    return false;
  }
  function onInput(el) {
    if (el.matches('[data-fin-f]') && el.type === 'search') return onFiltro(el);
    if (el.matches('[data-fin-parcelas]')) return syncTxForm(el.form), true;
    return false;
  }

  return { view, ACTIONS, FORMS, onChange, onInput, importar, backup, reset: () => ((S.fin = null), (carregando = null)) };
}
