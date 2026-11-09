const test = require('node:test');
const assert = require('node:assert/strict');
const Statement = require('../web/statement.js');

// ---- Маскирование ----
test('maskDigits: телефон оставляет последние 4 цифры', () =>
  assert.equal(Statement.maskDigits('Внешний перевод по номеру телефона +79991112233'),
    'Внешний перевод по номеру телефона +7···2233'));
test('maskDigits: номер договора', () =>
  assert.equal(Statement.maskDigits('Внутренний перевод на договор 4444555566'),
    'Внутренний перевод на договор ···5566'));
test('maskDigits: короткие числа остаются', () =>
  assert.equal(Statement.maskDigits('Оплата в CH12345 City'), 'Оплата в CH12345 City'));

// ---- Ключ магазина ----
test('shopKey: слово после «Оплата в»', () => {
  assert.equal(Statement.shopKey('Оплата в MAGNIT MM City RUS'), 'magnit');
  assert.equal(Statement.shopKey('Оплата в CH12345 City RUS'), 'ch');
  assert.equal(Statement.shopKey('Оплата в Y.M*vkusnoitochka'), 'y.m*vkusnoitochka');
});
test('shopKey: прочее по первым двум словам без цифр', () =>
  assert.equal(Statement.shopKey('Перевод себе 1234'), 'перевод себе'));

// ---- Категории ----
test('categorize: встроенные правила', () => {
  assert.deepEqual(Statement.categorize('Оплата в MAGNIT MM', 'out', {}), { cat: 'Еда', own: false });
  assert.equal(Statement.categorize('Оплата в urent G. MOSKVA', 'out', {}).cat, 'Транспорт');
  assert.equal(Statement.categorize('ПФР. Пенсия по случ.', 'in', {}).cat, 'Пенсия');
  assert.equal(Statement.categorize('Оплата в UNKNOWNSHOP', 'out', {}).cat, 'Другое');
  assert.equal(Statement.categorize('Пополнение. Система быстрых платежей', 'in', {}).cat, 'Другое');
});
test('categorize: правило пользователя раньше встроенного', () =>
  assert.equal(Statement.categorize('Оплата в MAGNIT MM', 'out', { magnit: 'Подарок' }).cat, 'Подарок'));
test('categorize: переводы между своими', () => {
  for (const d of ['Перевод себе 1234', 'Внутренний перевод на договор 4444555566', 'Перевод с договора 1111222233', 'Перевод между своими счетами']) {
    assert.equal(Statement.categorize(d, 'out', {}).own, true, d);
  }
  assert.equal(Statement.categorize('Внешний перевод по номеру телефона +79991112233', 'out', {}).own, false);
});

// ---- Разбор таблицы Т-Банка (выдуманные данные) ----
const X = { dt: 40, pay: 110, amtOp: 180, amtCard: 250, desc: 330, card: 520 };
const it = (str, x, y, page = 1) => ({ str, x, y, page });
const header = (page = 1, y = 800) => [
  it('Дата и время', X.dt, y, page), it('операции', X.dt, y - 10, page),
  it('Дата', X.pay, y, page), it('списания', X.pay, y - 10, page),
  it('Сумма в валюте', X.amtOp, y, page), it('операции', X.amtOp, y - 10, page),
  it('Сумма операции', X.amtCard, y, page), it('в валюте карты', X.amtCard, y - 10, page),
  it('Описание', X.desc, y, page), it('операции', X.desc, y - 10, page),
  it('Номер', X.card, y, page), it('карты', X.card, y - 10, page)
];
// Одна операция: даты и суммы на высоте y, описание построчно, номер карты посередине
const op = ({ page = 1, y, date = '09.11.2026', time = '16:39', amtOp = '-156.00 ₽', amtCard = amtOp, lines = ['Оплата в SHOP1 City RUS'], card = '1234' }) => [
  it(date, X.dt, y, page), it(time, X.dt, y - 10, page),
  it(date, X.pay, y, page), it(time, X.pay, y - 10, page),
  it(amtOp, X.amtOp, y, page), it(amtCard, X.amtCard, y, page),
  ...lines.map((l, i) => it(l, X.desc, y - 10 * i, page)),
  it(card, X.card, y - 10, page)
];
const footer = (page = 1, y = 60) => [
  it('АО «ТБанк» универсальная лицензия Банка России № 2673', 40, y, page),
  it('БИК 044525974 ИНН 7710140679 КПП 771301001', 40, y - 10, page),
  it(String(page), 300, y - 25, page)
];
const parse = items => Statement.parseTbankItems(items);

test('parse: одна операция', () => {
  const r = parse([...header(), ...op({ y: 770 })]);
  assert.deepEqual(r.ops, [{ date: '2026-11-09', time: '16:39', amount: -15600, desc: 'Оплата в SHOP1 City RUS', card: '1234' }]);
});
test('parse: суммы со знаком и пробелами', () => {
  const r = parse([...header(),
    ...op({ y: 770, amtOp: '+60.00 ₽', time: '10:00' }),
    ...op({ y: 740, amtOp: '-2 508.00 ₽', time: '11:00' }),
    ...op({ y: 710, amtOp: '+1 234.56 ₽', time: '12:00' })]);
  assert.deepEqual(r.ops.map(o => o.amount), [6000, -250800, 123456]);
});
test('parse: описание с номером карты посередине склеивается без номера', () => {
  const r = parse([...header(), ...op({ y: 770, lines: ['Оплата в SHOP2', 'CAFE City RUS'] })]);
  assert.equal(r.ops[0].desc, 'Оплата в SHOP2 CAFE City RUS');
  assert.equal(r.ops[0].card, '1234');
});
test('parse: телефон в описании маскируется', () => {
  const r = parse([...header(), ...op({ y: 770, lines: ['Внешний перевод по', 'номеру телефона +79991112233'] })]);
  assert.equal(r.ops[0].desc, 'Внешний перевод по номеру телефона +7···2233');
});
test('parse: операция и описание продолжаются на следующей странице', () => {
  const p1 = [...header(1), ...op({ page: 1, y: 100, lines: ['Оплата в LONGSHOP'] }), ...footer(1)];
  const p2 = [...header(2), it('Moscow RUS', X.desc, 780, 2), ...op({ page: 2, y: 740, time: '09:00' }), ...footer(2)];
  const r = parse([...p1, ...p2]);
  assert.equal(r.ops.length, 2);
  assert.equal(r.ops[0].desc, 'Оплата в LONGSHOP Moscow RUS');
});
test('parse: колонтитулы не попадают в описания и не создают операций', () => {
  const r = parse([...header(1), ...op({ y: 770 }), ...footer(1)]);
  assert.equal(r.ops.length, 1);
  assert.equal(r.ops[0].desc, 'Оплата в SHOP1 City RUS');
  assert.equal(r.ops[0].card, '1234');
});
test('parse: операция не в рублях уходит в skipped', () => {
  const r = parse([...header(), ...op({ y: 770, amtOp: '-10.00 $', amtCard: '-900.00 ₽', lines: ['Оплата в USSHOP'] })]);
  assert.equal(r.ops.length, 0);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /другой валюте/);
});
test('parse: две одинаковые операции в одну минуту остаются двумя', () => {
  const r = parse([...header(), ...op({ y: 770 }), ...op({ y: 740 })]);
  assert.equal(r.ops.length, 2);
  assert.deepEqual(r.ops[0], r.ops[1]);
});
test('parse: итоги и остаток, совпадение без предупреждений', () => {
  const totals = [it('Пополнения:', 40, 400, 1), it('60,00 ₽', 300, 400, 1), it('Расходы:', 40, 380, 1), it('156,00 ₽', 300, 380, 1),
    it('Сумма доступного остатка на 09.11.2026: 1 234.56 ₽', 40, 790, 1)];
  const r = parse([...header(), ...op({ y: 770, amtOp: '+60.00 ₽', time: '10:00' }), ...op({ y: 740 }), ...totals]);
  assert.equal(r.declared.income, 6000);
  assert.equal(r.declared.expense, 15600);
  assert.equal(r.declared.balance, 123456);
  assert.equal(r.declared.balanceDate, '2026-11-09');
  assert.deepEqual(r.warnings, []);
});
test('parse: расхождение итогов даёт предупреждение', () => {
  const totals = [it('Пополнения:', 40, 400, 1), it('999,00 ₽', 300, 400, 1), it('Расходы:', 40, 380, 1), it('156,00 ₽', 300, 380, 1)];
  const r = parse([...header(), ...op({ y: 770 }), ...totals]);
  assert.ok(r.warnings.some(w => /итоги/i.test(w)));
});
test('parse: нет таблицы или операций', () => {
  assert.ok(parse([it('Что-то совсем другое', 40, 700)]).warnings.some(w => /Не нашёл операций/.test(w)));
  assert.ok(parse([...header()]).warnings.some(w => /Не нашёл операций/.test(w)));
  assert.deepEqual(parse([]).ops, []);
});

test('parse: слово «Номер» в тексте над таблицей не принимается за заголовок колонки', () => {
  const above = [it('Номер договора: 0000000000', 40, 900, 1), it('Номер лицевого счета: 00000000000000000000', 40, 890, 1)];
  const r = parse([...above, ...header(), ...op({ y: 770 })]);
  assert.equal(r.ops[0].desc, 'Оплата в SHOP1 City RUS');
  assert.equal(r.ops[0].card, '1234');
});
