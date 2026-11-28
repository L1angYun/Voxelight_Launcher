// SPDX-License-Identifier: GPL-3.0-only
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn read_launcher_version(manifest_dir: &Path) -> String {
    let package_json = manifest_dir.join("../../package.json");
    println!("cargo:rerun-if-changed={}", package_json.display());
    if let Ok(raw) = fs::read_to_string(&package_json) {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(version) = parsed.get("version").and_then(|value| value.as_str()) {
                if !version.trim().is_empty() {
                    return version.trim().to_owned();
                }
            }
        }
    }
    env!("CARGO_PKG_VERSION").to_owned()
}

fn escape_rust_path(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut out = String::with_capacity(text.len() + 8);
    out.push('"');
    for ch in text.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn generate_payload_module(manifest_dir: &Path, out_dir: &Path) {
    println!("cargo:rerun-if-env-changed=VOXELIGHT_SETUP_PAYLOAD");
    println!("cargo:rerun-if-env-changed=VOXELIGHT_SETUP_EXPECTED_INSTALL_BYTES");

    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_owned());
    let payload_env = std::env::var("VOXELIGHT_SETUP_PAYLOAD")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());

    let expected_override = std::env::var("VOXELIGHT_SETUP_EXPECTED_INSTALL_BYTES")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|bytes| *bytes > 0);

    let generated = if let Some(raw_path) = payload_env {
        let candidate = PathBuf::from(&raw_path);
        let resolved = if candidate.is_absolute() {
            candidate
        } else {
            manifest_dir.join(candidate)
        };
        let canonical = fs::canonicalize(&resolved).unwrap_or_else(|error| {
            panic!(
                "VOXELIGHT_SETUP_PAYLOAD could not be resolved ({}): {error}",
                resolved.display()
            )
        });
        println!("cargo:rerun-if-changed={}", canonical.display());
        let bytes = fs::read(&canonical).unwrap_or_else(|error| {
            panic!(
                "VOXELIGHT_SETUP_PAYLOAD could not be read ({}): {error}",
                canonical.display()
            )
        });
        assert!(
            !bytes.is_empty(),
            "VOXELIGHT_SETUP_PAYLOAD must not be empty: {}",
            canonical.display()
        );
        let digest = sha256_hex(&bytes);
        let fallback_expected = (bytes.len() as u64)
            .saturating_mul(3)
            .max(32 * 1024 * 1024);
        let expected_bytes = expected_override.unwrap_or(fallback_expected);
        format!(
            "pub const PAYLOAD_BYTES: &[u8] = include_bytes!({});\n\
             pub const PAYLOAD_SHA256: &str = \"{digest}\";\n\
             pub const EXPECTED_INSTALL_BYTES: u64 = {expected_bytes};\n\
             pub const PAYLOAD_IS_PLACEHOLDER: bool = false;\n",
            escape_rust_path(&canonical),
        )
    } else {
        if profile == "release" {
            panic!(
                "VOXELIGHT_SETUP_PAYLOAD must point to the built NSIS installer for release builds"
            );
        }
        let placeholder = b"VOXELIGHT_SETUP_DEBUG_PLACEHOLDER";
        let digest = sha256_hex(placeholder);
        let expected_bytes = expected_override.unwrap_or(36 * 1024 * 1024);
        format!(
            "pub const PAYLOAD_BYTES: &[u8] = b\"VOXELIGHT_SETUP_DEBUG_PLACEHOLDER\";\n\
             pub const PAYLOAD_SHA256: &str = \"{digest}\";\n\
             pub const EXPECTED_INSTALL_BYTES: u64 = {expected_bytes};\n\
             pub const PAYLOAD_IS_PLACEHOLDER: bool = true;\n",
        )
    };

    fs::write(out_dir.join("embedded_payload.rs"), generated)
        .expect("failed to write embedded_payload.rs");
}

/// A release Setup built without Tauri's `custom-protocol` feature embeds no UI
/// and opens `build.devUrl` (http://localhost:1421) in a frameless window, so
/// the user would see an error page with no way to close it. The Tauri CLI adds
/// the feature automatically; Setup is built with plain Cargo, so check here.
fn require_custom_protocol_for_release() {
    let profile = std::env::var("PROFILE").unwrap_or_default();
    if profile == "release" && tauri_build::is_dev() {
        panic!(
            "Voxelight Setup release builds must enable the custom-protocol feature \
             (cargo build --release --features custom-protocol, as scripts/build.ps1 does). \
             Without it Tauri embeds no UI and the Setup window loads the development \
             server at build.devUrl instead of the bundled pages."
        );
    }
}

fn main() {
    require_custom_protocol_for_release();

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR missing"));

    let launcher_version = read_launcher_version(&manifest_dir);
    println!("cargo:rustc-env=VOXELIGHT_LAUNCHER_VERSION={launcher_version}");

    let license_path = manifest_dir.join("../../LICENSE");
    println!("cargo:rerun-if-changed={}", license_path.display());

    generate_payload_module(&manifest_dir, &out_dir);

    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=app.manifest");
        let manifest = manifest_dir.join("app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());

        // Setup is frequently run from Downloads. The tao/wry stack statically
        // imports non-KnownDLLs, so harden the PE loader:
        // - DEPENDENTLOADFLAG makes every dependent load search System32 only;
        // - delay-load the non-KnownDLLs so they are not resolved before main;
        // - delayimp.lib provides the delay-load thunks.
        // SetDefaultDllDirectories(LOAD_LIBRARY_SEARCH_SYSTEM32) in main.rs is
        // the third layer and also covers dynamically loaded DLLs.
        println!("cargo:rustc-link-arg-bins=/DEPENDENTLOADFLAG:0x800");
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:dwmapi.dll");
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:WINHTTP.dll");
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:USERENV.dll");
        println!("cargo:rustc-link-arg-bins=/DELAYLOAD:RstrtMgr.DLL");
        println!("cargo:rustc-link-arg-bins=delayimp.lib");
    }

    let icon_path = manifest_dir.join("../../src-tauri/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", icon_path.display());
    let windows_attributes = tauri_build::WindowsAttributes::new_without_app_manifest()
        .window_icon_path(icon_path);
    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new())
        .windows_attributes(windows_attributes);
    tauri_build::try_build(attributes).expect("failed to run tauri-build for voxelight-setup");
}
