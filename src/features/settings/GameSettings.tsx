import { useTranslation } from "react-i18next";
import { pickLauncherPath } from "../../lib/nativePaths";
import { Folder, FolderOpen, Plus, Trash2 } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { command, type GameFolder } from "../../lib/launcher";
import { sameGameFolderPath } from "../../lib/gameFolders";
import type { SettingsSectionProps } from "./types";

export function GameSettings({ config, onChange, onError }: SettingsSectionProps) {
  const { t } = useTranslation();
  const folders: GameFolder[] =
    config.gameFolders.length > 0
      ? config.gameFolders
      : [{ path: config.gameDirectory, label: "", active: true }];

  function apply(next: GameFolder[], activePath?: string) {
    const active =
      activePath ??
      next.find((folder) => folder.active)?.path ??
      next[0]?.path ??
      "";
    onChange({
      ...config,
      gameFolders: next.map((folder) => ({
        ...folder,
        active: sameGameFolderPath(folder.path, active),
      })),
      gameDirectory: active,
    });
  }

  async function addFolder() {
    try {
      const path = await pickLauncherPath("gameDirectory");
      if (typeof path !== "string") return;
      if (folders.some((folder) => sameGameFolderPath(folder.path, path))) return;
      apply([...folders, { path, label: "", active: false }]);
    } catch (cause) {
      onError(cause);
    }
  }

  async function openFolder(path: string) {
    try {
      await command("open_game_folder", { path });
    } catch (cause) {
      onError(cause);
    }
  }

  return (
    <div className="vx-settings-section">
      <header><h2>{t("settings:section.game")}</h2><p>{t("settings:gameDescription")}</p></header>
      <section className="vx-settings-group">
        <div data-settings-target="game-directory">
          <span className="vx-settings-group__label">{t("settings:fields.gameDirectory")}</span>
          <p className="vx-muted">{t("settings:game.foldersDescription")}</p>
          <ul className="vx-game-folders">
            {folders.map((folder) => (
              <li key={folder.path} className="vx-game-folders__row" data-active={folder.active || undefined}>
                <label className="vx-game-folders__active">
                  <input
                    type="radio"
                    name="active-game-folder"
                    checked={folder.active}
                    onChange={() => apply(folders, folder.path)}
                    aria-label={t("settings:game.makeActive", { name: folder.label || folder.path })}
                  />
                  <span>{t("settings:game.active")}</span>
                </label>
                <div className="vx-game-folders__fields">
                  <input
                    aria-label={t("settings:game.folderLabel")}
                    value={folder.label}
                    maxLength={60}
                    placeholder={folder.path}
                    onChange={(event) =>
                      apply(
                        folders.map((candidate) =>
                          sameGameFolderPath(candidate.path, folder.path)
                            ? { ...candidate, label: event.target.value }
                            : candidate,
                        ),
                      )
                    }
                  />
                  <small title={folder.path}>{folder.path}</small>
                </div>
                <div className="vx-game-folders__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<FolderOpen size={15} />}
                    aria-label={t("settings:game.openFolder", { name: folder.label || folder.path })}
                    onClick={() => void openFolder(folder.path)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Trash2 size={15} />}
                    disabled={folders.length <= 1}
                    title={folders.length <= 1 ? t("settings:game.lastFolder") : undefined}
                    aria-label={t("settings:game.removeFolder", { name: folder.label || folder.path })}
                    onClick={() => {
                      if (folders.length <= 1) return;
                      const next = folders.filter((candidate) => !sameGameFolderPath(candidate.path, folder.path));
                      apply(next, folder.active ? next[0]?.path : undefined);
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
          <Button variant="secondary" icon={<Plus size={15} />} onClick={() => void addFolder()}>
            {t("settings:game.addFolder")}
          </Button>
          <p className="vx-muted">{t("settings:game.lastFolderHint")}</p>
        </div>
        <label className="vx-settings-check" data-settings-target="game-version-isolation">
          <input type="checkbox" aria-label={t("settings:fields.versionIsolation")} checked={config.versionIsolation} onChange={(event) => onChange({ ...config, versionIsolation: event.target.checked })} />
          <span>{t("settings:fields.versionIsolation")}<small>{t("settings:game.isolationDescription")}</small></span>
        </label>
        <div className="vx-settings-fields">
          <label data-settings-target="game-window-width">
            {t("settings:fields.screenWidth")}
            <input aria-label={t("settings:fields.screenWidth")} type="number" min={320} max={16384} value={config.screenWidth} onChange={(event) => onChange({ ...config, screenWidth: Number(event.target.value) })} />
          </label>
          <label data-settings-target="game-window-height">
            {t("settings:fields.screenHeight")}
            <input aria-label={t("settings:fields.screenHeight")} type="number" min={240} max={16384} value={config.screenHeight} onChange={(event) => onChange({ ...config, screenHeight: Number(event.target.value) })} />
          </label>
        </div>
        <p className="vx-muted"><Folder size={14} aria-hidden="true" /> {t("settings:game.sharedFilesHint")}</p>
      </section>
    </div>
  );
}
