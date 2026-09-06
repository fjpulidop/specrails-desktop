use std::{env, path::PathBuf};

fn main() {
    tauri_build::build();
    embed_example_manifest();
}

/// tauri-build embeds the Windows application manifest (Common Controls v6)
/// into the package *binaries* only. The native smoke fixtures are cargo
/// examples, so they would run without a manifest: Windows then activates
/// comctl32 5.82, which does not export `SetWindowSubclass` by name although
/// tao/wry import it that way, and the loader ends the process with
/// STATUS_ENTRYPOINT_NOT_FOUND (0xC0000139) before `main` runs — no output,
/// no panic. Give the examples the same manifest the shipped app carries.
fn embed_example_manifest() {
    let windows_msvc = env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if !windows_msvc {
        return;
    }
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"))
        .join("examples")
        .join("windows-app.manifest");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg-examples=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg-examples=/MANIFESTINPUT:{}", manifest.display());
}
