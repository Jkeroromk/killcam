//! Chinese / English for messages KillCam shows while it runs (progress,
//! notices, errors, the tray menu). Labels stored in recordings stay Chinese;
//! the UI translates those when it shows them.

use std::sync::atomic::{AtomicBool, Ordering};

static EN: AtomicBool = AtomicBool::new(false);

/// `setting`: "zh", "en" or "auto" (the Windows display language).
pub fn set(setting: &str) {
    let en = match setting {
        "en" => true,
        "zh" => false,
        _ => !system_is_chinese(),
    };
    EN.store(en, Ordering::Relaxed);
}

pub fn en() -> bool {
    EN.load(Ordering::Relaxed)
}

/// The message in the current language.
pub fn tr(zh: impl Into<String>, en: impl Into<String>) -> String {
    pick(self::en(), zh, en)
}

fn pick(english: bool, zh: impl Into<String>, en: impl Into<String>) -> String {
    if english {
        en.into()
    } else {
        zh.into()
    }
}

#[cfg(windows)]
fn system_is_chinese() -> bool {
    // LANG_CHINESE is the primary language id 0x04 (all Chinese variants)
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    id & 0x3ff == 0x04
}

#[cfg(not(windows))]
fn system_is_chinese() -> bool {
    std::env::var("LANG").map(|l| l.starts_with("zh")).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    // (tests run in parallel: they never switch the global language)
    #[test]
    fn picks_the_language() {
        assert_eq!(pick(true, "录像库", "Library"), "Library");
        assert_eq!(pick(false, "录像库", "Library"), "录像库");
        assert!(!en(), "Chinese until a setting says otherwise");
    }
}
