const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../web/core.js');

const n = s => s.replace(/\s/g, ' ');

// ---- Деньги ----
test('parseMoney: запятая и копейки', () => assert.equal(Core.parseMoney('1500,50'), 150050));
test('parseMoney: пробелы-разделители', () => assert.equal(Core.parseMoney('1 500'), 150000));
test('parseMoney: точка и одна цифра копеек', () => assert.equal(Core.parseMoney('1500.5'), 150050));
test('parseMoney: 19.99 без ошибки плавающей точки', () => assert.equal(Core.parseMoney('19.99'), 1999));
test('parseMoney: лишние знаки округляются', () => assert.equal(Core.parseMoney('1500.505'), 150051));
test('parseMoney: меньше копейки это ноль', () => assert.equal(Core.parseMoney('0,001'), 0));
test('parseMoney: число', () => assert.equal(Core.parseMoney(12), 1200));
test('parseMoney: отрицательное', () => assert.equal(Core.parseMoney('-5'), -500));
test('parseMoney: мусор даёт null', () => {
  assert.equal(Core.parseMoney('abc'), null);
  assert.equal(Core.parseMoney(''), null);
  assert.equal(Core.parseMoney(null), null);
  assert.equal(Core.parseMoney('1,2,3'), null);
});
test('fmtMoney: целые рубли без копеек', () => assert.equal(n(Core.fmtMoney(150000)), '1 500'));
test('fmtMoney: копейки показываются', () => assert.equal(n(Core.fmtMoney(150050)), '1 500,50'));
test('fmtMoney: пять копеек', () => assert.equal(n(Core.fmtMoney(5)), '0,05'));
test('fmtMoney: минус', () => assert.equal(n(Core.fmtMoney(-150000)), '−1 500'));
test('money: со знаком рубля', () => assert.equal(n(Core.money(150000)), '1 500 ₽'));

// ---- Перенос v1 → v2 ----
const demo = () => JSON.parse(require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'v1-demo.json'), 'utf8'));

test('migrate: v1 → v2, суммы ×100, счёт «Основной»', () => {
  const v1 = {
    opening: 800, cur: '2026-11', months: ['2026-11'],
    items: [{ id: 1, t: 1, type: 'in', date: '2026-11-06', title: 'ЗП', cat: 'Зарплата', amount: 4400.5 }],
    limits: { 'Еда': 20000 }, goals: [{ id: 5, name: 'Отпуск', target: 120000, saved: 45000 }]
  };
  const s = Core.migrate(v1);
  assert.equal(s.version, 2);
  assert.deepEqual(s.accounts, [{ id: 1, name: 'Основной', opening: 80000 }]);
  assert.equal(s.items[0].amount, 440050);
  assert.equal(s.items[0].account, 1);
  assert.equal(s.limits['Еда'], 2000000);
  assert.equal(s.goals[0].target, 12000000);
  assert.equal(s.goals[0].saved, 4500000);
  assert.equal('opening' in s, false);
});
test('migrate: идемпотентен', () => {
  const once = Core.migrate(demo());
  assert.deepEqual(Core.migrate(once), once);
});
test('migrate: не меняет исходный объект', () => {
  const v1 = demo(); const copy = JSON.parse(JSON.stringify(v1));
  Core.migrate(v1);
  assert.deepEqual(v1, copy);
});
test('migrate: неизвестные поля сохраняются', () => {
  const v1 = demo(); v1.foo = 1; v1.items[0].bar = 2;
  const s = Core.migrate(v1);
  assert.equal(s.foo, 1);
  assert.equal(s.items[0].bar, 2);
});
test('migrate: минимальные старые данные не роняют перенос', () => {
  const s = Core.migrate({ opening: 0, months: ['2026-11'], items: [
    { id: 1, t: 1, type: 'out', date: '2026-12-02', title: 'x', cat: 'Еда', amount: 10 }] });
  assert.deepEqual(s.limits, {});
  assert.deepEqual(s.goals, []);
  assert.deepEqual(s.reminders, []);
  assert.deepEqual(s.cats, Core.DEFAULT_CATS);
  assert.deepEqual(s.months, ['2026-11', '2026-12']);
  assert.equal(s.items.length, 1);
  assert.equal('rep' in s.items[0], false);
  assert.equal(s.cur, '2026-12');
});
test('migrate: мусор бросает bad data', () => {
  assert.throws(() => Core.migrate({}), /bad data/);
  assert.throws(() => Core.migrate({ items: [] }), /bad data/);
  assert.throws(() => Core.migrate(null), /bad data/);
});
test('migrate: демо-данные сохраняют итоговые суммы', () => {
  const v1 = demo();
  const sum = v1.items.reduce((a, i) => a + (i.type === 'in' ? i.amount : -i.amount), v1.opening);
  const s = Core.migrate(v1);
  const kop = s.items.reduce((a, i) => a + (i.type === 'in' ? i.amount : -i.amount), s.accounts[0].opening);
  assert.equal(kop, Math.round(sum * 100));
});
test('emptyState: один счёт и стандартные категории', () => {
  const s = Core.emptyState('2026-11');
  assert.equal(s.version, 2);
  assert.deepEqual(s.accounts, [{ id: 1, name: 'Основной', opening: 0 }]);
  assert.deepEqual(s.cats, Core.DEFAULT_CATS);
  assert.deepEqual(s.months, ['2026-11']);
  assert.equal(s.cur, '2026-11');
  assert.deepEqual(s.items, []);
});

// ---- Подсчёт остатков, счета, переводы ----
const mk = (items, extra = {}) => ({
  ...Core.emptyState('2026-11'),
  accounts: [{ id: 1, name: 'Карта', opening: 100000 }, { id: 2, name: 'Наличные', opening: 50000 }],
  months: ['2026-11', '2026-12'],
  items, ...extra
});
const it = (id, type, date, amount, account, extra = {}) => ({ id, t: id, type, date, title: 't' + id, cat: 'Еда', amount, account, ...extra });
const base = () => mk([
  it(3, 'transfer', '2026-11-10', 20000, 1, { toAccount: 2 }),
  it(1, 'in', '2026-11-03', 30000, 1),
  it(2, 'out', '2026-11-05', 10000, 2),
  it(4, 'out', '2026-12-02', 5000, 1)
]);

test('calc: общий остаток, доходы и расходы без переводов', () => {
  const [nov] = Core.calc(base());
  assert.equal(nov.opening, 150000);
  assert.equal(nov.inc, 30000);
  assert.equal(nov.exp, 10000);
  assert.equal(nov.closing, 170000);
});
test('calc: перевод не меняет общий остаток в строке', () => {
  const [nov] = Core.calc(base());
  assert.deepEqual(nov.rows.map(r => [r.id, r.balance]), [[1, 180000], [2, 170000], [3, 170000]]);
});
test('calc: начало следующего месяца равно концу предыдущего', () => {
  const [nov, dec] = Core.calc(base());
  assert.equal(dec.opening, nov.closing);
  assert.equal(dec.closing, 165000);
});
test('calc: внутри дня порядок по t', () => {
  const s = mk([it(2, 'out', '2026-11-05', 1, 1), it(1, 'in', '2026-11-05', 5, 1)]);
  assert.deepEqual(Core.calc(s)[0].rows.map(r => r.id), [1, 2]);
});
test('accountBalances: остатки счетов на конец месяца', () => {
  assert.deepEqual(Core.accountBalances(base(), '2026-11'), { 1: 110000, 2: 60000 });
  assert.deepEqual(Core.accountBalances(base(), '2026-12'), { 1: 105000, 2: 60000 });
});
test('accountBalances: без месяца учитывает все записи', () => {
  assert.deepEqual(Core.accountBalances(base()), { 1: 105000, 2: 60000 });
});
test('accountBalances: сумма счетов равна общему остатку', () => {
  const s = base();
  const total = Object.values(Core.accountBalances(s, '2026-11')).reduce((a, b) => a + b, 0);
  assert.equal(total, Core.calc(s)[0].closing);
});
test('запись с удалённым счётом считается в общем остатке', () => {
  const s = mk([it(1, 'out', '2026-11-05', 1000, 99)]);
  const [nov] = Core.calc(s);
  assert.equal(nov.closing, 149000);
  const b = Core.accountBalances(s, '2026-11');
  assert.equal(b[99], -1000);
  assert.equal(Object.values(b).reduce((a, x) => a + x, 0), nov.closing);
});
test('запись без категории не роняет подсчёт', () => {
  const s = mk([{ id: 1, t: 1, type: 'out', date: '2026-11-05', title: 'x', amount: 500, account: 1 }]);
  assert.equal(Core.calc(s)[0].exp, 500);
});
test('перевод на тот же счёт ничего не меняет', () => {
  const s = mk([it(1, 'transfer', '2026-11-05', 7000, 1, { toAccount: 1 })]);
  assert.deepEqual(Core.accountBalances(s, '2026-11'), { 1: 100000, 2: 50000 });
  assert.equal(Core.calc(s)[0].closing, 150000);
});
test('canDeleteAccount: правила', () => {
  assert.equal(Core.canDeleteAccount(base(), 1).ok, false);
  assert.match(Core.canDeleteAccount(base(), 1).reason, /запис/);
  assert.equal(Core.canDeleteAccount(base(), 2).ok, false);
  const empty = mk([]);
  assert.deepEqual(Core.canDeleteAccount(empty, 2), { ok: true });
  const single = { ...empty, accounts: [empty.accounts[0]] };
  assert.equal(Core.canDeleteAccount(single, 1).ok, false);
  assert.match(Core.canDeleteAccount(single, 1).reason, /хотя бы один/);
});
test('nextKey и daysIn', () => {
  assert.equal(Core.nextKey('2026-12'), '2027-01');
  assert.equal(Core.nextKey('2026-03'), '2026-04');
  assert.equal(Core.daysIn('2026-02'), 28);
  assert.equal(Core.daysIn('2028-02'), 29);
});

// ---- Разбор таблиц ----
const sheet = [
  ['НОЯБРЬ 2026', 800],
  ['дата', 'доход', 'откуда', 'расход', 'на что'],
  ['05.11.2026', 1000.5, 'ЗП', '', ''],
  ['', '', '', '1 234,56', 'Продукты']
];
test('parseSheet: суммы в копейках, счёт и номера', () => {
  const r = Core.parseSheet(sheet, { cur: '2026-11', account: 3, seq: 100 });
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map(i => i.amount), [100050, 123456]);
  assert.deepEqual(r.items.map(i => i.account), [3, 3]);
  assert.deepEqual(r.items.map(i => i.id), [101, 102]);
  assert.equal(r.opening, 80000);
  assert.deepEqual(r.months, ['2026-11']);
});
test('parseSheet: строка без даты берёт день предыдущей', () => {
  const r = Core.parseSheet(sheet, { cur: '2026-11', account: 1, seq: 0 });
  assert.equal(r.items[1].date, '2026-11-05');
});
test('guessCat: подбор категории', () => {
  assert.equal(Core.guessCat('out', 'Такси домой'), 'Транспорт');
  assert.equal(Core.guessCat('in', 'ЗП за ноябрь'), 'Зарплата');
  assert.equal(Core.guessCat('out', 'что-то'), 'Другое');
});
test('parseSheet: без колонок дохода и расхода записей нет', () => {
  const r = Core.parseSheet([['а', 'б'], ['1', '2']], { cur: '2026-11', account: 1, seq: 0 });
  assert.deepEqual(r.items, []);
});
test('parseSheet: ячейка с копейками как число', () => {
  const r = Core.parseSheet([['дата', 'доход', 'расход'], ['01.11.2026', '', 19.99]], { cur: '2026-11', account: 1, seq: 0 });
  assert.equal(r.items[0].amount, 1999);
  assert.equal(r.items[0].type, 'out');
});

// ---- Исправления по итогам ревью ----
test('migrate: данные более новой версии не пересчитываются и не принимаются', () => {
  const v3 = { version: 3, accounts: [{ id: 2, name: 'X', opening: 5 }], months: ['2026-11'],
    items: [{ id: 1, t: 1, type: 'in', date: '2026-11-01', title: 'a', cat: 'Другое', amount: 150050, account: 2 }] };
  assert.throws(() => Core.migrate(v3), /newer version/);
});
test('migrate: version 1 явно пересчитывается как v1', () => {
  const s = Core.migrate({ version: 1, opening: 1, months: ['2026-11'], items: [
    { id: 1, t: 1, type: 'in', date: '2026-11-01', title: 'a', cat: 'Другое', amount: 2 }] });
  assert.equal(s.accounts[0].opening, 100);
  assert.equal(s.items[0].amount, 200);
});

test('applyEdit: неверная сумма ничего не меняет в записи', () => {
  const it = { id: 1, t: 1, type: 'out', date: '2026-11-05', title: 'Еда', cat: 'Еда', amount: 100000, account: 1 };
  const copy = JSON.parse(JSON.stringify(it));
  const r = Core.applyEdit(it, { type: 'in', amount: 'abc', title: 'x', cat: 'Зарплата', date: '2026-11-06', note: '', rep: false }, Core.DEFAULT_CATS);
  assert.equal(r.ok, false);
  assert.match(r.error, /сумму/);
  assert.deepEqual(it, copy);
});
test('applyEdit: верные данные дают новую запись, исходная не меняется', () => {
  const it = { id: 1, t: 1, type: 'out', date: '2026-11-05', title: 'Еда', cat: 'Еда', amount: 100000, account: 1 };
  const copy = JSON.parse(JSON.stringify(it));
  const r = Core.applyEdit(it, { type: 'in', amount: '1 200,50', title: ' ЗП ', cat: 'Зарплата', date: '2026-12-01', note: ' n ', rep: true }, Core.DEFAULT_CATS);
  assert.equal(r.ok, true);
  assert.deepEqual(r.item, { ...copy, type: 'in', amount: 120050, title: 'ЗП', cat: 'Зарплата', date: '2026-12-01', note: 'n', rep: true });
  assert.deepEqual(it, copy);
});
test('applyEdit: «+ Своя категория» берёт первую категорию нового типа', () => {
  const it = { id: 1, t: 1, type: 'out', date: '2026-11-05', title: 'x', cat: 'Еда', amount: 100, account: 1 };
  const r = Core.applyEdit(it, { type: 'in', amount: '5', title: 'x', cat: '__new__', date: '2026-11-05', note: '', rep: false }, Core.DEFAULT_CATS);
  assert.equal(r.item.cat, 'Зарплата');
});

// ---- Исправления отложенных замечаний ----
test('parseMoney: запись с экспонентой из текста отвергается', () => {
  assert.equal(Core.parseMoney('1e3'), null);
  assert.equal(Core.parseMoney('2E2'), null);
  assert.equal(Core.parseMoney(2e2), 20000); // число из ячейки таблицы по-прежнему принимается
});
test('migrate: сумма v1 строкой с пробелами разбирается, а не обнуляется', () => {
  const s = Core.migrate({ opening: '1 000,50', months: ['2026-11'], items: [
    { id: 1, t: 1, type: 'in', date: '2026-11-01', title: 'a', cat: 'Другое', amount: '1 500' }] });
  assert.equal(s.items[0].amount, 150000);
  assert.equal(s.accounts[0].opening, 100050);
});
test('migrate: числа v2 строками приводятся к числам, мусор отвергается', () => {
  const v2 = { version: 2, accounts: [{ id: 1, name: 'A', opening: '100' }], months: ['2026-11'], items: [
    { id: 1, t: 1, type: 'out', date: '2026-11-01', title: 'a', cat: 'Еда', amount: '500', account: 1 }] };
  const s = Core.migrate(v2);
  assert.equal(s.items[0].amount, 500);
  assert.equal(s.accounts[0].opening, 100);
  assert.equal(Core.calc(s)[0].exp, 500);
  v2.items[0].amount = 'abc';
  assert.throws(() => Core.migrate(v2), /bad data/);
});
test('setOpeningTotal: общий стартовый остаток при нескольких счетах', () => {
  const s = mk([]);
  Core.setOpeningTotal(s, 300000);
  assert.equal(s.accounts.reduce((a, x) => a + x.opening, 0), 300000);
  assert.equal(s.accounts[1].opening, 50000);
  assert.equal(s.accounts[0].opening, 250000);
});
test('splitNewItems: дубли пропускаются, в том числе внутри самого импорта', () => {
  const have = [{ date: '2026-11-01', type: 'out', title: 'Еда', amount: 100 }];
  const inc = [
    { date: '2026-11-01', type: 'out', title: 'Еда', amount: 100 },
    { date: '2026-11-02', type: 'out', title: 'Еда', amount: 100 },
    { date: '2026-11-02', type: 'out', title: 'Еда', amount: 100 },
    { date: '2026-11-01', type: 'in', title: 'Еда', amount: 100 }
  ];
  const r = Core.splitNewItems(have, inc);
  assert.equal(r.fresh.length, 2);
  assert.equal(r.skipped, 2);
});

// ---- Банковская выписка: время в дублях, остаток на дату, правила ----
const timed = (time, extra = {}) => ({ date: '2026-11-09', time, type: 'out', title: 'Оплата в SHOP', amount: 15600, ...extra });
test('splitNewItems: две одинаковые операции со временем при пустой базе загружаются обе', () => {
  const r = Core.splitNewItems([], [timed('10:00'), timed('10:00')]);
  assert.equal(r.fresh.length, 2);
  assert.equal(r.skipped, 0);
});
test('splitNewItems: повторная загрузка тех же двух пропускает обе', () => {
  const r = Core.splitNewItems([timed('10:00'), timed('10:00')], [timed('10:00'), timed('10:00')]);
  assert.equal(r.fresh.length, 0);
  assert.equal(r.skipped, 2);
});
test('splitNewItems: дозагрузка третьей берёт только её', () => {
  const r = Core.splitNewItems([timed('10:00'), timed('10:00')], [timed('10:00'), timed('10:00'), timed('10:00')]);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.skipped, 2);
});
test('splitNewItems: разное время не дубль', () => {
  const r = Core.splitNewItems([timed('10:00')], [timed('10:01')]);
  assert.equal(r.fresh.length, 1);
});
test('splitNewItems: записи без времени как раньше', () => {
  const a = { date: '2026-11-09', type: 'out', title: 'x', amount: 5 };
  const r = Core.splitNewItems([a], [a, { ...a, amount: 6 }, { ...a, amount: 6 }]);
  assert.equal(r.fresh.length, 1);
  assert.equal(r.skipped, 2);
});
test('balanceOn: остаток на конец дня, перевод не влияет', () => {
  const s = base();
  assert.equal(Core.balanceOn(s, '2026-11-02'), 150000);
  assert.equal(Core.balanceOn(s, '2026-11-03'), 180000);
  assert.equal(Core.balanceOn(s, '2026-11-09'), 170000);
  assert.equal(Core.balanceOn(s, '2026-11-10'), 170000);
  assert.equal(Core.balanceOn(s, '2026-12-02'), 165000);
});
test('migrate: поле rules по умолчанию и сохраняется', () => {
  assert.deepEqual(Core.migrate({ opening: 0, months: ['2026-11'], items: [] }).rules, {});
  assert.deepEqual(Core.migrate({ opening: 0, months: ['2026-11'], items: [], rules: { magnit: 'Еда' } }).rules, { magnit: 'Еда' });
  assert.deepEqual(Core.emptyState('2026-11').rules, {});
});
