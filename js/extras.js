// Aniversários (lista com quantos dias faltam) e calculadora rápida.

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MES_CURTO = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function createExtras(ctx) {
  const { S, db, U, esc, icon, openModal, closeModal, toast, persist, render, ask, modalHead, modalFoot, agora, errMsg, loading } = ctx;

  // -------------------------------------------------------------------------
  // Aniversários
  // -------------------------------------------------------------------------

  S.anivs = null;
  S.anivBusca = '';

  // Próximo aniversário a partir de hoje (hoje conta). 29/02 em ano comum vira 28/02.
  function proxima(a) {
    const hoje = U.parseYmd(U.todayStr());
    const em = (y) => new Date(y, a.mes - 1, Math.min(a.dia, new Date(y, a.mes, 0).getDate()));
    let d = em(hoje.getFullYear());
    if (d < hoje) d = em(hoje.getFullYear() + 1);
    return { d, dias: Math.round((d - hoje) / 86400000), idade: a.ano ? d.getFullYear() - a.ano : null };
  }

  const faltaTxt = (n) => (n === 0 ? 'Hoje!' : n === 1 ? 'Amanhã' : `Faltam ${n} dias`);

  function linhaAniv(a) {
    const p = proxima(a);
    const sub = [p.idade ? `faz ${p.idade} anos` : '', p.dias ? SEMANA[p.d.getDay()] : '', a.obs || ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="aniv-item${p.dias === 0 ? ' hoje' : p.dias <= 7 ? ' perto' : ''}" data-action="aniv-edit" data-id="${a.id}">
      <span class="aniv-data"><strong>${a.dia}</strong><small>${MES_CURTO[a.mes - 1]}</small></span>
      <span class="aniv-nome"><strong>${esc(a.nome)}</strong>${sub ? `<small class="muted">${esc(sub)}</small>` : ''}</span>
      <span class="aniv-falta">${p.dias === 0 ? icon('aniversarios') : ''}${faltaTxt(p.dias)}</span>
    </button></li>`;
  }

  function listaAnivHTML() {
    const q = ctx.norm(S.anivBusca || '');
    const lista = S.anivs
      .filter((a) => !q || ctx.norm(a.nome).includes(q))
      .map((a) => ({ a, p: proxima(a) }))
      .sort((x, y) => x.p.dias - y.p.dias || x.a.nome.localeCompare(y.a.nome, 'pt-BR'));
    if (!lista.length) return `<p class="muted sm aniv-vazio">${q ? 'Ninguém com esse nome.' : 'Nenhum aniversário ainda.'}</p>`;
    const grupos = [
      ['Hoje', (d) => d === 0],
      ['Próximos 7 dias', (d) => d > 0 && d <= 7],
      ['Próximos 30 dias', (d) => d > 7 && d <= 30],
      ['Mais para frente', (d) => d > 30],
    ];
    return grupos
      .map(([tit, f]) => {
        const g = lista.filter((x) => f(x.p.dias));
        return g.length
          ? `<section class="aniv-grupo"><h2 class="aniv-tit">${tit}<span class="count">${g.length}</span></h2>
             <ul class="aniv-lista">${g.map((x) => linhaAniv(x.a)).join('')}</ul></section>`
          : '';
      })
      .join('');
  }

  function view() {
    const head = `<header class="page-head">
      <div><p class="eyebrow">Pessoas · ${agora()}</p><h1>Aniversários</h1></div>
      <div class="head-btns"><button type="button" class="btn primary" data-action="aniv-new">${icon('plus')}<span>Novo aniversário</span></button></div>
    </header>`;
    if (!S.anivs) {
      db.list('aniversarios')
        .then((rows) => {
          S.anivs = rows;
          render();
        })
        .catch((err) => toast(errMsg(err)));
      return head + loading();
    }
    const prox = S.anivs.map((a) => ({ a, p: proxima(a) })).sort((x, y) => x.p.dias - y.p.dias)[0];
    return `${head}
    ${
      prox
        ? `<section class="card aniv-destaque">
        <span class="aniv-bolo">${icon('aniversarios')}</span>
        <div><p class="muted sm">${prox.p.dias === 0 ? 'Aniversário hoje' : 'Próximo aniversário'}</p>
          <p class="aniv-dest-nome">${esc(prox.a.nome)}</p>
          <p class="muted sm">${prox.p.dias === 0 ? 'É hoje!' : `${faltaTxt(prox.p.dias)} · ${SEMANA[prox.p.d.getDay()]}, ${prox.a.dia} de ${MESES[prox.a.mes - 1]}`}${prox.p.idade ? ` · faz ${prox.p.idade} anos` : ''}</p></div>
      </section>`
        : ''
    }
    <section class="card aniv-card">
      ${S.anivs.length > 6 ? `<label class="journal-search">${icon('busca')}<input type="search" data-aniv-busca placeholder="Buscar pelo nome" value="${esc(S.anivBusca)}" aria-label="Buscar aniversário"></label>` : ''}
      <div id="aniv-lista">${listaAnivHTML()}</div>
    </section>`;
  }

  function openAniv(a = {}) {
    const editing = !!a.id;
    const dias = Array.from({ length: 31 }, (_, i) => i + 1);
    openModal(`<form class="modal-body" data-form="aniv" data-id="${a.id || ''}">
      ${modalHead(editing ? 'Editar aniversário' : 'Novo aniversário')}
      <label class="field"><span>De quem</span><input name="nome" required maxlength="60" autocomplete="off" value="${esc(a.nome || '')}" autofocus></label>
      <div class="row2">
        <label class="field"><span>Dia</span><select name="dia" required>
          <option value="">—</option>${dias.map((d) => `<option value="${d}" ${d === a.dia ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="field"><span>Mês</span><select name="mes" required>
          <option value="">—</option>${MESES.map((m, i) => `<option value="${i + 1}" ${i + 1 === a.mes ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Ano em que nasceu <em>opcional, para mostrar a idade</em></span>
        <input name="ano" type="number" inputmode="numeric" min="1900" max="${new Date().getFullYear()}" value="${a.ano || ''}"></label>
      <label class="field"><span>Observação <em>opcional</em></span><input name="obs" maxlength="80" autocomplete="off" value="${esc(a.obs || '')}" placeholder="Ex.: primo, cliente, igreja"></label>
      ${modalFoot(editing ? 'aniv-del' : '', a.id)}
    </form>`);
  }

  function saveAniv(form) {
    const f = Object.fromEntries(new FormData(form));
    const data = {
      nome: String(f.nome || '').trim(),
      dia: Number(f.dia),
      mes: Number(f.mes),
      ano: Number(f.ano) || null,
      obs: String(f.obs || '').trim(),
    };
    if (!data.nome || !data.dia || !data.mes) return;
    if (data.dia > new Date(2024, data.mes, 0).getDate()) return toast(`${MESES[data.mes - 1]} não tem dia ${data.dia}.`);
    const id = form.dataset.id;
    if (id) {
      Object.assign(S.anivs.find((a) => a.id === id) || {}, data);
      persist(db.update('aniversarios', id, data));
    } else {
      const a = { id: U.newId(), ...data, criadoEm: Date.now() };
      S.anivs.push(a);
      persist(db.set('aniversarios', a.id, a));
    }
    closeModal();
    render();
  }

  document.addEventListener('input', (e) => {
    if (!e.target.matches('[data-aniv-busca]')) return;
    S.anivBusca = e.target.value;
    const box = document.getElementById('aniv-lista');
    if (box) box.innerHTML = listaAnivHTML();
  });

  // -------------------------------------------------------------------------
  // Calculadora
  // -------------------------------------------------------------------------

  let conta = '';
  let acabou = false; // acabou de apertar "=": o próximo número começa outra conta

  const TECLAS = [
    ['C', 'C', 'fn'], ['bk', '⌫', 'fn'], ['%', '%', 'fn'], ['/', '÷', 'op'],
    ['7', '7'], ['8', '8'], ['9', '9'], ['*', '×', 'op'],
    ['4', '4'], ['5', '5'], ['6', '6'], ['-', '−', 'op'],
    ['1', '1'], ['2', '2'], ['3', '3'], ['+', '+', 'op'],
    ['0', '0', 'zero'], [',', ','], ['=', '=', 'igual'],
  ];

  // Conta com prioridade (× e ÷ antes de + e −). "200 + 10%" = 220; "50 × 10%" = 5.
  function avaliar(s) {
    const tk = s.match(/\d+(?:,\d*)?|[-+*/%]/g) || [];
    while (tk.length && /^[-+*/]$/.test(tk[tk.length - 1])) tk.pop();
    if (!tk.length) return null;
    let i = 0;
    const fator = () => {
      let neg = 1;
      while (tk[i] === '-' || tk[i] === '+') {
        if (tk[i] === '-') neg = -neg;
        i++;
      }
      const t = tk[i++];
      if (!t || !/\d/.test(t)) throw new Error('conta');
      const v = neg * parseFloat(t.replace(',', '.'));
      let pct = false;
      while (tk[i] === '%') {
        pct = true;
        i++;
      }
      return { v, pct };
    };
    let total = 0;
    let primeiro = true;
    while (i < tk.length) {
      let sinal = 1;
      if (!primeiro) {
        const o = tk[i++];
        if (o === '-') sinal = -1;
        else if (o !== '+') throw new Error('conta');
      }
      const f = fator();
      let val = f.pct ? (primeiro ? f.v / 100 : null) : f.v;
      while (tk[i] === '*' || tk[i] === '/') {
        const o = tk[i++];
        const g = fator();
        const gv = g.pct ? g.v / 100 : g.v;
        if (val === null) val = f.v / 100;
        val = o === '*' ? val * gv : val / gv;
      }
      if (val === null) val = (total * f.v) / 100;
      total += sinal * val;
      primeiro = false;
    }
    return Math.round(total * 1e10) / 1e10;
  }

  const bonito = (s) => s.replace(/\*/g, ' × ').replace(/\//g, ' ÷ ').replace(/\+/g, ' + ').replace(/(\d|%)-/g, '$1 − ');
  const fmtNum = (v) => v.toLocaleString('pt-BR', { maximumFractionDigits: 8 });

  function mostra() {
    const ex = document.querySelector('[data-calc-expr]');
    const re = document.querySelector('[data-calc-res]');
    if (!ex || !re) return;
    let v = null;
    try {
      v = avaliar(conta);
    } catch {
      v = NaN;
    }
    ex.textContent = bonito(conta) || ' ';
    re.textContent = v === null ? '0' : !Number.isFinite(v) ? 'Não dá para dividir por zero' : fmtNum(v);
    re.classList.toggle('final', acabou);
  }

  function tecla(k) {
    const ult = conta.slice(-1);
    const numAtual = conta.match(/[\d,]*$/)[0];
    if (k === 'C') {
      conta = '';
      acabou = false;
    } else if (k === 'bk') {
      conta = acabou ? '' : conta.slice(0, -1);
      acabou = false;
    } else if (k === '=') {
      let v = null;
      try {
        v = avaliar(conta);
      } catch {}
      if (v === null || !Number.isFinite(v)) return mostra();
      conta = String(v).replace('.', ',');
      acabou = true;
    } else if ('+-*/'.includes(k)) {
      if (!conta && k !== '-') return;
      if ('+-*/'.includes(ult)) conta = conta.slice(0, -1);
      if (ult === ',') conta += '0';
      conta += k;
      acabou = false;
    } else if (k === '%') {
      if (!/[\d]/.test(ult)) return;
      conta += '%';
      acabou = false;
    } else if (k === ',') {
      if (acabou) conta = '';
      acabou = false;
      if (numAtual.includes(',')) return;
      conta += numAtual ? ',' : '0,';
    } else if (/^\d$/.test(k)) {
      if (acabou) conta = '';
      acabou = false;
      if (ult === '%') conta += '*';
      if (numAtual === '0') conta = conta.slice(0, -1);
      conta += k;
    }
    mostra();
  }

  function openCalc() {
    conta = '';
    acabou = false;
    openModal(`<div class="modal-body calc" data-calc>
      ${modalHead(`${icon('calc')}Calculadora`)}
      <div class="calc-tela" aria-live="polite"><div class="calc-expr" data-calc-expr> </div><div class="calc-res" data-calc-res>0</div></div>
      <div class="calc-teclas">${TECLAS.map(([k, l, c]) => `<button type="button" class="calc-k${c ? ` ${c}` : ''}" data-action="calc-k" data-k="${k}" aria-label="${l === '⌫' ? 'Apagar' : l}">${l}</button>`).join('')}</div>
      <button type="button" class="btn ghost sm calc-copiar" data-action="calc-copiar">Copiar resultado</button>
    </div>`);
  }

  // Teclado do computador também funciona enquanto a calculadora está aberta.
  document.addEventListener('keydown', (e) => {
    if (!document.querySelector('#modal[open] [data-calc]') || e.ctrlKey || e.metaKey || e.altKey) return;
    const mapa = { Enter: '=', '=': '=', Backspace: 'bk', Delete: 'C', '.': ',', ',': ',', x: '*', X: '*', '*': '*', '/': '/', '+': '+', '-': '-', '%': '%' };
    const k = /^\d$/.test(e.key) ? e.key : mapa[e.key];
    if (!k) return;
    e.preventDefault();
    tecla(k);
    const b = document.querySelector(`.calc-k[data-k="${CSS.escape(k)}"]`);
    if (b) {
      b.classList.add('apertou');
      setTimeout(() => b.classList.remove('apertou'), 120);
    }
  });

  const ACTIONS = {
    'aniv-new': () => openAniv(),
    'aniv-edit': ({ id }) => {
      const a = S.anivs?.find((x) => x.id === id);
      if (a) openAniv(a);
    },
    'aniv-del': async ({ id }) => {
      const a = S.anivs?.find((x) => x.id === id);
      if (!a || !(await ask(`Excluir o aniversário de ${a.nome}?`))) return;
      S.anivs = S.anivs.filter((x) => x.id !== id);
      persist(db.remove('aniversarios', id));
      closeModal();
      render();
    },
    'calc-open': () => openCalc(),
    'calc-k': ({ k }) => tecla(k),
    'calc-copiar': async () => {
      let v = null;
      try {
        v = avaliar(conta);
      } catch {}
      if (v === null || !Number.isFinite(v)) return toast('Nada para copiar.');
      try {
        await navigator.clipboard.writeText(String(v).replace('.', ','));
        toast(`Copiado: ${fmtNum(v)}`);
      } catch {
        toast('Não deu para copiar.');
      }
    },
  };

  return { view, ACTIONS, FORMS: { aniv: saveAniv }, avaliar };
}
