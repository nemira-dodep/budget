const KEY = 'budget.v1';
const THEME_KEY = 'budget.theme';
const CATS = {
  in: ['Зарплата', 'Пенсия', 'Подработка', 'Подарок', 'Другое'],
  out: ['Еда', 'Транспорт', 'Жильё', 'Техника', 'Одежда', 'Подписки', 'Здоровье', 'Семья', 'Развлечения', 'Другое']
};
const $ = s => document.querySelector(s);
const fmt = n => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
const money = n => fmt(n) + ' ₽';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthKey = date => date.slice(0, 7);
const nextKey = key => {
  let [y, m] = key.split('-').map(Number);
  m++; if (m > 12) { m = 1; y++; }
  return `${y}-${pad(m)}`;
};
const daysIn = key => { const [y, m] = key.split('-').map(Number); return new Date(y, m, 0).getDate(); };
const monthName = key => {
  const [y, m] = key.split('-').map(Number);
  const s = new Date(y, m - 1, 1).toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' }).replace(' г.', '');
  return s[0].toUpperCase() + s.slice(1);
};

// Пустой бюджет для первого запуска
const SEED = {
  opening: 0,
  cur: localDate().slice(0, 7),
  months: [localDate().slice(0, 7)],
  limits: {},
  goals: [],
  reminders: [],
  items: []
};

// Безопасная работа с хранилищем (в приватном режиме может бросать ошибку)
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
};

let S = load();
const ui = { type: 'out', q: '', filter: 'all', view: 'month' };
let undo = null, toastTimer = null;

function load() {
  try {
    const s = JSON.parse(store.get(KEY));
    if (s && Array.isArray(s.items) && Array.isArray(s.months) && typeof s.opening === 'number') {
      s.limits = s.limits || {};
      s.goals = s.goals || [];
      s.reminders = s.reminders || [];
      return s;
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(SEED));
}
function save() { store.set(KEY, JSON.stringify(S)); syncReminders(); }
function ensureMonth(key) { if (!S.months.includes(key)) S.months.push(key); }

// Каждый месяц: начало = конец предыдущего, остаток считается по строкам.
function calc() {
  const months = [...new Set(S.months)].sort();
  let bal = S.opening;
  return months.map(key => {
    const items = S.items
      .filter(i => monthKey(i.date) === key)
      .sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.t - b.t);
    const opening = bal;
    let inc = 0, exp = 0;
    const rows = items.map(i => {
      if (i.type === 'in') { bal += i.amount; inc += i.amount; }
      else { bal -= i.amount; exp += i.amount; }
      return { ...i, balance: bal };
    });
    return { key, opening, inc, exp, closing: bal, rows };
  });
}

// Копирует записи с отметкой «каждый месяц» из одного месяца в другой.
function copyRecurring(from, to) {
  const list = S.items.filter(i => i.rep && monthKey(i.date) === from &&
    !S.items.some(x => x.src === i.id && monthKey(x.date) === to));
  const now = Date.now();
  list.forEach((i, k) => S.items.push({
    ...i, id: now + k, t: now + k, src: i.id,
    date: `${to}-${pad(Math.min(Number(i.date.slice(8)), daysIn(to)))}`
  }));
  return list.length;
}

function curve(m) {
  const pts = [m.opening, ...m.rows.map(r => r.balance)];
  if (pts.length < 2) return '<p class="empty">Здесь пока нет записей. Добавьте первую ниже.</p>';
  const W = 1000, H = 150, p = 8;
  const min = Math.min(0, ...pts), max = Math.max(...pts, 1), span = (max - min) || 1;
  const x = i => p + i * (W - 2 * p) / (pts.length - 1);
  const y = v => H - p - (v - min) / span * (H - 2 * p);
  const line = pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zero = y(0).toFixed(1);
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Остаток по записям за месяц">
    <line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--rule)" stroke-dasharray="4 6" vector-effect="non-scaling-stroke"/>
    <polygon points="${x(0).toFixed(1)},${zero} ${line} ${x(pts.length - 1).toFixed(1)},${zero}" fill="var(--line)" opacity=".14"/>
    <polyline points="${line}" fill="none" stroke="var(--line)" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}

function ledger(m) {
  const q = ui.q.trim().toLowerCase();
  const rows = m.rows.filter(r =>
    (ui.filter === 'all' || r.type === ui.filter) &&
    (!q || (r.title + ' ' + r.cat + ' ' + (r.note || '')).toLowerCase().includes(q)));
  if (!m.rows.length) return '<p class="empty">Пусто. Добавьте доход или расход формой выше.</p>';
  if (!rows.length) return '<p class="empty">Ничего не найдено.</p>';
  return rows.map(r => `
    <div class="row" data-id="${r.id}">
      <span class="date">${r.date.slice(8)}.${r.date.slice(5, 7)}</span>
      <button class="what" type="button" data-edit="${r.id}" aria-label="Изменить: ${esc(r.title)}">
        <span class="title">${esc(r.title)}${r.rep ? ' <span class="cat">· каждый месяц</span>' : ''}</span>
        <span class="cat">${esc(r.cat)}</span>
        ${r.note ? `<span class="note">${esc(r.note)}</span>` : ''}
      </button>
      <span class="amt ${r.type}">${r.type === 'in' ? '+' : '−'}${fmt(r.amount)}</span>
      <span class="run">${fmt(r.balance)}</span>
      <button class="del" type="button" data-del="${r.id}" aria-label="Удалить: ${esc(r.title)}">×</button>
    </div>`).join('');
}

function breakdown(m) {
  const block = (title, t, total) => {
    const g = {};
    m.rows.filter(r => r.type === t).forEach(r => g[r.cat] = (g[r.cat] || 0) + r.amount);
    // Категории с лимитом показываем, даже если трат ещё нет
    if (t === 'out') Object.keys(S.limits).forEach(c => { if (!(c in g)) g[c] = 0; });
    const list = Object.entries(g).sort((a, b) => b[1] - a[1]);
    if (!list.length) return `<section><h3>${title}</h3><p class="empty">Пусто</p></section>`;
    const max = Math.max(1, list[0][1]);
    return `<section><h3>${title}</h3>${list.map(([c, v]) => {
      const lim = t === 'out' ? S.limits[c] : 0;
      const over = lim && v > lim;
      const pct = lim ? v / lim * 100 : v / max * 100;
      const right = lim
        ? `${money(v)} <small class="${over ? 'over' : ''}">из ${fmt(lim)}</small>`
        : `${money(v)} <small>${Math.round(v / total * 100)}%</small>`;
      return `
      <div class="cat-row">
        <div class="cat-top"><span>${esc(c)}</span><span>${right}</span></div>
        <div class="bar"><i class="${t}${over ? ' over' : ''}" style="width:${Math.min(pct, 100).toFixed(1)}%"></i></div>
        ${t === 'out' ? `<div class="cat-act"><button class="link" type="button" data-limit="${esc(c)}">${lim ? 'изменить лимит' : 'задать лимит'}</button></div>` : ''}
      </div>`;
    }).join('')}</section>`;
  };
  const goals = S.goals.length
    ? S.goals.map(g => {
        const pct = g.target ? Math.min(g.saved / g.target * 100, 100) : 0;
        return `<div class="goal">
          <div class="cat-top"><span>${esc(g.name)}</span><span>${fmt(g.saved)} / ${fmt(g.target)} ₽</span></div>
          <div class="bar"><i class="in" style="width:${pct.toFixed(1)}%"></i></div>
          <div class="goal-act">
            <button class="link" type="button" data-goal-add="${g.id}">внести</button>
            <button class="link danger" type="button" data-goal-del="${g.id}">удалить</button>
          </div></div>`;
      }).join('')
    : '<p class="empty">Целей пока нет.</p>';
  return block('Расходы по категориям', 'out', m.exp || 1) +
         block('Доходы по источникам', 'in', m.inc || 1) +
         remindersHTML() +
         `<section><h3>Цели накопления</h3>${goals}<button class="ghost" type="button" id="newGoal">Новая цель</button></section>`;
}

function yearView(cal) {
  const tot = cal.reduce((a, m) => ({ inc: a.inc + m.inc, exp: a.exp + m.exp }), { inc: 0, exp: 0 });
  const maxExp = Math.max(1, ...cal.map(m => m.exp));
  const totNet = tot.inc - tot.exp;
  return `<div class="table-wrap"><table class="year">
    <thead><tr><th>Месяц</th><th>Доходы</th><th>Расходы</th><th>Итог</th><th>Остаток</th></tr></thead>
    <tbody>${cal.map(m => {
      const net = m.inc - m.exp;
      return `<tr data-month-go="${m.key}" tabindex="0" aria-label="Открыть ${monthName(m.key)}">
        <td>${monthName(m.key)}</td>
        <td class="in">+${fmt(m.inc)}</td>
        <td class="out">−${fmt(m.exp)}<div class="mini"><i style="width:${(m.exp / maxExp * 100).toFixed(1)}%"></i></div></td>
        <td class="${net >= 0 ? 'in' : 'out'}">${net >= 0 ? '+' : '−'}${fmt(Math.abs(net))}</td>
        <td class="gold">${fmt(m.closing)}</td></tr>`;
    }).join('')}</tbody>
    <tfoot><tr><td>Всего</td><td class="in">+${fmt(tot.inc)}</td><td class="out">−${fmt(tot.exp)}</td>
      <td class="${totNet >= 0 ? 'in' : 'out'}">${totNet >= 0 ? '+' : '−'}${fmt(Math.abs(totNet))}</td><td></td></tr></tfoot>
  </table></div>`;
}

function render() {
  const cal = calc();
  if (!cal.length) { S.months = [localDate().slice(0, 7)]; S.cur = S.months[0]; save(); return render(); }
  if (!cal.find(x => x.key === S.cur)) S.cur = cal[cal.length - 1].key;
  const m = cal.find(x => x.key === S.cur);
  const idx = cal.indexOf(m);
  const isFirst = idx === 0;
  const net = m.inc - m.exp;

  $('#months').innerHTML =
    cal.map(x => `<button class="month-btn" type="button" data-key="${x.key}" aria-current="${x.key === m.key}">
      <span>${monthName(x.key)}</span><small>${money(x.closing)}</small></button>`).join('') +
    `<button class="add-month" id="addMonth" type="button">+ Новый месяц</button>`;

  const inYear = ui.view === 'year';
  $('#monthView').hidden = inYear;
  $('#yearView').hidden = !inYear;
  $('#fab').hidden = inYear;
  document.querySelectorAll('[data-view]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === ui.view)));
  $('#title').textContent = inYear ? 'Все месяцы' : monthName(m.key);

  if (inYear) { $('#yearView').innerHTML = yearView(cal); return; }

  // Повторяющиеся записи из прошлого месяца, которых ещё нет в этом
  const prev = idx > 0 ? cal[idx - 1] : null;
  const pending = prev ? prev.rows.filter(r => r.rep && !m.rows.some(x => x.src === r.id)).length : 0;

  $('#hero').innerHTML = `
    <div>
      <p class="lbl">Остаток на конец месяца</p>
      <div class="big">${money(m.closing)}</div>
    </div>
    <dl class="stats">
      <div><dt>Начало месяца</dt>
        <dd>${money(m.opening)} ${isFirst ? '<button class="link" type="button" id="editOpening">изменить</button>' : ''}</dd></div>
      <div><dt>Доходы</dt><dd class="in">+${money(m.inc)}</dd></div>
      <div><dt>Расходы</dt><dd class="out">−${money(m.exp)}</dd></div>
      <div><dt>Итог за месяц</dt><dd class="${net >= 0 ? 'in' : 'out'}">${net >= 0 ? '+' : '−'}${money(Math.abs(net))}</dd></div>
    </dl>
    <div class="hero-foot">
      ${pending ? `<button class="ghost copy-rec" type="button" id="copyRec">Добавить повторяющиеся из прошлого месяца (${pending})</button>` : ''}
      ${cal.length > 1 ? `<button class="link danger" type="button" id="delMonth">Удалить месяц</button>` : ''}
    </div>`;

  $('#curve').innerHTML = curve(m);
  $('#ledger').innerHTML = ledger(m);
  $('#side').innerHTML = breakdown(m);
}

function fillCats(sel, type, value) {
  sel.innerHTML = CATS[type].map(c => `<option${c === value ? ' selected' : ''}>${esc(c)}</option>`).join('');
}
function syncSeg() {
  document.querySelectorAll('[data-type]').forEach(b =>
    b.setAttribute('aria-pressed', String(b.dataset.type === ui.type)));
  fillCats($('#quick select[name=cat]'), ui.type);
}

// ---- уведомления и отмена ----
function toast(msg, action) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? '<button type="button">Отменить</button>' : ''}`;
  if (action) el.querySelector('button').addEventListener('click', () => { el.remove(); action(); });
  document.body.appendChild(el);
  toastTimer = setTimeout(() => el.remove(), 6000);
}
function removeItem(id) {
  const idx = S.items.findIndex(i => i.id === id);
  if (idx < 0) return;
  const [it] = S.items.splice(idx, 1);
  save(); render();
  toast(`Удалено: ${it.title}`, () => {
    S.items.splice(Math.min(idx, S.items.length), 0, it);
    ensureMonth(monthKey(it.date)); save(); render();
  });
}

// ---- сохранение файлов: в браузере — загрузка, в десктопном приложении — диалог «Сохранить» ----
const tauriInvoke = (cmd, args) => window.__TAURI__?.core?.invoke(cmd, args);

function download(name, text, type) {
  if (window.__TAURI__) { tauriInvoke('save_file', { name, text }).catch(err => alert('Не удалось сохранить: ' + err)); return; }
  const a = document.createElement('a');
  const url = URL.createObjectURL(new Blob([text], { type }));
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- события ----
document.addEventListener('click', e => {
  const t = e.target;
  const hit = sel => t.closest(sel);

  if (hit('[data-view]')) { ui.view = hit('[data-view]').dataset.view; return render(); }
  const go = hit('[data-month-go]');
  if (go) { S.cur = go.dataset.monthGo; ui.view = 'month'; save(); return render(); }
  const mb = hit('[data-key]');
  if (mb) { S.cur = mb.dataset.key; save(); return render(); }

  if (hit('#addMonth')) {
    const cal = calc();
    const last = cal[cal.length - 1].key;
    const key = nextKey(last);
    ensureMonth(key); S.cur = key;
    const n = copyRecurring(last, key);
    save(); render();
    if (n) toast(`Добавлено повторяющихся записей: ${n}`);
    return;
  }
  if (hit('#copyRec')) {
    const cal = calc();
    const m = cal.find(x => x.key === S.cur);
    const idx = cal.indexOf(m);
    const n = copyRecurring(cal[idx - 1].key, m.key);
    save(); render();
    toast(`Добавлено: ${n}`);
    return;
  }
  if (hit('#delMonth')) {
    const key = S.cur;
    if (!confirm(`Удалить ${monthName(key)} со всеми записями? Это нельзя отменить.`)) return;
    S.months = S.months.filter(k => k !== key);
    S.items = S.items.filter(i => monthKey(i.date) !== key);
    S.cur = [...S.months].sort().pop();
    save(); return render();
  }
  if (hit('#editOpening')) {
    const v = prompt('Остаток на начало первого месяца, ₽', S.opening);
    if (v !== null && v.trim() !== '' && !isNaN(Number(v))) { S.opening = Number(v); save(); render(); }
    return;
  }
  const seg = hit('[data-type]');
  if (seg) { ui.type = seg.dataset.type; syncSeg(); return; }

  const del = hit('[data-del]');
  if (del) return removeItem(Number(del.dataset.del));

  const edit = hit('[data-edit]');
  if (edit) return openEdit(Number(edit.dataset.edit));

  const lim = hit('[data-limit]');
  if (lim) {
    const c = lim.dataset.limit;
    const v = prompt(`Лимит на «${c}» в месяц, ₽ (0 — убрать)`, S.limits[c] || '');
    if (v === null) return;
    const n = Number(v.replace(/\s/g, ''));
    if (isNaN(n) || v.trim() === '') return;
    if (n > 0) S.limits[c] = n; else delete S.limits[c];
    save(); return render();
  }

  if (hit('#newGoal')) {
    const name = prompt('Название цели (например, «Новый ноутбук»)');
    if (!name || !name.trim()) return;
    const target = Number(String(prompt('Сумма цели, ₽') || '').replace(/\s/g, ''));
    if (!(target > 0)) return;
    const now = Date.now();
    S.goals.push({ id: now, name: name.trim(), target, saved: 0 });
    save(); return render();
  }
  const ga = hit('[data-goal-add]');
  if (ga) {
    const g = S.goals.find(x => x.id === Number(ga.dataset.goalAdd));
    if (!g) return;
    const n = Number(String(prompt(`Сколько отложить в «${g.name}», ₽`) || '').replace(/\s/g, ''));
    if (n > 0) { g.saved += n; save(); render(); }
    return;
  }
  const gd = hit('[data-goal-del]');
  if (gd) {
    const g = S.goals.find(x => x.id === Number(gd.dataset.goalDel));
    if (g && confirm(`Удалить цель «${g.name}»?`)) { S.goals = S.goals.filter(x => x !== g); save(); render(); }
    return;
  }

  const rd = hit('[data-rem-done]');
  if (rd) return reminderDone(Number(rd.dataset.remDone));
  const rdel = hit('[data-rem-del]');
  if (rdel) { S.reminders = S.reminders.filter(r => r.id !== Number(rdel.dataset.remDel)); save(); return render(); }
  if (hit('#importTable')) return openImport();

  if (hit('#theme')) return toggleTheme();
  if (hit('#fab')) { $('#quick [name=amount]').scrollIntoView({ block: 'center' }); $('#quick [name=amount]').focus(); return; }
});

document.addEventListener('keydown', e => {
  const typing = e.target.matches?.('input,select,textarea,[contenteditable]');
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault(); $('#q').focus(); $('#q').select(); return;
  }
  if (e.key === 'Enter' && e.target.matches?.('[data-month-go]')) { e.target.click(); return; }
  if (typing || $('#dlg').open || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'n' || e.key === 'N') {
    if (ui.view === 'year') return;
    e.preventDefault(); $('#quick [name=amount]').focus();
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const cal = calc();
    const i = cal.findIndex(x => x.key === S.cur) + (e.key === 'ArrowLeft' ? -1 : 1);
    if (i >= 0 && i < cal.length) { S.cur = cal[i].key; save(); render(); }
  }
});

let qTimer = null;
$('#q').addEventListener('input', e => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { ui.q = e.target.value; render(); }, 120);
});
$('#filter').addEventListener('change', e => { ui.filter = e.target.value; render(); });

$('#quick').addEventListener('submit', e => {
  e.preventDefault();
  const f = e.target;
  const amount = Number(f.amount.value);
  if (!(amount > 0)) return f.amount.focus();
  const date = f.date.value || localDate();
  const now = Date.now();
  S.items.push({ id: now, t: now, type: ui.type, date, title: f.title.value.trim(), cat: f.cat.value, amount, rep: f.rep.checked });
  ensureMonth(monthKey(date));
  S.cur = monthKey(date);
  save();
  f.amount.value = '';
  f.title.value = '';
  f.rep.checked = false;
  render();
  f.amount.focus();
});

// Диалог редактирования
let editingId = null;
const dlg = $('#dlg'), ef = $('#editForm');
function openEdit(id) {
  const it = S.items.find(i => i.id === id);
  if (!it) return;
  editingId = id;
  ef.type.value = it.type;
  ef.amount.value = it.amount;
  ef.title.value = it.title;
  ef.date.value = it.date;
  ef.note.value = it.note || '';
  ef.rep.checked = !!it.rep;
  fillCats($('#eCat'), it.type, it.cat);
  dlg.showModal();
  ef.title.focus();
}
ef.type.addEventListener('change', () => fillCats($('#eCat'), ef.type.value));
ef.addEventListener('submit', e => {
  e.preventDefault();
  const it = S.items.find(i => i.id === editingId);
  if (!it) return dlg.close();
  it.type = ef.type.value;
  it.amount = Number(ef.amount.value);
  it.title = ef.title.value.trim();
  it.cat = $('#eCat').value;
  it.date = ef.date.value;
  it.note = ef.note.value.trim();
  it.rep = ef.rep.checked;
  ensureMonth(monthKey(it.date));
  S.cur = monthKey(it.date);
  save(); dlg.close(); render();
});
$('#dlgCancel').addEventListener('click', () => dlg.close());
$('#dlgDelete').addEventListener('click', () => {
  const id = editingId;
  dlg.close();
  removeItem(id);
});

// Экспорт / копия / восстановление
$('#exportCsv').addEventListener('click', () => {
  const rows = [['Месяц', 'Дата', 'Тип', 'Категория', 'Описание', 'Заметка', 'Сумма', 'Остаток']];
  calc().forEach(m => m.rows.forEach(r =>
    rows.push([m.key, r.date, r.type === 'in' ? 'Доход' : 'Расход', r.cat, r.title, r.note || '', r.amount, r.balance])));
  const text = '﻿' + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download('budget.csv', text, 'text/csv;charset=utf-8');
});
$('#backup').addEventListener('click', () =>
  download(`budget-${localDate()}.json`, JSON.stringify(S, null, 2), 'application/json'));
$('#restore').addEventListener('click', () => window.__TAURI__ ? openImport() : $('#file').click());
$('#file').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    importText(await f.text());
    toast('Данные восстановлены из копии');
  } catch (err) {
    alert('Этот файл не похож на копию бюджета.');
  }
});
function importText(text) {
  const s = JSON.parse(text);
  if (!Array.isArray(s.items) || !Array.isArray(s.months) || typeof s.opening !== 'number') throw new Error('bad');
  S = s;
  S.limits = S.limits || {};
  S.goals = S.goals || [];
  S.reminders = S.reminders || [];
  if (!S.months.includes(S.cur)) S.cur = [...S.months].sort().pop();
  save(); render();
}

// Тема
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('#theme').textContent = t === 'light' ? 'Тёмная тема' : 'Светлая тема';
}
function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  store.set(THEME_KEY, next);
  applyTheme(next);
}

// ---- напоминания ----
const nowAt = () => { const d = new Date(); return `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtAt = at => `${at.slice(8, 10)}.${at.slice(5, 7)}.${at.slice(0, 4)} ${at.slice(11, 16)}`;
function addMonthsAt(at, n) {
  const [date, time] = at.split('T');
  let [y, m, d] = date.split('-').map(Number);
  m += n;
  while (m > 12) { m -= 12; y++; }
  while (m < 1) { m += 12; y--; }
  return `${y}-${pad(m)}-${pad(Math.min(d, new Date(y, m, 0).getDate()))}T${time}`;
}
// Напоминание сработало: «каждый месяц» переносим на следующий срок, разовое — убираем
function reminderDone(id) {
  const r = S.reminders.find(x => x.id === id);
  if (!r) return;
  if (r.repeat === 'monthly') {
    let at = r.at;
    do { at = addMonthsAt(at, 1); } while (at <= nowAt());
    r.at = at;
  } else {
    S.reminders = S.reminders.filter(x => x !== r);
  }
  save(); render();
}
function syncReminders() {
  if (!window.__TAURI__) return;
  tauriInvoke('sync_reminders', { list: S.reminders.map(r => ({ id: r.id, title: r.title, at: r.at })) }).catch(() => {});
}
const firedWeb = new Set();
function checkWeb() {
  if (window.__TAURI__) return; // в десктопном приложении уведомления шлёт Rust
  const now = nowAt();
  [...S.reminders].forEach(r => {
    const key = r.id + '|' + r.at;
    if (r.at <= now && !firedWeb.has(key)) {
      firedWeb.add(key);
      if ('Notification' in window && Notification.permission === 'granted') new Notification('Напоминание', { body: r.title });
      toast('Напоминание: ' + r.title);
      reminderDone(r.id);
    }
  });
}
function remindersHTML() {
  const list = [...S.reminders].sort((a, b) => a.at < b.at ? -1 : 1);
  const rows = list.length ? list.map(r => `
    <div class="rem-row">
      <div><div>${esc(r.title)}</div>
        <div class="meta">${fmtAt(r.at)}${r.repeat === 'monthly' ? ' · каждый месяц' : ''}</div></div>
      <div class="acts">
        <button class="link" type="button" data-rem-done="${r.id}">готово</button>
        <button class="link danger" type="button" data-rem-del="${r.id}">удалить</button>
      </div></div>`).join('') : '<p class="empty">Напоминаний нет.</p>';
  return `<section><h3>Напоминания</h3>${rows}
    <form class="rem-form" id="remForm" autocomplete="off">
      <input name="title" placeholder="Что напомнить, например «Оплатить интернет»" aria-label="Текст напоминания" required>
      <div class="row2">
        <input name="date" type="date" value="${localDate()}" aria-label="Дата" required>
        <input name="time" type="time" value="09:00" aria-label="Время" required>
      </div>
      <select name="repeat" aria-label="Повтор"><option value="none">Один раз</option><option value="monthly">Каждый месяц</option></select>
      <button class="ghost" type="submit">Добавить напоминание</button>
    </form></section>`;
}
document.addEventListener('submit', e => {
  if (e.target.id !== 'remForm') return;
  e.preventDefault();
  const f = e.target;
  const title = f.title.value.trim();
  if (!title || !f.date.value) return;
  S.reminders.push({ id: Date.now(), title, at: `${f.date.value}T${f.time.value || '09:00'}`, repeat: f.repeat.value });
  save(); render();
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  toast('Напоминание добавлено');
});

// ---- импорт таблиц ----
const MONTH_WORDS = ['январ', 'феврал', 'март', 'апрел', 'май', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
const MONTH_NUM = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
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
const toNum = v => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
};
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
  return idx < 0 ? null : { num: MONTH_NUM[idx], year: m[2] ? Number(m[2]) : null };
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
// Разбирает первый лист таблицы: строки-месяцы, шапка «доход/расход», строки записей.
function parseSheet(rows) {
  const items = [], months = new Set();
  let ctx = null, map = null, lastDay = 1, opening = null;
  const defYear = Number(S.cur.slice(0, 4));
  let seq = Date.now();
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
      if (opening === null && num !== undefined && items.length === 0) opening = num;
      continue;
    }
    if (!map) continue;
    const sides = [
      { type: 'in', amount: toNum(row[map.incAmt]), col: map.incTitle },
      { type: 'out', amount: toNum(row[map.expAmt]), col: map.expTitle }
    ];
    for (const s of sides) {
      if (!(s.amount > 0)) continue;
      const title = (s.col >= 0 ? String(row[s.col] ?? '').trim() : '') || (s.type === 'in' ? 'Доход' : 'Расход');
      let date = map.date >= 0 ? parseDate(row[map.date]) : null;
      const tm = title.match(/(\d{1,2})[.\-](\d{1,2})(?!\d)/);
      if (!date && tm && ctx && Number(tm[2]) === Number(ctx.slice(5, 7))) date = `${ctx}-${pad(tm[1])}`;
      if (!date) date = `${ctx || S.cur}-${pad(lastDay)}`;
      else lastDay = Number(date.slice(8, 10));
      months.add(monthKey(date));
      seq++;
      items.push({ id: seq, t: seq, type: s.type, date, title, cat: guessCat(s.type, title), amount: s.amount });
    }
  }
  return { items, months: [...months].sort(), opening };
}
let xlsxPromise = null;
// Библиотека таблиц тяжёлая (~870 КБ): грузим только при первом импорте
function loadXlsx() {
  if (window.XLSX) return Promise.resolve();
  xlsxPromise = xlsxPromise || new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = ok;
    s.onerror = () => { xlsxPromise = null; fail(new Error('Не удалось загрузить модуль таблиц')); };
    document.head.appendChild(s);
  });
  return xlsxPromise;
}
let pendingImport = null;
function openImport() {
  pendingImport = null;
  $('#impBox').innerHTML = '<p class="empty" style="padding:0">Файл ещё не выбран.</p>';
  $('#impGo').disabled = true;
  $('#impDlg').showModal();
}
async function pickImport() {
  if (window.__TAURI__) {
    const res = await tauriInvoke('open_table');
    if (res) await handleImportFile(res.name, new Uint8Array(res.bytes));
  } else {
    $('#impFile').click();
  }
}
async function handleImportFile(name, bytes) {
  try {
    if (/\.json$/i.test(name)) {
      const text = new TextDecoder().decode(bytes);
      const s = JSON.parse(text);
      if (!Array.isArray(s.items)) throw new Error('Это не копия бюджета.');
      pendingImport = { json: text };
      showImportPreview(`Копия бюджета: записей ${s.items.length}, месяцев ${s.months.length}. Текущие данные будут заменены.`, []);
      return;
    }
    await loadXlsx();
    const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
    const res = parseSheet(rows);
    if (!res.items.length) throw new Error('Не нашёл записей. Проверьте, что в таблице есть колонки «доход» и «расход».');
    pendingImport = res;
    showImportPreview(null, res.items);
  } catch (err) {
    pendingImport = null;
    $('#impGo').disabled = true;
    $('#impBox').innerHTML = `<p class="empty" style="padding:0">${esc(err.message || 'Не удалось прочитать файл')}</p>`;
  }
}
function showImportPreview(summary, items) {
  const existing = new Set(S.items.map(i => `${i.date}|${i.type}|${i.title}|${i.amount}`));
  const dups = items.filter(i => existing.has(`${i.date}|${i.type}|${i.title}|${i.amount}`)).length;
  const inc = items.filter(i => i.type === 'in').reduce((a, i) => a + i.amount, 0);
  const out = items.filter(i => i.type === 'out').reduce((a, i) => a + i.amount, 0);
  const head = summary || `Найдено записей: ${items.length} (доходы ${money(inc)}, расходы ${money(out)}). ` +
    (dups ? `Уже есть и будут пропущены: ${dups}. ` : '') +
    (pendingImport && pendingImport.opening != null ? `Начальный остаток из таблицы: ${money(pendingImport.opening)}.` : '');
  const table = items.length ? `<div class="imp-preview"><table>${items.slice(0, 40).map(i =>
    `<tr><td>${i.date.slice(8)}.${i.date.slice(5, 7)}</td><td>${i.type === 'in' ? 'доход' : 'расход'}</td>
     <td>${esc(i.title)}</td><td>${esc(i.cat)}</td><td class="num">${i.type === 'in' ? '+' : '−'}${fmt(i.amount)}</td></tr>`).join('')}</table></div>` +
     (items.length > 40 ? `<p class="empty" style="padding:0">Показаны первые 40 из ${items.length}.</p>` : '') : '';
  $('#impBox').innerHTML = `<p style="margin:0">${esc(head)}</p>${table}`;
  $('#impGo').disabled = false;
}
function doImport() {
  if (!pendingImport) return;
  if (pendingImport.json) {
    importText(pendingImport.json);
    $('#impDlg').close();
    toast('Копия восстановлена');
    return;
  }
  const existing = new Set(S.items.map(i => `${i.date}|${i.type}|${i.title}|${i.amount}`));
  const now = Date.now();
  let added = 0, skipped = 0;
  pendingImport.items.forEach((it, k) => {
    const key = `${it.date}|${it.type}|${it.title}|${it.amount}`;
    if (existing.has(key)) { skipped++; return; }
    existing.add(key);
    S.items.push({ ...it, id: now + k, t: now + k });
    ensureMonth(monthKey(it.date));
    added++;
  });
  if (pendingImport.opening != null) S.opening = pendingImport.opening;
  if (pendingImport.months.length) S.cur = pendingImport.months[0];
  save(); render();
  $('#impDlg').close();
  toast(`Импортировано: ${added}` + (skipped ? `, пропущено дублей: ${skipped}` : ''));
}
$('#impPick').addEventListener('click', pickImport);
$('#impFile').addEventListener('change', async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) handleImportFile(f.name, new Uint8Array(await f.arrayBuffer()));
});
$('#impGo').addEventListener('click', doImport);
$('#impCancel').addEventListener('click', () => $('#impDlg').close());

// ---- уведомления из приложения ----
if (window.__TAURI__?.event) window.__TAURI__.event.listen('reminder-fired', e => reminderDone(e.payload));

// init
const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
if (!isMac) {
  document.querySelectorAll('kbd, #q').forEach(el => {
    if (el.tagName === 'KBD') el.textContent = el.textContent.replace('⌘', 'Ctrl+');
    else el.placeholder = el.placeholder.replace('⌘', 'Ctrl+');
  });
}
applyTheme(store.get(THEME_KEY) || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('#quick [name=date]').value = localDate();
syncSeg();
render();
syncReminders();
checkWeb();
setInterval(checkWeb, 30000);
