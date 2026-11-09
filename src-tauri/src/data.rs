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
