//! Файл данных, автокопии и настройки.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// Результат чтения файла данных.
pub enum Loaded {
    /// Файла нет (первый запуск).
    None,
    /// Файл прочитан и является корректным JSON.
    Ok(String),
    /// Файл повреждён: он переименован в `<имя>.broken`, ничего не стёрто.
    Broken,
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(suffix);
    path.with_file_name(name)
}

/// Пишет файл целиком или не пишет совсем: временный файл рядом, затем переименование.
pub fn atomic_write(path: &Path, text: &str) -> io::Result<()> {
    let tmp = sibling(path, ".tmp");
    let res = (|| {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(text.as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

/// Читает файл данных. Пустой или не JSON файл не трогается, а переименовывается в `.broken`.
pub fn load_data_file(path: &Path) -> io::Result<Loaded> {
    let bytes = match fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Loaded::None),
        Err(e) => return Err(e),
    };
    let valid = String::from_utf8(bytes)
        .ok()
        .filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok());
    match valid {
        Some(text) => Ok(Loaded::Ok(text)),
        None => {
            let broken = sibling(path, ".broken");
            let _ = fs::remove_file(&broken);
            fs::rename(path, &broken)?;
            Ok(Loaded::Broken)
        }
    }
}

// ---- Автокопии ----

const BACKUP_PREFIX: &str = "budget-";
const BACKUP_SUFFIX: &str = ".json";

fn backup_date(name: &str) -> Option<chrono::NaiveDate> {
    let core = name.strip_prefix(BACKUP_PREFIX)?.strip_suffix(BACKUP_SUFFIX)?;
    chrono::NaiveDate::parse_from_str(core, "%Y-%m-%d").ok()
}

/// Копия `data.json` за сегодня; `true`, если создана. Если копия за день есть, ничего не делает.
pub fn ensure_daily_backup(data: &Path, dir: &Path, today: chrono::NaiveDate) -> io::Result<bool> {
    fs::create_dir_all(dir)?;
    let target = dir.join(format!("{}{}{}", BACKUP_PREFIX, today.format("%Y-%m-%d"), BACKUP_SUFFIX));
    if target.exists() {
        return Ok(false);
    }
    let text = fs::read_to_string(data)?;
    atomic_write(&target, &text)?;
    Ok(true)
}

/// Удаляет копии старше `keep_days` дней. Трогает только файлы вида `budget-ГГГГ-ММ-ДД.json`.
pub fn prune_backups(dir: &Path, today: chrono::NaiveDate, keep_days: i64) -> io::Result<usize> {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e),
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(date) = backup_date(&name) {
            if (today - date).num_days() > keep_days && fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

// ---- Настройки ----

#[derive(serde::Serialize, serde::Deserialize, Default, Debug, PartialEq, Clone)]
pub struct Settings {
    pub backup_dir: Option<String>,
}

pub fn load_settings(path: &Path) -> Settings {
    fs::read_to_string(path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

pub fn save_settings(path: &Path, s: &Settings) -> io::Result<()> {
    let text = serde_json::to_string_pretty(s).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    atomic_write(path, &text)
}

fn writable_dir(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".budget-write-test");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

/// Папка копий: выбранная, если она доступна, иначе папка по умолчанию.
/// Второй элемент `true`, если пришлось вернуться к папке по умолчанию.
pub fn effective_backup_dir(default: &Path, s: &Settings) -> (PathBuf, bool) {
    match &s.backup_dir {
        Some(dir) if writable_dir(Path::new(dir)) => (PathBuf::from(dir), false),
        Some(_) => (default.to_path_buf(), true),
        None => (default.to_path_buf(), false),
    }
}

// ---- Восстановление ----

/// Текст самой свежей копии с корректным JSON в папке (файлы не вида `budget-ГГГГ-ММ-ДД.json` пропускаются).
pub fn latest_valid_backup(dir: &Path) -> Option<String> {
    let mut found: Vec<(chrono::NaiveDate, PathBuf)> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| backup_date(&e.file_name().to_string_lossy()).map(|d| (d, e.path())))
        .collect();
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().find_map(|(_, p)| {
        fs::read_to_string(p)
            .ok()
            .filter(|t| serde_json::from_str::<serde_json::Value>(t).is_ok())
    })
}

/// Ставит `data.json` из последней рабочей копии в списке папок. Старый файл, если он есть,
/// остаётся рядом как `data.json.broken`. Без копий возвращает ошибку и ничего не меняет.
pub fn restore_from_backup(data: &Path, dirs: &[PathBuf]) -> Result<String, String> {
    let text = dirs
        .iter()
        .find_map(|d| latest_valid_backup(d))
        .ok_or_else(|| "Копий не найдено".to_string())?;
    if data.exists() {
        let broken = sibling(data, ".broken");
        let _ = fs::remove_file(&broken);
        fs::rename(data, &broken).map_err(|e| e.to_string())?;
    }
    atomic_write(data, &text).map_err(|e| e.to_string())?;
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_creates_file_without_tmp() {
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        atomic_write(&p, "{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "{\"a\":1}");
        let names: Vec<_> = fs::read_dir(d.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names, vec![std::ffi::OsString::from("data.json")]);
    }

    #[test]
    fn atomic_write_replaces_content() {
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        atomic_write(&p, "{\"v\":1}").unwrap();
        atomic_write(&p, "{\"v\":2}").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "{\"v\":2}");
    }

    #[test]
    fn atomic_write_to_missing_dir_fails() {
        let d = tempdir().unwrap();
        let p = d.path().join("nope").join("data.json");
        assert!(atomic_write(&p, "{}").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn atomic_write_failure_keeps_old_file() {
        use std::os::unix::fs::PermissionsExt;
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        atomic_write(&p, "{\"old\":true}").unwrap();
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o555)).unwrap();
        let res = atomic_write(&p, "{\"new\":true}");
        fs::set_permissions(d.path(), fs::Permissions::from_mode(0o755)).unwrap();
        if res.is_err() {
            assert_eq!(fs::read_to_string(&p).unwrap(), "{\"old\":true}");
        }
    }

    #[test]
    fn load_missing_is_none() {
        let d = tempdir().unwrap();
        assert!(matches!(load_data_file(&d.path().join("data.json")).unwrap(), Loaded::None));
    }

    #[test]
    fn load_valid_returns_text() {
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        fs::write(&p, "{\"version\":2}").unwrap();
        match load_data_file(&p).unwrap() {
            Loaded::Ok(t) => assert_eq!(t, "{\"version\":2}"),
            _ => panic!("expected Ok"),
        }
    }

    #[test]
    fn load_empty_is_broken_and_kept() {
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        fs::write(&p, "").unwrap();
        assert!(matches!(load_data_file(&p).unwrap(), Loaded::Broken));
        assert!(!p.exists());
        assert_eq!(fs::read_to_string(d.path().join("data.json.broken")).unwrap(), "");
    }

    #[test]
    fn load_truncated_is_broken_and_kept() {
        let d = tempdir().unwrap();
        let p = d.path().join("data.json");
        fs::write(&p, "{\"a\":").unwrap();
        assert!(matches!(load_data_file(&p).unwrap(), Loaded::Broken));
        assert!(!p.exists());
        assert_eq!(fs::read_to_string(d.path().join("data.json.broken")).unwrap(), "{\"a\":");
    }
}

#[cfg(test)]
mod backup_tests {
    use super::*;
    use chrono::NaiveDate;
    use std::fs;
    use tempfile::tempdir;

    fn day(y: i32, m: u32, d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, d).unwrap()
    }

    #[test]
    fn daily_backup_created_once_per_day() {
        let d = tempdir().unwrap();
        let data = d.path().join("data.json");
        fs::write(&data, "{\"v\":1}").unwrap();
        let dir = d.path().join("backups");
        assert!(ensure_daily_backup(&data, &dir, day(2026, 11, 9)).unwrap());
        let copy = dir.join("budget-2026-11-09.json");
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{\"v\":1}");
        fs::write(&data, "{\"v\":2}").unwrap();
        assert!(!ensure_daily_backup(&data, &dir, day(2026, 11, 9)).unwrap());
        assert_eq!(fs::read_to_string(&copy).unwrap(), "{\"v\":1}");
        assert!(ensure_daily_backup(&data, &dir, day(2026, 11, 10)).unwrap());
    }

    #[test]
    fn prune_removes_only_old_backups() {
        let d = tempdir().unwrap();
        for n in ["budget-2026-09-01.json", "budget-2026-10-20.json", "notes.txt", "budget-abc.json"] {
            fs::write(d.path().join(n), "x").unwrap();
        }
        let removed = prune_backups(d.path(), day(2026, 11, 9), 30).unwrap();
        assert_eq!(removed, 1);
        assert!(!d.path().join("budget-2026-09-01.json").exists());
        assert!(d.path().join("budget-2026-10-20.json").exists());
        assert!(d.path().join("notes.txt").exists());
        assert!(d.path().join("budget-abc.json").exists());
    }

    #[test]
    fn prune_missing_dir_is_ok() {
        let d = tempdir().unwrap();
        assert_eq!(prune_backups(&d.path().join("none"), day(2026, 11, 9), 30).unwrap(), 0);
    }

    #[test]
    fn settings_roundtrip_and_defaults() {
        let d = tempdir().unwrap();
        let p = d.path().join("settings.json");
        assert_eq!(load_settings(&p), Settings::default());
        fs::write(&p, "not json").unwrap();
        assert_eq!(load_settings(&p), Settings::default());
        let s = Settings { backup_dir: Some("/tmp/x".into()) };
        save_settings(&p, &s).unwrap();
        assert_eq!(load_settings(&p), s);
    }

    #[test]
    fn effective_dir_default_when_not_set() {
        let d = tempdir().unwrap();
        let (dir, fb) = effective_backup_dir(d.path(), &Settings::default());
        assert_eq!(dir, d.path());
        assert!(!fb);
    }

    #[test]
    fn effective_dir_uses_chosen_folder() {
        let d = tempdir().unwrap();
        let chosen = d.path().join("mine");
        let s = Settings { backup_dir: Some(chosen.to_string_lossy().into()) };
        let (dir, fb) = effective_backup_dir(&d.path().join("default"), &s);
        assert_eq!(dir, chosen);
        assert!(!fb);
    }

    #[test]
    fn effective_dir_falls_back_when_unavailable() {
        let d = tempdir().unwrap();
        let file = d.path().join("plain-file");
        fs::write(&file, "x").unwrap();
        let s = Settings { backup_dir: Some(file.join("sub").to_string_lossy().into()) };
        let default = d.path().join("default");
        let (dir, fb) = effective_backup_dir(&default, &s);
        assert_eq!(dir, default);
        assert!(fb);
    }
}

#[cfg(test)]
mod restore_tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn latest_valid_backup_skips_broken_and_foreign_files() {
        let d = tempdir().unwrap();
        fs::write(d.path().join("budget-2026-11-01.json"), "{\"v\":1}").unwrap();
        fs::write(d.path().join("budget-2026-11-05.json"), "{\"v\":5}").unwrap();
        fs::write(d.path().join("budget-2026-11-09.json"), "{\"v\":").unwrap();
        fs::write(d.path().join("budget-zzz.json"), "{\"v\":99}").unwrap();
        assert_eq!(latest_valid_backup(d.path()).unwrap(), "{\"v\":5}");
    }

    #[test]
    fn latest_valid_backup_none_when_empty_or_missing() {
        let d = tempdir().unwrap();
        assert!(latest_valid_backup(d.path()).is_none());
        assert!(latest_valid_backup(&d.path().join("none")).is_none());
    }

    #[test]
    fn restore_keeps_existing_file_as_broken() {
        let d = tempdir().unwrap();
        let data = d.path().join("data.json");
        fs::write(&data, "{\"bad\":").unwrap();
        let bk = d.path().join("backups");
        fs::create_dir_all(&bk).unwrap();
        fs::write(bk.join("budget-2026-11-05.json"), "{\"v\":5}").unwrap();
        assert_eq!(restore_from_backup(&data, &[bk]).unwrap(), "{\"v\":5}");
        assert_eq!(fs::read_to_string(&data).unwrap(), "{\"v\":5}");
        assert_eq!(fs::read_to_string(d.path().join("data.json.broken")).unwrap(), "{\"bad\":");
    }

    #[test]
    fn restore_without_backups_is_error_and_keeps_file() {
        let d = tempdir().unwrap();
        let data = d.path().join("data.json");
        fs::write(&data, "{\"keep\":1}").unwrap();
        assert!(restore_from_backup(&data, &[d.path().join("none")]).is_err());
        assert_eq!(fs::read_to_string(&data).unwrap(), "{\"keep\":1}");
    }
}
