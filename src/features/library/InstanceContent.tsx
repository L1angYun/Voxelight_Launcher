import { useTranslation } from "react-i18next";
import { useId } from "react";
import { Download, History, RefreshCw, Upload } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { useResourceManager } from "./useInstanceContent";
import { errorText, noticeText, sizeText } from "./utils";
import { formatDate } from "../../i18n/format";

export function InstanceContent({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const manager = useResourceManager(versionId, instanceId);
  const { kind, setKind, view, setView, files, updates, history, busy, error, notice } = manager;
  return (
    <div className="vx-detail-stack">
      <div className="vx-toolbar">
        <Select
          className="vx-resource-kind-select"
          aria-label={t("library:resourceKind")}
          value={kind}
          onChange={(value) => setKind(value as typeof kind)}
          options={[
            { value: "resourcepack", label: t("library:resourcepacks") },
            { value: "mod", label: t("library:mods") },
            { value: "shader", label: t("library:shaders") },
          ]}
        />
        <div className="vx-action-row">
          <Button variant="secondary" icon={<Upload size={15} />} onClick={() => void manager.importFiles()}>{t("library:importResources")}</Button>
          <Button variant="secondary" icon={<RefreshCw size={15} />} onClick={() => void manager.refresh()}>{t("common:actions.retry")}</Button>
          <Button variant="secondary" icon={<Download size={15} />} onClick={() => void manager.checkUpdates()}>{t("library:checkUpdates")}</Button>
          <Button variant="ghost" icon={<History size={15} />} onClick={() => void manager.showHistory()}>{t("library:history")}</Button>
        </div>
      </div>
      <Segmented semantic="tabs" label={t("library:resourceViews")} value={view} onChange={setView}
        idPrefix={`${id}-resource-tab`} panelId={`${id}-resource-panel`}
        options={(["files", "updates", "history"] as const).map((value) => ({ value, label: t(`library:${value}`) }))} />
      <LoadingStatus active={Boolean(busy)}>{t("common:status.loading")}</LoadingStatus>
      {error ? <p role="alert">{errorText(error, t)}</p> : null}
      {notice ? <p className="vx-inline-notice">{noticeText(notice, t)}</p> : null}
      <SectionPanel selectionKey={`${kind}:${view}`} role="tabpanel" id={`${id}-resource-panel`} aria-labelledby={`${id}-resource-tab-${view}`}>
      {view === "files" ? (
        files.length ? <div className="vx-resource-list">{files.map((file) => (
          <div className="vx-resource-row" key={file.fileName}>
            <div><strong>{file.name}</strong><small>{file.fileName} · {sizeText(file.size, i18n.language)}</small></div>
            <Button variant={file.enabled ? "secondary" : "ghost"} aria-pressed={file.enabled} onClick={() => void manager.toggle(file)}>{file.enabled ? t("library:enabled") : t("library:disabled")}</Button>
          </div>
        ))}</div> : <EmptyState title={t("library:noResources")} description={t("library:noResourcesDescription")} />
      ) : null}
      {view === "updates" ? (
        updates === null ? <EmptyState title={t("library:updatesNotChecked")} /> : updates.length ? <div className="vx-resource-list">{updates.map((update) => (
          <div className="vx-resource-row" key={update.fileName}>
            <div><strong>{update.name}</strong><small>{update.currentVersion} → {update.newVersion}</small></div>
            <Button variant="secondary" onClick={() => void manager.applyUpdate(update)}>{t("library:update")}</Button>
          </div>
        ))}</div> : <EmptyState title={t("library:noUpdates")} />
      ) : null}
      {view === "history" ? (
        history === null ? <EmptyState title={t("library:historyNotLoaded")} /> : history.length ? <div className="vx-resource-list">{history.map((entry) => (
          <div className="vx-resource-row" key={entry.updateId}>
            <div><strong>{entry.name}</strong><small>{formatDate(entry.createdAt, i18n.language)} · {t(`library:historyStatus.${entry.status}`)}</small></div>
            {entry.status === "committed" ? <Button variant="ghost" onClick={() => void manager.rollback(entry, t("library:rollbackConfirm", { name: entry.name }))}>{t("library:rollback")}</Button> : null}
          </div>
        ))}</div> : <EmptyState title={t("library:noHistory")} />
      ) : null}
      </SectionPanel>
    </div>
  );
}
