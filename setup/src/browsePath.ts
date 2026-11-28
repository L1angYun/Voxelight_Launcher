// SPDX-License-Identifier: GPL-3.0-only
/** Folder the launcher is installed into, matching the NSIS directory page. */
export const INSTALL_FOLDER_NAME = "Voxelight Launcher";

/**
 * Turns a folder chosen in the Browse dialog into the actual installation
 * folder.
 *
 * Like the NSIS directory page, Setup appends `\Voxelight Launcher` to the
 * picked folder unless the picked path is empty or already names that folder.
 * Without this, browsing to `D:\Games` would install the launcher files
 * directly into `D:\Games` and the byte-progress monitor would walk a folder
 * the user did not mean to use as the installation.
 */
export function installFolderFromPicked(picked: string | null | undefined): string | null {
  const trimmed = (picked ?? "").trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\//g, "\\");
  const withoutTrailingSeparators = normalized.replace(/\\+$/, "");
  if (!withoutTrailingSeparators) return null;
  const last = withoutTrailingSeparators.split("\\").pop() ?? "";
  if (last.toLowerCase() === INSTALL_FOLDER_NAME.toLowerCase()) {
    return withoutTrailingSeparators;
  }
  return `${withoutTrailingSeparators}\\${INSTALL_FOLDER_NAME}`;
}
