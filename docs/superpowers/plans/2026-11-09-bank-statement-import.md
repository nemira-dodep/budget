# Импорт банковской выписки. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Загружать операции из PDF «Справки о движении средств» Т-Банка одной кнопкой: список с категориями, пропуск переводов между своими, сверка остатка, без дублей.

**Architecture:** Чистая логика разбора и категорий в новом `web/statement.js` (работает и в браузере, и в Node, как `core.js`). Чтение PDF делает pdf.js, загружаемый по требованию, и отдаёт плоский список текстовых элементов с координатами; `Statement.parseTbankItems` раскладывает их по колонкам таблицы. Окно импорта в `app.js` показывает результат и загружает записи.

**Tech Stack:** JS без сборки, `node --test`, pdf.js 3.11.174 (классическая сборка, Apache-2.0), Tauri 2.

**Spec:** `docs/superpowers/specs/2026-11-09-bank-statement-import-design.md`

## Global Constraints

- Работа идёт на новой ветке `bank-import`, созданной от `stage1-data-foundation` (формат данных v2, `Core`, копейки уже там).
- Суммы в копейках; `Op.amount` со знаком, у записи `amount > 0` и `type: 'in'|'out'`.
- Ничего из реального образца выписки (имена, адрес, номера счетов, договоров, телефонов, названия магазинов вместе с реальными суммами) не попадает в репозиторий, тесты и коммиты: только выдуманные строки. Реальный файл используется только локально для ручной проверки.
- pdf.js версия `3.11.174` закреплена, файлы в `web/vendor/pdfjs/`, сеть при работе не используется, грузится только при первом импорте PDF.
- Переводы между своими (`own`) по умолчанию не загружаются и считаются в сводке; операции не в рублях пропускаются с пометкой.
- Файл PDF нигде не сохраняется; в названия не попадают ФИО, адрес, номера счетов и карт; телефоны и номера договоров маскируются до последних 4 цифр.
- Версия релиза 1.3.0; тег и релиз делает человек.

## Review Focus

- Две одинаковые операции в одну минуту (два платежа на одну сумму в одном магазине): обе загружаются; при повторной загрузке обе пропускаются; при дозагрузке третьей загружается только она.
- Описание операции, разорванное строками, с номером карты посередине («Оплата в SHOP2 / 1234 / CAFE City RUS»): номер карты не попадает в описание, а строки склеиваются по порядку.
- Колонтитулы на каждой странице (реквизиты банка, номер страницы) и операция, начатая на одной странице и закончившаяся на следующей: колонтитулы не попадают в описания, операция не рвётся.
- Файл не та справка, пустая таблица, PDF без текста, повреждённый или зашифрованный PDF: понятное сообщение, приложение не падает, данные не меняются.
- Суммы с пробелами-разделителями и знаком («-2 508.00 ₽», «+60.00 ₽»), копейки, операция в другой валюте: суммы точные, «не рубли» пропускаются с пометкой.

---

## File Structure

- Create `web/statement.js`: `Statement.maskDigits`, `shopKey`, `categorize`, `parseTbankItems`.
- Create `tests/statement.test.js`: тесты на выдуманных данных.
- Create `web/vendor/pdfjs/pdf.min.js`, `web/vendor/pdfjs/pdf.worker.min.js`, `web/vendor/pdfjs/LICENSE`: pdf.js.
- Modify `web/core.js`, `tests/core.test.js`: `splitNewItems` с временем, `balanceOn`, поле `rules` в `migrate`.
- Modify `web/app.js`, `web/index.html`, `web/style.css`: чтение PDF, окно импорта.
- Modify `src-tauri/src/main.rs` (фильтр `pdf` в `open_table`), `src-tauri/tauri.conf.json` (CSP `worker-src 'self'`).
- Modify `CHANGELOG.md`, `README.md`, версии: релиз 1.3.0.

---

### Task 1: Маскирование, ключ магазина и категории

**Files:**
- Create: `web/statement.js`, `tests/statement.test.js`

**Interfaces:**
- Produces: модуль в стиле `core.js` (`typeof module === 'object' ? module.exports = factory() : root.Statement = factory()`);
  `Statement.maskDigits(text: string): string`; `Statement.shopKey(desc: string): string`; `Statement.categorize(desc: string, type: 'in'|'out', rules: {[key: string]: string}): {cat: string, own: boolean}` (тип операции берётся по знаку суммы и подаётся на вход; в спеке тип возвращался функцией, здесь он вход, потому что он известен из знака).

- [ ] **Step 1: Write failing tests** в `tests/statement.test.js`:
  - `maskDigits('Внешний перевод по номеру телефона +79991112233') === 'Внешний перевод по номеру телефона +7···2233'`; `maskDigits('Внутренний перевод на договор 4444555566') === 'Внутренний перевод на договор ···5566'`; `maskDigits('Оплата в CH12345 City') === 'Оплата в CH12345 City'` (короткие числа остаются).
  - `shopKey('Оплата в MAGNIT MM City RUS') === 'magnit'`; `shopKey('Оплата в CH12345 City RUS') === 'ch'`; `shopKey('Оплата в Y.M*vkusnoitochka') === 'y.m*vkusnoitochka'`; `shopKey('Перевод себе 1234') === 'перевод себе'`.
  - `categorize`: `('Оплата в MAGNIT MM', 'out', {})` даёт `{cat:'Еда', own:false}`; `('Оплата в urent G. MOSKVA', 'out', {})` даёт `'Транспорт'`; `('ПФР. Пенсия по случ.', 'in', {})` даёт `'Пенсия'`; `('Оплата в UNKNOWNSHOP', 'out', {})` даёт `'Другое'`; `('Пополнение. Система быстрых платежей', 'in', {})` даёт `'Другое'`.
  - Правило пользователя раньше встроенного: `('Оплата в MAGNIT MM', 'out', {magnit: 'Подарок'})` даёт `'Подарок'`.
  - Переводы между своими: описания, начинающиеся с «Перевод себе», «Внутренний перевод», «Перевод с договора», «Перевод между своими», дают `own: true`; «Внешний перевод по номеру телефона» даёт `own: false`.
- [ ] **Step 2: Run** `node --test tests/` → FAIL (модуль не найден).
- [ ] **Step 3: Implement** по спеку, раздел 2. Встроенные правила как массивы `[RegExp, категория]` для `in` и `out`, регистр не важен; ключ магазина: нижний регистр, цифры и знаки кроме букв, пробела, `&`, `*`, `.`, `-` убираются, берётся первое слово после «оплата в», иначе первые два слова.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: statement masking, shop key and categories`.

---

### Task 2: Разбор таблицы Т-Банка

**Files:**
- Modify: `web/statement.js`, `tests/statement.test.js`

**Interfaces:**
- Consumes: `Statement.maskDigits` (Task 1). Суммы разбираются здесь же, без `Core`.
- Produces: `Statement.parseTbankItems(items: {str: string, x: number, y: number, page: number}[]): ParsedStatement` где `ParsedStatement = {ops: Op[], skipped: {date: string, desc: string, reason: string}[], declared: {income?: number, expense?: number, balance?: number, balanceDate?: string}, warnings: string[]}` и `Op = {date: string /*ГГГГ-ММ-ДД*/, time: string /*ЧЧ:ММ*/, amount: number /*копейки со знаком*/, desc: string /*уже с маскированием*/, card: string}`.

- [ ] **Step 1: Write failing tests.** Помощник `T(page, y, cols)` строит синтетические элементы: колонки по `x`: дата 40, дата списания 110, сумма операции 180, сумма в карте 250, описание 330, карта 520; заголовки на странице: «Дата и время», «операции», «Дата», «списания», «Сумма в валюте», «Сумма операции», «Описание», «Номер», «карты». Тесты (значения выдуманные):
  - Одна операция: дата `09.11.2026` + время `16:39` в первой колонке, `-156.00 ₽` и `-156.00 ₽` в колонках сумм, «Оплата в SHOP1 City RUS» в описании, `1234` в карте → `ops[0]` `{date:'2026-11-09', time:'16:39', amount:-15600, desc:'Оплата в SHOP1 City RUS', card:'1234'}`.
  - Приход `+60.00 ₽` даёт `amount: 6000`; `-2 508.00 ₽` даёт `-250800`; `+1 234.56 ₽` даёт `123456`.
  - Описание на трёх строках с номером карты посередине (`Оплата в SHOP2` на `y`, `1234` в колонке карты на `y-10`, `CAFE City RUS` в описании на `y-10`) → `desc === 'Оплата в SHOP2 CAFE City RUS'`, `card === '1234'`.
  - Телефон в описании маскируется: `+79991112233` → `+7···2233`.
  - Операция, начатая внизу страницы 1 (дата и время есть, описание продолжается), и продолжение описания вверху страницы 2: одна операция с полным описанием.
  - Колонтитул на странице («АО «ТБанк» универсальная лицензия Банка России», «БИК 044525974 ИНН …», номер страницы «9» ниже) не попадает ни в одно описание и не создаёт операций.
  - Операция с суммой в долларах (`-10.00 $` в колонке операции, `-900.00 ₽` в карте) попадает в `skipped` с `reason` «в другой валюте», в `ops` нет.
  - Сверка: итоги `Пополнения: 60.00 ₽`, `Расходы: 156.00 ₽` (метки и значения на одной высоте) при совпадении дают `declared.income === 6000`, `declared.expense === 15600`, `warnings` пуст; при расхождении `warnings` содержит строку со словом «итоги».
  - «Сумма доступного остатка на 09.11.2026: 1 234.56 ₽» даёт `declared.balance === 123456`, `declared.balanceDate === '2026-11-09'`.
  - Нет таблицы или нет операций: `ops` пуст, `warnings` содержит «Не нашёл операций».
  - Две одинаковые операции в одну минуту остаются двумя элементами в `ops`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement `parseTbankItems`** по спеку, раздел 1: границы колонок берутся из `x` заголовочных слов и действуют на всех страницах; начало операции это элемент вида `ДД.ММ.ГГГГ` в первой колонке, за которым следует время `ЧЧ:ММ`; элементы между началами операций, включая страницы, раскладываются по колонкам по `x`; колонтитул отсекается по первому элементу с «лицензия» или «БИК» на странице (всё ниже него на странице отбрасывается); в колонке суммы в валюте карты берётся первый токен вида `[+-]\d[\d ]*\.\d{2} ₽` (если несколько токенов в одном элементе, подходят первый для операции и второй для карты); сумма операции в другой валюте определяется по символу не `₽` в колонке «в валюте операции». Итоги и остаток находятся по текстам «Пополнения», «Расходы» и «Сумма доступного остатка на».
- [ ] **Step 4: Run** `node --test tests/` → PASS.
- [ ] **Step 5: Commit** `feat: parse T-Bank statement table`.

---

### Task 3: Дубли со временем, остаток на дату, правила в данных

**Files:**
- Modify: `web/core.js`, `tests/core.test.js`

**Interfaces:**
- Consumes: `Core.splitNewItems(existing, incoming): {fresh, skipped}` (есть), `Core.migrate`.
- Produces: `Core.splitNewItems` учитывает `time`; `Core.balanceOn(S: State, date: 'ГГГГ-ММ-ДД'): number` (общий остаток на конец дня: сумма стартовых остатков плюс доходы минус расходы по записям с `date <= date`; переводы не влияют); `Core.migrate` добавляет `rules: {}`.

- [ ] **Step 1: Write failing tests** в `tests/core.test.js`:
  - Две записи с одним ключом и `time` в импорте при пустой базе: `fresh.length === 2`, `skipped === 0`.
  - Те же две при повторной загрузке (в базе уже две): `fresh.length === 0`, `skipped === 2`.
  - В базе две, в импорте три одинаковых: `fresh.length === 1`, `skipped === 2`.
  - Записи без `time` ведут себя как раньше (прежний тест на дубли внутри импорта остаётся зелёным).
  - Записи с разным `time` и остальным одинаковым не считаются дублями.
  - `balanceOn`: состояние с двумя счетами и переводом из тестов подсчёта: на `2026-11-04` без записей после даты даёт сумму с учётом только прошедших записей; перевод не меняет значение.
  - `migrate` без `rules` даёт `{}`; с `rules: {magnit: 'Еда'}` сохраняет.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** в `core.js`: для записей со `time` считать вхождения через `Map` ключ → число; запись пропускается, если её номер вхождения среди пришедших не больше числа таких в базе.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: time-aware duplicate detection, balanceOn and rules field`.

---

### Task 4: pdf.js и чтение файла

**Files:**
- Create: `web/vendor/pdfjs/pdf.min.js`, `web/vendor/pdfjs/pdf.worker.min.js`, `web/vendor/pdfjs/LICENSE`
- Modify: `web/app.js`, `web/index.html` (добавить `statement.js`), `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: в `app.js` `loadPdfJs(): Promise<void>` (ленивая загрузка `vendor/pdfjs/pdf.min.js`, как `loadXlsx`; `pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'`); `extractTextItems(bytes: Uint8Array): Promise<{str: string, x: number, y: number, page: number}[]>` (по каждой странице `getTextContent()`, `x = transform[4]`, `y = transform[5]`, пустые строки отбрасываются; для зашифрованного или повреждённого файла бросает ошибку с текстом «Не удалось прочитать PDF»); в Rust диалог `open_table` принимает `pdf`; CSP содержит `worker-src 'self'`.

- [ ] **Step 1: Download** pdf.js: `curl -L https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js -o web/vendor/pdfjs/pdf.min.js`, то же для `pdf.worker.min.js` и текста лицензии Apache-2.0 из пакета. Проверить размер и первую строку (должна содержать `pdf.js`).
- [ ] **Step 2: Implement** `loadPdfJs` и `extractTextItems`; подключить `<script src="statement.js">` после `core.js`; в `main.rs` добавить `"pdf"` в `add_filter("Таблицы и копии", ...)`; в `tauri.conf.json` дополнить CSP директивой `worker-src 'self'`.
- [ ] **Step 3: Verify локально на реальном образце** (вне репозитория): в папке scratchpad `npm i pdfjs-dist@3.11.174`, скрипт Node читает локальный образец справки (файл из папки «Загрузки», который дал пользователь) через `pdfjs-dist/legacy/build/pdf.js`, собирает те же элементы `{str,x,y,page}`, передаёт в `Statement.parseTbankItems`. Ожидается: `warnings` пуст, число операций в `ops` плюс `skipped` примерно 220, сумма плюсов равна `declared.income`, сумма минусов `declared.expense`. Если не сходится, исправить `parseTbankItems` по тесту на воспроизведённый случай (синтетический) и повторить. Реальные строки в репозиторий и в вывод для коммита не попадают.
- [ ] **Step 4: Verify в браузере:** поднять `python3 -m http.server` в папке `web`, в странице вызвать `extractTextItems` на образце (загрузить через `fetch` с локального сервера из scratchpad) и убедиться, что число элементов больше нуля и воркер загрузился без ошибок CSP в консоли.
- [ ] **Step 5: Commit** `feat: read PDF statements with pdf.js`.

---

### Task 5: Окно импорта выписки

**Files:**
- Modify: `web/app.js`, `web/index.html`, `web/style.css`

**Interfaces:**
- Consumes: `Statement.parseTbankItems`, `Statement.categorize`, `Statement.shopKey` (Tasks 1-2), `Core.splitNewItems`, `Core.balanceOn`, `Core.setOpeningTotal`, `extractTextItems` (Task 4), `S.rules` (Task 3).
- Produces: `handleImportFile(name, bytes)` принимает `.pdf`; новое состояние `pendingImport = {bank: {rows: Row[], declared, warnings, skipped}}`, где `Row = {op: Op, type: 'in'|'out', cat: string, own: boolean, include: boolean, remember: boolean, changed: boolean}`; `showStatementPreview()` отрисовывает окно; `doImport()` загружает выбранные строки.

- [ ] **Step 1: Implement** по спеку, раздел 3:
  - В `handleImportFile` для `.pdf`: `extractTextItems` → `parseTbankItems` → при пустом `ops` бросить сообщение «Не нашёл операций. Это справка Т-Банка о движении средств?»; при ошибке чтения «Не удалось прочитать PDF. Возможно, файл защищён паролем»; для каждой операции получить `{cat, own}` через `Statement.categorize(op.desc, type, S.rules)`; если категории нет в `S.cats[type]`, взять «Другое», если её нет, первую; `include = !own`.
  - Окно: предупреждения сверху; сводка «Найдено N, будет загружено N, дублей N, переводов между своими N (пропущено), другая валюта N»; галочка «Загрузить и переводы между своими как расходы и доходы» (включает `include` у строк `own`); таблица строк: галочка, дата, описание, выпадающий список категорий нужного типа, сумма со знаком; у изменённой категории галочка «Запомнить для магазина» (по умолчанию включена).
  - Сверка: если есть `declared.balance`, показать «В справке: X ₽, у вас после импорта: Y ₽, разница Z ₽», где `Y = Core.balanceOn(S + выбранные строки, declared.balanceDate)`; если разница не ноль и в бюджете нет записей раньше первой операции выписки, показать кнопку «Подогнать стартовый остаток под справку», которая при загрузке меняет общий стартовый остаток через `Core.setOpeningTotal` на разницу.
  - Загрузка: записи `{id, t, type, date, time, title: op.desc, cat, amount: abs, account: S.accounts[0].id}` через `Core.splitNewItems`; правила: для строк с `changed && remember` `S.rules[Statement.shopKey(op.desc)] = cat`; `ensureMonth`, `save()`, уведомление «Загружено: N» (и «, дублей пропущено: M»).
  - В `index.html` обновить текст окна импорта («.xlsx, .xls, .csv, .pdf с выпиской Т-Банка или копию .json»), в `style.css` добавить стили таблицы предпросмотра и строки сверки.
- [ ] **Step 2: Verify** `node --check web/app.js` и `node --test tests/`.
- [ ] **Step 3: Verify в браузере** на выдуманных данных: подать в `handleImportFile` PDF-образец локально (из scratchpad, не из репозитория) и убедиться: число строк и сводка правдоподобны, переводы между своими сняты с галочек, категории подобраны, смена категории у магазина и загрузка сохраняют правило в `S.rules`, повторный импорт того же файла показывает «Загружено: 0, дублей пропущено: N», остаток по справке сверяется, консоль без ошибок; снять скриншот окна для себя (в репозиторий не коммитить).
- [ ] **Step 4: Commit** `feat: bank statement import window`.

---

### Task 6: Документы, версия, проверка приватности

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: готовая функция из Tasks 1-5.

- [ ] **Step 1: Docs.** `CHANGELOG.md`: раздел `## 1.3.0 — <дата>` (импорт выписки Т-Банка из PDF, подбор категорий и запоминание, пропуск переводов между своими, сверка остатка, без дублей). `README.md`: строка в таблице «Что умеет» и раздел «Импорт банковской выписки» (где взять справку, как загрузить, что делает с переводами и приватностью).
- [ ] **Step 2: Versions** до `1.3.0` в трёх файлах, затем `npm install --package-lock-only` и `cargo update -p budget --offline`.
- [ ] **Step 3: Privacy check:** выполнить `git diff <base>..HEAD` по ключевым фрагментам реального образца (фамилия и имя из шапки, город и улица адреса, номера счёта, договоров, телефонов, названия реальных магазинов вместе с суммами) и убедиться, что совпадений нет; проверить `git grep` по цифровым фрагментам номеров из образца; ничего реального в тестах нет.
- [ ] **Step 4: Verify** `npm test` проходит (Node и Rust); `gh workflow run build.yml --ref bank-import` проходит на Mac и Windows.
- [ ] **Step 5: Commit и push** `chore: release 1.3.0 prep`. Тег и релиз не создаются.
