use std::{fs, path::{Path, PathBuf}};

fn has_library(profile: &Path) -> Result<bool, String> {
    let settings = profile.join("desktop.json");
    let config: serde_json::Value = if settings.exists() {
        serde_json::from_slice(&fs::read(&settings).map_err(|e| e.to_string())?).map_err(|_| "Не удалось прочитать настройки прежней MORA; файлы сохранены".to_string())?
    } else { serde_json::Value::Null };
    let data = config["dataDir"].as_str().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_else(|| profile.join("data"));
    Ok(data.join("automix.sqlite").is_file())
}
pub fn choose(base: &Path) -> Result<PathBuf, String> {
    let stable = base.join("MORA");
    let preview = base.join("MORA-Native-Preview");
    // Existing Electron data wins; a separate Native library is preserved untouched.
    Ok(if !has_library(&stable)? && has_library(&preview)? { preview } else { stable })
}
#[cfg(test)]
mod tests {
    #[test]
    fn stable_wins_and_preview_is_retained() {
        let root = std::env::temp_dir().join(format!("mora-profile-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("MORA-Native-Preview/data")).unwrap();
        std::fs::write(root.join("MORA-Native-Preview/data/automix.sqlite"), []).unwrap();
        assert_eq!(super::choose(&root).unwrap(), root.join("MORA-Native-Preview"));
        std::fs::create_dir_all(root.join("MORA/data")).unwrap();
        std::fs::write(root.join("MORA/data/automix.sqlite"), []).unwrap();
        assert_eq!(super::choose(&root).unwrap(), root.join("MORA"));
        assert!(root.join("MORA-Native-Preview/data/automix.sqlite").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
