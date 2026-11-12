// מצב הדגמה: אותו ממשק כמו store-firebase.js, אבל הנתונים נשמרים ב-localStorage
// של הדפדפן הזה בלבד ואינם מסתנכרנים בין מכשירים.

import { DEFAULT_CATEGORIES } from './budget.js';

export const LOCAL_KEY = 'budget.local';
const HID = 'local';
const USER = { uid: 'local', email: '', name: 'אני' };

export function readLocalData() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY)) || null;
  } catch {
    return null;
  }
}

export function createLocalStore() {
  let data = readLocalData() || { household: null, recurring: [], expenses: [] };
  const listeners = new Set();
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  const commit = () => {
    try {
      localStorage.setItem(LOCAL_KEY, JSON.stringify(data));
    } catch { /* אחסון חסום — ממשיכים בזיכרון */ }
    listeners.forEach((fn) => fn());
  };
  const watch = (fn) => {
    listeners.add(fn);
    queueMicrotask(fn);
    return () => listeners.delete(fn);
  };

  return {
    kind: 'local',
    onAuth(cb) {
      queueMicrotask(() => cb(USER));
      return () => {};
    },
    async signOut() {},
    async myHousehold() {
      return data.household ? HID : null;
    },
    async createHousehold(user, name) {
      data.household = {
        name,
        members: [user.uid],
        names: { [user.uid]: user.name },
        startDay: 1,
        categories: DEFAULT_CATEGORIES,
      };
      commit();
      return HID;
    },
    watchHousehold(hid, cb) {
      return watch(() => cb(data.household ? { id: HID, ...data.household } : null));
    },
    watchRecurring(hid, cb) {
      return watch(() => cb(data.recurring.map((x) => ({ ...x }))));
    },
    watchExpenses(hid, start, end, cb) {
      return watch(() => cb(data.expenses.filter((e) => e.date >= start && e.date < end).map((x) => ({ ...x }))));
    },
    async updateHousehold(hid, patch) {
      for (const [k, v] of Object.entries(patch)) {
        if (k.startsWith('names.')) data.household.names[k.slice(6)] = v;
        else data.household[k] = v;
      }
      commit();
    },
    async addRecurring(hid, item) {
      data.recurring.push({ id: uid(), ...item });
      commit();
    },
    async updateRecurring(hid, id, patch) {
      data.recurring = data.recurring.map((x) => (x.id === id ? { ...x, ...patch } : x));
      commit();
    },
    async deleteRecurring(hid, id) {
      data.recurring = data.recurring.filter((x) => x.id !== id);
      commit();
    },
    async addExpenses(hid, items) {
      const now = Date.now();
      items.forEach((item, i) => data.expenses.push({ id: uid() + i, createdAt: now + i, ...item }));
      commit();
    },
    async updateExpense(hid, id, patch) {
      data.expenses = data.expenses.map((x) => (x.id === id ? { ...x, ...patch } : x));
      commit();
    },
    async deleteExpense(hid, id) {
      data.expenses = data.expenses.filter((x) => x.id !== id);
      commit();
    },
    async exportAll() {
      return { recurring: data.recurring, expenses: data.expenses };
    },
  };
}
