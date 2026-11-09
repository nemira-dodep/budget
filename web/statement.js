// Банковская выписка: маскирование, категории, разбор таблицы Т-Банка.
// Без обращения к странице: работает в браузере (window.Statement) и в Node для тестов.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Statement = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Приватность: телефоны и номера договоров остаются только последними 4 цифрами ----
  function maskDigits(text) {
    return String(text)
      .replace(/\+7(\d{10})/g, (m, d) => '+7···' + d.slice(-4))
      .replace(/\d{8,}/g, d => '···' + d.slice(-4));
  }

  // ---- Ключ магазина для запоминания правил ----
  function shopKey(desc) {
    const clean = String(desc).toLowerCase().replace(/[^a-zа-яё&*.\-\s]/g, '');
    const m = clean.match(/^\s*оплата в\s+(.+)/);
    const tokens = (m ? m[1] : clean).split(/\s+/).filter(Boolean);
    return m ? (tokens[0] || '') : tokens.slice(0, 2).join(' ');
  }

  // ---- Категории ----
  const OWN = /^\s*(перевод себе|внутренний перевод|перевод с договора|перевод между своими)/i;
  const RULES = {
    in: [
      [/пфр\.?\s*пенси|пенси/i, 'Пенсия'],
      [/зарплат|salary|аванс/i, 'Зарплата']
    ],
    out: [
      [/magnit|магнит|krasnoe|красное|beloe|белое|pyaterochka|пят[её]рочка|dixy|дикси|bristol|бристоль|lenta|лента|ashan|ашан|vkusvill|вкусвилл|perekrestok|перекр[её]сток|pekari|пекари|burger|бургер|vkusnoitochka|вкусно и точка|кафе|cafe|coffe|кофе|ресторан|pizza|пицц|sushi|суши/i, 'Еда'],
      [/urent|такси|taxi|метро|metro|трамва|автобус|ржд|rzd/i, 'Транспорт'],
      [/tmmb|подписк|netflix|spotify|icloud|vpn|впн|кинопоиск/i, 'Подписки'],
      [/playerok|playschamp|steam|avito|авито|кино|игр/i, 'Развлечения'],
      [/аптек|apteka|клиник|стоматолог/i, 'Здоровье'],
      [/жкх|коммунал|аренд/i, 'Жильё']
    ]
  };

  // Категория для операции. Тип ('in'|'out') известен из знака суммы.
  function categorize(desc, type, rules) {
    if (OWN.test(desc)) return { cat: 'Другое', own: true };
    const user = rules && rules[shopKey(desc)];
    if (user) return { cat: user, own: false };
    const hit = RULES[type].find(([re]) => re.test(desc));
    return { cat: hit ? hit[1] : 'Другое', own: false };
  }

  // ---- Разбор таблицы Т-Банка «Справка о движении средств» ----
  // items: плоский список текста PDF {str, x, y, page}; y растёт вверх, как в pdf.js.
  const DATE = /^(\d{2})\.(\d{2})\.(\d{4})$/;
  const TIME = /^\d{2}:\d{2}$/;
  const AMOUNT = /([+\-−])\s*(\d[\d  ]*[.,]\d{2})\s*([^\s\d+\-−])/g;
  const isoDate = m => `${m[3]}-${m[2]}-${m[1]}`;
  const toKop = str => {
    const [i, f = ''] = str.replace(/[\s ]/g, '').replace(',', '.').split('.');
    return Number(i) * 100 + Number((f + '00').slice(0, 2));
  };
  const rub = kop => (kop / 100).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function parseTbankItems(items) {
    const out = { ops: [], skipped: [], declared: {}, warnings: [] };
    const NOT_FOUND = 'Не нашёл операций. Это справка Т-Банка о движении средств?';

    // Остаток на дату и итоги (ищем по всем элементам)
    for (const it of items) {
      const m = it.str.match(/остатка на (\d{2})\.(\d{2})\.(\d{4}):?\s*(\d[\d  ]*[.,]\d{2})/);
      if (m) { out.declared.balance = toKop(m[4]); out.declared.balanceDate = isoDate(m); }
    }
    const valueNear = (label) => items.find(v => v.page === label.page && Math.abs(v.y - label.y) <= 3 && v.x > label.x &&
      /^\s*\d[\d  ]*[.,]\d{2}/.test(v.str));
    const incomeLabel = items.find(i => /^Пополнения/.test(i.str));
    const expenseLabel = items.find(i => /^Расходы/.test(i.str));
    if (incomeLabel) { const v = valueNear(incomeLabel); if (v) out.declared.income = toKop(v.str.match(/\d[\d  ]*[.,]\d{2}/)[0]); }
    if (expenseLabel) { const v = valueNear(expenseLabel); if (v) out.declared.expense = toKop(v.str.match(/\d[\d  ]*[.,]\d{2}/)[0]); }

    // Колонки по заголовкам таблицы
    const find = test => items.find(i => test(i.str));
    const heads = [
      find(s => s.startsWith('Дата и время')), find(s => s === 'Дата'), find(s => s.startsWith('Сумма в валюте')),
      find(s => s.startsWith('Сумма операции')), find(s => s.startsWith('Описание')), find(s => s.startsWith('Номер'))
    ];
    if (heads.some(h => !h)) { out.warnings.push(NOT_FOUND); return out; }
    const xs = heads.map(h => h.x);
    const bounds = xs.slice(1).map((x, i) => (xs[i] + x) / 2);
    const colOf = x => bounds.filter(b => x >= b).length;

    // Что отбросить на каждой странице: шапку таблицы, колонтитул и всё ниже итогов
    const cut = {};
    for (const page of new Set(items.map(i => i.page))) {
      const on = items.filter(i => i.page === page);
      const head = on.find(i => i.str.startsWith('Описание'));
      const foot = on.filter(i => /лицензия|^БИК/.test(i.str)).map(i => i.y);
      const tot = on.filter(i => /^(Пополнения|Расходы)/.test(i.str)).map(i => i.y);
      cut[page] = {
        top: head ? head.y - 15 : Infinity,
        bottom: Math.max(foot.length ? Math.max(...foot) : -Infinity, tot.length ? Math.max(...tot) + 5 : -Infinity)
      };
    }
    const body = items
      .filter(i => i.y <= cut[i.page].top && i.y > cut[i.page].bottom)
      .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);

    // Раскладка по операциям
    const rows = [];
    let cur = null;
    for (const it of body) {
      const col = colOf(it.x);
      const dm = col === 0 && it.str.trim().match(DATE);
      if (dm) { cur = { date: isoDate(dm), time: null, cols: [[], [], [], [], [], []] }; rows.push(cur); continue; }
      if (!cur) continue;
      if (col === 0 && TIME.test(it.str.trim()) && !cur.time) { cur.time = it.str.trim(); continue; }
      cur.cols[col].push(it.str);
    }

    const all = [];   // для сверки с итогами: сумма в валюте карты каждой операции
    for (const r of rows) {
      const desc = maskDigits(r.cols[4].join(' ').replace(/\s+/g, ' ').trim());
      const tokens = [...r.cols[2].concat(r.cols[3]).join(' ').matchAll(AMOUNT)];
      if (!tokens.length) { out.skipped.push({ date: r.date, desc, reason: 'не удалось прочитать сумму' }); continue; }
      const opTok = tokens[0], cardTok = tokens[1] || tokens[0];
      const signed = t => (t[1] === '+' ? 1 : -1) * toKop(t[2]);
      if (opTok[3] !== '₽' || cardTok[3] !== '₽') {
        out.skipped.push({ date: r.date, desc, reason: 'операция в другой валюте' });
        if (cardTok[3] === '₽') all.push(signed(cardTok));
        continue;
      }
      const amount = signed(cardTok);
      all.push(amount);
      const card = (r.cols[5].join(' ').match(/\d{4}/) || [''])[0];
      out.ops.push({ date: r.date, time: r.time || '00:00', amount, desc, card });
    }

    if (!out.ops.length && !out.skipped.length) { out.warnings.push(NOT_FOUND); return out; }
    const plus = all.filter(a => a > 0).reduce((a, b) => a + b, 0);
    const minus = -all.filter(a => a < 0).reduce((a, b) => a + b, 0);
    const bad = [];
    if (out.declared.income !== undefined && plus !== out.declared.income) bad.push(`пополнения: прочитано ${rub(plus)} ₽, в справке ${rub(out.declared.income)} ₽`);
    if (out.declared.expense !== undefined && minus !== out.declared.expense) bad.push(`расходы: прочитано ${rub(minus)} ₽, в справке ${rub(out.declared.expense)} ₽`);
    if (bad.length) out.warnings.push('Итоги не сходятся со справкой (' + bad.join('; ') + '). Проверьте список перед загрузкой.');
    return out;
  }

  return { maskDigits, shopKey, categorize, parseTbankItems };
});
