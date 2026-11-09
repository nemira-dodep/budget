// Бюджет: нативные диалоги, напоминания с уведомлениями, значок в трее.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod data;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

#[derive(serde::Deserialize, Clone)]
struct Rem {
    id: u64,
    title: String,
    /// Локальное время срабатывания: "YYYY-MM-DDTHH:MM"
    at: String,
}

#[derive(Default)]
struct Store {
    list: Mutex<Vec<Rem>>,
    fired: Mutex<HashSet<String>>,
}

#[derive(serde::Serialize)]
struct Table {
    name: String,
    bytes: Vec<u8>,
}

/// Веб-интерфейс присылает актуальный список напоминаний.
#[tauri::command]
fn sync_reminders(store: tauri::State<Store>, list: Vec<Rem>) {
    *store.list.lock().unwrap() = list;
}

/// Диалог «Сохранить» (CSV, копия).
#[tauri::command]
async fn save_file(name: String, text: String) -> Result<bool, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .set_file_name(&name)
        .save_file()
        .await
    else {
        return Ok(false);
    };
    std::fs::write(handle.path(), text.as_bytes()).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Диалог «Открыть» для таблиц (.xlsx, .xls, .csv) и копий (.json).
#[tauri::command]
async fn open_table() -> Result<Option<Table>, String> {
    let Some(handle) = rfd::AsyncFileDialog::new()
        .add_filter("Таблицы и копии", &["xlsx", "xls", "csv", "json", "pdf"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let bytes = std::fs::read(handle.path()).map_err(|e| e.to_string())?;
    let name = handle.file_name();
    Ok(Some(Table { name, bytes }))
}

// ---- Данные: файл, копии, настройки ----

#[derive(serde::Serialize)]
struct LoadResult {
    status: &'static str,
    text: Option<String>,
}

#[derive(serde::Serialize)]
struct BackupStatus {
    dir: String,
    fallback: bool,
}

fn app_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn backup_dirs(app: &tauri::AppHandle) -> Result<(std::path::PathBuf, bool), String> {
    let base = app_dir(app)?;
    let settings = data::load_settings(&base.join("settings.json"));
    Ok(data::effective_backup_dir(&base.join("backups"), &settings))
}

/// Копия за сегодня (если её ещё нет) и очистка старых.
fn daily_backup(app: &tauri::AppHandle) {
    let Ok(base) = app_dir(app) else { return };
    let today = chrono::Local::now().date_naive();
    // Быстрый выход без проверки записи в папку: копия за сегодня уже лежит
    let settings = data::load_settings(&base.join("settings.json"));
    let quick = settings.backup_dir.as_ref().map(std::path::PathBuf::from).unwrap_or_else(|| base.join("backups"));
    if quick.join(data::backup_name(today)).exists() {
        return;
    }
    let Ok((dir, _)) = backup_dirs(app) else { return };
    if data::ensure_daily_backup(&base.join("data.json"), &dir, today).unwrap_or(false) {
        let _ = data::prune_backups(&dir, today, 30);
    }
}

#[tauri::command]
fn load_data(app: tauri::AppHandle) -> Result<LoadResult, String> {
    let base = app_dir(&app)?;
    let path = base.join("data.json");
    let (dir, _) = backup_dirs(&app)?;
    let dirs = vec![dir, base.join("backups")];
    match data::load_or_recover(&path, &dirs).map_err(|e| e.to_string())? {
        data::Loaded::None => Ok(LoadResult { status: "none", text: None }),
        data::Loaded::Broken => Ok(LoadResult { status: "broken", text: None }),
        data::Loaded::Ok(text) => {
            daily_backup(&app);
            Ok(LoadResult { status: "ok", text: Some(text) })
        }
    }
}

#[tauri::command]
fn save_data(app: tauri::AppHandle, text: String) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(&text).map_err(|_| "Данные не похожи на JSON".to_string())?;
    let path = app_dir(&app)?.join("data.json");
    data::atomic_write(&path, &text).map_err(|e| e.to_string())?;
    daily_backup(&app);
    Ok(())
}

#[tauri::command]
fn restore_latest_backup(app: tauri::AppHandle) -> Result<String, String> {
    let base = app_dir(&app)?;
    let (dir, _) = backup_dirs(&app)?;
    let mut dirs = vec![dir];
    dirs.push(base.join("backups"));
    data::restore_from_backup(&base.join("data.json"), &dirs, chrono::Local::now().date_naive())
}

#[tauri::command]
fn backup_status(app: tauri::AppHandle) -> Result<BackupStatus, String> {
    let (dir, fallback) = backup_dirs(&app)?;
    Ok(BackupStatus { dir: dir.to_string_lossy().into_owned(), fallback })
}

#[tauri::command]
async fn choose_backup_dir(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new().pick_folder().await else {
        return Ok(None);
    };
    if !data::writable_dir(folder.path()) {
        return Err("В эту папку нельзя записывать. Выберите другую".to_string());
    }
    let dir = folder.path().to_string_lossy().into_owned();
    let path = app_dir(&app)?.join("settings.json");
    let settings = data::Settings { backup_dir: Some(dir.clone()) };
    data::save_settings(&path, &settings).map_err(|e| e.to_string())?;
    daily_backup(&app);
    Ok(Some(dir))
}

#[tauri::command]
fn open_backup_dir(app: tauri::AppHandle) -> Result<(), String> {
    let (dir, _) = backup_dirs(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    };
    std::process::Command::new(opener).arg(&dir).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// Файл данных читается, но не подходит приложению: убрать его в сторону как data.json.broken.
#[tauri::command]
fn quarantine_data(app: tauri::AppHandle) -> Result<(), String> {
    data::quarantine(&app_dir(&app)?.join("data.json")).map_err(|e| e.to_string())
}

/// Интерфейс сохранил данные и просит закрыть приложение.
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Первый запрос на выход (Cmd+Q, «Выйти» в трее) просит интерфейс сохранить данные.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            sync_reminders, save_file, open_table,
            load_data, save_data, restore_latest_backup, backup_status,
            choose_backup_dir, open_backup_dir, quit_app, quarantine_data
        ])
        .setup(|app| {
            app.manage(Store::default());
            let _ = app.notification().request_permission();

            // Значок в трее: «Открыть» и «Выйти»
            let show = MenuItem::with_id(app, "show", "Открыть Бюджет", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            // Проверка напоминаний раз в 20 секунд
            let handle = app.handle().clone();
            std::thread::spawn(move || loop {
                std::thread::sleep(Duration::from_secs(20));
                let now = chrono::Local::now().format("%Y-%m-%dT%H:%M").to_string();
                let store = handle.state::<Store>();
                let due: Vec<Rem> = store
                    .list
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|r| r.at <= now)
                    .cloned()
                    .collect();
                for r in due {
                    let key = format!("{}|{}", r.id, r.at);
                    let is_new = store.fired.lock().unwrap().insert(key);
                    if is_new {
                        let _ = handle
                            .notification()
                            .builder()
                            .title("Напоминание")
                            .body(&r.title)
                            .show();
                        let _ = handle.emit("reminder-fired", r.id);
                    }
                }
            });
            Ok(())
        })
        // Закрытие окна прячет его: напоминания продолжают работать. Выход — через трей.
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("ошибка сборки приложения")
        .run(|app, event| {
            // Выход: сначала даём интерфейсу сохранить данные, сами выходим через 1,5 с, если он не ответил
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                if !QUITTING.swap(true, Ordering::SeqCst) {
                    api.prevent_exit();
                    let _ = app.emit("before-quit", ());
                    let handle = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(1500));
                        handle.exit(0);
                    });
                }
            }
            // macOS: клик по значку в Dock возвращает спрятанное окно
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
