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
