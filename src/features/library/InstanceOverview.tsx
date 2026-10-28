import { useState } from "react";
import { useTranslation } from "react-i18next";
import { openPath } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { command, type Instance } from "../../lib/launcher";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Button } from "../../components/ui/Button";
import { useInstanceBackups } from "./useInstanceContent";
import { errorText, loaderText, noticeText, sizeText } from "./utils";
import { formatDate } from "../../i18n/format";

export function InstanceOverview({
  instance,
  onChanged,
}: {
  instance: Instance;
  onChanged: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation();
  const { run } = useLauncher();
  const {
    backups,
    busy: backupsBusy,
    error: backupsError,
    refresh,
  } = useInstanceBackups(instance.id);
  const [selectedBackup, setSelectedBackup] = useState("");
  const [notice, setNotice] = useState("");
  const [includeConfigs, setIncludeConfigs] = useState(true);
  const [includeResourcePacks, setIncludeResourcePacks] = useState(false);
  const [includeShaderPacks, setIncludeShaderPacks] = useState(false);
  const [includeSaves, setIncludeSaves] = useState(false);
  const [includeOwnedAssets, setIncludeOwnedAssets] = useState(false);

  const backup = () =>
    void run("instance.backup", async () => {
      const result = await command("backup_instance", {
        instanceId: instance.id,
      });
      setNotice("backupCreated");
      await refresh();
      return result;
    });
  const clone = () =>
    void run("instance.clone", async () => {
      await command("clone_instance", {
        instanceId: instance.id,
        name: t("library:cloneName", { name: instance.name }),
      });
      setNotice("instanceCloned");
      await onChanged();
    });
  const restore = () => {
    if (!selectedBackup) return;
    void run("instance.restore", async () => {
      await command("restore_instance_backup", {
        instanceId: instance.id,
        backupId: selectedBackup,
      });
      setNotice("backupRestored");
      await onChanged();
    });
  };
  const exportZip = () =>
    void run("instance.exportZip", async () => {
      const outputPath = await save({
        title: t("library:exportZip"),
        defaultPath: `${instance.name}-backup.zip`,
        filters: [{ name: t("library:backupFileType"), extensions: ["zip"] }],
      });
      if (!outputPath) return;
      await command("export_instance_zip", {
        instanceId: instance.id,
        outputPath,
      });
      setNotice("exportComplete");
    });
  const exportPack = () =>
    void run("instance.exportPack", async () => {
      const outputPath = await save({
        title: t("library:exportPack"),
        defaultPath: `${instance.name}.mrpack`,
        filters: [
          { name: t("library:modrinthFileType"), extensions: ["mrpack"] },
        ],
      });
      if (!outputPath) return;
      await command("export_modrinth_modpack", {
        instanceId: instance.id,
        outputPath,
        name: instance.name,
        includeConfigs,
        includeResourcePacks,
        includeShaderPacks,
        includeSaves,
        includeOwnedAssets,
      });
      setNotice("exportComplete");
    });
  return (
    <div className="vx-detail-stack">
      <section className="vx-detail-section vx-overview-ledger">
        <h2>{t("library:overview")}</h2>
        <dl className="vx-facts">
          <div>
            <dt>{t("library:version")}</dt>
            <dd>{instance.versionId}</dd>
          </div>
          <div>
            <dt>{t("library:loader")}</dt>
            <dd>{loaderText(instance, t)}</dd>
          </div>
          <div>
            <dt>{t("library:directory")}</dt>
            <dd className="vx-path">{instance.gameDirectory}</dd>
          </div>
          <div>
            <dt>{t("library:lastPlayed")}</dt>
            <dd>
              {instance.lastPlayed
                ? formatDate(instance.lastPlayed, i18n.language)
                : t("library:neverPlayed")}
            </dd>
          </div>
          <div>
            <dt>{t("library:playtime")}</dt>
            <dd>
              {t("library:minutes", {
                count: Math.round(instance.totalPlayTime / 60),
              })}
            </dd>
          </div>
        </dl>
        <div className="vx-action-row">
          <Button
            variant="secondary"
            onClick={() => void openPath(instance.gameDirectory)}
          >
            {t("library:openFolder")}
          </Button>
          <Button variant="secondary" onClick={clone}>
            {t("library:clone")}
          </Button>
        </div>
      </section>
      <div className="vx-overview-operations">
        <section className="vx-detail-section">
          <div className="vx-section-heading">
            <h2>{t("library:backups")}</h2>
            <Button variant="secondary" onClick={backup}>
              {t("library:createBackup")}
            </Button>
          </div>
          {backupsError ? (
            <p role="alert">{errorText(backupsError, t)}</p>
          ) : null}
          <div className="vx-action-row">
            <select
              aria-label={t("library:backupToRestore")}
              value={selectedBackup}
              onChange={(event) => setSelectedBackup(event.target.value)}
            >
              <option value="">
                {backupsBusy
                  ? t("common:status.loading")
                  : t("library:selectBackup")}
              </option>
              {backups.map((backup) => (
                <option key={backup.id} value={backup.id}>
                  {formatDate(backup.createdAt, i18n.language)} ·{" "}
                  {sizeText(backup.size, i18n.language)}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              disabled={!selectedBackup || backupsBusy}
              onClick={restore}
            >
              {t("library:restoreBackup")}
            </Button>
          </div>
        </section>
        <section className="vx-detail-section">
          <h2>{t("library:export")}</h2>
          <div className="vx-action-row">
            <Button variant="secondary" onClick={exportZip}>
              {t("library:exportZip")}
            </Button>
            <Button variant="secondary" onClick={exportPack}>
              {t("library:exportPack")}
            </Button>
          </div>
          <div className="vx-check-grid">
            <label>
              <input
                type="checkbox"
                checked={includeConfigs}
                onChange={(event) => setIncludeConfigs(event.target.checked)}
              />{" "}
              {t("library:includeConfigs")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeResourcePacks}
                onChange={(event) =>
                  setIncludeResourcePacks(event.target.checked)
                }
              />{" "}
              {t("library:includeResourcePacks")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeShaderPacks}
                onChange={(event) =>
                  setIncludeShaderPacks(event.target.checked)
                }
              />{" "}
              {t("library:includeShaderPacks")}
            </label>
            <label>
              <input
                type="checkbox"
                checked={includeSaves}
                onChange={(event) => setIncludeSaves(event.target.checked)}
              />{" "}
              {t("library:includeSaves")}
            </label>
            {includeResourcePacks || includeShaderPacks ? (
              <label>
                <input
                  type="checkbox"
                  checked={includeOwnedAssets}
                  onChange={(event) =>
                    setIncludeOwnedAssets(event.target.checked)
                  }
                />{" "}
                {t("library:includeOwnedAssets")}
              </label>
            ) : null}
          </div>
        </section>
      </div>
      {notice ? (
        <p className="vx-inline-notice">{noticeText(notice, t)}</p>
      ) : null}
    </div>
  );
}
