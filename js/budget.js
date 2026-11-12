// חישובי תקציב טהורים — בלי DOM ובלי רשת, כדי שאפשר יהיה לבדוק אותם ב-node.

export const DEFAULT_CATEGORIES = [
  { id: 'groceries', name: 'סופר', emoji: '🛒' },
  { id: 'eating-out', name: 'אוכל בחוץ', emoji: '🍽️' },
  { id: 'transport', name: 'רכב ותחבורה', emoji: '⛽' },
  { id: 'fun', name: 'בילויים ופנאי', emoji: '🎉' },
  { id: 'shopping', name: 'קניות וביגוד', emoji: '🛍️' },
  { id: 'health', name: 'בריאות ופארם', emoji: '💊' },
  { id: 'kids', name: 'ילדים', emoji: '🧸' },
  { id: 'home', name: 'בית', emoji: '🏠' },
  { id: 'other', name: 'אחר', emoji: '📦' },
];

const pad = (n) => String(n).padStart(2, '0');

/** תאריך מקומי כמחרוזת YYYY-MM-DD */
export function toISODate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseISODate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(iso, n) {
  const d = parseISODate(iso);
  d.setDate(d.getDate() + n);
  return toISODate(d);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((parseISODate(toIso) - parseISODate(fromIso)) / 86400000);
}

/** הזזת מפתח חודש ('YYYY-MM') ב-n חודשים */
export function shiftMonth(key, n) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/**
 * לאיזה חודש תקציב שייך תאריך. כשיום תחילת החודש הוא 10,
 * חודש התקציב "2026-11" נמשך מ-10.11 עד 9.12.
 */
export function periodKeyOf(iso, startDay = 1) {
  const [y, m, d] = iso.split('-').map(Number);
  const key = `${y}-${pad(m)}`;
  return d >= startDay ? key : shiftMonth(key, -1);
}

/** טווח התאריכים של חודש תקציב: start כולל, end לא כולל */
export function periodRange(key, startDay = 1) {
  const next = shiftMonth(key, 1);
  return { start: `${key}-${pad(startDay)}`, end: `${next}-${pad(startDay)}` };
}

/**
 * הסכום של פריט קבוע (הכנסה / הוצאה קבועה) בחודש נתון, או null אם אינו פעיל בו.
 * פריט: { start:'YYYY-MM', end:'YYYY-MM'|null, versions:[{from:'YYYY-MM', amount}] }
 * כל גרסה תקפה מהחודש שלה ועד הגרסה הבאה, כך ששינוי סכום לא משכתב את העבר.
 */
export function amountFor(item, key) {
  if (key < item.start) return null;
  if (item.end && key > item.end) return null;
  const versions = [...(item.versions || [])].sort((a, b) => a.from.localeCompare(b.from));
  if (!versions.length) return 0;
  let current = versions[0];
  for (const v of versions) if (v.from <= key) current = v;
  return current.amount;
}

/** קביעת סכום חדש החל מחודש נתון (מחזיר מערך גרסאות חדש) */
export function withAmountFrom(item, key, amount) {
  // אם החודש קודם לתחילת הפריט, הגרסה נרשמת על חודש ההתחלה
  const from = key < item.start ? item.start : key;
  const rest = (item.versions || []).filter((v) => v.from !== from);
  rest.push({ from, amount });
  return rest.sort((a, b) => a.from.localeCompare(b.from));
}

/** חלוקת חודש התקציב לשבועות (ראשון–שבת), חתוכים לגבולות החודש */
export function weeksOf(range) {
  const weeks = [];
  let start = range.start;
  while (start < range.end) {
    const dow = parseISODate(start).getDay(); // 0 = ראשון
    let end = addDays(start, 7 - dow); // יום ראשון הבא
    if (end > range.end) end = range.end;
    weeks.push({ start, end });
    start = end;
  }
  return weeks;
}

/**
 * סיכום חודש תקציב.
 * recurring: פריטים קבועים ({type:'income'|'fixed', ...})
 * expenses: הוצאות משתנות ({amount, category, date})
 */
export function summarize({ recurring, expenses, key, startDay = 1, today }) {
  const range = periodRange(key, startDay);
  const income = [];
  const fixed = [];
  for (const item of recurring) {
    const amount = amountFor(item, key);
    if (amount === null) continue;
    (item.type === 'income' ? income : fixed).push({ ...item, amount });
  }
  const sum = (list) => list.reduce((s, x) => s + (Number(x.amount) || 0), 0);
  const inPeriod = expenses.filter((e) => e.date >= range.start && e.date < range.end);

  const incomeTotal = sum(income);
  const fixedTotal = sum(fixed);
  const spent = sum(inPeriod);
  const variableBudget = incomeTotal - fixedTotal;
  const remaining = variableBudget - spent;

  const byCategory = new Map();
  for (const e of inPeriod) {
    byCategory.set(e.category, (byCategory.get(e.category) || 0) + (Number(e.amount) || 0));
  }

  const weeks = weeksOf(range).map((w) => ({
    ...w,
    total: sum(inPeriod.filter((e) => e.date >= w.start && e.date < w.end)),
    isCurrent: !!today && today >= w.start && today < w.end,
  }));

  const isCurrent = !!today && today >= range.start && today < range.end;
  const isPast = !!today && today >= range.end;
  const daysLeft = isCurrent ? daysBetween(today, range.end) : 0; // כולל היום
  const totalDays = daysBetween(range.start, range.end);

  return {
    key,
    range,
    income,
    fixed,
    expenses: inPeriod,
    incomeTotal,
    fixedTotal,
    spent,
    variableBudget,
    remaining,
    byCategory: [...byCategory.entries()]
      .map(([category, total]) => ({ category, total }))
      .sort((a, b) => b.total - a.total),
    weeks,
    isCurrent,
    isPast,
    daysLeft,
    totalDays,
    perDay: isCurrent && daysLeft > 0 ? remaining / daysLeft : null,
  };
}

/** פענוח סכום שהוקלד ("1,250.50", "1250", "‎₪ 80") למספר, או NaN */
export function parseAmount(text) {
  const cleaned = String(text ?? '').replace(/[^\d.,-]/g, '').replace(/,/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}
