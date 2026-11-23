# SPDX-License-Identifier: GPL-3.0-only
"""Installer artwork made from the launcher's own visuals.

The scene is a frame of the launcher's Massif world in the dark theme: the
world canvas alone, rendered by the app in a 700x1256 window so the camera
frames it upright, kept at src-tauri/installer/windows/assets/source/massif-dark.png.
The icons and the page-header mark are the app icon. The page colors in
VoxelightPages.nsh and installer.nsi are the launcher's light-theme tokens.
Run this after changing the source frame or the app icon.
"""
import shutil
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "src-tauri" / "installer" / "windows" / "assets"
SOURCE = ASSETS / "source" / "massif-dark.png"
APP_ICON = ROOT / "src-tauri" / "icons" / "icon.ico"
# The launcher's light theme, --bg-base: the installer pages' background.
BACKGROUND = (0xF3, 0xF1, 0xEB)


def upright(scene: Image.Image, size: tuple[int, int]) -> Image.Image:
    """The middle of the frame with the target's proportions, resized."""
    width, height = scene.size
    slice_width = min(width, round(height * size[0] / size[1]))
    left = (width - slice_width) // 2
    return scene.crop((left, 0, left + slice_width, height)).resize(size, Image.Resampling.LANCZOS)


def app_icon(size: int) -> Image.Image:
    icon = Image.open(APP_ICON)
    icon.size = (256, 256)
    return icon.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)


def save_assets(out: Path = ASSETS):
    scene = Image.open(SOURCE).convert("RGB")
    # The art column of the welcome and finish pages shows at about 175x314
    # px at 100% scaling; twice that stays sharp at 200%.
    upright(scene, (350, 628)).save(out / "scene.bmp")
    # The classic NSIS sidebar, used by the uninstaller's pages.
    upright(scene, (164, 314)).save(out / "sidebar.bmp")
    header = Image.new("RGB", (150, 57), BACKGROUND)
    mark = app_icon(44)
    header.paste(mark, (99, 6), mark)
    header.save(out / "header.bmp")
    # The app's own icon file, with its hand-made small sizes.
    for name in ("installer", "uninstaller"):
        shutil.copyfile(APP_ICON, out / f"{name}.ico")
    print(f"Installer artwork written to {out}")


if __name__ == "__main__":
    save_assets(Path(sys.argv[1]) if len(sys.argv) > 1 else ASSETS)
