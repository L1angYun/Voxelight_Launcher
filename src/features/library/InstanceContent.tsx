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
import { useFileDrop } from "../../app/FileDropContext";
import { displayName, resourceCounts, visibleResources, type ResourceSort, type ResourceStateFilter } from "./localContentFilter";
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
  const { kind, setKind, view, setView, files, updates, curseforgeSkipped, curseforgeFailed, history, busy, error, notice, noticeParams,
    selectedFiles, selectedFileNames, selectFile, selectVisible, clearSelection, toggleMany, deleteMany, importPaths } = manager;
  useFileDrop((dropped) => {
    if (dropped.mods.length > 0) {
      void importPaths(dropped.mods, "mod");
      return true;
    }
    if (dropped.zips.length > 0) {
      const targetKind = kind === "shader" ? "shader" : "resourcepack";
      void importPaths(dropped.zips, targetKind);
      return true;
    }
    return false;
  }, { priority: 20, hintKey: "shell:drop.hintInstanceContent" });
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<ResourceStateFilter>("all");
  const [sort, setSort] = useState<ResourceSort>("name");
  const searchRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const [focusAfterDelete, setFocusAfterDelete] = useState(false);
  useEffect(() => {
    if (!focusAfterDelete) return;
    setFocusAfterDelete(false);
    (selectAllRef.current ?? searchRef.current)?.focus();
  }, [focusAfterDelete, files]);
  const waitingForView = busy === view || (view === "files" && busy === "import");
  const showEmpty = !waitingForView && !error;
  const visible = visibleResources(files, { query, state: stateFilter, sort });
  const counts = resourceCounts(files, query);
  const allVisibleSelected = visible.length > 0 && visible.every((file) => selectedFileNames.has(file.fileName));
  const someVisibleSelected = visible.some((file) => selectedFileNames.has(file.fileName));
  const clearSelectionAndFocus = () => {
    clearSelection();
    // The Clear button becomes disabled with nothing selected, so hand keyboard
    // focus to a control that remains available.
    (visible.length ? selectAllRef.current : searchRef.current)?.focus();
  };
  const changeKind = (value: string) => {
    setQuery("");
    clearSelection();
    setKind(value as typeof kind);
  };
  const deleteSelected = async () => {
    const hadFocus = document.activeElement === deleteRef.current;
    const deleted = await deleteMany(selectedFiles, t("library:batchDeleteConfirm", { count: selectedFiles.length }));
    // This action always deletes the whole selection, so success leaves nothing
    // selected; if focus was on Delete or fell back to body, move it cleanly
    // after the refreshed list renders rather than losing it with the button.
    if (deleted && (hadFocus || document.activeElement === deleteRef.current || document.activeElement === document.body)) {
      setFocusAfterDelete(true);
    }
  };
  return (
    <div className="vx-detail-stack">
      <div className="vx-toolbar">
        <Select
          className="vx-resource-kind-select"
          aria-label={t("library:resourceKind")}
          value={kind}
          disabled={Boolean(busy)}
          onChange={changeKind}
          options={[
            { value: "resourcepack", label: t("library:resourcepacks") },
            { value: "mod", label: t("library:mods") },
            { value: "shader", label: t("library:shaders") },
          ]}
        />
        <div className="vx-action-row">
          <Button variant="secondary" icon={<Upload size={15} />} disabled={Boolean(busy)} onClick={() => void manager.importFiles()}>{t("library:importResources")}</Button>
          <Button variant="secondary" icon={<RefreshCw size={15} />} disabled={Boolean(busy)} onClick={() => void manager.refresh()}>{t("common:actions.retry")}</Button>
          <Button variant="secondary" icon={<Download size={15} />} disabled={Boolean(busy)} onClick={() => void manager.checkUpdates()}>{t("library:checkUpdates")}</Button>
          <Button variant="ghost" icon={<History size={15} />} disabled={Boolean(busy)} onClick={() => void manager.showHistory()}>{t("library:history")}</Button>
        </div>
      </div>
      <Segmented semantic="tabs" label={t("library:resourceViews")} value={view} onChange={setView}
        idPrefix={`${id}-resource-tab`} panelId={`${id}-resource-panel`}
        options={(["files", "updates", "history"] as const).map((value) => ({ value, label: t(`library:${value}`) }))} />
      <LoadingStatus active={Boolean(busy)}>{t("common:status.loading")}</LoadingStatus>
      {error ? <p role="alert">{errorText(error, t)}</p> : null}
      {notice ? <p className="vx-inline-notice">{noticeText(notice, t, noticeParams)}</p> : null}
      <SectionPanel selectionKey={`${kind}:${view}`} role="tabpanel" id={`${id}-resource-panel`} aria-labelledby={`${id}-resource-tab-${view}`}>
      {view === "files" ? (
        files.length ? (
          <div className="vx-resource-files">
            <div className="vx-resource-controls">
              <input className="vx-resource-search" type="search" aria-label={t("library:resourceSearch")}
                ref={searchRef}
                placeholder={t("library:resourceSearchPlaceholder")} value={query}
                autoComplete="off" spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
              <Segmented<ResourceStateFilter> className="vx-resource-filter" semantic="toggle" label={t("library:resourceFilter")}
                value={stateFilter} onChange={setStateFilter}
                options={[
                  { value: "all", label: t("library:filterAll", { count: counts.all }) },
                  { value: "enabled", label: t("library:filterEnabled", { count: counts.enabled }) },
                  { value: "disabled", label: t("library:filterDisabled", { count: counts.disabled }) },
                ]} />
              <Select className="vx-resource-sort" aria-label={t("library:sort")} value={sort}
                onChange={(value) => setSort(value as ResourceSort)}
                options={[
                  { value: "name", label: t("library:sortName") },
                  { value: "size", label: t("library:sortSize") },
                  { value: "modified", label: t("library:sortModified") },
                ]} />
            </div>
            {/* Always mounted: the bar reserves its space so the list never shifts,
                and its live region exists before the first selected count changes. */}
            <div className="vx-resource-batch">
              <span role="status">{t("library:selectedCount", { count: selectedFiles.length })}</span>
              <Button variant="secondary" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void toggleMany(selectedFiles, true)}>{t("library:batchEnable")}</Button>
              <Button variant="secondary" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void toggleMany(selectedFiles, false)}>{t("library:batchDisable")}</Button>
              <Button ref={deleteRef} variant="secondary" tone="danger" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void deleteSelected()}>{t("library:batchDelete")}</Button>
              {/* Remains mounted so clearing selection never removes a focused control. */}
              <Button variant="ghost" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={clearSelectionAndFocus}>{t("library:batchClear")}</Button>
            </div>
            {visible.length ? (
              <div className="vx-resource-list">
                <div className="vx-resource-list__header">
                  <input type="checkbox" aria-label={t("library:selectAllVisible")} checked={allVisibleSelected}
                    disabled={Boolean(busy)}
                    ref={(node) => {
                      selectAllRef.current = node;
                      if (node) node.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    onChange={(event) => selectVisible(visible, event.target.checked)} />
                </div>
                {visible.map((file) => (
                  <div className="vx-resource-row vx-resource-file-row" key={file.fileName}>
                    <input type="checkbox" aria-label={displayName(file)} checked={selectedFileNames.has(file.fileName)}
                      disabled={Boolean(busy)} onChange={(event) => selectFile(file, event.target.checked)} />
                    <LocalFileName file={file} versionId={versionId} instanceId={instanceId} />
                    <Button variant={file.enabled ? "secondary" : "ghost"} aria-pressed={file.enabled} disabled={Boolean(busy)}
                      onClick={() => void manager.toggle(file)}>{file.enabled ? t("library:enabled") : t("library:disabled")}</Button>
                  </div>
                ))}
              </div>
            ) : <p className="vx-resource-no-match">{t("library:resourceNoMatch")}</p>}
          </div>
        ) : showEmpty ? <EmptyState title={t("library:noResources")} description={t("library:noResourcesDescription")} /> : null
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
