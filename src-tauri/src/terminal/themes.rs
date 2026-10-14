use serde::Deserialize;
use std::sync::OnceLock;

#[derive(Deserialize)]
struct Palette {
    id: String,
    background: String,
    foreground: String,
    cursor: String,
    selection: String,
    palette: [String; 16],
}

fn catalog() -> &'static Vec<(String, String)> {
    static THEMES: OnceLock<Vec<(String, String)>> = OnceLock::new();
    THEMES.get_or_init(|| {
        // This file also supplies the frontend previews. Only bundled colors
        // enter Ghostty configuration; IPC never accepts config text or paths.
        let palettes: Vec<Palette> = serde_json::from_str(include_str!(
            "../../../src/config/terminalThemes.json"
        ))
        .expect("valid bundled terminal palettes");
        palettes.into_iter().map(|theme| {
            let color = |value: &str| {
                assert!(value.len() == 6 && value.bytes().all(|c| c.is_ascii_hexdigit()));
                value.to_owned()
            };
            let mut config = format!(
                "background = {}\nforeground = {}\ncursor-color = {}\ncursor-text = {}\nselection-background = {}\nselection-foreground = {}\n",
                color(&theme.background), color(&theme.foreground), color(&theme.cursor),
                color(&theme.background), color(&theme.selection), color(&theme.foreground),
            );
            for (index, value) in theme.palette.iter().enumerate() {
                config.push_str(&format!("palette = {index}={}\n", color(value)));
            }
            (theme.id, config)
        }).collect()
    })
}

pub fn default_theme() -> String {
    "auto".into()
}

pub fn resolve(id: &str, dark: bool) -> Result<&'static str, String> {
    let resolved = if id == "auto" {
        if dark {
            "phi-dark"
        } else {
            "phi-light"
        }
    } else {
        id
    };
    catalog()
        .iter()
        .find(|(key, _)| key == resolved)
        .map(|(_, config)| config.as_str())
        .ok_or_else(|| "invalid-terminal-theme".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_bundled_palettes_are_allowed() {
        assert_eq!(catalog().len(), 6);
        for (id, config) in catalog() {
            assert_eq!(resolve(id, false).unwrap(), config);
            assert_eq!(
                config
                    .lines()
                    .filter(|line| line.starts_with("palette = "))
                    .count(),
                16
            );
        }
        for invalid in ["../config", "nord\ncommand = touch /tmp/no", "unknown", ""] {
            assert!(resolve(invalid, false).is_err());
        }
    }
    #[test]
    fn auto_theme_follows_app_but_explicit_theme_does_not() {
        assert_eq!(resolve("auto", false), resolve("phi-light", true));
        assert_eq!(resolve("auto", true), resolve("phi-dark", false));
        assert_eq!(resolve("nord", false), resolve("nord", true));
        assert_ne!(resolve("auto", false), resolve("auto", true));
    }
}
