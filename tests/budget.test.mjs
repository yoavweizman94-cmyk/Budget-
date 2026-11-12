import test from 'node:test';
import assert from 'node:assert/strict';
import {
  periodKeyOf, periodRange, shiftMonth, amountFor, withAmountFrom,
  weeksOf, summarize, parseAmount, addDays, daysBetween,
} from '../js/budget.js';

test('shiftMonth crosses year boundaries', () => {
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
  assert.equal(shiftMonth('2026-11', -14), '2025-09');
});

test('periodKeyOf with calendar months', () => {
  assert.equal(periodKeyOf('2026-11-01'), '2026-11');
  assert.equal(periodKeyOf('2026-11-30'), '2026-11');
});

test('periodKeyOf with a custom start day', () => {
  assert.equal(periodKeyOf('2026-11-09', 10), '2026-10');
  assert.equal(periodKeyOf('2026-11-10', 10), '2026-11');
  assert.equal(periodKeyOf('2027-01-05', 10), '2026-12');
});

test('periodRange', () => {
  assert.deepEqual(periodRange('2026-12'), { start: '2026-12-01', end: '2027-01-01' });
  assert.deepEqual(periodRange('2026-11', 10), { start: '2026-11-10', end: '2026-12-10' });
});

test('date helpers', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(addDays('2026-03-27', 2), '2026-03-29'); // מעבר לשעון קיץ בישראל
  assert.equal(daysBetween('2026-03-01', '2026-04-01'), 31);
  assert.equal(daysBetween('2026-10-01', '2026-11-01'), 31);
});

test('amountFor respects start, end and versions', () => {
  const item = {
    start: '2026-03', end: '2026-10',
    versions: [{ from: '2026-03', amount: 100 }, { from: '2026-06', amount: 150 }],
  };
  assert.equal(amountFor(item, '2026-02'), null);
  assert.equal(amountFor(item, '2026-03'), 100);
  assert.equal(amountFor(item, '2026-05'), 100);
  assert.equal(amountFor(item, '2026-06'), 150);
  assert.equal(amountFor(item, '2026-10'), 150);
  assert.equal(amountFor(item, '2026-11'), null);
});

test('one-time item is active only in its month', () => {
  const bonus = { start: '2026-11', end: '2026-11', versions: [{ from: '2026-11', amount: 3000 }] };
  assert.equal(amountFor(bonus, '2026-10'), null);
  assert.equal(amountFor(bonus, '2026-11'), 3000);
  assert.equal(amountFor(bonus, '2026-12'), null);
});

test('withAmountFrom keeps history and replaces same-month version', () => {
  const item = { start: '2026-01', versions: [{ from: '2026-01', amount: 100 }] };
  const v2 = withAmountFrom(item, '2026-05', 120);
  assert.deepEqual(v2, [{ from: '2026-01', amount: 100 }, { from: '2026-05', amount: 120 }]);
  const v3 = withAmountFrom({ ...item, versions: v2 }, '2026-05', 130);
  assert.deepEqual(v3, [{ from: '2026-01', amount: 100 }, { from: '2026-05', amount: 130 }]);
  assert.equal(amountFor({ ...item, versions: v3 }, '2026-04'), 100);
  assert.equal(amountFor({ ...item, versions: v3 }, '2026-07'), 130);
});

test('weeksOf splits Sunday–Saturday and clips to the period', () => {
  // 1.11.2026 הוא יום ראשון
  const weeks = weeksOf(periodRange('2026-11'));
  assert.equal(weeks.length, 5);
  assert.deepEqual(weeks[0], { start: '2026-11-01', end: '2026-11-08' });
  assert.deepEqual(weeks[4], { start: '2026-11-29', end: '2026-12-01' });
  // 1.10.2026 הוא יום חמישי — שבוע ראשון קצר
  const oct = weeksOf(periodRange('2026-10'));
  assert.deepEqual(oct[0], { start: '2026-10-01', end: '2026-10-04' });
  assert.equal(oct.at(-1).end, '2026-11-01');
  // השבועות מכסים את כל החודש ברצף
  for (let i = 1; i < oct.length; i++) assert.equal(oct[i].start, oct[i - 1].end);
});

test('summarize computes what is left to spend', () => {
  const recurring = [
    { type: 'income', name: 'משכורת א', start: '2026-01', end: null, versions: [{ from: '2026-01', amount: 12000 }] },
    { type: 'income', name: 'משכורת ב', start: '2026-01', end: null, versions: [{ from: '2026-01', amount: 9000 }] },
    { type: 'fixed', name: 'שכירות', start: '2026-01', end: null, versions: [{ from: '2026-01', amount: 6000 }] },
    { type: 'fixed', name: 'ישן', start: '2026-01', end: '2026-06', versions: [{ from: '2026-01', amount: 999 }] },
  ];
  const expenses = [
    { amount: 400, category: 'groceries', date: '2026-11-03' },
    { amount: 250, category: 'groceries', date: '2026-11-10' },
    { amount: 100, category: 'fun', date: '2026-11-10' },
    { amount: 777, category: 'fun', date: '2026-10-31' }, // חודש קודם
    { amount: 555, category: 'fun', date: '2026-12-01' }, // חודש הבא
  ];
  const s = summarize({ recurring, expenses, key: '2026-11', today: '2026-11-12' });
  assert.equal(s.incomeTotal, 21000);
  assert.equal(s.fixedTotal, 6000);
  assert.equal(s.variableBudget, 15000);
  assert.equal(s.spent, 750);
  assert.equal(s.remaining, 14250);
  assert.equal(s.isCurrent, true);
  assert.equal(s.daysLeft, 19); // 12–30 בנובמבר, כולל היום
  assert.equal(s.perDay, 14250 / 19);
  assert.deepEqual(s.byCategory, [
    { category: 'groceries', total: 650 },
    { category: 'fun', total: 100 },
  ]);
  assert.equal(s.weeks[0].total, 400);
  assert.equal(s.weeks[1].total, 350);
  assert.equal(s.weeks[1].isCurrent, true);
  assert.equal(s.weeks.reduce((t, w) => t + w.total, 0), s.spent);
});

test('summarize for a past month has no daily allowance', () => {
  const s = summarize({ recurring: [], expenses: [], key: '2026-09', today: '2026-11-12' });
  assert.equal(s.isCurrent, false);
  assert.equal(s.isPast, true);
  assert.equal(s.perDay, null);
});

test('parseAmount', () => {
  assert.equal(parseAmount('1,250.50'), 1250.5);
  assert.equal(parseAmount(' 80 ₪'), 80);
  assert.equal(parseAmount('12.345'), 12.35);
  assert.ok(Number.isNaN(parseAmount('')));
  assert.ok(Number.isNaN(parseAmount('abc')));
});
