//! Which server port, data home and log folder this desktop host uses.
//!
//! The installed (release) app keeps its fixed port 4200 and the user's
//! `~/.specrails`. A development build (`npm run dev:desktop`, debug
//! assertions on) gets its own port and its own data home, so it can run next
//! to the installed app without contending for the port or sharing databases,
//! worktrees and tokens. The release port is never moved automatically: two
//! servers on the same data would corrupt each other's queues and recovery.

use std::path::PathBuf;

pub const RELEASE_SERVER_PORT: u16 = 4200;
pub const DEV_SERVER_PORT: u16 = 4300;
const DEV_DATA_DIR: &str = ".specrails-dev";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostProfile {
    pub dev: bool,
    pub server_port: u16,
    /// Exported to the sidecar as `SPECRAILS_REGISTRY_HOME` (the directory that
    /// contains `.specrails/`). `None` keeps whatever the environment provides.
    pub data_home: Option<PathBuf>,
    /// Folder under `~/Library/Logs` for the sidecar log.
    pub log_dir: &'static str,
}

fn parse_port(value: Option<String>) -> Option<u16> {
    value.and_then(|raw| raw.trim().parse::<u16>().ok()).filter(|port| *port > 0)
}

pub fn resolve(dev: bool, env: impl Fn(&str) -> Option<String>, home: Option<PathBuf>) -> HostProfile {
    if !dev {
        return HostProfile { dev, server_port: RELEASE_SERVER_PORT, data_home: None, log_dir: "Specrails" };
    }
    let server_port = parse_port(env("SPECRAILS_DEV_SERVER_PORT"))
        .or_else(|| parse_port(env("SPECRAILS_PORT")))
        .unwrap_or(DEV_SERVER_PORT);
    let data_home = env("SPECRAILS_REGISTRY_HOME")
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .or_else(|| home.map(|home| home.join(DEV_DATA_DIR)));
    HostProfile { dev, server_port, data_home, log_dir: "Specrails Dev" }
}

static PROFILE: std::sync::OnceLock<HostProfile> = std::sync::OnceLock::new();

/// The profile of this process, resolved once from the build type and environment.
pub fn current() -> &'static HostProfile {
    PROFILE.get_or_init(|| resolve(cfg!(debug_assertions), |name| std::env::var(name).ok(), dirs_next::home_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn release_keeps_the_installed_port_and_data() {
        let profile = resolve(false, env(&[("SPECRAILS_DEV_SERVER_PORT", "4999"), ("SPECRAILS_REGISTRY_HOME", "/tmp/x")]), Some("/Users/me".into()));
        assert_eq!(profile, HostProfile { dev: false, server_port: 4200, data_home: None, log_dir: "Specrails" });
    }

    #[test]
    fn dev_uses_its_own_port_and_data_home() {
        let profile = resolve(true, env(&[]), Some("/Users/me".into()));
        assert_eq!(profile.server_port, DEV_SERVER_PORT);
        assert_eq!(profile.data_home, Some(PathBuf::from("/Users/me/.specrails-dev")));
        assert_eq!(profile.log_dir, "Specrails Dev");
    }

    #[test]
    fn dev_honours_explicit_port_and_home() {
        let profile = resolve(true, env(&[("SPECRAILS_DEV_SERVER_PORT", "4400"), ("SPECRAILS_PORT", "4500"), ("SPECRAILS_REGISTRY_HOME", "/tmp/sr")]), Some("/Users/me".into()));
        assert_eq!(profile.server_port, 4400);
        assert_eq!(profile.data_home, Some(PathBuf::from("/tmp/sr")));
        let fallback = resolve(true, env(&[("SPECRAILS_DEV_SERVER_PORT", "nope"), ("SPECRAILS_PORT", "4500")]), None);
        assert_eq!(fallback.server_port, 4500);
        assert_eq!(fallback.data_home, None);
    }
}
