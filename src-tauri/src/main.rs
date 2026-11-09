// Бюджет: нативные диалоги, напоминания с уведомлениями, значок в трее.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashSet;
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
        .add_filter("Таблицы и копии", &["xlsx", "xls", "csv", "json"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let bytes = std::fs::read(handle.path()).map_err(|e| e.to_string())?;
    let name = handle.file_name();
    Ok(Some(Table { name, bytes }))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![sync_reminders, save_file, open_table])
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
