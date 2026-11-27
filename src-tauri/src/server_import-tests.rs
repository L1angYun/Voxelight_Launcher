// SPDX-License-Identifier: GPL-3.0-only
use super::*;
use std::io::Write;
use zip::{write::SimpleFileOptions, ZipWriter};

fn scratch() -> PathBuf {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("target/server-import-tests")
        .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).unwrap();
    root
}

/// A JAR with an optional Main-Class and some text entries; never run.
fn jar(path: &Path, main_class: Option<&str>, entries: &[(&str, &str)]) {
    let mut zip = ZipWriter::new(fs::File::create(path).unwrap());
    let options = SimpleFileOptions::default();
    if let Some(main) = main_class {
        zip.start_file("META-INF/MANIFEST.MF", options).unwrap();
        write!(zip, "Manifest-Version: 1.0\r\nMain-Class: {main}\r\n\r\n").unwrap();
    }
    for (name, text) in entries {
        zip.start_file(*name, options).unwrap();
        zip.write_all(text.as_bytes()).unwrap();
    }
    zip.finish().unwrap();
}

fn state(root: &Path) -> LauncherState {
    LauncherState::test_fixture(root.join("profile"), Default::default(), crate::storage::test_client())
}

fn request(kind: ImportKind, path: &Path, jar: &str) -> ImportServerRequest {
    ImportServerRequest {
        kind,
        path: path.to_string_lossy().into_owned(),
        name: "Imported fixture".into(),
        version_id: "1.21.4".into(),
        jar: jar.into(),
        args_file: None,
    }
}

fn args_request(path: &Path, version_id: &str, args_file: &str) -> ImportServerRequest {
    ImportServerRequest {
        kind: ImportKind::Folder,
        path: path.to_string_lossy().into_owned(),
        name: "Imported args fixture".into(),
        version_id: version_id.into(),
        jar: String::new(),
        args_file: Some(args_file.into()),
    }
}

/// The servers folder's entries, without antivirus backup copies.
fn servers(state: &LauncherState) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(servers_root(state).unwrap())
        .map(|entries| entries.flatten().map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| !crate::parts::scanner_copy(name)).collect())
        .unwrap_or_default();
    names.sort();
    names
}

const PAPERCLIP: &str = "io.papermc.paperclip.Main";

#[test]
fn v2_a_jar_tells_its_software_and_minecraft_version_without_running_it() {
    let root = scratch();
    let cases: [(&str, Option<&str>, &[(&str, &str)], Option<&str>, Option<&str>); 10] = [
        ("paper-1.21.4-123.jar", Some(PAPERCLIP), &[], Some("Paper"), Some("1.21.4")),
        ("purpur-1.21.4-2400.jar", Some(PAPERCLIP), &[], Some("Purpur"), Some("1.21.4")),
        ("folia-1.21.4-6.jar", Some(PAPERCLIP), &[], Some("Folia"), Some("1.21.4")),
        ("spigot-1.20.1.jar", Some("org.bukkit.craftbukkit.bootstrap.Main"), &[], Some("Spigot"), Some("1.20.1")),
        ("craftbukkit-1.20.1.jar", Some("org.bukkit.craftbukkit.Main"), &[], Some("CraftBukkit"), Some("1.20.1")),
        (
            "fabric-server-mc.1.20.1-loader.0.16.9-launcher.1.0.1.jar",
            Some("net.fabricmc.installer.ServerLauncher"),
            &[("install.properties", "fabric-loader-version=0.16.9\ngame-version=1.20.1\n")],
            Some("Fabric"),
            Some("1.20.1"),
        ),
        ("quilt-server-launch.jar", Some("org.quiltmc.loader.impl.launch.server.QuiltServerLauncher"), &[], Some("Quilt"), None),
        ("forge-1.12.2-14.23.5.2860.jar", Some("net.minecraftforge.fml.relauncher.ServerLaunchWrapper"), &[], Some("Forge"), Some("1.12.2")),
        // version.json speaks for a vanilla server, whatever the file is called.
        ("server.jar", Some("net.minecraft.bundler.Main"), &[("version.json", r#"{"id":"1.21.4","name":"1.21.4"}"#)], Some("Vanilla"), Some("1.21.4")),
        ("mystery.jar", None, &[], None, None),
    ];
    for (name, main, entries, software, version) in cases {
        let path = root.join(name);
        jar(&path, main, entries);
        let facts = jar_facts(&path).unwrap();
        assert_eq!((facts.software, facts.version.as_deref(), facts.installer), (software, version, false), "{name}");
    }
    // version.json wins over a version in the file name.
    let renamed = root.join("paper-1.20.1.jar");
    jar(&renamed, Some(PAPERCLIP), &[("version.json", r#"{"id":"1.21.4"}"#)]);
    assert_eq!(jar_facts(&renamed).unwrap().version.as_deref(), Some("1.21.4"));
    // A loader profile names the game version it builds on.
    let universal = root.join("forge-universal.jar");
    jar(&universal, Some("net.minecraftforge.fml.relauncher.ServerLaunchWrapper"),
        &[("version.json", r#"{"id":"1.12.2-forge-14.23.5.2860","inheritsFrom":"1.12.2"}"#)]);
    assert_eq!(jar_facts(&universal).unwrap().version.as_deref(), Some("1.12.2"));
    // The Fabric server launcher's own properties, when the name has no version.
    let launcher = root.join("fabric-server-launch.jar");
    jar(&launcher, Some("net.fabricmc.installer.ServerLauncher"), &[("install.properties", "game-version=1.21.4\n")]);
    assert_eq!(jar_facts(&launcher).unwrap().version.as_deref(), Some("1.21.4"));
    // A renamed bundler JAR: vanilla and Paperclip record the version inside.
    let bundled = root.join("server-a.jar");
    jar(&bundled, Some(PAPERCLIP), &[("META-INF/versions.list", "abc\tpaper-1.21.4\t1.21.4/paper-1.21.4.jar\n")]);
    assert_eq!(jar_facts(&bundled).unwrap().version.as_deref(), Some("1.21.4"));
    let downloaded = root.join("server-b.jar");
    jar(&downloaded, Some(PAPERCLIP), &[("META-INF/download-context", "abc\thttps://example.invalid/x.jar\tmojang_1.20.6.jar\n")]);
    assert_eq!(jar_facts(&downloaded).unwrap().version.as_deref(), Some("1.20.6"));
    // Year-numbered versions, from 26.1 on.
    let yearly = root.join("paper-26.1-12.jar");
    jar(&yearly, Some(PAPERCLIP), &[]);
    assert_eq!(jar_facts(&yearly).unwrap().version.as_deref(), Some("26.1"));
    // Installers are told apart by their entry point or their name.
    for (name, main) in [
        ("forge-1.20.1-47.2.0-installer.jar", Some("net.minecraftforge.installer.SimpleInstaller")),
        ("fabric-installer-1.0.1.jar", Some("net.fabricmc.installer.Main")),
        ("neoforge-21.1.77-installer.jar", None),
        ("setup.jar", Some("net.minecraftforge.installer.SimpleInstaller")),
    ] {
        let path = root.join(name);
        jar(&path, main, &[]);
        assert!(jar_facts(&path).unwrap().installer, "{name}");
    }
    // A signed JAR: the digest list makes the manifest far longer than what is read.
    let signed = root.join("forge-1.12.2-14.23.5.2860-universal.jar");
    let digests: String = (0..2000).map(|index| format!("Name: net/minecraftforge/Class{index}.class\r\nSHA-256-Digest: {}\r\n\r\n", "A".repeat(44))).collect();
    jar(&signed, None, &[("META-INF/MANIFEST.MF", &format!("Manifest-Version: 1.0\r\nMain-Class: net.minecraftforge.fml.relauncher.ServerLaunchWrapper\r\n\r\n{digests}"))]);
    assert!(fs::metadata(&signed).unwrap().len() > 0);
    let facts = jar_facts(&signed).unwrap();
    assert_eq!((facts.main.as_deref(), facts.software), (Some("net.minecraftforge.fml.relauncher.ServerLaunchWrapper"), Some("Forge")));
    // A JAR whose end record declares more than the launcher indexes is refused before it is parsed.
    let declared = root.join("declared.jar");
    jar(&declared, Some(PAPERCLIP), &[]);
    let mut bytes = fs::read(&declared).unwrap();
    let end = bytes.windows(4).rposition(|window| window == [0x50, 0x4b, 0x05, 0x06]).unwrap();
    bytes[end + 12..end + 16].copy_from_slice(&(80u32 * 1024 * 1024).to_le_bytes());
    fs::write(&declared, &bytes).unwrap();
    assert_eq!(crate::errors::expected(jar_facts(&declared).err().unwrap()).code, "server.importTooLarge");
    // Something that is not a JAR.
    fs::write(root.join("broken.jar"), b"not a zip").unwrap();
    assert_eq!(crate::errors::expected(jar_facts(&root.join("broken.jar")).err().unwrap()).code, "server.importNotJar");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_a_folder_lists_its_runnable_jars_and_what_it_will_copy() {
    let root = scratch();
    let folder = root.join("my-server");
    fs::create_dir_all(folder.join("world/region")).unwrap();
    fs::create_dir_all(folder.join("plugins")).unwrap();
    jar(&folder.join("server.jar"), Some("net.minecraft.bundler.Main"), &[("version.json", r#"{"id":"1.21.4"}"#)]);
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    jar(&folder.join("forge-1.20.1-47.2.0-installer.jar"), Some("net.minecraftforge.installer.SimpleInstaller"), &[]);
    jar(&folder.join("plugins/essentials.jar"), Some("com.earth2me.essentials.Essentials"), &[]);
    fs::write(folder.join("world/region/r.0.0.mca"), vec![7u8; 4096]).unwrap();
    fs::write(folder.join("server.properties"), "server-port=25570\n").unwrap();
    let found = inspect(ImportKind::Folder, &folder).unwrap();
    assert_eq!(found.jars, ["paper-1.21.4-123.jar", "server.jar"], "top-level runnable JARs only, installers left out");
    assert_eq!(found.default_jar.as_deref(), Some("paper-1.21.4-123.jar"), "a third-party server before a vanilla one");
    assert_eq!((found.software.as_deref(), found.minecraft_version.as_deref()), (Some("Paper"), Some("1.21.4")));
    assert_eq!(found.unsupported, None);
    // The dialog reads these names.
    let json = serde_json::to_value(&found).unwrap();
    for key in ["kind", "software", "minecraftVersion", "jars", "details", "defaultJar", "totalBytes", "fileCount", "unsupported"] {
        assert!(json.get(key).is_some(), "{key}: {json}");
    }
    assert_eq!((json["kind"].as_str(), json["unsupported"].is_null()), (Some("folder"), true));
    assert_eq!(json["details"][0]["minecraftVersion"], "1.21.4");
    assert_eq!(json["details"][0]["jar"], "paper-1.21.4-123.jar");
    let mut bytes = 0;
    let mut pending = vec![folder.clone()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() { pending.push(entry.path()); } else { bytes += entry.metadata().unwrap().len(); }
        }
    }
    let mut files = 0;
    let mut pending = vec![folder.clone()];
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(dir).unwrap().flatten() {
            if entry.path().is_dir() { pending.push(entry.path()); } else { files += 1; }
        }
    }
    assert!(files >= 6);
    assert_eq!((found.file_count, found.total_bytes), (files, bytes));

    let details: Vec<_> = found.details.iter().map(|detail| (detail.jar.as_str(), detail.software, detail.minecraft_version.as_deref())).collect();
    assert_eq!(details, [("paper-1.21.4-123.jar", Some("Paper"), Some("1.21.4")), ("server.jar", Some("Vanilla"), Some("1.21.4"))]);

    // Two builds of one server: the newer is suggested, whatever the names sort as.
    let upgraded = root.join("upgraded");
    fs::create_dir_all(&upgraded).unwrap();
    jar(&upgraded.join("paper-1.20.4-499.jar"), Some(PAPERCLIP), &[]);
    jar(&upgraded.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    jar(&upgraded.join("library.jar"), None, &[]);
    // A vanilla JAR that sorts first and is newer still comes after the server software.
    jar(&upgraded.join("minecraft_server.1.21.5.jar"), Some("net.minecraft.bundler.Main"), &[]);
    let found = inspect(ImportKind::Folder, &upgraded).unwrap();
    assert_eq!(found.jars, ["minecraft_server.1.21.5.jar", "paper-1.20.4-499.jar", "paper-1.21.4-123.jar"], "a JAR with no entry point is not offered");
    assert_eq!((found.default_jar.as_deref(), found.minecraft_version.as_deref()), (Some("paper-1.21.4-123.jar"), Some("1.21.4")));
    assert_eq!(found.details[1].minecraft_version.as_deref(), Some("1.20.4"));

    // A JAR on its own.
    let single = inspect(ImportKind::Jar, &folder.join("server.jar")).unwrap();
    assert_eq!(single.jars, ["server.jar"]);
    assert_eq!(single.default_jar.as_deref(), Some("server.jar"));
    assert_eq!((single.file_count, single.total_bytes), (1, fs::metadata(folder.join("server.jar")).unwrap().len()));
    assert_eq!((single.software.as_deref(), single.minecraft_version.as_deref()), (Some("Vanilla"), Some("1.21.4")));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_an_installer_an_arguments_file_server_or_a_folder_without_a_jar_is_not_importable() {
    let root = scratch();
    let installer = root.join("forge-1.20.1-47.2.0-installer.jar");
    jar(&installer, Some("net.minecraftforge.installer.SimpleInstaller"), &[]);
    assert_eq!(inspect(ImportKind::Jar, &installer).unwrap().unsupported, Some("installer"));

    // On its own, a loader's launch JAR or a JAR with no entry point cannot start.
    for (name, main) in [
        ("forge-1.12.2-14.23.5.2860.jar", Some("net.minecraftforge.fml.relauncher.ServerLaunchWrapper")),
        ("fabric-server-launch.jar", Some("net.fabricmc.loader.launch.server.FabricServerLauncher")),
        ("quilt-server-launch.jar", Some("org.quiltmc.loader.impl.launch.server.QuiltServerLauncher")),
        ("forge-1.21.1-52.1.20-shim.jar", Some("net.minecraftforge.bootstrap.shim.Main")),
        ("library.jar", None),
    ] {
        let path = root.join(name);
        jar(&path, main, &[]);
        let found = inspect(ImportKind::Jar, &path).unwrap();
        assert_eq!((found.unsupported, found.jars.len()), (Some("needsFolder"), 0), "{name}");
    }
    // A name Java would read as an arguments file or an option is refused, by name.
    for name in ["@paper.jar", "-paper.jar"] {
        let path = root.join(name);
        jar(&path, Some(PAPERCLIP), &[]);
        assert_eq!(crate::errors::expected(inspect(ImportKind::Jar, &path).unwrap_err()).code, "server.importJarName", "{name}");
    }
    // The Fabric server launcher fetches what it needs and runs alone.
    let launcher = root.join("fabric-server-mc.1.21.4-loader.0.16.9-launcher.1.0.1.jar");
    jar(&launcher, Some("net.fabricmc.installer.ServerLauncher"), &[]);
    assert_eq!(inspect(ImportKind::Jar, &launcher).unwrap().unsupported, None);

    // Forge and NeoForge 1.17+ with win_args.txt are now importable, detecting software and version.
    for (folder, args, expected_software, expected_version) in [
        ("forge", "libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt", "Forge", "1.20.1"),
        ("neoforge", "libraries/net/neoforged/neoforge/21.1.77/win_args.txt", "NeoForge", "1.21.1"),
        ("neoforge-1.20.1", "libraries/net/neoforged/forge/1.20.1-47.1.106/win_args.txt", "NeoForge", "1.20.1"),
    ] {
        let dir = root.join(folder);
        let file = dir.join(args);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(
            &file,
            "-p libraries/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget forgeserver\n",
        )
        .unwrap();
        fs::write(dir.join("run.bat"), "java @user_jvm_args.txt @libraries/x/win_args.txt %*\n").unwrap();
        jar(&dir.join("server.jar"), Some("net.minecraft.bundler.Main"), &[]);
        let found = inspect(ImportKind::Folder, &dir).unwrap();
        assert_eq!(found.unsupported, None, "{folder}");
        assert_eq!(found.software, Some(expected_software), "{folder}");
        assert_eq!(found.minecraft_version.as_deref(), Some(expected_version), "{folder}");
        assert_eq!(found.args_file.as_deref(), Some(args), "{folder}");
        assert!(found.jars.is_empty(), "vanilla server.jar beside win_args.txt is not offered");
    }

    // A folder with only unix_args.txt (no win_args.txt) stays unsupported on Windows.
    let unix_only = root.join("forge-unix-only");
    let unix_file = unix_only.join("libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt");
    fs::create_dir_all(unix_file.parent().unwrap()).unwrap();
    fs::write(&unix_file, "-p libraries/x.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n").unwrap();
    assert_eq!(inspect(ImportKind::Folder, &unix_only).unwrap().unsupported, Some("argsFile"));

    // Newer Forge adds a shim JAR that starts it with -jar: that is offered, the vanilla JAR is not.
    let shim = root.join("forge");
    jar(&shim.join("forge-1.21.1-52.1.20-shim.jar"), Some("net.minecraftforge.bootstrap.shim.Main"), &[]);
    jar(&shim.join("mystery.jar"), Some("com.example.Main"), &[]);
    let found = inspect(ImportKind::Folder, &shim).unwrap();
    assert_eq!(found.unsupported, None);
    assert_eq!(found.jars, ["forge-1.21.1-52.1.20-shim.jar"], "neither the vanilla nor an unknown JAR beside it is offered");
    assert_eq!((found.software, found.minecraft_version.as_deref()), (Some("Forge"), Some("1.21.1")));
    // A hybrid that installs the loader itself (Arclight) is kept, and suggested before the bare loader.
    jar(&shim.join("arclight-forge-1.21.1-1.0.2.jar"), Some("io.izzel.arclight.server.Launcher"), &[]);
    let found = inspect(ImportKind::Folder, &shim).unwrap();
    assert_eq!(found.jars, ["arclight-forge-1.21.1-1.0.2.jar", "forge-1.21.1-52.1.20-shim.jar"]);
    assert_eq!((found.default_jar.as_deref(), found.software), (Some("arclight-forge-1.21.1-1.0.2.jar"), Some("Arclight")));
    // Also when the hybrid's name sorts after the loader's.
    let mohist = root.join("mohist");
    let args = mohist.join("libraries/net/minecraftforge/forge/1.20.1-47.2.0/win_args.txt");
    fs::create_dir_all(args.parent().unwrap()).unwrap();
    fs::write(&args, "-p x
").unwrap();
    jar(&mohist.join("forge-1.20.1-47.2.0-shim.jar"), Some("net.minecraftforge.bootstrap.shim.Main"), &[]);
    jar(&mohist.join("mohist-1.20.1-12.jar"), Some("com.mohistmc.MohistMCStart"), &[]);
    let found = inspect(ImportKind::Folder, &mohist).unwrap();
    assert_eq!((found.default_jar.as_deref(), found.software), (Some("mohist-1.20.1-12.jar"), Some("Mohist")));
    // Without a shim (NeoForge), the hybrid alone still makes the folder importable.
    let hybrid = root.join("neoforge-1.20.1");
    jar(&hybrid.join("arclight-neoforge-1.21.1-1.0.2.jar"), Some("io.izzel.arclight.server.Launcher"), &[]);
    assert_eq!(inspect(ImportKind::Folder, &hybrid).unwrap().unsupported, None);

    let empty = root.join("world-only");
    fs::create_dir_all(empty.join("world")).unwrap();
    fs::write(empty.join("world/level.dat"), b"level").unwrap();
    let found = inspect(ImportKind::Folder, &empty).unwrap();
    assert_eq!((found.unsupported, found.jars.len(), found.default_jar), (Some("noJar"), 0, None));
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_a_folder_deeper_than_the_copy_allows_is_refused_before_copying() {
    let root = scratch();
    let folder = root.join("deep");
    let mut dir = folder.clone();
    for _ in 0..66 {
        dir = dir.join("d");
    }
    fs::create_dir_all(&dir).unwrap();
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    let error = inspect(ImportKind::Folder, &folder).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importTooLarge");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_a_changed_copy_is_named_and_other_copy_errors_pass_through() {
    assert_eq!(copy_problem(crate::instances::COPY_CHANGED.into()), IMPORT_CHANGED);
    assert_eq!(copy_problem(crate::instances::COPY_MISMATCH.into()), IMPORT_CHANGED);
    assert_eq!(copy_problem("复制实例文件失败：另一个程序正在使用此文件，进程无法访问。 (os error 32)".into()), IMPORT_CHANGED);
    assert_eq!(copy_problem("无法读取实例文件：另一个程序已锁定文件的一部分，进程无法访问。 (os error 33)".into()), IMPORT_CHANGED);
    // A full disk is not something stopping the server would fix.
    assert_eq!(copy_problem("复制实例文件失败：磁盘空间不足。 (os error 112)".into()), "复制实例文件失败：磁盘空间不足。 (os error 112)");
    assert_eq!(copy_problem("磁盘已满".into()), "磁盘已满");
    assert_eq!(copy_problem("任务已取消，已校验文件保留供下次复用".into()), "任务已取消，已校验文件保留供下次复用");
}

/// A running server keeps its world locked; the import says to stop it.
#[cfg(windows)]
#[test]
fn v2_a_running_servers_locked_world_names_the_problem() {
    use std::os::windows::fs::OpenOptionsExt;
    let root = scratch();
    let state = state(&root);
    let folder = root.join("running");
    fs::create_dir_all(folder.join("world")).unwrap();
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    fs::write(folder.join("world/session.lock"), b"lock").unwrap();
    let held = fs::OpenOptions::new().read(true).write(true).share_mode(0).open(folder.join("world/session.lock")).unwrap();
    let error = import_into(&state, &request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar"), &folder).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importChanged");
    assert!(servers(&state).is_empty());
    drop(held);
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_a_cancelled_import_leaves_nothing_behind() {
    let root = scratch();
    let state = std::sync::Arc::new(state(&root));
    let folder = root.join("survival");
    fs::create_dir_all(folder.join("world")).unwrap();
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    fs::write(folder.join("world/level.dat"), b"level").unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let task = state.control.begin("server-import", "1.21.4", "Fixture import").unwrap();
    state.control.cancel(&task);
    let shared = state.clone();
    let source = folder.clone();
    let error = runtime
        .block_on(runtime.spawn_blocking(move || {
            import_with(&shared, &request(ImportKind::Folder, &source, "paper-1.21.4-123.jar"), &source, Some(&shared))
        }))
        .unwrap()
        .unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "download.cancelled");
    state.control.finish(&task, Some("cancelled"));
    assert!(servers(&state).is_empty(), "the cancelled copy is gone: {:?}", servers(&state));
    assert!(folder.join("world/level.dat").is_file(), "the source is untouched");
    drop(runtime);
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[cfg(windows)]
#[test]
fn v2_a_folder_with_a_link_in_it_is_not_imported() {
    let root = scratch();
    let state = state(&root);
    let folder = root.join("linked");
    let elsewhere = root.join("elsewhere");
    fs::create_dir_all(&folder).unwrap();
    fs::create_dir_all(&elsewhere).unwrap();
    fs::write(elsewhere.join("secret.txt"), b"outside the server").unwrap();
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    let output = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(folder.join("world").to_string_lossy().replace('/', r"\"))
        .arg(elsewhere.to_string_lossy().replace('/', r"\"))
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let error = inspect(ImportKind::Folder, &folder).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importLinks");
    let error = import_into(&state, &request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar"), &folder).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importLinks");
    assert!(servers(&state).is_empty());
    fs::remove_dir(folder.join("world")).unwrap();
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_importing_a_jar_copies_it_into_a_new_server_with_the_eula_off() {
    let root = scratch();
    let state = state(&root);
    let source = root.join("paper-1.21.4-123.jar");
    jar(&source, Some(PAPERCLIP), &[]);
    let before = fs::read(&source).unwrap();
    let definition = import_into(&state, &request(ImportKind::Jar, &source, "paper-1.21.4-123.jar"), &source).unwrap();
    let dir = server_directory(&state, &definition.id).unwrap();
    assert_eq!(fs::read(dir.join("paper-1.21.4-123.jar")).unwrap(), before);
    assert_eq!(fs::read(&source).unwrap(), before, "the source is untouched");
    assert_eq!(definition.source, ServerSource::Imported);
    assert_eq!(definition.jar.as_deref(), Some("paper-1.21.4-123.jar"));
    assert_eq!(definition.software.as_deref(), Some("Paper"));
    assert_eq!((definition.name.as_str(), definition.version_id.as_str()), ("Imported fixture", "1.21.4"));
    assert!(!definition.eula_accepted && definition.jar_sha1.is_none());
    let saved = load_definition(&dir).unwrap();
    assert_eq!((saved.source, saved.jar), (ServerSource::Imported, definition.jar.clone()), "the record is saved");
    assert!(fs::read_to_string(dir.join("eula.txt")).unwrap().contains("eula=false"));
    assert!(fs::read_to_string(dir.join("server.properties")).unwrap().contains("server-port=25565"), "a JAR gets the launcher's default properties");
    assert_eq!(settings_from_properties(&properties(&dir).unwrap(), &ServerSettings::default()).unwrap().port, 25565, "default properties");
    let info = server_info(&state, &ServerRegistry::default(), definition.clone()).unwrap();
    assert!(info.installed, "an imported server is ready when its JAR is there");
    assert_eq!((info.source, info.software.as_deref(), info.jar.as_deref()), (ServerSource::Imported, Some("Paper"), Some("paper-1.21.4-123.jar")));
    assert_eq!(servers(&state), [definition.id.clone()], "no staging folder is left");
    fs::remove_file(dir.join("paper-1.21.4-123.jar")).unwrap();
    assert!(!server_info(&state, &ServerRegistry::default(), definition).unwrap().installed);
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_importing_a_folder_keeps_its_files_and_settings_but_turns_the_eula_off() {
    let root = scratch();
    let state = state(&root);
    let folder = root.join("survival");
    fs::create_dir_all(folder.join("world")).unwrap();
    fs::create_dir_all(folder.join("plugins")).unwrap();
    jar(&folder.join("purpur-1.21.4-2400.jar"), Some(PAPERCLIP), &[]);
    jar(&folder.join("plugins/essentials.jar"), Some("com.earth2me.essentials.Essentials"), &[]);
    fs::write(folder.join("world/level.dat"), b"the user's world").unwrap();
    let properties_text = "#Minecraft server properties\nserver-port=25570\nmax-players=8\nmotd=Fixture\nlevel-name=world\nspawn-protection=4\n";
    fs::write(folder.join("server.properties"), properties_text).unwrap();
    fs::write(folder.join("eula.txt"), "eula=true\n").unwrap();
    let definition = import_into(&state, &request(ImportKind::Folder, &folder, "purpur-1.21.4-2400.jar"), &folder).unwrap();
    let dir = server_directory(&state, &definition.id).unwrap();
    assert_eq!(fs::read(dir.join("world/level.dat")).unwrap(), b"the user's world");
    assert!(dir.join("plugins/essentials.jar").is_file());
    assert_eq!(fs::read_to_string(dir.join("server.properties")).unwrap(), properties_text, "the properties are kept as they are");
    assert_eq!((definition.settings.port, definition.settings.max_players, definition.settings.motd.as_str()), (25570, 8, "Fixture"));
    assert_eq!((definition.software.as_deref(), definition.jar.as_deref()), (Some("Purpur"), Some("purpur-1.21.4-2400.jar")));
    assert!(!definition.eula_accepted);
    assert!(fs::read_to_string(dir.join("eula.txt")).unwrap().contains("eula=false"), "the EULA must be accepted again in the launcher");
    assert_eq!(fs::read_to_string(folder.join("eula.txt")).unwrap(), "eula=true\n", "the source is untouched");
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn v2_an_import_the_launcher_cannot_manage_leaves_nothing_behind() {
    let root = scratch();
    let state = state(&root);
    let folder = root.join("server");
    fs::create_dir_all(folder.join("plugins")).unwrap();
    jar(&folder.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    jar(&folder.join("plugins/essentials.jar"), Some("com.earth2me.essentials.Essentials"), &[]);

    // Settings out of the launcher's range, named by key.
    for (line, key) in [
        ("view-distance=40", "view-distance"),
        ("server-ip=play.example.org", "server-ip"),
        ("max-players=0", "max-players"),
        ("online-mode=yes", "online-mode"),
    ] {
        fs::write(folder.join("server.properties"), format!("motd=Kept\n{line}\nlevel-name=world\n")).unwrap();
        let error = import_into(&state, &request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar"), &folder).unwrap_err();
        assert_eq!(error, format!("{IMPORT_PROPERTIES}{key}"));
        assert_eq!(crate::errors::expected(error).code, "server.importProperties");
    }
    fs::write(folder.join("server.properties"), "view-distance=10\n").unwrap();

    // Only a top-level runnable JAR of what was imported can be chosen.
    for chosen in ["plugins/essentials.jar", "missing.jar", "../paper-1.21.4-123.jar", "server.properties"] {
        assert!(import_into(&state, &request(ImportKind::Folder, &folder, chosen), &folder).is_err(), "{chosen}");
    }
    let installer = root.join("forge-1.20.1-47.2.0-installer.jar");
    jar(&installer, Some("net.minecraftforge.installer.SimpleInstaller"), &[]);
    let error = import_into(&state, &request(ImportKind::Jar, &installer, "forge-1.20.1-47.2.0-installer.jar"), &installer).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importInstaller");

    let forge = root.join("forge");
    fs::create_dir_all(forge.join("libraries/net/minecraftforge/forge/1.20.1-47.2.0")).unwrap();
    fs::write(forge.join("libraries/net/minecraftforge/forge/1.20.1-47.2.0/unix_args.txt"), "-p x\n").unwrap();
    jar(&forge.join("server.jar"), Some("net.minecraft.bundler.Main"), &[]);
    let error = import_into(&state, &request(ImportKind::Folder, &forge, "server.jar"), &forge).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importArgsFile");

    let launch = root.join("fabric-server-launch.jar");
    jar(&launch, Some("net.fabricmc.loader.launch.server.FabricServerLauncher"), &[]);
    let error = import_into(&state, &request(ImportKind::Jar, &launch, "fabric-server-launch.jar"), &launch).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importNeedsFolder");

    // A server.properties saved in another encoding.
    fs::write(folder.join("server.properties"), b"motd=\xc4\xe3\xba\xc3\n").unwrap();
    let error = import_into(&state, &request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar"), &folder).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importPropertiesText");
    fs::write(folder.join("server.properties"), "view-distance=10\n").unwrap();

    let empty = root.join("empty");
    fs::create_dir_all(&empty).unwrap();
    let error = import_into(&state, &request(ImportKind::Folder, &empty, "server.jar"), &empty).unwrap_err();
    assert_eq!(crate::errors::expected(error).code, "server.importNoJar");

    // The launcher's own data folder, or a folder inside it, is never copied into itself.
    let inside = state.data_dir.join("some-server");
    fs::create_dir_all(&inside).unwrap();
    jar(&inside.join("paper-1.21.4-123.jar"), Some(PAPERCLIP), &[]);
    for folder in [&inside, &state.data_dir, &root] {
        let error = import_into(&state, &request(ImportKind::Folder, folder, "paper-1.21.4-123.jar"), folder).unwrap_err();
        assert_eq!(crate::errors::expected(error).code, "server.importOwnData");
    }
    fs::remove_dir_all(&inside).unwrap();

    // A name and a version the launcher can use.
    let mut unnamed = request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar");
    unnamed.name = "  ".into();
    assert!(import_into(&state, &unnamed, &folder).is_err());
    let mut odd = request(ImportKind::Folder, &folder, "paper-1.21.4-123.jar");
    odd.version_id = "../1.21.4".into();
    assert!(import_into(&state, &odd, &folder).is_err());

    assert!(servers(&state).is_empty(), "no server or staging folder is left: {:?}", servers(&state));
    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn u4_importing_a_neoforge_args_file_folder_records_args_file_and_rejects_unsafe_flags() {
    let root = scratch();
    let state = state(&root);
    let folder = root.join("neoforge-server");
    let rel = "libraries/net/neoforged/neoforge/21.1.77/win_args.txt";
    let args_path = folder.join(rel);
    fs::create_dir_all(args_path.parent().unwrap()).unwrap();
    fs::write(
        &args_path,
        "-Djava.net.preferIPv6Addresses=system\n-DlibraryDirectory=libraries\n-p libraries/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar\n--add-modules ALL-MODULE-PATH\ncpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget forge_server\n--fml.neoForgeVersion 21.1.77\n--fml.mcVersion 1.21.1\n",
    )
    .unwrap();
    fs::write(folder.join("server.properties"), "server-port=25580\n").unwrap();
    fs::write(folder.join("eula.txt"), "eula=true\n").unwrap();

    let found = inspect(ImportKind::Folder, &folder).unwrap();
    assert_eq!(found.unsupported, None);
    assert_eq!(found.software, Some("NeoForge"));
    assert_eq!(found.minecraft_version.as_deref(), Some("1.21.1"));
    assert_eq!(found.args_file.as_deref(), Some(rel));

    let definition = import_into(&state, &args_request(&folder, "1.21.1", rel), &folder).unwrap();
    let dir = server_directory(&state, &definition.id).unwrap();
    assert_eq!(definition.jar, None);
    assert_eq!(definition.args_file.as_deref(), Some(rel));
    assert_eq!(definition.software.as_deref(), Some("NeoForge"));
    assert!(!definition.eula_accepted);
    assert!(fs::read_to_string(dir.join("eula.txt")).unwrap().contains("eula=false"));

    let info = server_info(&state, &ServerRegistry::default(), definition.clone()).unwrap();
    assert!(info.installed);
    assert_eq!(info.args_file.as_deref(), Some(rel));

    // Removing win_args.txt marks the server as no longer installed.
    fs::remove_file(dir.join(rel)).unwrap();
    assert!(!server_info(&state, &ServerRegistry::default(), definition).unwrap().installed);

    // Unsafe tokens in win_args.txt are refused before copying.
    for bad in [
        "@user_jvm_args.txt\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-javaagent:agent.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-agentlib:jdwp=transport=dt_socket\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-XX:OnError=calc.exe\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-XX:OnOutOfMemoryError=calc.exe\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-XX:VMOptionsFile=jvm.txt\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-XX:Flags=flags.txt\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-Xmx8G\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-p ../outside/evil.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-p C:\\Windows\\evil.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-DlibraryDirectory=\\\\server\\share\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-p libraries/a.jar\n",
        // Best-fit look-alikes for a space and `:` inside a quoted module path.
        "-p \"libraries/x.jar\u{2000}-XX\u{FF1A}VMOptionsFile=jvm.txt\"\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-p \u{FF3C}\u{FF3C}host\u{FF3C}share\u{FF3C}evil.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-DlegacyClassPath.file=libraries/cp.txt\n-p libraries/x.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n",
        "-p libraries/x.jar\ncpw.mods.bootstraplauncher.BootstrapLauncher\n--launchTarget forgeserver\n--universe C:\\Users\\x\n",
    ] {
        fs::write(&args_path, bad).unwrap();
        let err = inspect(ImportKind::Folder, &folder).unwrap_err();
        assert_eq!(crate::errors::expected(err).code, "server.importArgsInvalid", "{bad}");
    }

    drop(state);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn u4_args_allowlist_refuses_unlisted_jvm_options_unsafe_paths_and_two_entry_points() {
    const ENTRY: &str = "cpw.mods.bootstraplauncher.BootstrapLauncher";
    let cases: &[&[&str]] = &[
        // JVM options that were not on the old denylist, or that read more options from a file.
        &["-XX:VMOptionsFile=jvm.txt", ENTRY],
        &["-XX:Flags=flags.txt", ENTRY],
        &[r"-Xlog:all=info:file=C:\x", ENTRY],
        &[r"-XX:StartFlightRecording=filename=C:\x", ENTRY],
        &["-XX:MaxHeapSize=8m", ENTRY],
        &["-Xss4m", ENTRY],
        &["-Djava.library.path=x", ENTRY],
        &["-Dhttps.proxyHost=x", ENTRY],
        &["-Djava.net.preferIPv4Stack=true", ENTRY],
        &["-Dhelp", ENTRY],
        // The class path named by legacyClassPath.file would never be checked.
        &["-DlegacyClassPath.file=libraries/cp.txt", ENTRY],
        &[r"-DlegacyClassPath.file=..\x.txt", ENTRY],
        // Path-like system properties must stay inside the server folder.
        &[r"-DlibraryDirectory=C:\libs", ENTRY],
        &[r"-DlegacyClassPath=..\x.jar", ENTRY],
        &["-DlibraryDirectory=.. ", ENTRY],
        &["-DlibraryDirectory=...", ENTRY],
        &["-DlibraryDirectory=COM1", ENTRY],
        &[r"-DmergeModules=jna-5.10.0.jar,..\jna-platform-5.10.0.jar", ENTRY],
        &["-DignoreList=evil/path.jar", ENTRY],
        &["-Dfml.pluginLayerLibraries=libraries/a.jar,/x.jar", ENTRY],
        &[r"-Dfml.gameLayerLibraries=libraries/a.jar,..\x.jar", ENTRY],
        // Every module/class path spelling checks every element.
        &["-p", "libraries/NUL.jar", ENTRY],
        &["-cp", r"libraries\a.jar;C:\x.jar", ENTRY],
        &["-classpath", "libraries/a.jar;../x.jar", ENTRY],
        &["--module-path", "/x.jar", ENTRY],
        &["--class-path", r"\\h\s\x.jar", ENTRY],
        &[r"--class-path=C:\x.jar", ENTRY],
        &[r"--module-path=\\h\s\x.jar", ENTRY],
        &["--module-path=../x.jar", ENTRY],
        &["--class-path=libraries/a.jar;/x.jar", ENTRY],
        &["--module-path=", ENTRY],
        // Module options take module/package specs only, in both spellings.
        &["--add-opens", "java.base", ENTRY],
        &["--add-exports", "java.base/sun.security.util", ENTRY],
        &["--add-reads", "java.base=../x", ENTRY],
        &["--add-modules", "C:/x", ENTRY],
        &["--add-opens=java.base", ENTRY],
        &["--add-exports=java.base/sun.security.util=../x", ENTRY],
        &["--add-reads=java.base", ENTRY],
        &["--add-modules=../x", ENTRY],
        // The entry point is a class name, not a path.
        &["-p", "libraries/x.jar", r"C:\x.jar"],
        &["-p", "libraries/x.jar", "x/y.jar"],
        // Unknown JVM options are refused before the entry point.
        &["-p", "libraries/x.jar", "--patch-module", "java.base=evil", ENTRY],
        &["-p", "libraries/x.jar", "--upgrade-module-path", "x.jar", ENTRY],
        // A second bare token before any application argument is a second entry point.
        &["-p", "libraries/x.jar", ENTRY, "evil.Second"],
        // JVM-only options and argument files are refused after the entry point too.
        &["-p", "libraries/x.jar", ENTRY, "-XX:MaxHeapSize=8m"],
        &["-p", "libraries/x.jar", ENTRY, "-DlibraryDirectory=libraries"],
        &["-p", "libraries/x.jar", ENTRY, "--launchTarget", "forgeserver", "--patch-module", "x"],
        &["-p", "libraries/x.jar", ENTRY, "--launchTarget", "forgeserver", "--module-path", "libraries/x.jar"],
        &["-p", "libraries/x.jar", ENTRY, "@user_jvm_args.txt"],
    ];
    for case in cases {
        let tokens: Vec<String> = case.iter().map(|token| (*token).to_owned()).collect();
        let error = validate_args_file_tokens(&tokens).expect_err("must be refused");
        assert_eq!(crate::errors::expected(error).code, "server.importArgsInvalid", "{case:?}");
    }
}

#[test]
fn u4_args_allowlist_accepts_real_forge_and_neoforge_win_args_files() {
    const ENTRY: &str = "cpw.mods.bootstraplauncher.BootstrapLauncher";
    // The shape of Forge 1.20.1-47.2.0 `win_args.txt`: module path, module opens/exports,
    // then the Bootstraplauncher entry point and the Forge application arguments.
    let forge_1201 = r#"
-p libraries/cpw/mods/bootstraplauncher/1.1.2/bootstraplauncher-1.1.2.jar;libraries/cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar;libraries/org/ow2/asm/asm/9.5/asm-9.5.jar;libraries/org/ow2/asm/asm-commons/9.5/asm-commons-9.5.jar;libraries/org/ow2/asm/asm-util/9.5/asm-util-9.5.jar;libraries/org/ow2/asm/asm-tree/9.5/asm-tree-9.5.jar;libraries/org/ow2/asm/asm-analysis/9.5/asm-analysis-9.5.jar;libraries/net/minecraftforge/JarJarFileSystems/0.3.19/JarJarFileSystems-0.3.19.jar
--add-modules ALL-MODULE-PATH
--add-opens java.base/java.util.jar=cpw.mods.securejarhandler
--add-opens java.base/java.lang.invoke=cpw.mods.securejarhandler
--add-exports java.base/sun.security.util=cpw.mods.securejarhandler
--add-exports jdk.naming.dns/com.sun.jndi.dns=java.naming
-Djava.net.preferIPv6Addresses=system
-DignoreList=bootstraplauncher-1.1.2.jar,securejarhandler-2.1.10.jar,asm-9.5.jar,asm-commons-9.5.jar,asm-util-9.5.jar,asm-tree-9.5.jar,asm-analysis-9.5.jar,JarJarFileSystems-0.3.19.jar
-DlibraryDirectory=libraries
-DlegacyClassPath=libraries/cpw/mods/securejarhandler/2.1.10/securejarhandler-2.1.10.jar;libraries/net/minecraftforge/fmlloader/1.20.1-47.2.0/fmlloader-1.20.1-47.2.0.jar;libraries/net/minecraft/server/1.20.1-20230612.114412/server-1.20.1-20230612.114412-extra.jar
cpw.mods.bootstraplauncher.BootstrapLauncher
--launchTarget forgeserver
--fml.forgeVersion 47.2.0
--fml.mcVersion 1.20.1
--fml.forgeGroup net.minecraftforge
--fml.mcpVersion 20230612.114412
"#;
    // NeoForge 21.1.77 for 1.21.1: the same bootstrap, plus the two (empty) FML layer lists
    // and the NeoForge/FML versions.
    let neoforge_211 = r#"
-p libraries/cpw/mods/bootstraplauncher/2.0.2/bootstraplauncher-2.0.2.jar;libraries/cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar;libraries/org/ow2/asm/asm/9.7/asm-9.7.jar;libraries/org/ow2/asm/asm-commons/9.7/asm-commons-9.7.jar;libraries/net/neoforged/JarJarFileSystems/0.4.1/JarJarFileSystems-0.4.1.jar
--add-modules ALL-MODULE-PATH
--add-opens java.base/java.util.jar=cpw.mods.securejarhandler
--add-opens java.base/java.lang.invoke=cpw.mods.securejarhandler
--add-exports java.base/sun.security.util=cpw.mods.securejarhandler
--add-exports jdk.naming.dns/com.sun.jndi.dns=java.naming
-Djava.net.preferIPv6Addresses=system
-DignoreList=bootstraplauncher-2.0.2.jar,securejarhandler-3.0.8.jar,asm-9.7.jar,asm-commons-9.7.jar,JarJarFileSystems-0.4.1.jar
-Dfml.pluginLayerLibraries=
-Dfml.gameLayerLibraries=
-DlibraryDirectory=libraries
-DlegacyClassPath=libraries/cpw/mods/securejarhandler/3.0.8/securejarhandler-3.0.8.jar;libraries/net/neoforged/fmlloader/4.0.7/fmlloader-4.0.7.jar;libraries/net/minecraft/server/1.21.1-20240808.144430/server-1.21.1-20240808.144430-extra.jar
cpw.mods.bootstraplauncher.BootstrapLauncher
--launchTarget forgeserver
--fml.neoForgeVersion 21.1.77
--fml.fmlVersion 4.0.7
--fml.mcVersion 1.21.1
--fml.neoFormVersion 20240808.144430
"#;
    // NeoForge 21.1.209 for 1.21.11: no module path any more, a plain `-classpath`, the
    // `ALL-UNNAMED` module target and the newer startup class.
    let neoforge_21111 = r#"
--add-opens java.base/java.lang.invoke=ALL-UNNAMED
--add-exports jdk.naming.dns/com.sun.jndi.dns=java.naming
-Djava.net.preferIPv6Addresses=system
-DlibraryDirectory=libraries
-classpath libraries/net/neoforged/neoforge/21.1.209/neoforge-21.1.209-universal.jar;libraries/net/neoforged/fmlloader/4.0.7/fmlloader-4.0.7.jar;libraries/net/minecraft/server/1.21.11-20251114.120000/server-1.21.11-20251114.120000-extra.jar
net.neoforged.fml.startup.Server
--fml.neoForgeVersion 21.1.209
--fml.mcVersion 1.21.11
--fml.neoFormVersion 20251114.120000
"#;
    for (name, text) in [
        ("Forge 1.20.1", forge_1201),
        ("NeoForge 21.1.77", neoforge_211),
        ("NeoForge 21.1.209", neoforge_21111),
    ] {
        let tokens = parse_java_argfile(text).unwrap();
        assert_eq!(validate_args_file_tokens(&tokens).unwrap(), tokens, "{name}");
    }

    // The remaining allowlisted server-only properties and option spellings.
    let extra = [
        "-DmergeModules=jna-5.10.0.jar,jna-platform-5.10.0.jar",
        "-Dfml.pluginLayerLibraries=libraries/plugin-layers.jar,libraries/plugin-extra.jar",
        "-Dfml.gameLayerLibraries=libraries/game-layers.jar",
        "--add-reads",
        "java.base=ALL-UNNAMED",
        "--add-opens=java.base/java.util.jar=cpw.mods.securejarhandler",
        "--add-exports=java.base/sun.security.util=cpw.mods.securejarhandler",
        "--add-reads=java.base=ALL-UNNAMED",
        "--add-modules=ALL-MODULE-PATH",
        "-p",
        "libraries/x.jar",
        "--module-path=libraries/y.jar;./libraries/z.jar",
        "-cp",
        r"libraries\a.jar;libraries/b.jar",
        "--class-path=libraries/c.jar",
        ENTRY,
        "--launchTarget",
        "forgeserver",
        "--fml.mcVersion=1.20.1",
    ];
    let tokens: Vec<String> = extra.iter().map(|token| (*token).to_owned()).collect();
    assert_eq!(validate_args_file_tokens(&tokens).unwrap(), tokens);
}

#[test]
fn u4_args_allowlist_refuses_non_ascii_and_spaces_in_every_token() {
    const ENTRY: &str = "cpw.mods.bootstraplauncher.BootstrapLauncher";
    // Each template is accepted with a plain ASCII letter in the marked place.
    let templates: [&[&str]; 8] = [
        &["-p", "libraries/x{}y.jar", ENTRY],
        &["-cp", "libraries/x{}y.jar", ENTRY],
        &["-DlibraryDirectory=lib{}raries", ENTRY],
        &["-DlegacyClassPath=libraries/x{}y.jar", ENTRY],
        &["-DmergeModules=jna{}5.jar,jna-platform.jar", ENTRY],
        &["-p", "libraries/x.jar", ENTRY, "--launchTarget", "forge{}server"],
        &["-p", "libraries/x.jar", ENTRY, "--launchTarget", "forgeserver", "--fml.mcVersion=1.20{}1"],
        &["-p", "libraries/x.jar", ENTRY, "--launchTarget", "forgeserver", "{}Dinjected=yes"],
    ];
    let fill = |template: &[&str], with: char| -> Vec<String> {
        template.iter().map(|token| token.replace("{}", &with.to_string())).collect()
    };
    for template in templates {
        let tokens = fill(template, 'a');
        assert_eq!(validate_args_file_tokens(&tokens).unwrap(), tokens, "{template:?}");
        // Best-fit look-alikes of space, `:`, `\`, `"` and `-`, plus ASCII space, tab and DEL.
        for c in [
            '\u{2000}', '\u{3000}', '\u{FF1A}', '\u{FF3C}', '\u{FF02}', '\u{00A5}', '\u{20A9}', '\u{00AD}', ' ', '\t',
            '\u{7F}',
        ] {
            let tokens = fill(template, c);
            let error = validate_args_file_tokens(&tokens).expect_err("must be refused");
            assert_eq!(crate::errors::expected(error).code, "server.importArgsInvalid", "{tokens:?}");
        }
    }

    // The shape of a crafted file: one quoted token that best-fit would split into two options.
    let text = "-p \"libraries/x.jar\u{2000}-XX\u{FF1A}VMOptionsFile=jvm.txt\"\ncpw.mods.bootstraplauncher.BootstrapLauncher\n";
    let tokens = parse_java_argfile(text).unwrap();
    assert_eq!(tokens.len(), 3, "{tokens:?}");
    assert!(validate_args_file_tokens(&tokens).is_err());
    for value in ["\u{FF3C}\u{FF3C}host\u{FF3C}share\u{FF3C}evil.jar", "C\u{FF1A}\u{FF3C}Users"] {
        let tokens = vec!["-p".to_owned(), value.to_owned(), ENTRY.to_owned()];
        assert!(validate_args_file_tokens(&tokens).is_err(), "{value}");
        let tokens = vec![format!("-DlibraryDirectory={value}"), ENTRY.to_owned()];
        assert!(validate_args_file_tokens(&tokens).is_err(), "{value}");
    }
}

#[test]
fn u4_args_allowlist_refuses_an_argument_file_as_an_option_value() {
    const ENTRY: &str = "cpw.mods.bootstraplauncher.BootstrapLauncher";
    for option in ["-p", "-cp", "--module-path", "--add-modules"] {
        let tokens: Vec<String> = [option, "@x.txt", ENTRY].iter().map(|token| (*token).to_owned()).collect();
        assert!(
            validate_args_file_tokens(&tokens).is_err(),
            "{option} @x.txt must be refused: java expands an argument file even as an option value"
        );
    }
}

#[test]
fn u4_args_allowlist_keeps_application_argument_paths_inside_the_server_folder() {
    const ENTRY: &str = "cpw.mods.bootstraplauncher.BootstrapLauncher";
    let with_app_args = |app_args: &[&str]| -> Vec<String> {
        ["-p", "libraries/x.jar", ENTRY]
            .iter()
            .chain(app_args)
            .map(|token| (*token).to_owned())
            .collect()
    };
    let refused: &[&[&str]] = &[
        // Absolute, UNC, drive-relative and `..` paths as option values, in both spellings.
        &["--launchTarget", "forgeserver", "--universe", r"C:\Users\x"],
        &["--launchTarget", "forgeserver", "--pidFile", r"\\host\share\pid"],
        &["--launchTarget", "forgeserver", r"--pidFile=..\..\pid"],
        &["--launchTarget", "forgeserver", "--gameDir", r"C:\elsewhere"],
        &["--launchTarget", "forgeserver", "--gameDir=/elsewhere"],
        &["--launchTarget", "forgeserver", "--world", "../world"],
        &["--launchTarget", "forgeserver", "--universe", "C:worlds"],
        &["--launchTarget", "forgeserver", "--assetsDir", "//host/share"],
        // Every element of a list option.
        &["--launchTarget", "forgeserver", "--fml.mavenRoots", "libraries,/x"],
        &["--launchTarget", "forgeserver", "--fml.modLists=mods.json;..\\x.json"],
        // A path option's value is a path even without a separator, also when abbreviated.
        &["--launchTarget", "forgeserver", "--pidFile", "NUL"],
        &["--launchTarget", "forgeserver", "--universe=CON"],
        &["--launchTarget", "forgeserver", "--pid", "COM1"],
        &["--launchTarget", "forgeserver", "--gamedir", "AUX"],
        &["--launchTarget", "forgeserver", "--universe", "..."],
        // Any value that looks like a path, whatever the option, and positional values too.
        &["--launchTarget", r"C:\x"],
        &["--launchTarget", "forgeserver", "--fml.extra", "C:x"],
        // A UNC value with no drive colon and no known path option, as an option value and positional.
        &["--launchTarget", "forgeserver", "--fml.extra", r"\\h\s\x"],
        &["--launchTarget", "forgeserver", r"\\h\s\x"],
        &["--launchTarget", "forgeserver", "--fml.extra", ".."],
        &["--launchTarget", "forgeserver", "--fml.extra=a,../b"],
        &["--launchTarget", "forgeserver", "--nogui", r"..\x"],
        &["--launchTarget", "forgeserver", "--universe", "worlds", "/x"],
    ];
    for &case in refused {
        let tokens = with_app_args(case);
        let error = validate_args_file_tokens(&tokens).expect_err("must be refused");
        assert_eq!(crate::errors::expected(error).code, "server.importArgsInvalid", "{case:?}");
    }

    // Relative paths inside the folder and plain values pass through unchanged.
    let tokens = with_app_args(&[
        "--launchTarget",
        "forgeserver",
        "--fml.forgeVersion",
        "47.2.0",
        "--universe",
        "worlds",
        "--world=main",
        "--pidFile",
        "run/server.pid",
        "--gameDir",
        ".",
        "--fml.mavenRoots",
        "libraries,mods",
        "--fml.modLists=./lists/mods.json",
        "--nogui",
        "nogui",
    ]);
    assert_eq!(validate_args_file_tokens(&tokens).unwrap(), tokens);
}
