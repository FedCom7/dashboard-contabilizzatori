// ==========================================
// Firebase — copia cloud dei dati (Firestore) con accesso via email/password.
// Le regole di sicurezza (firestore.rules) consentono l'accesso solo al proprietario.
// ==========================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import {
    initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
    collection, getDocs, doc, writeBatch
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
    GoogleAuthProvider, signInWithPopup
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

let db = null, auth = null, user = null;
let resolveReady;
const ready = new Promise(r => { resolveReady = r; });
const listeners = new Set();

try {
    const app = initializeApp(firebaseConfig);
    // Cache locale persistente: le scritture fatte offline partono appena torna la rete
    db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    auth = getAuth(app);
    onAuthStateChanged(auth, (u) => {
        user = u;
        resolveReady();
        listeners.forEach(fn => fn(u));
    });
} catch (error) {
    console.error("Error initializing Firebase:", error);
    resolveReady();
}

// Ultimo stato noto del cloud, per scrivere solo ciò che è cambiato
const known = { letture: new Map(), heating_periods: new Map() };
const idOf = { letture: (r) => r.data, heating_periods: (p) => p.start };

// Traduce gli errori Firestore/Auth in messaggi comprensibili
const explain = (e) => {
    const msg = String(e?.message || e);
    if (/database.*does not exist|NOT_FOUND/i.test(msg) || e?.code === 'not-found') return 'Firestore database not created yet (Firebase console → Firestore Database → Create database).';
    if (e?.code === 'permission-denied') return 'Permission denied: check the security rules and that your UID is in firestore.rules.';
    if (e?.code === 'auth/invalid-credential' || e?.code === 'auth/wrong-password' || e?.code === 'auth/user-not-found') return 'Wrong email or password.';
    if (e?.code === 'auth/configuration-not-found') return 'Authentication is not set up yet (Firebase console → Authentication → Get started).';
    if (e?.code === 'auth/operation-not-allowed') return 'This sign-in method is not enabled (Firebase console → Authentication → Sign-in method).';
    if (e?.code === 'auth/unauthorized-domain') return `This address (${location.hostname}) is not authorized (Firebase console → Authentication → Settings → Authorized domains).`;
    if (e?.code === 'auth/popup-blocked') return 'The browser blocked the Google window: allow pop-ups for this site and try again.';
    if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') return 'Sign-in cancelled.';
    if (e?.code === 'auth/operation-not-supported-in-this-environment' || e?.code === 'auth/web-storage-unsupported') return 'Google sign-in is not available here (e.g. app on the home screen): open the site in the browser, or use email and password.';
    if (e?.code === 'auth/too-many-requests') return 'Too many attempts, try again in a few minutes.';
    if (e?.code === 'unavailable') return 'Offline: changes will sync when the connection is back.';
    return msg;
};

const fetchCollection = async (name) => {
    const snap = await getDocs(collection(db, name));
    known[name] = new Map(snap.docs.map(d => [d.id, JSON.stringify(d.data())]));
    return snap.docs.map(d => d.data());
};

// Scrive solo i documenti nuovi/modificati e cancella quelli rimossi (batch da max 500 operazioni)
const syncCollection = async (name, items) => {
    const ops = [];
    const next = new Map(items.map(it => [idOf[name](it), JSON.stringify(it)]));
    next.forEach((json, id) => { if (known[name].get(id) !== json) ops.push({ type: 'set', id, data: JSON.parse(json) }); });
    known[name].forEach((_, id) => { if (!next.has(id)) ops.push({ type: 'del', id }); });
    for (let i = 0; i < ops.length; i += 450) {
        const batch = writeBatch(db);
        ops.slice(i, i + 450).forEach(op => {
            const ref = doc(db, name, op.id);
            if (op.type === 'set') batch.set(ref, op.data); else batch.delete(ref);
        });
        await batch.commit();
    }
    known[name] = next;
    return ops.length;
};

window.FirebaseService = {
    ready,
    isInitialized: () => !!db,
    isSignedIn: () => !!user,
    user: () => user ? { uid: user.uid, email: user.email } : null,
    onAuthChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    explain,

    signInWithGoogle: () => {
        const provider = new GoogleAuthProvider();
        provider.setCustomParameters({ prompt: 'select_account' });
        return signInWithPopup(auth, provider);
    },
    signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
    signOut: () => signOut(auth),

    getLetture: () => fetchCollection('letture'),
    getHeatingPeriods: () => fetchCollection('heating_periods'),

    // Sincronizza lo stato completo: ritorna il numero di operazioni eseguite
    sync: async (letture, periods) => {
        const a = await syncCollection('letture', letture);
        const b = await syncCollection('heating_periods', periods);
        return a + b;
    }
};
