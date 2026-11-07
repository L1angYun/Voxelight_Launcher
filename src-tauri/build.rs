fn valid_builtin_uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[cfg(not(test))]
fn main() {
    println!("cargo:rerun-if-env-changed=VOXELIGHT_MS_CLIENT_ID");
    match std::env::var("VOXELIGHT_MS_CLIENT_ID") {
        Ok(value) if !value.trim().is_empty() && !valid_builtin_uuid(value.trim()) => {
            panic!("VOXELIGHT_MS_CLIENT_ID is not a UUID")
        }
        Err(std::env::VarError::NotUnicode(_)) => {
            panic!("VOXELIGHT_MS_CLIENT_ID is not a UUID")
        }
        _ => {}
    }
    #[cfg(windows)]
    {
        println!("cargo:rerun-if-changed=app.manifest");
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("app.manifest");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
    }
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

#[cfg(test)]
mod tests {
    use super::valid_builtin_uuid;

    #[test]
    fn builtin_build_format_accepts_canonical_uuid_fixtures_only() {
        assert!(valid_builtin_uuid("11111111-1111-1111-1111-111111111111"));
        assert!(valid_builtin_uuid("22222222-2222-2222-2222-222222222222"));
        for invalid in [
            "",
            "not-a-uuid",
            "11111111111111111111111111111111",
            "11111111_1111-1111-1111-111111111111",
            "11111111-1111-1111-1111-11111111111g",
            "{11111111-1111-1111-1111-111111111111}",
        ] {
            assert!(!valid_builtin_uuid(invalid));
        }
    }
}
