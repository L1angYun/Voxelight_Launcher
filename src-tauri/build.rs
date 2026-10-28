fn main() {
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
