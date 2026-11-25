// Datas importantes (aniversários, namoro... com quantos dias faltam) e calculadora rápida.

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

export function createExtras(ctx) {
  const { S, db, U, esc, icon, openModal, closeModal, toast, persist, render, ask, modalHead, modalFoot, agora, errMsg, loading } = ctx;

  // -------------------------------------------------------------------------
  // Datas importantes (antes "Aniversários"): cada data tem uma categoria com ícone e cor.
  // Aniversário mostra "Aniversário de Fulano · faz N anos"; as outras, "N anos de <título>".
  // -------------------------------------------------------------------------

  S.anivs = null;
  S.datasCats = null;
  S.anivBusca = '';
  S.anivCat = 'todas';
  let carregando = false;

  const ICONES = ['aniversarios', 'coracao', 'anel', 'estrela', 'presente', 'casa', 'aviao', 'formatura', 'cruz', 'pata', 'musica', 'sorriso', 'bandeira', 'calendario', 'clientes'];
  const CORES = ['#64748b', '#ef4444', '#ec4899', '#f97316', '#eab308', '#22c55e', '#14b8a6', '#0ea5e9', '#6366f1', '#8b5cf6'];
  const CATS_PADRAO = [
    { id: 'aniversario', nome: 'Aniversário', icone: 'aniversarios', cor: '#64748b', ordem: 0 },
    { id: 'relacionamento', nome: 'Relacionamento', icone: 'coracao', cor: '#ef4444', ordem: 1 },
  ];

  // As duas de fábrica (podem ser editadas) + as criadas.
  function cats() {
    const salvas = S.datasCats || [];
    const out = CATS_PADRAO.map((d) => ({ ...d, ...(salvas.find((s) => s.id === d.id) || {}) }));
    for (const s of salvas) if (!CATS_PADRAO.some((d) => d.id === s.id)) out.push(s);
    return out
      .filter((c) => !c.excluida && c.nome)
      .sort((a, b) => (a.ordem ?? 50) - (b.ordem ?? 50) || a.nome.localeCompare(b.nome, 'pt-BR'));
  }
  const catIdDe = (a) => a.catId || 'aniversario';
  const catDe = (a) => cats().find((c) => c.id === catIdDe(a)) || CATS_PADRAO.find((c) => c.id === catIdDe(a)) || CATS_PADRAO[0];
  const ehAniv = (a) => catIdDe(a) === 'aniversario';

  // Próxima vez que a data cai a partir de hoje (hoje conta). 29/02 em ano comum vira 28/02.
  function proxima(a) {
    const hoje = U.parseYmd(U.todayStr());
    const em = (y) => new Date(y, a.mes - 1, Math.min(a.dia, new Date(y, a.mes, 0).getDate()));
    let d = em(hoje.getFullYear());
    if (d < hoje) d = em(hoje.getFullYear() + 1);
    return { d, dias: Math.round((d - hoje) / 86400000), idade: a.ano ? d.getFullYear() - a.ano : null };
  }

  const faltaTxt = (n) => (n === 0 ? 'Hoje!' : n === 1 ? 'Amanhã' : `Faltam ${n} dias`);
  const anosTxt = (n) => `${n} ano${n === 1 ? '' : 's'}`;

  // Título e "faz N anos" de cada data.
  function textos(a, p) {
    if (ehAniv(a)) return { tit: `Aniversário de ${a.nome}`, anos: p.idade > 0 ? `faz ${anosTxt(p.idade)}` : '' };
    return { tit: p.idade > 0 ? `${anosTxt(p.idade)} de ${a.nome}` : a.nome, anos: '' };
  }

  function linhaAniv(a) {
    const p = proxima(a);
    const c = catDe(a);
    const tx = textos(a, p);
    const sub = [tx.anos, p.dias ? SEMANA[p.d.getDay()] : '', a.obs || ''].filter(Boolean).join(' · ');
    return `<li><button type="button" class="aniv-item${p.dias === 0 ? ' hoje' : p.dias <= 7 ? ' perto' : ''}" style="--c:${c.cor}" data-action="aniv-edit" data-id="${a.id}">
      <span class="aniv-data"><strong>${p.d.getDate()}</strong>${icon(c.icone)}</span>
      <span class="aniv-nome"><strong>${esc(tx.tit)}</strong>${sub ? `<small class="muted">${esc(sub)}</small>` : ''}</span>
      <span class="aniv-falta">${faltaTxt(p.dias)}</span>
    </button></li>`;
  }

  const filtradas = () => {
    const q = ctx.norm(S.anivBusca || '');
    return (S.anivs || []).filter((a) => (S.anivCat === 'todas' || catIdDe(a) === S.anivCat) && (!q || ctx.norm(a.nome).includes(q)));
  };

  function listaAnivHTML() {
    const lista = filtradas()
      .map((a) => ({ a, p: proxima(a) }))
      .sort((x, y) => x.p.dias - y.p.dias || x.a.nome.localeCompare(y.a.nome, 'pt-BR'));
    if (!lista.length) return `<p class="muted sm aniv-vazio">${S.anivBusca ? 'Nada com esse nome.' : 'Nenhuma data ainda.'}</p>`;
    // Por ano e mês, na ordem em que vão acontecer (o que já passou neste ano vai para o ano que vem).
    const anos = new Map();
    for (const x of lista) {
      const y = x.p.d.getFullYear();
      const m = x.p.d.getMonth();
      if (!anos.has(y)) anos.set(y, new Map());
      const meses = anos.get(y);
      if (!meses.has(m)) meses.set(m, []);
      meses.get(m).push(x);
    }
    return [...anos]
      .map(
        ([y, meses]) => `<section class="aniv-ano"><h2 class="aniv-ano-tit">${y}</h2>
        ${[...meses]
          .map(
            ([m, g]) => `<div class="aniv-mes"><h3 class="aniv-mes-tit">${U.cap(MESES[m])}<span class="count">${g.length}</span></h3>
            <ul class="aniv-lista">${g.map((x) => linhaAniv(x.a)).join('')}</ul></div>`,
          )
          .join('')}</section>`,
      )
      .join('');
  }

  function view() {
    const head = `<header class="page-head">
      <div><p class="eyebrow">Datas · ${agora()}</p><h1>Datas importantes</h1></div>
      <div class="head-btns">
        <button type="button" class="btn soft" data-action="aniv-cats">${icon('categorias')}<span>Categorias</span></button>
        <button type="button" class="btn primary" data-action="aniv-new">${icon('plus')}<span>Nova<span class="so-largo"> data</span></span></button>
      </div>
    </header>`;
    if (!S.anivs || !S.datasCats) {
      if (!carregando) {
        carregando = true;
        Promise.all([db.list('aniversarios'), db.list('datasCats')])
          .then(([rows, cs]) => {
            S.anivs = rows;
            S.datasCats = cs;
            render();
          })
          .catch((err) => toast(errMsg(err)))
          .finally(() => (carregando = false));
      }
      return head + loading();
    }
    const lista = filtradas();
    const prox = lista.map((a) => ({ a, p: proxima(a) })).sort((x, y) => x.p.dias - y.p.dias)[0];
    const cs = cats();
    const chip = (id, txt, n) =>
      `<button type="button" class="tab-chip${S.anivCat === id ? ' on' : ''}" data-action="aniv-filtro" data-c="${id}">${txt}${n ? ` <span>${n}</span>` : ''}</button>`;
    const filtro =
      cs.length > 1 && S.anivs.length
        ? `<div class="tab-chips aniv-filtro">${chip('todas', 'Todas', S.anivs.length)}${cs
            .map((c) => chip(c.id, `${icon(c.icone)}${esc(c.nome)}`, S.anivs.filter((a) => catIdDe(a) === c.id).length))
            .join('')}</div>`
        : '';
    let dest = '';
    if (prox) {
      const c = catDe(prox.a);
      const tx = textos(prox.a, prox.p);
      dest = `<section class="card aniv-destaque" style="--c:${c.cor}">
        <span class="aniv-bolo">${icon(c.icone)}</span>
        <div><p class="muted sm">${prox.p.dias === 0 ? 'Hoje' : 'Próxima data'}</p>
          <p class="aniv-dest-nome">${esc(tx.tit)}</p>
          <p class="muted sm">${prox.p.dias === 0 ? 'É hoje!' : `${faltaTxt(prox.p.dias)} · ${SEMANA[prox.p.d.getDay()]}, ${prox.a.dia} de ${MESES[prox.a.mes - 1]}`}${tx.anos ? ` · ${tx.anos}` : ''}</p></div>
      </section>`;
    }
    return `${head}
    ${filtro}
    ${dest}
    <section class="card aniv-card">
      ${S.anivs.length > 6 ? `<label class="journal-search">${icon('busca')}<input type="search" data-aniv-busca placeholder="Buscar pelo nome" value="${esc(S.anivBusca)}" aria-label="Buscar data"></label>` : ''}
      <div id="aniv-lista">${listaAnivHTML()}</div>
    </section>`;
  }

  const nomeLbl = (catId) => (catId === 'aniversario' ? 'De quem' : 'Título');
  const nomeDica = (catId) =>
    catId === 'aniversario' ? 'Aparece como “Aniversário de Fulano · faz N anos”.' : 'Ex.: “namoro” aparece como “3 anos de namoro”.';
  const anoLbl = (catId) => `Ano <em>opcional, para mostrar ${catId === 'aniversario' ? 'a idade' : 'quantos anos faz'}</em>`;

  function openAniv(a = {}) {
    const editing = !!a.id;
    const catId = a.id ? catIdDe(a) : S.anivCat !== 'todas' ? S.anivCat : 'aniversario';
    const dias = Array.from({ length: 31 }, (_, i) => i + 1);
    openModal(`<form class="modal-body" data-form="aniv" data-id="${a.id || ''}">
      ${modalHead(editing ? 'Editar data' : 'Nova data')}
      <label class="field"><span>Categoria</span><select name="catId" data-aniv-cat>${cats()
        .map((c) => `<option value="${c.id}" ${c.id === catId ? 'selected' : ''}>${esc(c.nome)}</option>`)
        .join('')}</select></label>
      <label class="field"><span data-aniv-nome-lbl>${nomeLbl(catId)}</span><input name="nome" required maxlength="60" autocomplete="off" value="${esc(a.nome || '')}" autofocus>
        <small class="hint" data-aniv-dica>${nomeDica(catId)}</small></label>
      <div class="row2">
        <label class="field"><span>Dia</span><select name="dia" required>
          <option value="">—</option>${dias.map((d) => `<option value="${d}" ${d === a.dia ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
        <label class="field"><span>Mês</span><select name="mes" required>
          <option value="">—</option>${MESES.map((m, i) => `<option value="${i + 1}" ${i + 1 === a.mes ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span data-aniv-ano-lbl>${anoLbl(catId)}</span>
        <input name="ano" type="number" inputmode="numeric" min="1900" max="${new Date().getFullYear() + 1}" value="${a.ano || ''}"></label>
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
      catId: f.catId || 'aniversario',
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

  // Categorias: lista, nova e editar (nome, ícone e cor do card).
  function openCats() {
    openModal(`<div class="modal-body datas-cats">
      ${modalHead('Categorias')}
      <ul class="dc-lista">${cats()
        .map((c) => {
          const n = (S.anivs || []).filter((a) => catIdDe(a) === c.id).length;
          return `<li style="--c:${c.cor}"><span class="dc-ic">${icon(c.icone)}</span>
            <span class="grow"><strong>${esc(c.nome)}</strong> <small class="muted">${n} data${n === 1 ? '' : 's'}</small></span>
            <button type="button" class="icon-btn sm" data-action="datacat-edit" data-id="${c.id}" aria-label="Editar ${esc(c.nome)}">${icon('edit')}</button></li>`;
        })
        .join('')}</ul>
      <button type="button" class="btn soft full" data-action="datacat-new">${icon('plus')}Nova categoria</button>
    </div>`);
  }

  function openCatForm(c = {}) {
    const cor = c.cor || CORES[cats().length % CORES.length];
    const ic = c.icone || 'estrela';
    openModal(`<form class="modal-body" data-form="datacat" data-id="${c.id || ''}">
      ${modalHead(c.id ? 'Editar categoria' : 'Nova categoria')}
      <label class="field"><span>Nome</span><input name="nome" required maxlength="30" autocomplete="off" value="${esc(c.nome || '')}" autofocus placeholder="Ex.: Amizade, Casa, Viagem"></label>
      <fieldset class="field"><legend>Ícone</legend>
        <div class="ic-picks">${ICONES.map((i) => `<label class="ic-pick"><input type="radio" name="icone" value="${i}" ${i === ic ? 'checked' : ''} aria-label="${i}"><span>${icon(i)}</span></label>`).join('')}</div></fieldset>
      <fieldset class="field"><legend>Cor do card</legend>
        <div class="swatches">${CORES.map((p) => `<label class="sw" style="--c:${p}"><input type="radio" name="cor" value="${p}" ${p === cor ? 'checked' : ''} aria-label="${p}"><span></span></label>`).join('')}</div></fieldset>
      <footer class="modal-actions">
        ${c.id ? `<button type="button" class="btn ghost danger-text" data-action="datacat-del" data-id="${c.id}">${icon('trash')}Excluir</button>` : ''}
        <span class="grow"></span>
        <button type="button" class="btn ghost" data-action="aniv-cats">Voltar</button>
        <button type="submit" class="btn primary">Salvar</button>
      </footer>
    </form>`);
  }

  function saveCat(form) {
    const f = Object.fromEntries(new FormData(form));
    const nome = String(f.nome || '').trim();
    if (!nome) return form.elements.nome.focus();
    const id = form.dataset.id || U.newId();
    const antes = cats().find((c) => c.id === id);
    const c = { ...(antes || { ordem: 10 + cats().length }), id, nome, icone: f.icone || 'estrela', cor: f.cor || CORES[0] };
    S.datasCats = [...(S.datasCats || []).filter((x) => x.id !== id), c];
    persist(db.set('datasCats', id, c));
    render();
    openCats();
  }

  document.addEventListener('input', (e) => {
    if (!e.target.matches('[data-aniv-busca]')) return;
    S.anivBusca = e.target.value;
    const box = document.getElementById('aniv-lista');
    if (box) box.innerHTML = listaAnivHTML();
  });

  // Trocou a categoria no formulário: o nome do campo e a dica acompanham.
  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-aniv-cat]')) return;
    const form = e.target.form;
    const v = e.target.value;
    form.querySelector('[data-aniv-nome-lbl]').textContent = nomeLbl(v);
    form.querySelector('[data-aniv-dica]').textContent = nomeDica(v);
    form.querySelector('[data-aniv-ano-lbl]').innerHTML = anoLbl(v);
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
      if (!a || !(await ask(ehAniv(a) ? `Excluir o aniversário de ${a.nome}?` : `Excluir a data “${a.nome}”?`))) return;
      S.anivs = S.anivs.filter((x) => x.id !== id);
      persist(db.remove('aniversarios', id));
      closeModal();
      render();
    },
    'aniv-cats': () => openCats(),
    'aniv-filtro': ({ c }) => {
      S.anivCat = c || 'todas';
      render();
    },
    'datacat-new': () => openCatForm(),
    'datacat-edit': ({ id }) => {
      const c = cats().find((x) => x.id === id);
      if (c) openCatForm(c);
    },
    'datacat-del': async ({ id }) => {
      const c = cats().find((x) => x.id === id);
      if (!c) return;
      const n = (S.anivs || []).filter((a) => catIdDe(a) === id).length;
      if (n) return toast(`Há ${n} data${n === 1 ? '' : 's'} em “${c.nome}”. Mude a categoria delas antes.`);
      if (cats().length <= 1) return toast('Fica pelo menos uma categoria.');
      if (!(await ask(`Excluir a categoria “${c.nome}”?`))) return openCatForm(c);
      const padrao = CATS_PADRAO.some((d) => d.id === id);
      S.datasCats = (S.datasCats || []).filter((x) => x.id !== id);
      if (padrao) {
        S.datasCats.push({ id, excluida: true });
        persist(db.set('datasCats', id, { id, excluida: true }));
      } else persist(db.remove('datasCats', id));
      if (S.anivCat === id) S.anivCat = 'todas';
      render();
      openCats();
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

  return { view, ACTIONS, FORMS: { aniv: saveAniv, datacat: saveCat }, avaliar };
}
