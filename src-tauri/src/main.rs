#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // The update hand-off helper runs headless from a copy of this binary.
    if std::env::args_os().nth(1).is_some_and(|argument| argument == "--update-helper") {
        std::process::exit(voxelight_launcher_lib::run_update_helper());
    }
    voxelight_launcher_lib::run();
}
