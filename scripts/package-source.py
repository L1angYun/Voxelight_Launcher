# SPDX-License-Identifier: GPL-3.0-only
import argparse
import hashlib
import json
import re
from pathlib import Path, PurePosixPath
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = {
    ".gitignore",
    "index.html",
    "LICENSE",
    "NOTICE",
    "README.md",
    "THIRD_PARTY_NOTICES.md",
    "package.json",
    "package-lock.json",
    "playwright.config.ts",
    "tsconfig.json",
    "vite.config.ts",
    "vitest.config.ts",
}
SOURCE_DIRECTORIES = (
    "src",
    "public",
    "scripts",
    "tests",
    "licenses",
    "src-tauri/src",
    "src-tauri/tests",
    "src-tauri/capabilities",
    "src-tauri/permissions",
    "src-tauri/icons",
    "src-tauri/installer",
)
TAURI_FILES = ("Cargo.toml", "Cargo.lock", "app.manifest", "build.rs", "tauri.conf.json")
BLOCKED_PARTS = {".git", ".vs", "node_modules", "target", "dist", "releases", "_backup", "__pycache__"}
BLOCKED_FILES = {
    "steve.png",
    "alex.png",
    "background-beams.tsx",
    "landscape.tsx",
    "settings.json",
    "accounts.json",
    "instances.json",
}
# Files whose absence can break the release build, link, or its verification.
# Directory entries above still select the rest of the application and tests.
REQUIRED = ROOT_FILES | {f"src-tauri/{name}" for name in TAURI_FILES} | {
    "src/main.tsx",
    "src/app/App.tsx",
    "src/i18n/locales/zh-CN/settings.json",
    "src/i18n/locales/en-US/settings.json",
    "public/fonts/Doto-Black.woff2",
    "public/fonts/MiSans-Regular.woff2",
    "public/fonts/MiSans-Semibold.woff2",
    "licenses/fonts/Doto/OFL.txt",
    "licenses/fonts/MiSans/LICENSE.pdf",
    "src/components/WorldScene.tsx",
    "src-tauri/src/main.rs",
    "src-tauri/src/lib.rs",
    "src-tauri/tests/build_config.rs",
    "src-tauri/capabilities/default.json",
    "src-tauri/permissions/launcher.toml",
    "src-tauri/src/game_process.rs",
    "src-tauri/src/process_output.rs",
    "src-tauri/src/path_grants.rs",
    "src/lib/nativePaths.ts",
    "src-tauri/icons/32x32.png",
    "src-tauri/icons/128x128.png",
    "src-tauri/icons/icon.ico",
    "src-tauri/installer/windows/installer.nsi",
    "src-tauri/installer/windows/FileAssociation.nsh",
    "src-tauri/installer/windows/VoxelightPages.nsh",
    "src-tauri/installer/windows/utils.nsh",
    "src-tauri/installer/windows/languages/English.nsh",
    "src-tauri/installer/windows/languages/SimpChinese.nsh",
    "src-tauri/installer/windows/assets/MiSans-Regular.ttf",
    "src-tauri/installer/windows/assets/MiSans-Semibold.ttf",
    "src-tauri/installer/windows/assets/header.bmp",
    "src-tauri/installer/windows/assets/sidebar.bmp",
    "src-tauri/installer/windows/assets/scene.bmp",
    "src-tauri/installer/windows/assets/installer.ico",
    "src-tauri/installer/windows/assets/uninstaller.ico",
    "licenses/dependency-inventory.json",
    "scripts/build.ps1",
    "scripts/build-process-safety.ps1",
    "scripts/build-runtime.mjs",
    "scripts/check-public-secrets.mjs",
    "scripts/installer-safety.ps1",
    "scripts/repair-build-integrity.ps1",
    "scripts/run-medium.mjs",
    "scripts/signing-receipt.mjs",
    "scripts/tauri.mjs",
    "tests/fixtures/skin64.png",
}


def allowed(path: Path) -> bool:
    parts = tuple(part.lower() for part in path.relative_to(ROOT).parts)
    lower = parts[-1]
    if any(part in BLOCKED_PARTS for part in parts):
        return False
    is_locale = parts[:3] == ("src", "i18n", "locales")
    if (lower in BLOCKED_FILES and not is_locale) or lower.startswith(".env") or path.suffix.lower() in {".log", ".tmp", ".part", ".key", ".pem", ".p12", ".pfx", ".obj"}:
        return False
    if parts[:3] == ("public", "assets", "skins"):
        return False
    return path.is_file() and not path.is_symlink()


def source_files():
    selected = set()
    for name in ROOT_FILES:
        path = ROOT / name
        if allowed(path):
            selected.add(path.relative_to(ROOT))
    for name in TAURI_FILES:
        path = ROOT / "src-tauri" / name
        if allowed(path):
            selected.add(path.relative_to(ROOT))
    for directory in SOURCE_DIRECTORIES:
        base = ROOT / directory
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if allowed(path):
                selected.add(path.relative_to(ROOT))
    for path in (ROOT / "docs").rglob("*.md"):
        if allowed(path):
            selected.add(path.relative_to(ROOT))
    missing = REQUIRED.difference(path.as_posix() for path in selected)
    if missing:
        raise RuntimeError(f"Required source files are missing: {sorted(missing)}")
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))["version"]
    for path in (ROOT / "docs" / "screenshots" / version).rglob("*.png"):
        if allowed(path):
            selected.add(path.relative_to(ROOT))
    return sorted(selected, key=lambda path: path.as_posix())


def main():
    files = source_files()
    config = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text(encoding="utf-8"))
    version = config["version"]
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    lock = json.loads((ROOT / "package-lock.json").read_text(encoding="utf-8"))
    cargo = (ROOT / "src-tauri/Cargo.toml").read_text(encoding="utf-8")
    cargo_version = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.MULTILINE)
    inventory = json.loads((ROOT / "licenses/dependency-inventory.json").read_text(encoding="utf-8"))
    if not cargo_version or {version, package["version"], lock["version"], lock["packages"][""]["version"], cargo_version.group(1), inventory["version"]} != {version}:
        raise RuntimeError("Package, Cargo, Tauri, lockfile and license inventory versions must match")
    if package.get("license") != "GPL-3.0-only" or config["bundle"].get("license") != "GPL-3.0-only":
        raise RuntimeError("The source and bundle must declare GPL-3.0-only")
    parser = argparse.ArgumentParser(description="Package the GPL source corresponding to this checkout")
    parser.add_argument("--output", type=Path, default=ROOT / "releases" / version / f"VoxelightLauncher-{version}-source.zip")
    args = parser.parse_args()
    output = args.output.expanduser().resolve()
    if output.suffix.lower() != ".zip":
        raise RuntimeError("The source archive must be a .zip file")
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "project": "Voxelight Launcher",
        "version": version,
        "license": "GPL-3.0-only",
        "files": [
            {
                "path": path.as_posix(),
                "bytes": (ROOT / path).stat().st_size,
                "sha256": hashlib.sha256((ROOT / path).read_bytes()).hexdigest(),
            }
            for path in files
        ],
    }
    prefix = f"VoxelightLauncher-{version}"
    temporary = output.with_suffix(".zip.tmp")
    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for path in files:
            info = zipfile.ZipInfo(f"{prefix}/{path.as_posix()}", (1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o100644 << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, (ROOT / path).read_bytes())
        info = zipfile.ZipInfo(f"{prefix}/SOURCE_MANIFEST.json", (1980, 1, 1, 0, 0, 0))
        info.external_attr = 0o100644 << 16
        info.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(info, json.dumps(manifest, ensure_ascii=False, indent=2).encode("utf-8"))
    with zipfile.ZipFile(temporary) as archive:
        if archive.testzip() is not None:
            raise RuntimeError("Source archive CRC validation failed")
        names = archive.namelist()
        if len(names) != len(files) + 1:
            raise RuntimeError("Source archive contains an unexpected file count")
        for name in names:
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts or not name.startswith(f"{prefix}/"):
                raise RuntimeError(f"Unsafe archive path: {name}")
        embedded = json.loads(archive.read(f"{prefix}/SOURCE_MANIFEST.json"))
        for entry in embedded["files"]:
            contents = archive.read(f"{prefix}/{entry['path']}")
            if len(contents) != entry["bytes"] or hashlib.sha256(contents).hexdigest() != entry["sha256"]:
                raise RuntimeError(f"Source archive hash mismatch: {entry['path']}")
        if archive.read(f"{prefix}/LICENSE") != (ROOT / "LICENSE").read_bytes():
            raise RuntimeError("The archive GPL text differs from the checkout")
    temporary.replace(output)
    print(json.dumps({
        "archive": str(output),
        "files": len(files) + 1,
        "bytes": output.stat().st_size,
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
