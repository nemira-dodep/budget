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
