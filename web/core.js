// Логика бюджета без интерфейса: деньги, формат данных, подсчёт, разбор таблиц.
// Работает и в браузере (window.Core), и в Node (require) для тестов.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Деньги: целые числа в копейках ----
  const rubFmt = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });

  // Текст или число в рублях → копейки; null, если это не сумма.
  function parseMoney(input) {
    if (input === null || input === undefined) return null;
    if (typeof input === 'number' && !Number.isFinite(input)) return null;
    const s = String(input).replace(/[\s  ]/g, '').replace(',', '.');
    if (/e/i.test(s)) {
      const x = Number(s);
      return Number.isFinite(x) ? Math.round(x * 100) : null;
    }
    const m = s.match(/^([-+]?)(\d*)(?:\.(\d*))?$/);
    if (!m || (!m[2] && !m[3])) return null;
    const frac = m[3] || '';
    let kop = Number(m[2] || 0) * 100 + Number((frac + '00').slice(0, 2));
    if (frac.length > 2 && frac[2] >= '5') kop += 1;
    return kop === 0 ? 0 : (m[1] === '-' ? -kop : kop);
  }

  // Копейки → «1 500» или «1 500,50» (без знака валюты)
  function fmtMoney(kop) {
    const a = Math.abs(Math.round(kop));
    const r = Math.floor(a / 100), k = a % 100;
    let s = rubFmt.format(r);
    if (k) s += ',' + String(k).padStart(2, '0');
    return (kop < 0 ? '−' : '') + s;
  }
  const money = kop => fmtMoney(kop) + ' ₽';

  // ---- Формат данных v2 ----
  const DEFAULT_CATS = {
    in: ['Зарплата', 'Пенсия', 'Подработка', 'Подарок', 'Другое'],
    out: ['Еда', 'Транспорт', 'Жильё', 'Техника', 'Одежда', 'Подписки', 'Здоровье', 'Семья', 'Развлечения', 'Другое']
  };
  const monthKey = date => date.slice(0, 7);
  const kop = rub => Math.round((Number(rub) || 0) * 100);

  function emptyState(key) {
    return {
      version: 2,
      accounts: [{ id: 1, name: 'Основной', opening: 0 }],
      cats: { in: [...DEFAULT_CATS.in], out: [...DEFAULT_CATS.out] },
      limits: {}, goals: [], reminders: [],
      months: [key], cur: key, items: []
    };
  }

  // Любые данные (v1 или v2) → новый объект v2. Исходный объект не меняется.
  function migrate(raw) {
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || !Array.isArray(raw.months)) {
      throw new Error('bad data');
    }
    const s = JSON.parse(JSON.stringify(raw));
    if (s.version !== 2) {
      s.accounts = [{ id: 1, name: 'Основной', opening: kop(s.opening) }];
      delete s.opening;
      s.items.forEach(i => { i.amount = kop(i.amount); i.account = 1; });
      Object.keys(s.limits || {}).forEach(k => { s.limits[k] = kop(s.limits[k]); });
      (s.goals || []).forEach(g => { g.target = kop(g.target); g.saved = kop(g.saved); });
      s.version = 2;
    }
    if (!Array.isArray(s.accounts) || !s.accounts.length) s.accounts = [{ id: 1, name: 'Основной', opening: 0 }];
    s.limits = s.limits || {};
    s.goals = s.goals || [];
    s.reminders = s.reminders || [];
    const cat = t => (s.cats && Array.isArray(s.cats[t]) && s.cats[t].length) ? s.cats[t] : DEFAULT_CATS[t];
    s.cats = { in: [...cat('in')], out: [...cat('out')] };
    const first = s.accounts[0].id;
    s.items.forEach(i => { if (i.account === undefined) i.account = first; });
    s.months = [...new Set([...s.months, ...s.items.map(i => monthKey(i.date))])].sort();
    if (!s.months.includes(s.cur)) s.cur = s.months[s.months.length - 1];
    return s;
  }

  // ---- Подсчёт ----
  const nextKey = key => {
    let [y, m] = key.split('-').map(Number);
    m++; if (m > 12) { m = 1; y++; }
    return `${y}-${String(m).padStart(2, '0')}`;
  };
  const daysIn = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
  const byDate = (a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.t - b.t;
  const openingTotal = S => S.accounts.reduce((a, x) => a + x.opening, 0);

  // Месяцы с общим остатком. Перевод между счетами не входит в доходы и расходы
  // и не меняет общий остаток.
  function calc(S) {
    const months = [...new Set(S.months)].sort();
    let bal = openingTotal(S);
    return months.map(key => {
      const items = S.items.filter(i => monthKey(i.date) === key).sort(byDate);
      const opening = bal;
      let inc = 0, exp = 0;
      const rows = items.map(i => {
        if (i.type === 'in') { bal += i.amount; inc += i.amount; }
        else if (i.type === 'out') { bal -= i.amount; exp += i.amount; }
        return { ...i, balance: bal };
      });
      return { key, opening, inc, exp, closing: bal, rows };
    });
  }

  // Остатки счетов на конец месяца включительно (без аргумента: по всем записям).
  // Записи с неизвестным счётом получают собственный ключ, чтобы сумма сходилась.
  function accountBalances(S, upTo) {
    const b = {};
    S.accounts.forEach(a => { b[a.id] = a.opening; });
    const add = (id, v) => { b[id] = (b[id] || 0) + v; };
    S.items.filter(i => !upTo || monthKey(i.date) <= upTo).forEach(i => {
      if (i.type === 'in') add(i.account, i.amount);
      else if (i.type === 'out') add(i.account, -i.amount);
      else if (i.type === 'transfer') { add(i.account, -i.amount); add(i.toAccount, i.amount); }
    });
    return b;
  }

  function canDeleteAccount(S, id) {
    if (S.accounts.length <= 1) return { ok: false, reason: 'Должен остаться хотя бы один счёт' };
    if (S.items.some(i => i.account === id || i.toAccount === id)) {
      return { ok: false, reason: 'У счёта есть записи. Сначала удалите или перенесите их' };
    }
    return { ok: true };
  }

  return { parseMoney, fmtMoney, money, DEFAULT_CATS, emptyState, migrate, monthKey, nextKey, daysIn, calc, accountBalances, canDeleteAccount };
});
