//! Tauri checks plugin ACLs before reaching the app's invoke handler. Custom
//! commands have no ACL unless an app manifest is configured, so enforce the
//! app-interface boundary explicitly: remote child webviews and popup windows
//! must never call any host command, even though they share the main NSWindow.
use tauri::{ipc::Invoke, Runtime};

#[cfg(test)]
fn is_main_interface(label: &str) -> bool { label == "main" }

pub fn dispatch<R: Runtime>(invoke: Invoke<R>, handler: impl FnOnce(Invoke<R>) -> bool) -> bool {
    let caller = invoke.message.webview_ref();
    if caller.label() != caller.window().label() || !crate::mission_windows::permits_command(caller.label(), invoke.message.command()) {
        invoke.resolver.reject("This command is not available to this Specrails interface");
        return true;
    }
    handler(invoke)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn plugin_capabilities_belong_to_main_webview_without_window_inheritance() {
        let capability: serde_json::Value = serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        assert_eq!(capability["webviews"], serde_json::json!(["main"]));
        assert!(capability.get("windows").is_none());
        let permissions = capability["permissions"].as_array().unwrap();
        assert!(permissions.contains(&serde_json::json!("core:default")));
        assert!(permissions.contains(&serde_json::json!("clipboard-manager:allow-read-text")));
        assert!(permissions.iter().any(|permission| permission["identifier"] == "shell:allow-spawn"));
    }
    #[test]
    fn only_the_app_webview_can_dispatch_custom_commands() {
        assert!(is_main_interface("main"));
        for label in ["native-browser", "native-browser-owner", "native-browser-owner-popup-1", "main-popup", ""] {
            assert!(!is_main_interface(label));
        }
    }
}
