// שכבת הנתונים מול Firebase: הזדהות באימייל וסיסמה + Firestore עם מטמון
// מקומי, כך שאפשר להזין הוצאות גם בלי קליטה והן יסתנכרנו כשהרשת חוזרת.
//
// מבנה הנתונים:
//   users/{uid}                      { hid }  — לאיזה משק בית המשתמש שייך
//   households/{hid}                 { name, members[], names{}, joinOpen, startDay, categories[] }
//   households/{hid}/recurring/{id}  הכנסות והוצאות קבועות
//   households/{hid}/expenses/{id}   הוצאות משתנות

import { DEFAULT_CATEGORIES } from './budget.js';

export async function createFirebaseStore(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import('../vendor/firebase/firebase-app.js'),
    import('../vendor/firebase/firebase-auth.js'),
    import('../vendor/firebase/firebase-firestore.js'),
  ]);

  const { emulator, ...options } = config;
  const app = initializeApp(options);
  const auth = A.getAuth(app);
  let db;
  try {
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch {
    db = F.getFirestore(app); // למשל בגלישה פרטית, בלי IndexedDB
  }
  if (emulator) {
    // לבדיקות מקומיות בלבד (ראו README)
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }

  const toUser = (u) => (u ? { uid: u.uid, email: u.email || '', name: u.displayName || '' } : null);
  const household = (hid) => F.doc(db, 'households', hid);
  const sub = (hid, name) => F.collection(db, 'households', hid, name);
  const rows = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  // ההרשמה מעדכנת שם תצוגה אחרי יצירת המשתמש; ממתינים לה לפני שמדווחים על כניסה
  let pendingSignUp = Promise.resolve();

  return {
    kind: 'firebase',

    onAuth(cb) {
      return A.onAuthStateChanged(auth, async () => {
        await pendingSignUp.catch(() => {});
        cb(toUser(auth.currentUser));
      });
    },
    signIn: (email, password) => A.signInWithEmailAndPassword(auth, email, password),
    signUp(email, password, name) {
      pendingSignUp = (async () => {
        const cred = await A.createUserWithEmailAndPassword(auth, email, password);
        await A.updateProfile(cred.user, { displayName: name });
      })();
      return pendingSignUp;
    },
    resetPassword: (email) => A.sendPasswordResetEmail(auth, email),
    signOut: () => A.signOut(auth),

    async myHousehold(uid) {
      const snap = await F.getDoc(F.doc(db, 'users', uid));
      return snap.exists() ? snap.data().hid || null : null;
    },
    async createHousehold(user, name) {
      const ref = F.doc(F.collection(db, 'households'));
      await F.setDoc(ref, {
        name,
        members: [user.uid],
        names: { [user.uid]: user.name },
        joinOpen: true,
        startDay: 1,
        categories: DEFAULT_CATEGORIES,
        createdAt: F.serverTimestamp(),
      });
      await F.setDoc(F.doc(db, 'users', user.uid), { hid: ref.id });
      return ref.id;
    },
    async joinHousehold(user, hid) {
      await F.updateDoc(household(hid), {
        members: F.arrayUnion(user.uid),
        [`names.${user.uid}`]: user.name,
      });
      await F.setDoc(F.doc(db, 'users', user.uid), { hid });
      return hid;
    },

    watchHousehold(hid, cb, onError) {
      return F.onSnapshot(household(hid), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), onError);
    },
    watchRecurring(hid, cb, onError) {
      return F.onSnapshot(sub(hid, 'recurring'), (s) => cb(rows(s)), onError);
    },
    watchExpenses(hid, start, end, cb, onError) {
      const q = F.query(sub(hid, 'expenses'), F.where('date', '>=', start), F.where('date', '<', end));
      return F.onSnapshot(q, (s) => cb(rows(s)), onError);
    },

    updateHousehold: (hid, patch) => F.updateDoc(household(hid), patch),
    addRecurring: (hid, item) => F.addDoc(sub(hid, 'recurring'), { ...item, createdAt: Date.now() }),
    updateRecurring: (hid, id, patch) => F.updateDoc(F.doc(sub(hid, 'recurring'), id), patch),
    deleteRecurring: (hid, id) => F.deleteDoc(F.doc(sub(hid, 'recurring'), id)),
    addExpenses(hid, items) {
      const batch = F.writeBatch(db);
      const now = Date.now();
      items.forEach((item, i) => batch.set(F.doc(sub(hid, 'expenses')), { ...item, createdAt: now + i }));
      return batch.commit();
    },
    updateExpense: (hid, id, patch) => F.updateDoc(F.doc(sub(hid, 'expenses'), id), patch),
    deleteExpense: (hid, id) => F.deleteDoc(F.doc(sub(hid, 'expenses'), id)),

    async exportAll(hid) {
      const [recurring, expenses] = await Promise.all([
        F.getDocs(sub(hid, 'recurring')),
        F.getDocs(sub(hid, 'expenses')),
      ]);
      return { recurring: rows(recurring), expenses: rows(expenses) };
    },
  };
}
