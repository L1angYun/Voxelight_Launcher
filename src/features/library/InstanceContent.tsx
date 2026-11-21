import { useTranslation } from "react-i18next";
import { useEffect, useId, useRef, useState } from "react";
import { command } from "../../lib/launcher";
import type { LocalResource } from "./types";
import { Download, History, RefreshCw, Upload } from "lucide-react";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { ExternalLink } from "../../components/ui/ExternalLink";
import { Select } from "../../components/ui/Select";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { useResourceManager } from "./useInstanceContent";
import { errorText, noticeText, sizeText } from "./utils";
import { formatDate } from "../../i18n/format";

function LocalModIcon({ fileName, versionId, instanceId }: { fileName: string; versionId: string; instanceId?: string }) {
  const container = useRef<HTMLSpanElement>(null);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    const target = container.current;
    if (!target || typeof IntersectionObserver === "undefined") return;
    let disposed = false;
    let started = false;
    const observer = new IntersectionObserver((entries) => {
      if (disposed || started || !entries.some((entry) => entry.isIntersecting)) return;
      started = true;
      observer.disconnect();
      void command<string | null>("read_local_mod_icon", { fileName, versionId, instanceId }).then((value) => {
        if (!disposed && value?.startsWith("data:image/png;base64,")) setIcon(value);
      }).catch(() => {});
    });
    observer.observe(target.closest(".vx-resource-row") ?? target);
    return () => { disposed = true; observer.disconnect(); };
  }, [fileName, versionId, instanceId]);
  return <span ref={container} aria-hidden="true">{icon ? <img src={icon} alt="" width={24} height={24} onError={() => setIcon(null)} /> : null}</span>;
}

function LocalFileName({ file, versionId, instanceId }: { file: LocalResource; versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const meta = file.metadata;
  const details = [meta?.version, ...(meta?.authors ?? [])].filter(Boolean).join(" · ");
  return <div>
    {meta?.hasIcon ? <LocalModIcon key={`${versionId}:${instanceId ?? ""}:${file.fileName}:${file.size}:${file.modifiedMs ?? ""}`} fileName={file.fileName} versionId={versionId} instanceId={instanceId} /> : null}
    <strong>{meta?.name || file.name}</strong>
    <small>{file.fileName} · {sizeText(file.size, i18n.language)}{details ? ` · ${details}` : ""}</small>
    {meta?.dependencies.map((dep, i) => <span key={`${dep.id}:${i}`} className="vx-dependency-kind" data-kind={dep.kind}>
      {t(`discover:dependency.${dep.kind}`)} · {dep.id}{dep.range ? ` ${dep.range}` : ""}
    </span>)}
  </div>;
}

export function InstanceContent({ versionId, instanceId }: { versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const manager = useResourceManager(versionId, instanceId);
  const { kind, setKind, view, setView, files, updates, curseforgeSkipped, curseforgeFailed, history, busy, error, notice } = manager;
  const waitingForView = busy === view || (view === "files" && busy === "import");
  const showEmpty = !waitingForView && !error;
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
            <LocalFileName file={file} versionId={versionId} instanceId={instanceId} />
            <Button variant={file.enabled ? "secondary" : "ghost"} aria-pressed={file.enabled} onClick={() => void manager.toggle(file)}>{file.enabled ? t("library:enabled") : t("library:disabled")}</Button>
          </div>
        ))}</div> : showEmpty ? <EmptyState title={t("library:noResources")} description={t("library:noResourcesDescription")} /> : null
      ) : null}
      {view === "updates" ? (
        <>
          {curseforgeSkipped ? <p className="vx-inline-notice">{t("library:curseforgeSkipped")}</p> : null}
          {curseforgeFailed ? <p className="vx-inline-notice">{t("library:curseforgeFailed")}</p> : null}
          {updates === null ? (showEmpty ? <EmptyState title={t("library:updatesNotChecked")} /> : null) : updates.length ? <div className="vx-resource-list">{updates.map((update) => (
            <div className="vx-resource-row" key={update.fileName}>
              <div>
                <strong>{update.name}</strong>
                <small>{t(`library:source.${update.source}`)} · {update.currentVersion} → {update.newVersion}</small>
                {update.manualOnly ? <small>{t("library:manualOnlyHint")}</small> : null}
              </div>
              {update.manualOnly
                ? update.projectUrl ? <ExternalLink url={update.projectUrl}>{t("library:manualDownload")}</ExternalLink> : null
                : <Button variant="secondary" onClick={() => void manager.applyUpdate(update)}>{t("library:update")}</Button>}
            </div>
          ))}</div> : showEmpty ? <EmptyState title={t("library:noUpdates")} /> : null}
        </>
      ) : null}
      {view === "history" ? (
        history === null ? (showEmpty ? <EmptyState title={t("library:historyNotLoaded")} /> : null) : history.length ? <div className="vx-resource-list">{history.map((entry) => (
          <div className="vx-resource-row" key={entry.updateId}>
            <div><strong>{entry.name}</strong><small>{formatDate(entry.createdAt, i18n.language)} · {t(`library:historyStatus.${entry.status}`)}</small></div>
            {entry.canRecover ? (
              <Button variant="secondary" disabled={Boolean(busy)}
                onClick={() => void manager.recover(entry, t("library:recoverTransactionConfirm", { name: entry.name }))}>
                {t("library:recoverTransaction")}
              </Button>
            ) : entry.status === "committed" ? <Button variant="ghost" onClick={() => void manager.rollback(entry, t("library:rollbackConfirm", { name: entry.name }))}>{t("library:rollback")}</Button> : null}

          </div>
        ))}</div> : showEmpty ? <EmptyState title={t("library:noHistory")} /> : null
      ) : null}
      </SectionPanel>
    </div>
  );
}
