# SPDX-License-Identifier: GPL-3.0-only
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[2]
NATIVE_INPUTS = {
    "src-tauri/app.manifest",
    "src-tauri/tests/build_config.rs",
}
# Voxelight Setup is the published installer, so its source ships too.
SETUP_INPUTS = {
    "setup/index.html",
    "setup/vitest.config.ts",
    "setup/src/main.tsx",
    "setup/src/App.tsx",
    "setup/src-tauri/Cargo.toml",
    "setup/src-tauri/Cargo.lock",
    "setup/src-tauri/build.rs",
    "setup/src-tauri/tauri.conf.json",
    "setup/src-tauri/app.manifest",
    "setup/src-tauri/capabilities/default.json",
    "setup/src-tauri/permissions/setup.toml",
    "setup/src-tauri/src/main.rs",
    "setup/src-tauri/src/lib.rs",
}
# Build outputs and dependencies that can sit inside the Setup tree.
SETUP_OUTPUTS = (
    "setup/src-tauri/gen/schemas/desktop-schema.json",
    "setup/src-tauri/target/release/voxelight-setup.exe",
    "setup/node_modules/fixture-package/index.js",
    "dist/setup/index.html",
)


class SourcePackageTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        directory = tempfile.TemporaryDirectory(prefix="voxelight-source-package-")
        cls.addClassCleanup(directory.cleanup)
        root = Path(directory.name)
        archive_path = root / "source.zip"
        subprocess.run(
            [sys.executable, "-B", ROOT / "scripts/package-source.py", "--output", archive_path],
            cwd=ROOT,
            check=True,
            capture_output=True,
        )
        with zipfile.ZipFile(archive_path) as archive:
            prefix = archive.namelist()[0].split("/", 1)[0]
            cls.members = {name.removeprefix(f"{prefix}/") for name in archive.namelist()}
            with archive.open(f"{prefix}/SOURCE_MANIFEST.json") as manifest:
                cls.manifest_paths = {entry["path"] for entry in json.load(manifest)["files"]}
            archive.extractall(root)
        cls.extracted = root / prefix
        spec = importlib.util.spec_from_file_location(
            "source_package_test_subject", cls.extracted / "scripts/package-source.py"
        )
        cls.package = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.package)

    def test_source_zip_contains_windows_manifest_and_build_config_test(self):
        self.assertEqual(NATIVE_INPUTS - self.members, set())
        self.assertEqual(NATIVE_INPUTS - self.manifest_paths, set())

    def test_source_zip_contains_voxelight_setup_sources(self):
        self.assertEqual(SETUP_INPUTS - self.members, set())
        self.assertEqual(SETUP_INPUTS - self.manifest_paths, set())
        tracked = subprocess.run(
            ["git", "ls-files", "-z", "--", "setup"], cwd=ROOT, capture_output=True
        )
        if tracked.returncode != 0:
            self.skipTest("not a git checkout")
        setup_files = {name for name in tracked.stdout.decode("utf-8").split("\0") if name}
        self.assertTrue(setup_files)
        self.assertEqual(setup_files - self.members, set())
        self.assertEqual(setup_files - self.manifest_paths, set())

    def test_packager_leaves_setup_build_outputs_out(self):
        created = []
        try:
            for relative in SETUP_OUTPUTS:
                path = self.extracted / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"synthetic build output")
                created.append(path)
            selected = {path.as_posix() for path in self.package.source_files()}
            for relative in SETUP_OUTPUTS:
                with self.subTest(path=relative):
                    self.assertNotIn(relative, selected)
            self.assertIn("setup/src-tauri/src/lib.rs", selected)
        finally:
            for path in created:
                path.unlink(missing_ok=True)

    def test_packager_rejects_extracted_tree_missing_a_build_input(self):
        inputs = NATIVE_INPUTS | {"src-tauri/build.rs", "src-tauri/tauri.conf.json"} | SETUP_INPUTS
        for relative in sorted(inputs):
            with self.subTest(path=relative):
                path = self.extracted / relative
                original = path.read_bytes() if path.is_file() else None
                path.unlink(missing_ok=True)
                try:
                    with self.assertRaises(RuntimeError) as error:
                        self.package.source_files()
                    self.assertIn(relative, str(error.exception))
                finally:
                    if original is not None:
                        path.write_bytes(original)

    def test_packager_keeps_proprietary_skin_asset_exclusion(self):
        relative = Path("public/assets/skins/source-package-test-fixture.png")
        path = self.extracted / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"synthetic asset, not a game texture")
        try:
            self.assertFalse(relative in self.package.source_files(), relative.as_posix())
        finally:
            path.unlink()


if __name__ == "__main__":
    unittest.main()
