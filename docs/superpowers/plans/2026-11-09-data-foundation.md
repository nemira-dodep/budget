# Фундамент данных. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Хранить данные файлом с автокопиями, считать деньги в копейках, перейти на формат v2 со счетами и переводами и покрыть логику тестами.

**Architecture:** Чистая логика (деньги, перенос v1→v2, подсчёт, разбор таблиц) выносится из `web/app.js` в `web/core.js`, который работает и в браузере, и в Node. Rust получает модуль `src-tauri/src/data.rs` (атомарная запись, копии, настройки) и команды Tauri. `web/storage.js` прячет разницу между файлом (Tauri) и `localStorage` (браузер).

**Tech Stack:** JS без сборки, `node --test`; Rust, Tauri 2, `chrono`, `serde_json`, `tempfile` (dev); GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-09-data-foundation-design.md`

## Global Constraints

- Суммы везде целые числа в копейках; рубли только на входе и выходе (ввод, показ, CSV).
- Формат данных `version: 2`: `accounts[{id,name,opening}]`, у записи `account`, `type: "in"|"out"|"transfer"`, у перевода `toAccount`, без `cat`.
- Перенос v1→v2: суммы, лимиты, цели, стартовый остаток ×100 с округлением; `opening` становится счётом «Основной» (id `1`); неизвестные поля сохраняются; перенос идемпотентен.
- Ключ `budget.v1` в `localStorage` не удаляется.
- Файл данных `data.json` в `app_data_dir`; запись через временный файл и переименование.
- Копия `budget-ГГГГ-ММ-ДД.json` не чаще раза в день; хранить 30 дней; чужие файлы не трогать. Папка по умолчанию `<app_data_dir>/backups`, выбранная хранится в `settings.json`.
- Сохранение с задержкой 300 мс; повреждённый `data.json` не затирается, переименовывается в `data.json.broken`.
- Показ денег: «1 500 ₽», копейки только если есть: «1 500,50 ₽». Ввод: «1500,50», «1500.50», пробелы убираются, лишние знаки округляются до копейки.
- Все тексты интерфейса на русском.
- Версия релиза 1.2.0. Релиз и тег делает человек, не план.

## Review Focus

- Ввод суммы «1 500,50», «1500.505», «19.99», «0,001», «abc», пустая строка, «-5»: точные копейки без ошибок плавающей точки (19.99 → 1999), мусор отвергается.
- Старые данные без `limits`, `goals`, `reminders`, `cats`, записи без `rep` и `note`, месяцы записей, которых нет в `months`: перенос не падает и не теряет записей.
- `data.json` нулевой длины или обрезанный: приложение не перезаписывает его, оставляет `data.json.broken`, предлагает последнюю копию.
- Папка копий удалена, только для чтения или недоступна: копия уходит в папку по умолчанию, показано предупреждение, данные не пропадают.
- Перевод между счетами и запись с удалённой категорией или счётом: общий остаток и доходы с расходами не искажаются, приложение не падает.

---

## File Structure

- Create `web/core.js`: деньги, перенос, подсчёт, разбор таблиц. Без обращения к `document`.
- Create `web/storage.js`: загрузка и сохранение состояния (Tauri или `localStorage`).
- Create `tests/core.test.js`: тесты на Node.
- Create `src-tauri/src/data.rs`: файлы, копии, настройки, команды.
- Modify `web/app.js`: использует `Core` и `Storage`, деньги в копейках.
- Modify `web/index.html`: подключает скрипты, пункты меню «Папка копий», «Открыть папку копий», поля суммы.
- Modify `src-tauri/src/main.rs`, `src-tauri/Cargo.toml`: команды, выход через сохранение.
- Modify `package.json`, `.github/workflows/build.yml`, `README.md`, `CHANGELOG.md`: тесты в CI, документы, версия 1.2.0.

---

### Task 1: Деньги в `core.js`

**Files:**
- Create: `web/core.js`, `tests/core.test.js`
- Modify: `package.json` (скрипт `"test": "node --test tests/ && cargo test --manifest-path src-tauri/Cargo.toml"`)

**Interfaces:**
- Produces: `Core.parseMoney(input: string|number): number|null` (копейки или `null`), `Core.fmtMoney(kop: number): string` (без знака валюты), `Core.money(kop: number): string` (с « ₽»). Модуль: `(function(root, factory){ typeof module === 'object' ? module.exports = factory() : root.Core = factory(); })(this, ...)`.

- [ ] **Step 1: Write failing tests** в `tests/core.test.js` (`const test = require('node:test'); const assert = require('node:assert/strict'); const Core = require('../web/core.js');`). Помощник `const n = s => s.replace(/\s/g, ' ')`:
  - `parseMoney('1500,50') === 150050`, `parseMoney('1 500') === 150000`, `parseMoney('1500.5') === 150050`, `parseMoney('19.99') === 1999`, `parseMoney('1500.505') === 150051`, `parseMoney('0,001') === 0`, `parseMoney(12) === 1200`, `parseMoney('-5') === -500`.
  - `parseMoney('abc') === null`, `parseMoney('') === null`, `parseMoney(null) === null`, `parseMoney('1,2,3') === null`.
  - `n(fmtMoney(150000)) === '1 500'`, `n(fmtMoney(150050)) === '1 500,50'`, `n(fmtMoney(5)) === '0,05'`, `n(fmtMoney(-150000)) === '−1 500'` (U+2212), `n(Core.money(150000)) === '1 500 ₽'`.
- [ ] **Step 2: Run** `node --test tests/` → FAIL (модуль не найден).
- [ ] **Step 3: Implement** `parseMoney` разбором строки (убрать пробелы, nbsp и U+202F, запятую в точку, регулярка `^[-+]?\d+(\.\d+)?$`, округление по строке: целая часть ×100 + первые два знака + округление по третьему, без `Number*100`) и `fmtMoney` через `Intl.NumberFormat('ru-RU')` на целой и дробной частях.
- [ ] **Step 4: Run** `node --test tests/` → PASS.
- [ ] **Step 5: Commit** `git add web/core.js tests package.json && git commit -m "feat: money parsing and formatting in kopecks"`.

---

### Task 2: Перенос v1 → v2

**Files:**
- Create: `tests/fixtures/v1-demo.json` (данные v1 в рублях: `opening 15000`, два месяца `2026-10` и `2026-11`, 14 записей доходов и расходов, `limits {'Еда': 20000}`, одна цель, одно напоминание; те же, что на скриншотах README)
- Modify: `web/core.js`, `tests/core.test.js`

**Interfaces:**
- Consumes: `Math.round`.
- Produces: `Core.DEFAULT_CATS: {in: string[], out: string[]}` (списки из `CATS` в `app.js`), `Core.emptyState(monthKey: string): State`, `Core.migrate(raw: object): State` (новый объект; бросает `Error('bad data')`, если нет массивов `items` и `months`).

- [ ] **Step 1: Write failing tests:**
  - v1 `{opening: 800, cur:'2026-11', months:['2026-11'], items:[{id:1,t:1,type:'in',date:'2026-11-06',title:'ЗП',cat:'Зарплата',amount:4400.5}], limits:{'Еда':20000}, goals:[{id:5,name:'Отпуск',target:120000,saved:45000}]}` даёт `version 2`, `accounts` `[{id:1,name:'Основной',opening:80000}]`, `items[0].amount === 440050`, `items[0].account === 1`, `limits['Еда'] === 2000000`, `goals[0].target === 12000000`, `goals[0].saved === 4500000`, `opening` отсутствует.
  - Идемпотентность: `migrate(migrate(v1))` глубоко равен `migrate(v1)`.
  - Неизвестное поле `foo: 1` на верхнем уровне и `bar: 2` у записи сохраняются.
  - Review Focus: v1 без `limits`, `goals`, `reminders`, `cats`, запись без `rep` и `note`, запись в месяце `2026-12`, которого нет в `months` (месяц добавляется): не падает, записи на месте. `migrate({})` и `migrate({items:[]})` бросают `bad data`.
  - `emptyState('2026-11')`: один счёт «Основной» с `opening: 0`, `cats` равны `DEFAULT_CATS`, `months:['2026-11']`, `cur:'2026-11'`, `items:[]`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** в `core.js`. Версия берётся из `raw.version`; при `2` данные только дополняются недостающими полями (`limits`, `goals`, `reminders`, `cats`, `accounts` по умолчанию), суммы не умножаются.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: migrate data format v1 to v2`.

---

### Task 3: Подсчёт остатков, счета и переводы

**Files:**
- Modify: `web/core.js`, `tests/core.test.js`

**Interfaces:**
- Consumes: `State` из Task 2.
- Produces: `Core.calc(S: State): Month[]`, где `Month = {key, opening, inc, exp, closing, rows: (Item & {balance})[]}` (общий остаток, как прежний `calc` в `app.js:67-90`; в `rows` попадают и переводы с неизменным `balance`); `Core.accountBalances(S: State, monthKey?: string): {[accountId: number]: number}` (остатки счетов на конец месяца включительно, без аргумента на сегодня по всем записям); `Core.canDeleteAccount(S: State, id: number): {ok: boolean, reason?: string}`; вспомогательные `Core.monthKey(date)`, `Core.nextKey(key)`, `Core.daysIn(key)`.

- [ ] **Step 1: Write failing tests:** состояние с двумя счетами (`opening` 100000 и 50000), записи: доход 30000 на счёт 1 (3 ноября), расход 10000 со счёта 2, перевод 20000 со счёта 1 на счёт 2.
  - `calc` даёт `opening 150000`, `inc 30000`, `exp 10000`, `closing 170000`; у строки перевода `balance` равен предыдущему.
  - `accountBalances(S, '2026-11')` равно `{1: 110000, 2: 60000}`; сумма значений равна `closing`.
  - Переход месяцев: `opening` декабря равен `closing` ноября.
  - Порядок внутри месяца: по `date`, затем по `t`.
  - Review Focus: запись с `account`, которого нет в `accounts`, и запись `out` с отсутствующей категорией не бросают и считаются в общем остатке; перевод на тот же счёт не меняет ни один остаток.
  - `canDeleteAccount`: счёт с записями или единственный вернёт `{ok:false, reason}` с русским текстом, пустой при двух счетах вернёт `{ok:true}`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: перенести тело `calc` и хелперы из `app.js`, добавить правила для `transfer` (не влияет на `inc`, `exp` и общий остаток, меняет остатки счетов).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: accounts and transfers in balance calculation`.

---

### Task 4: Разбор таблиц в `core.js`

**Files:**
- Modify: `web/core.js`, `tests/core.test.js`

**Interfaces:**
- Consumes: `Core.parseMoney`.
- Produces: `Core.parseSheet(rows: any[][], opts: {defYear: number, account: number, seq: number}): {items: Item[], months: string[], opening: number|null}` (суммы в копейках, `account` из `opts`), `Core.guessCat(type: 'in'|'out', title: string): string`. Переносятся `parseSheet`, `guessCat`, `toNum`, `parseDate`, `monthFromCell`, `mapHeader` и таблицы `CAT_RULES`, `MONTH_WORDS` из `app.js:~730-800`.

- [ ] **Step 1: Write failing tests:**
  - Лист `[['НОЯБРЬ 2026', 800], ['дата','доход','откуда','расход','на что'], ['05.11.2026', 1000.5, 'ЗП', '', ''], ['', '', '', '1 234,56', 'Продукты']]` даёт два элемента, суммы `100050` и `123456`, `opening === 80000`, `months` `['2026-11']`, у элементов `account === opts.account`, ids начинаются с `opts.seq + 1`.
  - Строка без даты берёт день предыдущей; `guessCat('out', 'Такси домой') === 'Транспорт'`.
  - Лист без колонок «доход» и «расход» возвращает `items: []`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** переносом кода и заменой `toNum` на `parseMoney` (число из ячейки `Math.round(n * 100)`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: sheet parsing in kopecks`.

---

### Task 5: Интерфейс переходит на `Core` и копейки

**Files:**
- Modify: `web/app.js`, `web/index.html`
- Test: ручная проверка по шагам ниже

**Interfaces:**
- Consumes: всё из `Core` (Tasks 1-4).
- Produces: в `app.js` глобальные `S` (состояние v2), `fmt`/`money` как обёртки над `Core.fmtMoney`/`Core.money`; `load()` возвращает `Core.migrate(...)`; все суммы в `S` в копейках.

- [ ] **Step 1: Подключить** `<script src="core.js"></script>` перед `app.js` в `web/index.html`; поле суммы в форме и диалоге записи заменить на `type="text" inputmode="decimal"` без `min` и `step`.
- [ ] **Step 2: Заменить в `app.js`** локальные `calc`, `parseSheet`, `guessCat` и хелперы на вызовы `Core`; все места ввода суммы (форма записи, диалог записи, остаток, лимит, цель, взнос в цель) читают через `Core.parseMoney` и отклоняют `null` и значения ≤ 0 (стартовый остаток может быть отрицательным); все места показа идут через `money`/`fmt` (плитки, список, категории, цели, годовая таблица, импорт, CSV: в CSV суммы в рублях с запятой `Core.fmtMoney`-подобно без пробелов). Новая запись получает `account: S.accounts[0].id`. Начало месяца в плитке равно сумме стартовых остатков счетов; кнопка «изменить» правит `S.accounts[0].opening`.
- [ ] **Step 3: Verify** `node --check web/app.js` без ошибок.
- [ ] **Step 4: Verify в браузере** (`python3 -m http.server 8000 --directory web`): записать в `localStorage` ключ `budget.v1` содержимое `tests/fixtures/v1-demo.json`, открыть страницу. Ожидаем: остаток, доходы, расходы совпадают с прежней версией, в `localStorage` или памяти данные `version: 2`; добавить запись «1500,50» и убедиться, что в списке «1 500,50», а остаток вырос на 150050 копеек; ввод «abc» отвергается; консоль без ошибок.
- [ ] **Step 5: Commit** `feat: use core module and kopecks in the interface`.

---

### Task 6: Файл данных в Rust

**Files:**
- Create: `src-tauri/src/data.rs`
- Modify: `src-tauri/Cargo.toml` (`[dev-dependencies] tempfile = "3"`)

**Interfaces:**
- Produces: `pub fn atomic_write(path: &Path, text: &str) -> io::Result<()>` (запись в `<имя>.tmp` рядом, `sync_all`, переименование); `pub enum Loaded { None, Ok(String), Broken }`; `pub fn load_data_file(path: &Path) -> io::Result<Loaded>` (нет файла → `None`; не JSON или пустой → переименовать в `data.json.broken`, вернуть `Broken`).

- [ ] **Step 1: Write failing tests** (в `#[cfg(test)] mod tests` в `data.rs`, `tempfile::tempdir`):
  - `atomic_write` создаёт файл с нужным текстом и не оставляет `.tmp`.
  - Повторная запись заменяет содержимое; если папка недоступна для записи, возвращает `Err`, а старый файл цел.
  - `load_data_file` на отсутствующем файле возвращает `None`; на корректном JSON возвращает `Ok(text)`; на пустом файле и на обрезанном `{"a":` возвращает `Broken`, и в папке появился `data.json.broken` с прежним содержимым, а `data.json` исчез.
- [ ] **Step 2: Run** `cargo test --manifest-path src-tauri/Cargo.toml` → FAIL.
- [ ] **Step 3: Implement** функции; проверка JSON через `serde_json::from_str::<serde_json::Value>`; подключить модуль `mod data;` в `main.rs`.
- [ ] **Step 4: Run** `cargo test` → PASS.
- [ ] **Step 5: Commit** `feat: atomic data file with broken-file protection`.

---

### Task 7: Автокопии и настройки

**Files:**
- Modify: `src-tauri/src/data.rs`

**Interfaces:**
- Consumes: `atomic_write` (Task 6).
- Produces: `pub fn ensure_daily_backup(data: &Path, dir: &Path, today: chrono::NaiveDate) -> io::Result<bool>` (`true`, если копия создана; создаёт папку; имя `budget-ГГГГ-ММ-ДД.json`); `pub fn prune_backups(dir: &Path, today: NaiveDate, keep_days: i64) -> io::Result<usize>` (удаляет только файлы вида `budget-ГГГГ-ММ-ДД.json` старше `keep_days`); `pub struct Settings { pub backup_dir: Option<String> }` (`serde`, `Default`); `pub fn load_settings(path: &Path) -> Settings` (ошибка чтения или разбора даёт `Default`); `pub fn save_settings(path: &Path, s: &Settings) -> io::Result<()>`; `pub fn effective_backup_dir(default: &Path, s: &Settings) -> (PathBuf, bool)` (второй элемент `true`, если выбранная папка недоступна и взята папка по умолчанию; недоступна значит не существует и не создаётся, либо нет записи).

- [ ] **Step 1: Write failing tests:**
  - `ensure_daily_backup` в первый раз создаёт `budget-2026-11-09.json` с содержимым `data.json` и возвращает `true`; второй вызов в тот же день возвращает `false` и не меняет файл.
  - `prune_backups` с `keep_days = 30` удаляет `budget-2026-09-01.json`, оставляет `budget-2026-10-20.json` и файл `notes.txt`, возвращает `1`.
  - `load_settings` для отсутствующего и для битого файла равен `Default`; `save_settings` затем `load_settings` возвращает то же значение.
  - Review Focus: `effective_backup_dir` для папки, которая не создаётся (путь внутри обычного файла), возвращает папку по умолчанию и `true`.
- [ ] **Step 2: Run** `cargo test` → FAIL.
- [ ] **Step 3: Implement**; дата из имени файла разбирается `NaiveDate::parse_from_str`.
- [ ] **Step 4: Run** `cargo test` → PASS.
- [ ] **Step 5: Commit** `feat: daily backups, pruning and settings`.

---

### Task 8: Команды Tauri, `storage.js` и подключение к интерфейсу

**Files:**
- Modify: `src-tauri/src/main.rs`, `web/app.js`, `web/index.html`
- Create: `web/storage.js`

**Interfaces:**
- Consumes: `data.rs` (Tasks 6-7), `Core.migrate`, `Core.emptyState`.
- Produces (Rust, зарегистрировать в `generate_handler!`): `load_data() -> LoadResult {status: "ok"|"none"|"broken", text: Option<String>}`; `save_data(text: String) -> Result<(), String>` (проверяет JSON, `atomic_write`, затем `ensure_daily_backup` и `prune_backups` с папкой из `effective_backup_dir`); `backup_status() -> {dir: String, fallback: bool}` (для предупреждения о недоступной папке); `restore_latest_backup() -> Result<String, String>` (последняя копия с валидным JSON записывается как `data.json` и возвращается); `get_backup_dir() -> String`; `choose_backup_dir() -> Result<Option<String>, String>` (диалог `rfd::AsyncFileDialog::pick_folder`, сохраняет в `settings.json`); `open_backup_dir() -> Result<(), String>` (`open` на macOS, `explorer` на Windows); `quit_app()`. Меню трея «Выйти» вместо `app.exit(0)` отправляет событие `before-quit`, если окно живо, и выходит сам через 1500 мс, если интерфейс не ответил `quit_app`.
- Produces (JS): `Storage.load(): Promise<{state: State, notice?: string}>`, `Storage.save(state: State): void` (задержка 300 мс, сериализованные записи, при ошибке `toast`), `Storage.flush(): Promise<void>`, `Storage.backupInfo(): Promise<{dir, fallback}|null>`.

- [ ] **Step 1: Implement Rust-команды** и обработку `before-quit`; `cargo check` без ошибок.
- [ ] **Step 2: Implement `web/storage.js`:** в Tauri `load` вызывает `load_data`; `none` берёт `budget.v1` из `localStorage` через `Core.migrate`, при отсутствии даёт `Core.emptyState`, затем немедленно сохраняет файл; `broken` возвращает сообщение и предлагает «Восстановить из копии» (вызов `restore_latest_backup`); вне Tauri всё через `localStorage` под тем же ключом `budget.v1`, но в формате v2.
- [ ] **Step 3: Подключить в `app.js`:** запуск приложения становится асинхронным (`init()` после `Storage.load()`), `save()` вызывает `Storage.save(S)`; обработчик `before-quit` вызывает `Storage.flush()` и `quit_app`; в меню «Данные» добавить «Папка копий» (выбор, `choose_backup_dir`) и «Открыть папку копий» (`open_backup_dir`), видимые только в Tauri; если `backupInfo().fallback`, показать уведомление «Выбранная папка недоступна. Копии идут в папку приложения».
- [ ] **Step 4: Verify** `node --check web/app.js web/storage.js`, `cargo check --manifest-path src-tauri/Cargo.toml`.
- [ ] **Step 5: Verify вручную** (`npx tauri build --bundles app`, запуск): добавить запись, закрыть через «Выйти» в трее, открыть снова, запись на месте; в папке данных приложения есть `data.json` и `backups/budget-<сегодня>.json`; обрезать `data.json` вручную до пустого файла и открыть приложение: видно сообщение и кнопка восстановления, рядом лежит `data.json.broken`; выбор своей папки копий создаёт там копию; несуществующая папка в `settings.json` даёт предупреждение и копию в папке по умолчанию.
- [ ] **Step 6: Commit** `feat: file storage, backups and storage layer`.

---

### Task 9: CI, документы, версия 1.2.0

**Files:**
- Modify: `.github/workflows/build.yml`, `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, `README.md`, `CHANGELOG.md`

**Interfaces:**
- Consumes: готовые тесты Tasks 1-7.

- [ ] **Step 1: Добавить задание `test`** в `build.yml` (ubuntu-latest: checkout, Node 20, Rust stable, `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev` (нужны, чтобы собрался Tauri для `cargo test`), `node --test tests/`, `cargo test --manifest-path src-tauri/Cargo.toml`); у задания `build` добавить `needs: test`.
- [ ] **Step 2: Обновить версии** до `1.2.0` в `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`, затем `npm install --package-lock-only` и `cargo update -p budget --offline` в `src-tauri`.
- [ ] **Step 3: Документы.** `CHANGELOG.md`: раздел `## 1.2.0 — <дата>` (данные в файле, автокопии за 30 дней с выбором папки, копейки, подготовка к счетам, защита от повреждённого файла). `README.md`: раздел «Где лежат данные» описывает `data.json`, папку копий и меню «Данные → Папка копий».
- [ ] **Step 4: Verify** `npm test` проходит локально (Node и Rust); запуск workflow вручную (`gh workflow run build.yml`) проходит на всех системах.
- [ ] **Step 5: Commit и push** `chore: release 1.2.0 prep`. Тег и релиз не создаются: их выпускает человек после проверки.
