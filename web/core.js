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

  return { parseMoney, fmtMoney, money };
});
