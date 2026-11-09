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
      if (typeof input !== 'number') return null;   // «1e3» из текстового поля это ошибка ввода
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
  const kop = rub => { const k = parseMoney(rub); return k === null ? 0 : k; };
  const intOf = v => {
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) throw new Error('bad data');
    return n;
  };

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
    if (s.version !== undefined && s.version !== 1 && s.version !== 2) throw new Error('newer version');
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
    s.accounts.forEach(a => { a.opening = intOf(a.opening ?? 0); });
    s.items.forEach(i => { i.amount = intOf(i.amount); });
    Object.keys(s.limits).forEach(k => { s.limits[k] = intOf(s.limits[k]); });
    s.goals.forEach(g => { g.target = intOf(g.target); g.saved = intOf(g.saved ?? 0); });
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

  // Меняет общий стартовый остаток: разница уходит в первый счёт
  function setOpeningTotal(S, total) {
    S.accounts[0].opening += total - openingTotal(S);
  }

  // Новые записи для импорта: дубли (дата, тип, описание, сумма) пропускаются, в том числе внутри самого импорта
  function splitNewItems(existing, incoming) {
    const key = i => `${i.date}|${i.type}|${i.title}|${i.amount}`;
    const seen = new Set(existing.map(key));
    const fresh = [];
    let skipped = 0;
    incoming.forEach(i => {
      const k = key(i);
      if (seen.has(k)) skipped++;
      else { seen.add(k); fresh.push(i); }
    });
    return { fresh, skipped };
  }

  function canDeleteAccount(S, id) {
    if (S.accounts.length <= 1) return { ok: false, reason: 'Должен остаться хотя бы один счёт' };
    if (S.items.some(i => i.account === id || i.toAccount === id)) {
      return { ok: false, reason: 'У счёта есть записи. Сначала удалите или перенесите их' };
    }
    return { ok: true };
  }

  // Правка записи из диалога. Исходная запись не меняется; при ошибке возвращает {ok:false, error}.
  function applyEdit(it, v, cats) {
    const amount = parseMoney(v.amount);
    if (amount === null || !(amount > 0)) return { ok: false, error: 'Введите сумму, например 1500 или 1500,50' };
    const cat = v.cat === '__new__' ? cats[v.type][0] : v.cat;
    return { ok: true, item: { ...it, type: v.type, amount, title: v.title.trim(), cat,
      date: v.date, note: v.note.trim(), rep: !!v.rep } };
  }

  // ---- Разбор таблиц ----
  const pad = n => String(n).padStart(2, '0');
  const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const MONTH_WORDS = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
  const CAT_RULES = {
    in: [[/зп|зарплат|аванс/, 'Зарплата'], [/пенс/, 'Пенсия'], [/подраб|фриланс/, 'Подработка']],
    out: [[/маме|семь|ребен/, 'Семья'], [/еда|обед|продукт|кафе|ресторан|доставк/, 'Еда'],
          [/такси|бензин|метро|проезд|парков/, 'Транспорт'], [/квартир|аренд|ипотек|коммунал|жкх|ремонт/, 'Жильё'],
          [/мак|айфон|iphone|телефон|пылесос|техник|ноут|компьют|apple|наушник/, 'Техника'],
          [/одежд|обув|куртк|джинс/, 'Одежда'], [/впн|подписк|netflix|spotify|icloud|vpn/, 'Подписки'],
          [/аптек|врач|лекар|стоматолог|анализ/, 'Здоровье'], [/steam|игр|кино|развлеч|фигурк/, 'Развлечения']]
  };
  function guessCat(type, title) {
    const t = title.toLowerCase();
    const hit = CAT_RULES[type].find(([re]) => re.test(t));
    return hit ? hit[1] : 'Другое';
  }
  // Ячейка → копейки (0, если это не сумма)
  const cellMoney = v => { const k = parseMoney(v); return k === null ? 0 : k; };
  function parseDate(v) {
    if (v instanceof Date) return localDate(v);
    if (typeof v === 'number' && v > 20000 && v < 80000) {
      const d = new Date(Math.round((v - 25569) * 86400 * 1000));
      return localDate(new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    }
    const m = String(v ?? '').match(/(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/);
    return m ? `${m[3]}-${pad(m[2])}-${pad(m[1])}` : null;
  }
  function monthFromCell(text) {
    const m = text.trim().toLowerCase().match(/^([а-яё]+)\s*(\d{4})?$/);
    if (!m) return null;
    const idx = MONTH_WORDS.findIndex(w => m[1].startsWith(w));
    return idx < 0 ? null : { num: idx + 1, year: m[2] ? Number(m[2]) : null };
  }
  function mapHeader(cells) {
    const low = cells.map(c => c.toLowerCase());
    const find = (...keys) => low.findIndex(c => keys.some(k => c.includes(k)));
    return {
      incAmt: find('доход'), incTitle: find('откуда', 'источник'),
      expAmt: find('расход'), expTitle: find('на что', 'назначен', 'описан'),
      date: find('дата')
    };
  }
  // Первый лист таблицы: строки-месяцы, шапка «доход/расход», строки записей.
  // opts: { cur: месяц по умолчанию «ГГГГ-ММ», account: id счёта, seq: стартовый номер записей }
  function parseSheet(rows, opts) {
    const items = [], months = new Set();
    let ctx = null, map = null, lastDay = 1, opening = null;
    const defYear = Number(opts.cur.slice(0, 4));
    let seq = opts.seq;
    for (const row of rows) {
      if (!Array.isArray(row)) continue;
      const cells = row.map(v => v instanceof Date ? '' : String(v ?? '').trim());
      const filled = cells.filter(Boolean);
      if (!filled.length) continue;
      const low = cells.map(c => c.toLowerCase());
      if (low.some(c => c.includes('доход')) && low.some(c => c.includes('расход'))) { map = mapHeader(cells); continue; }
      const mh = filled.length <= 2 ? monthFromCell(filled[0]) : null;
      if (mh) {
        const year = mh.year || (ctx ? Number(ctx.slice(0, 4)) : defYear);
        ctx = `${year}-${pad(mh.num)}`;
        lastDay = 1;
        const num = row.find(v => typeof v === 'number');
        if (opening === null && num !== undefined && items.length === 0) opening = cellMoney(num);
        continue;
      }
      if (!map) continue;
      const sides = [
        { type: 'in', amount: cellMoney(row[map.incAmt]), col: map.incTitle },
        { type: 'out', amount: cellMoney(row[map.expAmt]), col: map.expTitle }
      ];
      for (const s of sides) {
        if (!(s.amount > 0)) continue;
        const title = (s.col >= 0 ? String(row[s.col] ?? '').trim() : '') || (s.type === 'in' ? 'Доход' : 'Расход');
        let date = map.date >= 0 ? parseDate(row[map.date]) : null;
        const tm = title.match(/(\d{1,2})[.\-](\d{1,2})(?!\d)/);
        if (!date && tm && ctx && Number(tm[2]) === Number(ctx.slice(5, 7))) date = `${ctx}-${pad(tm[1])}`;
        if (!date) date = `${ctx || opts.cur}-${pad(lastDay)}`;
        else lastDay = Number(date.slice(8, 10));
        months.add(monthKey(date));
        seq++;
        items.push({ id: seq, t: seq, type: s.type, date, title, cat: guessCat(s.type, title), amount: s.amount, account: opts.account });
      }
    }
    return { items, months: [...months].sort(), opening };
  }

  return { parseMoney, fmtMoney, money, DEFAULT_CATS, emptyState, migrate, monthKey, nextKey, daysIn, calc, accountBalances, canDeleteAccount, setOpeningTotal, splitNewItems, parseSheet, guessCat, localDate, applyEdit };
});
