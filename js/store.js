// Camada de dados. Usa Firebase (Auth + Firestore) quando configurado,
// ou o localStorage do navegador no modo demonstração.
//
// Todos os dados de um usuário ficam em users/{uid}/<coleção>/{id},
// e cada documento também guarda o campo uid.

import { firebaseConfig } from './firebase-config.js';

const SDK = 'https://www.gstatic.com/firebasejs/12.19.0';

export const isDemo = !firebaseConfig?.apiKey;
// Avisos com o app fechado precisam da chave "vapidKey" do Firebase Cloud Messaging.
export const pushConfigured = !isDemo && !!firebaseConfig?.vapidKey;

let backend;

export async function initBackend(onUser) {
  backend = isDemo ? createLocal() : await createFirebase();
  backend.watchAuth(onUser);
}

export const signIn = () => backend.signIn();
export const signOut = () => backend.signOut();

// Token deste aparelho para receber avisos pelo Firebase Cloud Messaging (null se não suportado).
export const getPushToken = (swRegistration) => backend.pushToken(swRegistration);
export const deletePushToken = () => backend.pushDelete();

// Lista de e-mails liberados (coleção "permitidos", fora dos dados de cada usuário).
export const access = {
  get: (email) => backend.access.get(email),
  list: () => backend.access.list(),
  set: (email, data) => backend.access.set(email, data),
  remove: (email) => backend.access.remove(email),
};

export const db = {
  get: (col, id) => backend.get(col, id),
  list: (col) => backend.where(col, []),
  where: (col, field, op, value) => backend.where(col, [[field, op, value]]),
  range: (col, field, from, to) => backend.where(col, [[field, '>=', from], [field, '<=', to]]),
  set: (col, id, data) => backend.batch([{ type: 'set', col, id, data }]),
  update: (col, id, data) => backend.batch([{ type: 'update', col, id, data }]),
  remove: (col, id) => backend.batch([{ type: 'delete', col, id }]),
  // ops: [{ type: 'set' | 'update' | 'delete', col, id, data }]
  batch: (ops) => (ops.length ? backend.batch(ops) : Promise.resolve()),
  getProfile: () => backend.getProfile(),
  setProfile: (patch) => backend.setProfile(patch),
};

// Firestore não aceita undefined; o id vai no caminho, não no documento.
const clean = (obj) => {
  const o = { ...obj };
  delete o.id;
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
};

async function createFirebase() {
  const [appMod, authMod, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  const { vapidKey, ...appOptions } = firebaseConfig;
  const app = appMod.initializeApp(appOptions);
  const auth = authMod.getAuth(app);
  auth.languageCode = 'pt-BR';

  let fdb;
  try {
    // Cache offline: o app abre e funciona mesmo sem internet, e sincroniza depois.
    fdb = fs.initializeFirestore(app, {
      localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
    });
  } catch {
    fdb = fs.getFirestore(app);
  }

  let uid = null;
  const colRef = (c) => fs.collection(fdb, 'users', uid, c);
  const docRef = (c, id) => fs.doc(fdb, 'users', uid, c, id);
  const rows = (snap) => snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  const accRef = (email) => fs.doc(fdb, 'permitidos', email);

  return {
    access: {
      async get(email) {
        const snap = await fs.getDoc(accRef(email));
        return snap.exists() ? { ...snap.data(), email: snap.id } : null;
      },
      async list() {
        const snap = await fs.getDocs(fs.collection(fdb, 'permitidos'));
        return snap.docs.map((d) => ({ ...d.data(), email: d.id }));
      },
      set: (email, data) => fs.setDoc(accRef(email), clean(data), { merge: true }),
      remove: (email) => fs.deleteDoc(accRef(email)),
    },
    watchAuth(cb) {
      authMod.onAuthStateChanged(auth, (u) => {
        uid = u?.uid ?? null;
        cb(u ? { uid: u.uid, nome: u.displayName || '', email: u.email || '', foto: u.photoURL || '' } : null);
      });
    },
    async signIn() {
      const provider = new authMod.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try {
        await authMod.signInWithPopup(auth, provider);
      } catch (err) {
        // Alguns navegadores de celular bloqueiam popup: cai para redirecionamento.
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(err.code)) {
          await authMod.signInWithRedirect(auth, provider);
        } else {
          throw err;
        }
      }
    },
    signOut: () => authMod.signOut(auth),
    async pushToken(swRegistration) {
      const m = await import(`${SDK}/firebase-messaging.js`);
      if (!(await m.isSupported())) return null;
      return m.getToken(m.getMessaging(app), { vapidKey: firebaseConfig.vapidKey, serviceWorkerRegistration: swRegistration });
    },
    async pushDelete() {
      const m = await import(`${SDK}/firebase-messaging.js`);
      if (await m.isSupported()) await m.deleteToken(m.getMessaging(app));
    },
    async get(c, id) {
      const snap = await fs.getDoc(docRef(c, id));
      return snap.exists() ? { ...snap.data(), id: snap.id } : null;
    },
    async where(c, conds) {
      const q = conds.length ? fs.query(colRef(c), ...conds.map(([f, o, v]) => fs.where(f, o, v))) : colRef(c);
      return rows(await fs.getDocs(q));
    },
    async batch(ops) {
      for (let i = 0; i < ops.length; i += 450) {
        const b = fs.writeBatch(fdb);
        for (const op of ops.slice(i, i + 450)) {
          const ref = docRef(op.col, op.id);
          if (op.type === 'set') b.set(ref, clean({ ...op.data, uid }));
          else if (op.type === 'update') b.update(ref, clean(op.data));
          else b.delete(ref);
        }
        await b.commit();
      }
    },
    async getProfile() {
      const snap = await fs.getDoc(fs.doc(fdb, 'users', uid));
      return snap.exists() ? snap.data() : null;
    },
    setProfile: (patch) => fs.setDoc(fs.doc(fdb, 'users', uid), clean({ ...patch, uid }), { merge: true }),
  };
}

const DEMO_KEY = 'rotina-demo:';

export function resetDemo() {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(DEMO_KEY) && k !== DEMO_KEY + 'session')
      .forEach((k) => localStorage.removeItem(k));
  } catch {}
}

function createLocal() {
  const read = (key, fallback) => {
    try {
      return JSON.parse(localStorage.getItem(DEMO_KEY + key)) ?? fallback;
    } catch {
      return fallback;
    }
  };
  const write = (key, value) => {
    try {
      localStorage.setItem(DEMO_KEY + key, JSON.stringify(value));
    } catch {}
  };
  const test = (row, [f, o, v]) => (o === '==' ? row[f] === v : o === '>=' ? row[f] >= v : o === '<=' ? row[f] <= v : true);
  const user = { uid: 'demo', nome: 'Visitante', email: 'Modo demonstração', foto: '' };
  let notify = () => {};

  return {
    // No modo demonstração o visitante é administrador, para poder conhecer a tela Acessos.
    access: {
      get: async (email) => (email === user.email ? { email, admin: true } : read('permitidos', {})[email] ?? null),
      list: async () => [
        { email: user.email, admin: true },
        ...Object.entries(read('permitidos', {})).map(([email, d]) => ({ ...d, email })),
      ],
      async set(email, data) {
        write('permitidos', { ...read('permitidos', {}), [email]: { ...read('permitidos', {})[email], ...data } });
      },
      async remove(email) {
        const m = read('permitidos', {});
        delete m[email];
        write('permitidos', m);
      },
    },
    watchAuth(cb) {
      notify = cb;
      cb(read('session', false) ? user : null);
    },
    async signIn() {
      write('session', true);
      notify(user);
    },
    async signOut() {
      write('session', false);
      notify(null);
    },
    pushToken: async () => null,
    pushDelete: async () => {},
    async get(c, id) {
      const row = read(c, {})[id];
      return row ? { ...row, id } : null;
    },
    async where(c, conds) {
      const all = read(c, {});
      return Object.entries(all)
        .map(([id, data]) => ({ ...data, id }))
        .filter((row) => conds.every((cond) => test(row, cond)));
    },
    async batch(ops) {
      const touched = {};
      for (const op of ops) {
        const m = (touched[op.col] ??= read(op.col, {}));
        if (op.type === 'set') m[op.id] = clean({ ...op.data, uid: user.uid });
        else if (op.type === 'update') m[op.id] = { ...m[op.id], ...clean(op.data) };
        else delete m[op.id];
      }
      for (const [c, m] of Object.entries(touched)) write(c, m);
    },
    async getProfile() {
      return read('profile', null);
    },
    async setProfile(patch) {
      write('profile', { ...read('profile', {}), ...clean(patch) });
    },
  };
}
