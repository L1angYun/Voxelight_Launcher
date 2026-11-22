import { useState } from "react";
import { useTranslation } from "react-i18next";
import { pickLauncherPath } from "../../lib/nativePaths";
import { command, type Instance } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import type { BackupRecoveryPaths, InstanceBackup, RecoverInstanceRestoreResult, RestoreInstanceBackupResult } from "./types";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { Dialog } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { useInstanceBackups } from "./useInstanceContent";
import { ModpackUpdate } from "./ModpackUpdate";
import { errorText, loaderText, noticeText, sizeText } from "./utils";
import { formatDate } from "../../i18n/format";

interface SharePreview {
  downloadReferences: string[];
  bundledFiles: string[];
  excludedFiles: { path: string; reason: string }[];
  fingerprint: string;
}

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
    backups, warnings, recovery,
    busy: backupsBusy,
    error: backupsError,
    refresh,
  } = useInstanceBackups(instance.id);
  const [selectedBackup, setSelectedBackup] = useState("");
  const [restoreFeedback, setRestoreFeedback] = useState<{
    failed?: boolean; text: string; paths?: BackupRecoveryPaths;
    previousBackup?: InstanceBackup | null; preservedDirectory?: string | null;
  } | null>(null);
  const chosenBackup = backups.find((item) => item.id === selectedBackup);
  const [notice, setNotice] = useState("");
  const [includeConfigs, setIncludeConfigs] = useState(false);
  const [share, setShare] = useState<{
    instanceId: string;
    options: Record<string, boolean>;
    preview: SharePreview;
  } | null>(null);
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
  const restoreFailureText = (code: string, params: Record<string, unknown>) => {
    if (params.kind === "packUpdate") {
      if (code === "backup.restoreRecoveryRequired") return t("library:modpackUpdate.recoveryRequired");
      if (code === "backup.restoreRolledBack") return t("library:modpackUpdate.rolledBack");
    }
    return errorText(code, t);
  };
  const reportRestoreFailure = (error: unknown) => {
    const fault = normalizeError(error);
    const path = (key: string) => typeof fault.params[key] === "string" ? fault.params[key] as string : undefined;
    setRestoreFeedback({
      failed: true, text: restoreFailureText(fault.code, fault.params),
      paths: fault.code === "backup.restoreRecoveryRequired" || fault.code === "backup.restoreRolledBack"
        ? { currentDirectory: path("currentDirectory") ?? instance.gameDirectory,
            previousDirectory: path("previousDirectory"), restoredDirectory: path("restoredDirectory"),
            previousBackupId: path("previousBackupId") }
        : undefined,
    });
  };
  const restore = () => {
    if (!chosenBackup || recovery || !window.confirm(t("library:backupRestoreConfirm", {
      name: instance.name, date: formatDate(chosenBackup.createdAt, i18n.language),
    }))) return;
    void run("instance.restore", async () => {
      setRestoreFeedback(null);
      setNotice("");
      try {
        const result = await command<RestoreInstanceBackupResult>("restore_instance_backup", {
          instanceId: instance.id, backupId: chosenBackup.id,
        });
        setRestoreFeedback({ text: t("library:notice.backupRestored"), previousBackup: result.previousBackup,
          preservedDirectory: result.previousDirectory });
      } catch (error) {
        reportRestoreFailure(error);
        await refresh();
        return;
      }
      await refresh();
      await onChanged();
    });
  };
  const recover = () => {
    if (!recovery) return;
    const packUpdate = recovery.kind === "packUpdate";
    if (!window.confirm(t(packUpdate ? "library:modpackUpdate.recoverConfirm" : "library:backupRecoverConfirm", { name: instance.name }))) return;
    void run("instance.restore", async () => {
      setRestoreFeedback(null);
      setNotice("");
      try {
        const result = await command<RecoverInstanceRestoreResult>("recover_instance_restore", { instanceId: instance.id });
        setRestoreFeedback({ text: t(packUpdate ? "library:modpackUpdate.recovered" : "library:backupRecovered"), previousBackup: result.previousBackup,
          preservedDirectory: result.preservedDirectory });
      } catch (error) {
        reportRestoreFailure(error);
        await refresh();
        return;
      }
      await refresh();
      await onChanged();
    });
  };
  const renderRecoveryPaths = (paths: BackupRecoveryPaths) => (
    <ul>
      <li>{t("library:backupTargetPath", { path: paths.currentDirectory })}</li>
      {paths.previousDirectory ? <li>{t("library:backupOriginalPath", { path: paths.previousDirectory })}</li> : null}
      {paths.restoredDirectory ? <li>{t("library:backupStagedPath", { path: paths.restoredDirectory })}</li> : null}
      {paths.previousBackupId ? <li>{t("library:backupPreviousId", { id: paths.previousBackupId })}</li> : null}
    </ul>
  );
  const exportZip = () =>
    void run("instance.exportZip", async () => {
      const outputPath = await pickLauncherPath("instanceArchive", `${instance.name}-backup.zip`);
      if (!outputPath) return;
      await command("export_instance_zip", {
        instanceId: instance.id,
        outputPath,
      });
      setNotice("exportComplete");
    });
  const previewPack = () =>
    void run("instance.exportPack", async () => {
      const options = { includeConfigs, includeResourcePacks, includeShaderPacks, includeSaves, includeOwnedAssets };
      const preview = await command<SharePreview>("plan_modrinth_export", { instanceId: instance.id, options });
      setShare({ instanceId: instance.id, options, preview });
    });
  const exportPack = () => {
    if (!share || share.instanceId !== instance.id) return;
    const approved = share;
    setShare(null);
    void run("instance.exportPack", async () => {
      const outputPath = await pickLauncherPath("packWrite", `${instance.name}.mrpack`);
      if (!outputPath) return;
      await command("export_modrinth_modpack", {
        instanceId: approved.instanceId, outputPath, name: instance.name, options: approved.options,
        confirmedFingerprint: approved.preview.fingerprint,
      });
      setNotice("exportComplete");
    });
  };
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
            onClick={() => void run("folder.open", () => command("open_folder", { kind: "instance", instanceId: instance.id }))}
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
          {warnings.length ? (
            <div role="status">
              <p>{t("library:backupWarnings")}</p>
              <ul>{warnings.map((warning) => (
                <li key={warning.fileName}>{t(`library:backupWarning.${warning.reason}`, { file: warning.fileName })}</li>
              ))}</ul>
            </div>
          ) : null}
          {recovery ? (
            <div role="status">
              <p>{t(recovery.kind === "packUpdate" ? "library:modpackUpdate.interrupted" : "library:backupInterrupted")}</p>
              {renderRecoveryPaths(recovery)}
              <Button variant="secondary" onClick={recover} disabled={backupsBusy}>
                {t(recovery.kind === "packUpdate" ? "library:modpackUpdate.recover" : "library:backupRecover")}
              </Button>
            </div>
          ) : null}
          {restoreFeedback ? (
            <div role={restoreFeedback.failed ? "alert" : "status"}>
              <p>{restoreFeedback.text}</p>
              {restoreFeedback.paths ? renderRecoveryPaths(restoreFeedback.paths) : null}
              {restoreFeedback.preservedDirectory ? (
                <p className="vx-path">{t("library:backupPreservedPath", { path: restoreFeedback.preservedDirectory })}</p>
              ) : null}
              {restoreFeedback.previousBackup ? (
                <p>{t("library:backupPreviousDate", { date: formatDate(restoreFeedback.previousBackup.createdAt, i18n.language) })}</p>
              ) : null}
            </div>
          ) : null}
          <div className="vx-action-row">
            <Select
              aria-label={t("library:backupToRestore")}
              value={selectedBackup}
              onChange={setSelectedBackup}
              options={[{ value: "", label: backupsBusy ? t("common:status.loading") : t("library:selectBackup") },
                ...backups.map((backup) => ({ value: backup.id,
                  label: `${formatDate(backup.createdAt, i18n.language)} · ${sizeText(backup.size, i18n.language)}` }))]} />
            <Button
              variant="secondary"
              disabled={!chosenBackup || backupsBusy || Boolean(recovery)}
              onClick={restore}
            >
              {t("library:restoreBackup")}
            </Button>
          </div>
        </section>
        <ModpackUpdate
          instance={instance}
          onChanged={onChanged}
          onBackupsChanged={refresh}
          onRecoveryFault={reportRestoreFailure}
        />
        <section className="vx-detail-section">
          <h2>{t("library:export")}</h2>
          <div className="vx-action-row">
            <Button variant="secondary" onClick={exportZip}>
              {t("library:exportZip")}
            </Button>
            <Button variant="secondary" onClick={previewPack}>
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
      {share?.instanceId === instance.id ? <Dialog open onOpenChange={(open) => { if (!open) setShare(null); }}
        title={t("library:sharePreview.title")} description={t("library:sharePreview.description")}
        footer={<><Button variant="ghost" onClick={() => setShare(null)}>{t("common:actions.cancel")}</Button>
          <Button variant="primary" onClick={exportPack}>{t("library:sharePreview.confirm")}</Button></>}>
        <details open><summary>{t("library:sharePreview.references", { count: share.preview.downloadReferences.length })}</summary>
          <ul>{share.preview.downloadReferences.map((path) => <li className="vx-path" key={path}>{path}</li>)}</ul></details>
        <details open><summary>{t("library:sharePreview.bundled", { count: share.preview.bundledFiles.length })}</summary>
          <ul>{share.preview.bundledFiles.map((path) => <li className="vx-path" key={path}>{path}</li>)}</ul></details>
        <details><summary>{t("library:sharePreview.excluded", { count: share.preview.excludedFiles.length })}</summary>
          <ul>{share.preview.excludedFiles.map((file) => <li className="vx-path" key={file.path}>{file.path} · {t(`library:sharePreview.reason.${file.reason}`)}</li>)}</ul></details>
      </Dialog> : null}
      {notice ? (
        <p className="vx-inline-notice">{noticeText(notice, t)}</p>
      ) : null}
    </div>
  );
}
