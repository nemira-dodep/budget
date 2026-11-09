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

  return { maskDigits, shopKey, categorize };
});
