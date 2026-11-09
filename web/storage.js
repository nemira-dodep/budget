// Хранение данных: файл через Tauri в приложении, localStorage в браузере.
// Старый ключ budget.v1 только читается и никогда не перезаписывается.
const Storage = (() => {
  const KEY = 'budget.v2', LEGACY = 'budget.v1', DELAY = 300;
  const T = () => window.__TAURI__;
  const invoke = (cmd, args) => T().core.invoke(cmd, args);
  const ls = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  let timer = null, pending = null, chain = Promise.resolve();
  const api = { onError: () => {} };

  const fromLocal = () => {
    const raw = ls.get(KEY) || ls.get(LEGACY);
    if (!raw) return null;
    try { return Core.migrate(JSON.parse(raw)); } catch (e) { return null; }
  };

  // → { state } | { broken: true } | { newer: true }
  api.load = async todayKey => {
    if (!T()) return { state: fromLocal() || Core.emptyState(todayKey) };
    const r = await invoke('load_data');
    if (r.status === 'ok') {
      try { return { state: Core.migrate(JSON.parse(r.text)) }; } catch (e) {
        if (/newer version/.test(String(e.message))) return { newer: true };
        await invoke('quarantine_data');   // файл читается, но не подходит: убрать в сторону, не затирать
        return { broken: true };
      }
    }
    if (r.status === 'broken') return { broken: true };
    // первый запуск файла: переносим данные из старого хранилища окна
    const state = fromLocal() || Core.emptyState(todayKey);
    await invoke('save_data', { text: JSON.stringify(state) });
    return { state };
  };

  const write = () => {
    if (!pending) return;
    const text = JSON.stringify(pending);
    pending = null;
    if (!T()) { ls.set(KEY, text); return; }
    chain = chain.then(() => invoke('save_data', { text })).catch(e => api.onError(e));
  };
  api.save = state => {
    pending = state;
    clearTimeout(timer);
    if (!T()) return write();
    timer = setTimeout(write, DELAY);
  };
  api.flush = () => { clearTimeout(timer); write(); return chain; };
  api.backupInfo = () => T() ? invoke('backup_status').catch(() => null) : Promise.resolve(null);
  return api;
})();
