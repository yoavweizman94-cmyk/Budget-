import {
  DEFAULT_CATEGORIES, toISODate, addDays, shiftMonth, periodKeyOf, periodRange,
  withAmountFrom, summarize, parseAmount,
} from './budget.js';
import { firebaseConfig as committedConfig } from './firebase-config.js';
import { createLocalStore, readLocalData, LOCAL_KEY } from './store-local.js';

const LS = { config: 'budget.fbconfig', mode: 'budget.mode', join: 'budget.pendingJoin' };

const state = {
  store: null,
  screen: 'loading', // loading | setup | auth | household | main | error
  user: null,
  hid: null,
  household: null,
  recurring: [],
  expenses: [],
  expensesLoaded: false,
  period: null,
  tab: 'home',
  error: '',
  notice: '',
};

// ---------- כלי עזר ----------

const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* אחסון חסום */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* אחסון חסום */ } },
};

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = attrs || {};
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false || key === 'value') continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'class') el.className = value;
    else if (key === 'checked') el.checked = true;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : String(child));
  }
  if (props.value != null) el.value = props.value; // אחרי הילדים, כדי ש-select יקבל ערך
  return el;
}

const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  repeat: '<path d="M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4"/><circle cx="16" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="14" cy="18" r="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  left: '<path d="M15 6l-6 6 6 6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
};

function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
  return span;
}

const nf0 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 });
const money = (n) => `${nf2.format(n)} ₪`;
const moneyRound = (n) => `${nf0.format(Math.round(n))} ₪`;
const monthFmt = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric' });
const monthOnlyFmt = new Intl.DateTimeFormat('he-IL', { month: 'long' });

const today = () => toISODate(new Date());
const dayMonth = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}.${m}`; };
const monthDate = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1); };
const monthLabel = (key) => monthFmt.format(monthDate(key));
const monthName = (key) => monthOnlyFmt.format(monthDate(key));
const startDay = () => state.household?.startDay || 1;
const categories = () => (state.household?.categories?.length ? state.household.categories : DEFAULT_CATEGORIES);
const categoryOf = (id) => categories().find((c) => c.id === id) || { id, name: 'ללא קטגוריה', emoji: '❔' };

/** טווח תאריכים קצר, למשל 8–14.11. תמיד משמאל לימין כדי שלא יתהפך בתוך טקסט עברי */
function rangeLabel(start, endExclusive) {
  const last = addDays(endExclusive, -1);
  const [, m1, d1] = start.split('-').map(Number);
  const [, m2, d2] = last.split('-').map(Number);
  let text;
  if (start === last) text = `${d1}.${m1}`;
  else if (m1 === m2) text = `${d1}–${d2}.${m2}`;
  else text = `${d1}.${m1}–${d2}.${m2}`;
  return h('span', { dir: 'ltr', class: 'ltr' }, text);
}

let toastTimer;
function toast(message) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

/** שמירה ברקע: הממשק מתעדכן מיד (גם בלי רשת), ושגיאה אמיתית מוצגת כהודעה */
function save(promise) {
  Promise.resolve(promise).catch((e) => {
    console.error(e);
    toast(e?.code === 'permission-denied' ? 'אין הרשאה לשמור את השינוי' : 'השמירה נכשלה. נסו שוב');
  });
}

function errorText(e) {
  const code = e?.code || '';
  if (code.startsWith('auth/api-key-not-valid') || code === 'auth/invalid-api-key') {
    return 'הגדרות ה-Firebase שגויות (מפתח API לא תקין)';
  }
  const map = {
    'auth/invalid-credential': 'האימייל או הסיסמה שגויים',
    'auth/wrong-password': 'האימייל או הסיסמה שגויים',
    'auth/user-not-found': 'האימייל או הסיסמה שגויים',
    'auth/email-already-in-use': 'כבר קיים חשבון עם האימייל הזה. נסו להתחבר',
    'auth/weak-password': 'הסיסמה צריכה להיות באורך 6 תווים לפחות',
    'auth/invalid-email': 'כתובת האימייל אינה תקינה',
    'auth/missing-email': 'הזינו כתובת אימייל',
    'auth/network-request-failed': 'אין חיבור לרשת',
    'auth/too-many-requests': 'יותר מדי ניסיונות. נסו שוב בעוד כמה דקות',
    'auth/operation-not-allowed': 'כניסה באימייל וסיסמה לא הופעלה בפרויקט ה-Firebase (ראו שלב 2 במדריך ההקמה)',
    'auth/configuration-not-found': 'שירות ההזדהות לא הופעל בפרויקט ה-Firebase (ראו שלב 2 במדריך ההקמה)',
    'permission-denied': 'אין הרשאת גישה לנתונים. בדקו שכללי האבטחה הועתקו ל-Firestore (שלב 3 במדריך ההקמה)',
    unavailable: 'אין חיבור לרשת',
  };
  return map[code] || 'משהו השתבש. נסו שוב';
}

// ---------- הגדרות Firebase וקישור הזמנה ----------

function savedConfig() {
  try { return JSON.parse(storage.get(LS.config)) || null; } catch { return null; }
}

/** מקבל את קטע הקוד ש-Firebase מציג (אובייקט JS או JSON) ומחלץ ממנו את ההגדרות */
export function parseFirebaseConfig(text) {
  const config = {};
  const pattern = /["']?(\w+)["']?\s*:\s*["']([^"']*)["']/g;
  let match;
  while ((match = pattern.exec(text))) config[match[1]] = match[2];
  return config.apiKey && config.projectId && config.appId ? config : null;
}

const encodeConfig = (config) => btoa(JSON.stringify(config)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decodeConfig = (text) => JSON.parse(atob(text.replace(/-/g, '+').replace(/_/g, '/')));

function readInviteFromUrl() {
  if (!location.hash.includes('join=') && !location.hash.includes('cfg=')) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const cfg = params.get('cfg');
  // הגדרות מקישור מתקבלות רק במכשיר שעוד לא הוגדר, כדי שקישור זר לא יחליף פרויקט קיים
  if (cfg && !committedConfig && !savedConfig()) {
    try {
      const config = decodeConfig(cfg);
      if (config.apiKey && config.projectId) {
        storage.set(LS.config, JSON.stringify(config));
        storage.remove(LS.mode);
      }
    } catch { /* קישור פגום — מתעלמים מההגדרות */ }
  }
  const join = params.get('join');
  if (join && /^[\w-]{10,}$/.test(join)) storage.set(LS.join, join);
  history.replaceState(null, '', location.pathname + location.search);
}

function inviteLink() {
  let url = `${location.origin}${location.pathname}#join=${state.hid}`;
  if (!committedConfig && savedConfig()) url += `&cfg=${encodeConfig(savedConfig())}`;
  return url;
}

// ---------- אתחול, כניסה ומשק בית ----------

let unsubscribers = [];
let unsubscribeExpenses = null;
let watchedRange = '';

function stopWatching() {
  unsubscribers.forEach((fn) => fn());
  unsubscribers = [];
  unsubscribeExpenses?.();
  unsubscribeExpenses = null;
  watchedRange = '';
}

async function boot() {
  readInviteFromUrl();
  const config = committedConfig || savedConfig();
  try {
    if (config) {
      const { createFirebaseStore } = await import('./store-firebase.js');
      state.store = await createFirebaseStore(config);
    } else if (storage.get(LS.mode) === 'local') {
      state.store = createLocalStore();
    } else {
      state.screen = 'setup';
      return render();
    }
  } catch (e) {
    console.error(e);
    state.screen = 'error';
    state.error = 'לא הצלחנו להתחבר ל-Firebase. בדקו את ההגדרות ואת החיבור לרשת.';
    return render();
  }
  state.store.onAuth(onUser);
}

async function onUser(user) {
  stopWatching();
  state.user = user && { ...user, name: user.name || user.email.split('@')[0] || 'אני' };
  state.household = null;
  state.hid = null;
  if (!user) {
    state.screen = 'auth';
    state.tab = 'home';
    state.period = null;
    state.recurring = [];
    state.expenses = [];
    return render();
  }
  state.screen = 'loading';
  render();
  const { store } = state;
  try {
    let hid = await store.myHousehold(user.uid);
    const invited = storage.get(LS.join);
    if (invited && store.joinHousehold && invited !== hid) {
      try {
        hid = await store.joinHousehold(state.user, invited);
      } catch (e) {
        console.error(e);
        state.notice = 'לא הצלחנו להצטרף דרך קישור ההזמנה. ייתכן שהקישור שגוי או שההצטרפות ננעלה בהגדרות.';
      }
    }
    storage.remove(LS.join);
    if (!hid && store.kind === 'local') hid = await store.createHousehold(state.user, 'התקציב שלנו');
    if (!hid) {
      state.screen = 'household';
      return render();
    }
    enterHousehold(hid);
  } catch (e) {
    console.error(e);
    state.screen = 'error';
    state.error = errorText(e);
    render();
  }
}

function enterHousehold(hid) {
  stopWatching();
  state.hid = hid;
  state.screen = 'loading';
  const { store } = state;
  const onError = (e) => {
    console.error(e);
    stopWatching();
    state.screen = 'error';
    state.error = errorText(e);
    render();
  };
  unsubscribers.push(
    store.watchHousehold(hid, (household) => {
      if (!household) return onError({ code: 'permission-denied' });
      state.household = household;
      if (!state.period) state.period = periodKeyOf(today(), startDay());
      state.screen = 'main';
      watchExpenses();
      render();
    }, onError),
    store.watchRecurring(hid, (items) => {
      state.recurring = items;
      render();
    }, onError),
  );
  render();
}

/** מאזין להוצאות של חודש התקציב המוצג בלבד; מתחלף כשעוברים חודש או משנים את יום התחילה */
function watchExpenses() {
  const range = periodRange(state.period, startDay());
  const id = `${range.start}|${range.end}`;
  if (id === watchedRange) return;
  watchedRange = id;
  unsubscribeExpenses?.();
  state.expenses = [];
  state.expensesLoaded = false;
  unsubscribeExpenses = state.store.watchExpenses(state.hid, range.start, range.end, (items) => {
    state.expenses = items;
    state.expensesLoaded = true;
    render();
  }, (e) => { console.error(e); toast(errorText(e)); });
}

function setPeriod(key) {
  state.period = key;
  watchExpenses();
  render();
}

function setTab(tab) {
  state.tab = tab;
  render();
  window.scrollTo(0, 0);
}

// ---------- רינדור ----------

const root = document.getElementById('app');

function render() {
  const screens = { loading: loadingScreen, setup: setupScreen, auth: authScreen, household: householdScreen, main: mainScreen, error: errorScreen };
  root.replaceChildren(screens[state.screen]());
}

function loadingScreen() {
  return h('div', { class: 'center-screen' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'טוען' }));
}

function errorScreen() {
  return h('div', { class: 'center-screen' },
    h('div', { class: 'card stack' },
      h('h1', {}, 'אופס'),
      h('p', {}, state.error),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'ניסיון נוסף'),
      state.user && h('button', { class: 'btn ghost', onclick: () => state.store.signOut() }, 'יציאה מהחשבון'),
      !committedConfig && savedConfig() && h('button', { class: 'btn ghost', onclick: resetConfig }, 'החלפת הגדרות Firebase'),
    ));
}

function resetConfig() {
  storage.remove(LS.config);
  location.reload();
}

function brand() {
  return h('div', { class: 'brand' },
    h('div', { class: 'brand-mark', 'aria-hidden': 'true' }, '₪'),
    h('h1', {}, 'התקציב שלנו'),
    h('p', {}, 'כמה נשאר לנו להוציא החודש'));
}

function setupScreen() {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const textarea = h('textarea', {
    rows: 7, dir: 'ltr', spellcheck: 'false', 'aria-label': 'הגדרות Firebase',
    placeholder: 'const firebaseConfig = {\n  apiKey: "...",\n  authDomain: "...",\n  projectId: "...",\n  ...\n};',
  });
  const connect = (event) => {
    event.preventDefault();
    const config = parseFirebaseConfig(textarea.value);
    if (!config) {
      error.textContent = 'לא זיהינו כאן הגדרות Firebase. הדביקו את כל הקטע שמתחיל ב-firebaseConfig.';
      return;
    }
    storage.set(LS.config, JSON.stringify(config));
    storage.remove(LS.mode);
    location.reload();
  };
  return h('div', { class: 'gate' },
    brand(),
    h('form', { class: 'card stack', onsubmit: connect },
      h('h2', {}, 'חיבור ל-Firebase'),
      h('p', { class: 'muted' }, 'כדי ששניכם תראו את אותם נתונים, האפליקציה שומרת אותם בפרויקט Firebase חינמי שלכם. ',
        h('a', { href: 'https://github.com/yoavweizman94-cmyk/Budget-#readme', target: '_blank', rel: 'noopener' }, 'מדריך ההקמה (10 דקות)')),
      h('label', { class: 'field' }, h('span', {}, 'הדביקו כאן את קטע ההגדרות מ-Firebase'), textarea),
      error,
      h('button', { class: 'btn primary', type: 'submit' }, 'חיבור')),
    h('div', { class: 'card stack' },
      h('h2', {}, 'רק רוצים לנסות?'),
      h('p', { class: 'muted' }, 'במצב הדגמה הנתונים נשמרים במכשיר הזה בלבד, בלי סנכרון. אפשר לעבור ל-Firebase אחר כך ולייבא את מה שהזנתם.'),
      h('button', {
        class: 'btn secondary',
        onclick: () => { storage.set(LS.mode, 'local'); location.reload(); },
      }, 'כניסה למצב הדגמה')));
}

function authScreen() {
  const invited = !!storage.get(LS.join);
  let mode = invited ? 'signup' : 'signin';
  const container = h('div', { class: 'gate' });

  const draw = () => {
    const signup = mode === 'signup';
    const error = h('p', { class: 'form-error', role: 'alert' });
    const name = h('input', { type: 'text', autocomplete: 'given-name', required: true, maxlength: 30 });
    const email = h('input', { type: 'email', autocomplete: 'email', required: true, dir: 'ltr' });
    const password = h('input', {
      type: 'password', required: true, minlength: 6, dir: 'ltr',
      autocomplete: signup ? 'new-password' : 'current-password',
    });
    const submit = h('button', { class: 'btn primary', type: 'submit' }, signup ? 'יצירת חשבון' : 'כניסה');
    const onSubmit = async (event) => {
      event.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        if (signup) await state.store.signUp(email.value.trim(), password.value, name.value.trim());
        else await state.store.signIn(email.value.trim(), password.value);
      } catch (e) {
        console.error(e);
        error.textContent = errorText(e);
        submit.disabled = false;
      }
    };
    const forgot = async () => {
      error.textContent = '';
      if (!email.value.trim()) {
        error.textContent = 'הזינו את כתובת האימייל ולחצו שוב';
        return email.focus();
      }
      try {
        await state.store.resetPassword(email.value.trim());
        toast('שלחנו אליכם אימייל לאיפוס הסיסמה');
      } catch (e) {
        error.textContent = errorText(e);
      }
    };
    container.replaceChildren(
      brand(),
      h('form', { class: 'card stack', onsubmit: onSubmit },
        h('h2', {}, signup ? 'יצירת חשבון' : 'כניסה'),
        invited && h('p', { class: 'notice' }, 'הוזמנתם לתקציב משותף. צרו חשבון (או התחברו) כדי להצטרף.'),
        signup && h('label', { class: 'field' }, h('span', {}, 'השם שלך'), name),
        h('label', { class: 'field' }, h('span', {}, 'אימייל'), email),
        h('label', { class: 'field' }, h('span', {}, signup ? 'סיסמה (6 תווים לפחות)' : 'סיסמה'), password),
        error,
        submit,
        !signup && h('button', { class: 'btn link', type: 'button', onclick: forgot }, 'שכחתי סיסמה')),
      h('p', { class: 'gate-switch' },
        signup ? 'כבר יש לך חשבון? ' : 'עוד אין לך חשבון? ',
        h('button', { class: 'btn link', type: 'button', onclick: () => { mode = signup ? 'signin' : 'signup'; draw(); } },
          signup ? 'כניסה' : 'יצירת חשבון')),
      !committedConfig && h('p', { class: 'gate-switch' },
        h('button', { class: 'btn link subtle', type: 'button', onclick: resetConfig }, 'החלפת הגדרות Firebase')),
    );
  };
  draw();
  return container;
}

function householdScreen() {
  const error = h('p', { class: 'form-error', role: 'alert' });
  const name = h('input', { type: 'text', required: true, maxlength: 40, value: 'התקציב שלנו' });
  const link = h('input', { type: 'text', dir: 'ltr', required: true, placeholder: 'https://…#join=…' });
  const busy = (form, on) => form.querySelectorAll('button').forEach((b) => { b.disabled = on; });

  const create = async (event) => {
    event.preventDefault();
    busy(event.target, true);
    try {
      enterHousehold(await state.store.createHousehold(state.user, name.value.trim() || 'התקציב שלנו'));
    } catch (e) {
      console.error(e);
      error.textContent = errorText(e);
      busy(event.target, false);
    }
  };
  const join = async (event) => {
    event.preventDefault();
    const code = (link.value.match(/join=([\w-]{10,})/) || link.value.trim().match(/^([\w-]{10,})$/) || [])[1];
    if (!code) {
      error.textContent = 'זה לא נראה כמו קישור הזמנה';
      return;
    }
    busy(event.target, true);
    try {
      enterHousehold(await state.store.joinHousehold(state.user, code));
    } catch (e) {
      console.error(e);
      error.textContent = 'לא הצלחנו להצטרף. ייתכן שהקישור שגוי או שההצטרפות ננעלה בהגדרות.';
      busy(event.target, false);
    }
  };

  const notice = state.notice;
  state.notice = '';
  return h('div', { class: 'gate' },
    brand(),
    notice && h('p', { class: 'notice warn' }, notice),
    h('form', { class: 'card stack', onsubmit: create },
      h('h2', {}, `שלום ${state.user.name}, מתחילים?`),
      h('p', { class: 'muted' }, 'צרו את התקציב המשותף, ואחר כך תוכלו להזמין אליו את בן או בת הזוג מתוך ההגדרות.'),
      h('label', { class: 'field' }, h('span', {}, 'שם התקציב'), name),
      h('button', { class: 'btn primary', type: 'submit' }, 'יצירת תקציב חדש')),
    h('form', { class: 'card stack', onsubmit: join },
      h('h2', {}, 'קיבלתם קישור הזמנה?'),
      h('label', { class: 'field' }, h('span', {}, 'הדביקו אותו כאן'), link),
      h('button', { class: 'btn secondary', type: 'submit' }, 'הצטרפות לתקציב קיים')),
    error,
    h('button', { class: 'btn link', onclick: () => state.store.signOut() }, 'יציאה מהחשבון'));
}

// ---------- המסך הראשי ----------

function mainScreen() {
  const summary = summarize({
    recurring: state.recurring,
    expenses: state.expenses,
    key: state.period,
    startDay: startDay(),
    today: today(),
  });
  const views = { home: homeView, expenses: expensesView, recurring: recurringView, settings: settingsView };
  const tabs = [
    ['home', 'סיכום', 'home'],
    ['expenses', 'הוצאות', 'list'],
    ['recurring', 'קבועים', 'repeat'],
    ['settings', 'הגדרות', 'settings'],
  ];
  const showFab = state.tab === 'home' || state.tab === 'expenses';
  return h('div', { class: 'shell' },
    state.tab !== 'settings' && periodHeader(summary),
    h('main', { class: 'view' }, views[state.tab](summary)),
    showFab && h('button', { class: 'fab', onclick: () => expenseSheet() }, icon('plus'), 'הוספת הוצאות'),
    h('nav', { class: 'tabbar', 'aria-label': 'ניווט ראשי' },
      tabs.map(([id, label, iconName]) => h('button', {
        class: `tab${state.tab === id ? ' active' : ''}`,
        'aria-current': state.tab === id ? 'page' : null,
        onclick: () => setTab(id),
      }, icon(iconName), h('span', {}, label)))));
}

function periodHeader(summary) {
  const currentKey = periodKeyOf(today(), startDay());
  return h('header', { class: 'period' },
    h('button', { class: 'icon-btn', 'aria-label': 'החודש הקודם', onclick: () => setPeriod(shiftMonth(state.period, -1)) }, icon('right')),
    h('div', { class: 'period-label' },
      h('strong', {}, monthLabel(state.period)),
      startDay() > 1 && h('small', {}, rangeLabel(summary.range.start, summary.range.end)),
      state.period !== currentKey && h('button', { class: 'btn link small', onclick: () => setPeriod(currentKey) }, 'חזרה לחודש הנוכחי')),
    h('button', { class: 'icon-btn', 'aria-label': 'החודש הבא', onclick: () => setPeriod(shiftMonth(state.period, 1)) }, icon('left')));
}

function bar(fraction, className = '') {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  return h('div', { class: `bar ${className}` }, h('div', { class: 'bar-fill', style: `width:${pct}%` }));
}

function homeView(s) {
  const nothingYet = !s.income.length && !s.fixed.length && !state.recurring.length;
  if (nothingYet && !s.expenses.length) {
    return h('div', { class: 'card stack onboarding' },
      h('h2', {}, 'ברוכים הבאים 👋'),
      h('p', {}, 'שלושה צעדים ואתם יודעים כמה נשאר להוציא החודש:'),
      h('ol', {},
        h('li', {}, h('strong', {}, 'הכנסות'), ' — המשכורות וכל הכנסה חודשית אחרת.'),
        h('li', {}, h('strong', {}, 'הוצאות קבועות'), ' — שכירות או משכנתא, חשבונות, ביטוחים, גן, חיסכון.'),
        h('li', {}, h('strong', {}, 'הוצאות משתנות'), ' — פעם בשבוע מזינים מה הוצאתם, והיתרה מתעדכנת.')),
      h('button', { class: 'btn primary', onclick: () => setTab('recurring') }, 'הוספת הכנסות והוצאות קבועות'));
  }

  const over = s.remaining < 0;
  const usedFraction = s.variableBudget > 0 ? s.spent / s.variableBudget : (s.spent > 0 ? 1 : 0);
  const heroTitle = over
    ? (s.isPast ? 'חרגתם מהתקציב ב־' : 'חריגה מהתקציב החודש')
    : (s.isPast ? 'נשאר בסוף החודש' : s.isCurrent ? 'נותר להוציא החודש' : 'פנוי להוצאות משתנות');

  const hero = h('section', { class: `hero${over ? ' over' : ''}` },
    h('p', { class: 'hero-title' }, heroTitle),
    h('p', { class: 'hero-amount' }, moneyRound(Math.abs(s.remaining))),
    bar(usedFraction, 'on-hero'),
    h('p', { class: 'hero-sub' },
      s.variableBudget > 0
        ? `הוצאתם ${moneyRound(s.spent)} מתוך ${moneyRound(s.variableBudget)}`
        : `הוצאות משתנות עד כה: ${moneyRound(s.spent)}`),
    s.isCurrent && h('div', { class: 'hero-stats' },
      !over && h('div', {}, h('strong', {}, moneyRound(s.perDay)), h('span', {}, 'ליום')),
      !over && h('div', {}, h('strong', {}, moneyRound(Math.min(s.remaining, s.perDay * 7))), h('span', {}, 'לשבוע')),
      h('div', {}, h('strong', {}, s.daysLeft), h('span', {}, s.daysLeft === 1 ? 'יום אחרון' : 'ימים נותרו'))));

  const equation = h('section', { class: 'card equation' },
    h('button', { class: 'eq-row', onclick: () => setTab('recurring') },
      h('span', {}, 'הכנסות'), h('strong', {}, moneyRound(s.incomeTotal))),
    h('button', { class: 'eq-row', onclick: () => setTab('recurring') },
      h('span', {}, 'פחות הוצאות קבועות'), h('strong', {}, moneyRound(s.fixedTotal))),
    h('button', { class: 'eq-row', onclick: () => setTab('expenses') },
      h('span', {}, 'פחות הוצאות משתנות'), h('strong', {}, moneyRound(s.spent))),
    h('div', { class: `eq-row total${over ? ' over' : ''}` },
      h('span', {}, over ? 'חריגה' : 'נותר'), h('strong', {}, moneyRound(Math.abs(s.remaining)))));

  const missedWeek = s.isCurrent && state.expensesLoaded
    ? s.weeks.filter((w) => w.end <= today()).at(-1)
    : null;
  const reminder = missedWeek && missedWeek.total === 0 && h('div', { class: 'notice' },
    h('span', {}, 'לא הוזנו הוצאות לשבוע ', rangeLabel(missedWeek.start, missedWeek.end), '.'),
    h('button', { class: 'btn link', onclick: () => expenseSheet(null, addDays(missedWeek.end, -1)) }, 'להזנה'));

  const maxWeek = Math.max(...s.weeks.map((w) => w.total), 1);
  const weeks = h('section', { class: 'card' },
    h('h2', {}, 'לפי שבועות'),
    h('ul', { class: 'rows' }, s.weeks.map((w) => {
      const future = s.isCurrent ? w.start > today() : !s.isPast;
      return h('li', { class: `meter-row${future ? ' dim' : ''}` },
        h('div', { class: 'meter-head' },
          h('span', {}, rangeLabel(w.start, w.end), w.isCurrent && h('span', { class: 'tag' }, 'השבוע')),
          h('strong', {}, future && !w.total ? '—' : moneyRound(w.total))),
        bar(w.total / maxWeek));
    })));

  const maxCat = Math.max(...s.byCategory.map((c) => c.total), 1);
  const cats = s.byCategory.length > 0 && h('section', { class: 'card' },
    h('h2', {}, 'לפי קטגוריות'),
    h('ul', { class: 'rows' }, s.byCategory.map(({ category, total }) => {
      const cat = categoryOf(category);
      return h('li', { class: 'meter-row' },
        h('div', { class: 'meter-head' },
          h('span', {}, `${cat.emoji || ''} ${cat.name}`),
          h('strong', {}, moneyRound(total))),
        bar(total / maxCat));
    })));

  return [hero, reminder, equation, weeks, cats];
}

function expensesView(s) {
  if (!state.expensesLoaded) return loadingScreen();
  if (!s.expenses.length) {
    return h('div', { class: 'empty' },
      h('p', { class: 'empty-emoji', 'aria-hidden': 'true' }, '🧾'),
      h('h2', {}, `עוד אין הוצאות ב${monthName(state.period)}`),
      h('p', { class: 'muted' }, 'פעם בשבוע עוברים על האשראי ומזינים כאן את ההוצאות המשתנות: סופר, דלק, בילויים וכדומה.'),
      h('button', { class: 'btn primary', onclick: () => expenseSheet() }, 'הוספת הוצאות'));
  }
  const showWho = (state.household.members || []).length > 1;
  const groups = s.weeks
    .map((w) => ({
      ...w,
      items: s.expenses
        .filter((e) => e.date >= w.start && e.date < w.end)
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0)),
    }))
    .filter((g) => g.items.length)
    .reverse();

  return [
    h('div', { class: 'list-total' },
      h('span', {}, `סה״כ הוצאות משתנות ב${monthName(state.period)}`),
      h('strong', {}, money(s.spent))),
    groups.map((g) => h('section', { class: 'card list-card' },
      h('div', { class: 'group-head' },
        h('h2', {}, 'שבוע ', rangeLabel(g.start, g.end)),
        h('strong', {}, money(g.total))),
      h('ul', { class: 'items' }, g.items.map((e) => {
        const cat = categoryOf(e.category);
        const who = showWho && state.household.names?.[e.by];
        return h('li', {},
          h('button', { class: 'item', onclick: () => expenseSheet(e) },
            h('span', { class: 'item-emoji', 'aria-hidden': 'true' }, cat.emoji || '•'),
            h('span', { class: 'item-main' },
              h('span', { class: 'item-title' }, e.note || cat.name),
              h('span', { class: 'item-sub' }, [e.note && cat.name, dayMonth(e.date), who].filter(Boolean).join(' · '))),
            h('strong', { class: 'item-amount' }, money(e.amount))));
      })))),
  ];
}

function recurringView(s) {
  const section = (type, title, items, total, emptyText, addLabel) => h('section', { class: 'card list-card' },
    h('div', { class: 'group-head' }, h('h2', {}, title), h('strong', {}, money(total))),
    items.length
      ? h('ul', { class: 'items' }, items
        .sort((a, b) => b.amount - a.amount)
        .map((item) => h('li', {},
          h('button', { class: 'item', onclick: () => recurringSheet(type, item) },
            h('span', { class: 'item-main' },
              h('span', { class: 'item-title' }, item.name),
              item.end === item.start && h('span', { class: 'item-sub' }, 'חד-פעמי')),
            h('strong', { class: 'item-amount' }, money(item.amount))))))
      : h('p', { class: 'muted pad' }, emptyText),
    h('button', { class: 'btn add-row', onclick: () => recurringSheet(type) }, icon('plus'), addLabel));

  return [
    section('income', 'הכנסות', s.income, s.incomeTotal,
      'עוד לא הוספתם הכנסות. התחילו מהמשכורות.', 'הוספת הכנסה'),
    section('fixed', 'הוצאות קבועות', s.fixed, s.fixedTotal,
      'שכירות או משכנתא, ארנונה, חשמל, ביטוחים, גן, מנויים, העברה לחיסכון…', 'הוספת הוצאה קבועה'),
    h('p', { class: 'muted hint' }, `שינוי של סכום חל מ${monthName(state.period)} והלאה; חודשים קודמים נשארים כפי שהיו.`),
  ];
}

function settingsView() {
  const hh = state.household;
  const { store, user } = state;
  const isFirebase = store.kind === 'firebase';
  const members = (hh.members || []).map((uid) => hh.names?.[uid] || 'ללא שם');
  const localData = isFirebase ? readLocalData() : null;
  const hasLocalData = !!localData && ((localData.recurring || []).length + (localData.expenses || []).length) > 0;

  const row = (label, value, onclick) => h('button', { class: 'item', onclick },
    h('span', { class: 'item-main' }, h('span', { class: 'item-title' }, label), value && h('span', { class: 'item-sub' }, value)),
    h('span', { class: 'chev' }, icon('left')));

  const fileInput = h('input', {
    type: 'file', accept: 'application/json,.json', hidden: true,
    onchange: async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      try {
        importSheet(JSON.parse(await file.text()));
      } catch {
        toast('הקובץ אינו קובץ גיבוי תקין');
      }
    },
  });

  return [
    h('h1', { class: 'page-title' }, 'הגדרות'),

    h('section', { class: 'card list-card' },
      h('div', { class: 'group-head' }, h('h2', {}, 'התקציב המשותף')),
      h('ul', { class: 'items' },
        h('li', {}, row('שם התקציב', hh.name, () => textSheet('שם התקציב', hh.name, (v) => store.updateHousehold(state.hid, { name: v })))),
        h('li', {}, row('השם שלך', hh.names?.[user.uid] || user.name,
          () => textSheet('השם שלך', hh.names?.[user.uid] || user.name, (v) => store.updateHousehold(state.hid, { [`names.${user.uid}`]: v })))),
        isFirebase && h('li', {}, h('div', { class: 'item static' },
          h('span', { class: 'item-main' }, h('span', { class: 'item-title' }, 'חברים'), h('span', { class: 'item-sub' }, members.join(' · ')))))),
      isFirebase && h('div', { class: 'pad stack' },
        h('button', { class: 'btn secondary', disabled: hh.joinOpen === false, onclick: inviteSheet }, 'הזמנת בן/בת הזוג'),
        h('label', { class: 'switch' },
          h('input', {
            type: 'checkbox', checked: hh.joinOpen !== false,
            onchange: (e) => save(store.updateHousehold(state.hid, { joinOpen: e.target.checked })),
          }),
          h('span', {}, 'אפשר הצטרפות דרך קישור ההזמנה')),
        h('p', { class: 'muted small' }, 'אחרי ששניכם בפנים, מומלץ לכבות כדי שאף אחד אחר לא יוכל להצטרף.'))),

    h('section', { class: 'card list-card' },
      h('div', { class: 'group-head' }, h('h2', {}, 'קטגוריות של הוצאות משתנות')),
      h('ul', { class: 'items' }, categories().map((cat) => h('li', {},
        h('button', { class: 'item', onclick: () => categorySheet(cat) },
          h('span', { class: 'item-emoji', 'aria-hidden': 'true' }, cat.emoji || '•'),
          h('span', { class: 'item-main' }, h('span', { class: 'item-title' }, cat.name)),
          h('span', { class: 'chev' }, icon('left')))))),
      h('button', { class: 'btn add-row', onclick: () => categorySheet() }, icon('plus'), 'הוספת קטגוריה')),

    h('section', { class: 'card stack' },
      h('h2', {}, 'חודש התקציב'),
      h('label', { class: 'field' },
        h('span', {}, 'היום בחודש שבו התקציב מתחיל'),
        h('select', {
          value: String(startDay()),
          onchange: (e) => {
            const day = Number(e.target.value);
            state.period = periodKeyOf(today(), day);
            save(store.updateHousehold(state.hid, { startDay: day }));
          },
        }, Array.from({ length: 28 }, (_, i) => h('option', { value: String(i + 1) }, i + 1)))),
      h('p', { class: 'muted small' }, 'למשל 10, אם המשכורת וחיוב האשראי יורדים ב-10 לחודש. ברירת המחדל היא חודש קלנדרי רגיל (1).')),

    h('section', { class: 'card stack' },
      h('h2', {}, 'גיבוי'),
      h('button', { class: 'btn secondary', onclick: exportBackup }, 'הורדת גיבוי של כל הנתונים'),
      h('button', { class: 'btn ghost', onclick: () => fileInput.click() }, 'ייבוא מקובץ גיבוי'),
      fileInput,
      hasLocalData && h('button', { class: 'btn ghost', onclick: () => importSheet(localData, true) }, 'ייבוא הנתונים ממצב ההדגמה')),

    isFirebase
      ? h('section', { class: 'card stack' },
        h('h2', {}, 'חשבון'),
        h('p', { class: 'muted', dir: 'ltr' }, user.email),
        h('button', { class: 'btn ghost', onclick: () => store.signOut() }, 'יציאה מהחשבון'))
      : h('section', { class: 'card stack' },
        h('h2', {}, 'מצב הדגמה'),
        h('p', { class: 'muted' }, 'הנתונים נשמרים במכשיר הזה בלבד. כדי לשתף את התקציב בין שני טלפונים, חברו את האפליקציה ל-Firebase; את מה שהזנתם כאן תוכלו לייבא אחר כך מההגדרות.'),
        h('button', { class: 'btn secondary', onclick: () => { storage.remove(LS.mode); location.reload(); } }, 'חיבור ל-Firebase')),
  ];
}

// ---------- חלונות (sheets) ----------

function openSheet(title, build) {
  const dialog = h('dialog', { class: 'sheet', 'aria-label': title });
  const close = () => dialog.close();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  dialog.append(h('div', { class: 'sheet-inner' },
    h('header', { class: 'sheet-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'סגירה', onclick: close }, icon('close'))),
    build(close)));
  document.body.append(dialog);
  dialog.showModal();
  return dialog;
}

/** כפתור מחיקה בשני שלבים, במקום חלון אישור */
function confirmButton(label, onConfirm) {
  let armed = false;
  const button = h('button', {
    type: 'button', class: 'btn danger',
    onclick: () => {
      if (armed) return onConfirm();
      armed = true;
      button.textContent = 'לחצו שוב לאישור';
      button.classList.add('armed');
      setTimeout(() => {
        armed = false;
        button.textContent = label;
        button.classList.remove('armed');
      }, 3000);
    },
  }, label);
  return button;
}

function amountInput(value) {
  return h('input', {
    type: 'text', inputmode: 'decimal', autocomplete: 'off', dir: 'ltr', class: 'amount',
    placeholder: '0', 'aria-label': 'סכום בשקלים', value: value != null ? String(value) : '',
  });
}

function textSheet(title, value, onSave) {
  openSheet(title, (close) => {
    const input = h('input', { type: 'text', required: true, maxlength: 40, value: value || '', 'aria-label': title });
    return h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        save(onSave(text));
        close();
      },
    }, input, h('button', { class: 'btn primary', type: 'submit' }, 'שמירה'));
  });
}

function defaultExpenseDate() {
  const range = periodRange(state.period, startDay());
  const now = today();
  if (now >= range.start && now < range.end) return now;
  return now >= range.end ? addDays(range.end, -1) : range.start;
}

function expenseSheet(existing = null, presetDate = null) {
  const cats = categories();
  openSheet(existing ? 'עריכת הוצאה' : 'הוספת הוצאות', (close) => {
    const date = h('input', { type: 'date', required: true, value: existing?.date || presetDate || defaultExpenseDate() });
    const rowsEl = h('div', { class: 'entry-rows' });
    const total = h('strong', {}, money(0));
    const error = h('p', { class: 'form-error', role: 'alert' });
    const rows = [];

    const updateTotal = () => {
      const sum = rows.reduce((t, r) => t + (parseAmount(r.amount.value) || 0), 0);
      total.textContent = money(sum);
    };

    const addRow = (values = {}) => {
      const row = {
        amount: amountInput(values.amount),
        category: h('select', { 'aria-label': 'קטגוריה', value: values.category || cats[0].id },
          cats.map((c) => h('option', { value: c.id }, `${c.emoji || ''} ${c.name}`)),
          values.category && !cats.some((c) => c.id === values.category) && h('option', { value: values.category }, 'ללא קטגוריה')),
        note: h('input', { type: 'text', maxlength: 60, placeholder: 'הערה (לא חובה)', 'aria-label': 'הערה', value: values.note || '' }),
      };
      row.amount.addEventListener('input', () => { row.amount.classList.remove('invalid'); updateTotal(); });
      row.el = h('div', { class: 'entry-row' },
        row.amount, row.category, row.note,
        !existing && h('button', {
          type: 'button', class: 'icon-btn remove', 'aria-label': 'הסרת השורה',
          onclick: () => {
            if (rows.length === 1) {
              row.amount.value = '';
              row.note.value = '';
            } else {
              rows.splice(rows.indexOf(row), 1);
              row.el.remove();
            }
            updateTotal();
          },
        }, icon('close')));
      rows.push(row);
      rowsEl.append(row.el);
      return row;
    };

    addRow(existing || {});
    updateTotal();

    const submit = (event) => {
      event.preventDefault();
      error.textContent = '';
      const items = [];
      let invalid = false;
      for (const row of rows) {
        const text = row.amount.value.trim();
        if (!text && !existing) continue;
        const amount = parseAmount(text);
        if (!(amount > 0)) {
          row.amount.classList.add('invalid');
          invalid = true;
          continue;
        }
        items.push({ amount, category: row.category.value, note: row.note.value.trim(), date: date.value });
      }
      if (invalid) {
        error.textContent = 'יש סכום שלא הצלחנו לקרוא. הזינו מספר גדול מאפס.';
        return;
      }
      if (!items.length) {
        error.textContent = 'הזינו סכום אחד לפחות.';
        return rows[0].amount.focus();
      }
      if (!date.value) {
        error.textContent = 'בחרו תאריך.';
        return;
      }
      if (existing) save(state.store.updateExpense(state.hid, existing.id, items[0]));
      else save(state.store.addExpenses(state.hid, items.map((item) => ({ ...item, by: state.user.uid }))));
      const key = periodKeyOf(date.value, startDay());
      if (key !== state.period) toast(`נשמר בחודש ${monthLabel(key)}`);
      close();
    };

    return h('form', { class: 'stack', onsubmit: submit, novalidate: true },
      h('label', { class: 'field' }, h('span', {}, 'תאריך'), date),
      rowsEl,
      !existing && h('button', {
        type: 'button', class: 'btn ghost',
        onclick: () => addRow().amount.focus(),
      }, icon('plus'), 'שורה נוספת'),
      !existing && h('div', { class: 'entry-total' }, h('span', {}, 'סה״כ'), total),
      error,
      h('button', { class: 'btn primary', type: 'submit' }, 'שמירה'),
      existing && confirmButton('מחיקת ההוצאה', () => {
        save(state.store.deleteExpense(state.hid, existing.id));
        close();
      }));
  });
}

function recurringSheet(type, existing = null) {
  const isIncome = type === 'income';
  const title = existing
    ? (isIncome ? 'עריכת הכנסה' : 'עריכת הוצאה קבועה')
    : (isIncome ? 'הכנסה חדשה' : 'הוצאה קבועה חדשה');
  const key = state.period;
  openSheet(title, (close) => {
    const name = h('input', {
      type: 'text', required: true, maxlength: 40, value: existing?.name || '',
      placeholder: isIncome ? 'למשל: משכורת' : 'למשל: שכירות',
    });
    const amount = amountInput(existing?.amount);
    const once = h('input', { type: 'checkbox' });
    const error = h('p', { class: 'form-error', role: 'alert' });

    const submit = (event) => {
      event.preventDefault();
      const value = parseAmount(amount.value);
      if (!name.value.trim()) {
        error.textContent = 'תנו לזה שם.';
        return name.focus();
      }
      if (!(value > 0)) {
        error.textContent = 'הזינו סכום גדול מאפס.';
        amount.classList.add('invalid');
        return amount.focus();
      }
      if (existing) {
        const original = state.recurring.find((x) => x.id === existing.id) || existing;
        save(state.store.updateRecurring(state.hid, existing.id, {
          name: name.value.trim(),
          versions: value === existing.amount ? original.versions : withAmountFrom(original, key, value),
        }));
      } else {
        save(state.store.addRecurring(state.hid, {
          type,
          name: name.value.trim(),
          start: key,
          end: once.checked ? key : null,
          versions: [{ from: key, amount: value }],
        }));
      }
      close();
    };

    const remove = () => {
      // הסרה מהחודש המוצג והלאה: אם הפריט התחיל קודם, ההיסטוריה שלו נשמרת
      if (existing.start >= key) save(state.store.deleteRecurring(state.hid, existing.id));
      else save(state.store.updateRecurring(state.hid, existing.id, { end: shiftMonth(key, -1) }));
      close();
    };

    const isOnce = existing && existing.end === existing.start;
    return h('form', { class: 'stack', onsubmit: submit, novalidate: true },
      h('label', { class: 'field' }, h('span', {}, 'שם'), name),
      h('label', { class: 'field' }, h('span', {}, isOnce || !existing ? 'סכום' : 'סכום חודשי'), amount),
      !existing && h('label', { class: 'switch' }, once, h('span', {}, `חד-פעמי, רק ב${monthName(key)}`)),
      existing && !isOnce && h('p', { class: 'muted small' }, `שינוי בסכום יחול מ${monthLabel(key)} והלאה.`),
      error,
      h('button', { class: 'btn primary', type: 'submit' }, 'שמירה'),
      existing && confirmButton(isOnce || existing.start >= key ? 'מחיקה' : `הסרה מ${monthLabel(key)} והלאה`, remove));
  });
}

function categorySheet(existing = null) {
  openSheet(existing ? 'עריכת קטגוריה' : 'קטגוריה חדשה', (close) => {
    const emoji = h('input', { type: 'text', maxlength: 8, class: 'emoji-input', 'aria-label': 'אימוג׳י', value: existing?.emoji || '', placeholder: '🙂' });
    const name = h('input', { type: 'text', required: true, maxlength: 30, 'aria-label': 'שם הקטגוריה', value: existing?.name || '', placeholder: 'שם הקטגוריה' });
    const update = (list) => save(state.store.updateHousehold(state.hid, { categories: list }));
    const submit = (event) => {
      event.preventDefault();
      const text = name.value.trim();
      if (!text) return name.focus();
      const next = { id: existing?.id || `c${Date.now().toString(36)}`, name: text, emoji: emoji.value.trim() };
      const list = categories();
      update(existing ? list.map((c) => (c.id === existing.id ? next : c)) : [...list, next]);
      close();
    };
    return h('form', { class: 'stack', onsubmit: submit, novalidate: true },
      h('div', { class: 'emoji-row' }, emoji, name),
      h('button', { class: 'btn primary', type: 'submit' }, 'שמירה'),
      existing && categories().length > 1 && h('p', { class: 'muted small' }, 'הוצאות שכבר שויכו לקטגוריה שנמחקה יופיעו כ״ללא קטגוריה״.'),
      existing && categories().length > 1 && confirmButton('מחיקת הקטגוריה', () => {
        update(categories().filter((c) => c.id !== existing.id));
        close();
      }));
  });
}

function inviteSheet() {
  const link = inviteLink();
  openSheet('הזמנה לתקציב', () => {
    const field = h('textarea', { readonly: true, rows: 4, dir: 'ltr', class: 'link-box', 'aria-label': 'קישור ההזמנה' }, link);
    field.addEventListener('focus', () => field.select());
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(link);
        toast('הקישור הועתק');
      } catch {
        field.focus();
        toast('סמנו והעתיקו את הקישור ידנית');
      }
    };
    return h('div', { class: 'stack' },
      h('p', {}, 'שלחו את הקישור לבן או לבת הזוג. כשיפתחו אותו וייצרו חשבון, הם יצטרפו לתקציב הזה ותראו שניכם את אותם נתונים.'),
      h('p', { class: 'muted small' }, 'כל מי שמחזיק בקישור יכול להצטרף, אז שלחו אותו בפרטי. אחרי ההצטרפות אפשר לנעול אותו בהגדרות.'),
      field,
      navigator.share && h('button', {
        class: 'btn primary',
        onclick: () => navigator.share({ title: 'התקציב שלנו', text: 'הצטרפות לתקציב המשותף שלנו', url: link }).catch(() => {}),
      }, 'שיתוף'),
      h('button', { class: `btn ${navigator.share ? 'secondary' : 'primary'}`, onclick: copy }, 'העתקת הקישור'));
  });
}

// ---------- גיבוי וייבוא ----------

async function exportBackup() {
  try {
    const data = await state.store.exportAll(state.hid);
    const hh = state.household;
    const backup = {
      app: 'budget',
      version: 1,
      exportedAt: new Date().toISOString(),
      household: { name: hh.name, startDay: startDay(), categories: categories() },
      ...data,
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
    const a = h('a', { href: url, download: `budget-backup-${today()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) {
    console.error(e);
    toast('הגיבוי נכשל. בדקו את החיבור לרשת');
  }
}

function importSheet(data, fromLocalDemo = false) {
  const recurring = (data.recurring || []).filter((x) => x && x.name && x.start && Array.isArray(x.versions));
  const expenses = (data.expenses || []).filter((x) => x && x.date && Number(x.amount) > 0);
  if (!recurring.length && !expenses.length) return toast('לא נמצאו נתונים לייבוא');
  openSheet('ייבוא נתונים', (close) => {
    const button = h('button', { class: 'btn primary' }, 'ייבוא');
    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = 'מייבא…';
      try {
        const { store, hid } = state;
        const imported = data.household?.categories;
        if (Array.isArray(imported) && imported.length) {
          const known = new Set(categories().map((c) => c.id));
          const extra = imported.filter((c) => c && c.id && c.name && !known.has(c.id));
          if (extra.length) await store.updateHousehold(hid, { categories: [...categories(), ...extra] });
        }
        for (const { id, createdAt, ...item } of recurring) await store.addRecurring(hid, item);
        const clean = expenses.map(({ id, createdAt, ...item }) => ({ ...item, amount: Number(item.amount), by: item.by || state.user.uid }));
        for (let i = 0; i < clean.length; i += 400) await store.addExpenses(hid, clean.slice(i, i + 400));
        if (fromLocalDemo) storage.remove(LOCAL_KEY);
        toast('הייבוא הושלם');
        close();
        render();
      } catch (e) {
        console.error(e);
        toast('הייבוא נכשל. בדקו את החיבור לרשת ונסו שוב');
        button.disabled = false;
        button.textContent = 'ייבוא';
      }
    });
    return h('div', { class: 'stack' },
      h('p', {}, `יתווספו ${recurring.length} הכנסות והוצאות קבועות ו-${expenses.length} הוצאות משתנות לתקציב הנוכחי. נתונים קיימים לא יימחקו.`),
      button);
  });
}

// ---------- הפעלה ----------

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// היום מתחלף? מרעננים כשחוזרים לאפליקציה
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.screen === 'main' && !document.querySelector('dialog[open]')) render();
});

render();
boot();
