import { useTranslation } from "react-i18next";
import { useEffect, useId, useRef, useState } from "react";
import { command } from "../../lib/launcher";
import type { LocalResource } from "./types";
import { Download, Package, RefreshCw, Upload } from "lucide-react";
import { Button, IconButton } from "../../components/ui/Button";
import { ICON } from "../../design/icons";
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

function LocalModIcon({ fileName, versionId, instanceId, hasIcon }: { fileName: string; versionId: string; instanceId?: string; hasIcon: boolean }) {
  const container = useRef<HTMLSpanElement>(null);
  const [icon, setIcon] = useState<string | null>(null);
  useEffect(() => {
    const target = container.current;
    if (!hasIcon || !target || typeof IntersectionObserver === "undefined") return;
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
  }, [fileName, versionId, instanceId, hasIcon]);
  return <span ref={container} className="vx-resource-icon" aria-hidden="true">{icon
    ? <img src={icon} alt="" width={24} height={24} onError={() => setIcon(null)} />
    : <span data-testid="local-mod-icon-placeholder"><Package size={ICON.xl} strokeWidth={1.3} /></span>}</span>;
}

/** An immediate on/off state: the state text, then a 28x16 track whose thumb sits right when on. */
export function ResourceSwitch({ checked, disabled, onToggle }: { checked: boolean; disabled?: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  return <button type="button" role="switch" className="vx-switch" aria-checked={checked} disabled={disabled} onClick={onToggle}>
    <span>{checked ? t("library:enabled") : t("library:disabled")}</span>
    <span className="vx-switch__track" aria-hidden="true" />
  </button>;
}

function LocalFileName({ file, versionId, instanceId }: { file: LocalResource; versionId: string; instanceId?: string }) {
  const { t, i18n } = useTranslation();
  const meta = file.metadata;
  const details = [meta?.version, ...(meta?.authors ?? [])].filter((detail): detail is string => Boolean(detail));
  return <div>
    <LocalModIcon key={`${versionId}:${instanceId ?? ""}:${file.fileName}:${file.size}:${file.modifiedMs ?? ""}`} fileName={file.fileName} versionId={versionId} instanceId={instanceId} hasIcon={Boolean(meta?.hasIcon)} />
    <strong>{meta?.name || file.name}</strong>
    <small className="vx-resource-meta">
      <span>{file.fileName}</span>{" "}
      <span>{sizeText(file.size, i18n.language)}</span>{" "}
      {details.map((detail, index) => <span key={`${detail}:${index}`}>{index > 0 ? " " : ""}{detail}</span>)}
    </small>
    {meta?.dependencies.map((dep, i) => <span key={`${dep.id}:${i}`} className="vx-dependency-kind" data-kind={dep.kind}>
      <span>{t(`discover:dependency.${dep.kind}`)}</span>{" "}
      <span>{dep.id}{dep.range ? ` ${dep.range}` : ""}</span>
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
  const selectAllId = `${id}-select-all`;
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
  // The History tab is the one way into the update history, so picking it (or
  // picking it again to retry) loads it; a pick made while another operation
  // runs loads it as soon as that operation ends.
  const historyWanted = useRef(false);
  const changeView = (value: typeof view) => {
    setView(value);
    historyWanted.current = value === "history" && Boolean(busy);
    if (value === "history" && !busy) void manager.showHistory();
  };
  const { showHistory } = manager;
  useEffect(() => {
    if (!historyWanted.current || view !== "history" || busy) return;
    historyWanted.current = false;
    void showHistory();
  }, [busy, showHistory, view]);
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
          <Button variant="primary" icon={<Upload />} disabled={Boolean(busy)} onClick={() => void manager.importFiles()}>{t("library:importResources")}</Button>
          <Button variant="secondary" icon={<Download />} disabled={Boolean(busy)} onClick={() => void manager.checkUpdates()}>{t("library:checkUpdates")}</Button>
          <IconButton label={t("library:refresh")} icon={<RefreshCw />} disabled={Boolean(busy)} onClick={() => void manager.refresh()} />
        </div>
      </div>
      <Segmented semantic="tabs" label={t("library:resourceViews")} value={view} onChange={changeView}
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
            <div className="vx-resource-batch" data-empty={selectedFiles.length === 0}>
              <span role="status">{selectedFiles.length ? t("library:selectedCount", { count: selectedFiles.length }) : t("library:batchHint")}</span>
              {/* Hidden, not removed, with nothing selected: the row keeps its height
                  and clearing the selection never removes a mounted control. */}
              <div className="vx-resource-batch__actions" aria-hidden={selectedFiles.length === 0 || undefined}>
                <Button variant="secondary" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void toggleMany(selectedFiles, true)}>{t("library:batchEnable")}</Button>
                <Button variant="secondary" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void toggleMany(selectedFiles, false)}>{t("library:batchDisable")}</Button>
                <Button ref={deleteRef} variant="secondary" tone="danger" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={() => void deleteSelected()}>{t("library:batchDelete")}</Button>
                <Button variant="ghost" disabled={Boolean(busy) || selectedFiles.length === 0} onClick={clearSelectionAndFocus}>{t("library:batchClear")}</Button>
              </div>
            </div>
            {visible.length ? (
              <div className="vx-resource-list">
                <div className="vx-resource-list__header">
                  <input id={selectAllId} type="checkbox" checked={allVisibleSelected}
                    disabled={Boolean(busy)}
                    ref={(node) => {
                      selectAllRef.current = node;
                      if (node) node.indeterminate = someVisibleSelected && !allVisibleSelected;
                    }}
                    onChange={(event) => selectVisible(visible, event.target.checked)} />
                  <label htmlFor={selectAllId}>{t("library:selectAllCount", { count: visible.length })}</label>
                  <span>{t("library:stateColumn")}</span>
                </div>
                {visible.map((file) => (
                  <div className="vx-resource-row vx-resource-file-row" key={file.fileName}>
                    <input type="checkbox" aria-label={displayName(file)} checked={selectedFileNames.has(file.fileName)}
                      disabled={Boolean(busy)} onChange={(event) => selectFile(file, event.target.checked)} />
                    <LocalFileName file={file} versionId={versionId} instanceId={instanceId} />
                    <ResourceSwitch checked={file.enabled} disabled={Boolean(busy)} onToggle={() => void manager.toggle(file)} />
                  </div>
                ))}
              </div>
            ) : <p className="vx-resource-no-match">{t("library:resourceNoMatch")}</p>}
          </div>
        ) : showEmpty ? <EmptyState variant="inline" title={t("library:noResources")} description={t("library:noResourcesDescription")} /> : null
      ) : null}
      {view === "updates" ? (
        <>
          {curseforgeSkipped ? <p className="vx-inline-notice">{t("library:curseforgeSkipped")}</p> : null}
          {curseforgeFailed ? <p className="vx-inline-notice">{t("library:curseforgeFailed")}</p> : null}
          {updates === null ? (showEmpty ? <EmptyState variant="inline" title={t("library:updatesNotChecked")} /> : null) : updates.length ? <div className="vx-resource-list">{updates.map((update) => (
            <div className="vx-resource-row" key={update.fileName}>
              <div>
                <strong>{update.name}</strong>
                <small className="vx-resource-meta"><span>{t(`library:source.${update.source}`)}</span>{" "}<span>{update.currentVersion} → {update.newVersion}</span></small>
                {update.manualOnly ? <small>{t("library:manualOnlyHint")}</small> : null}
              </div>
              {update.manualOnly
                ? update.projectUrl ? <ExternalLink url={update.projectUrl}>{t("library:manualDownload")}</ExternalLink> : null
                : <Button variant="secondary" onClick={() => void manager.applyUpdate(update)}>{t("library:update")}</Button>}
            </div>
          ))}</div> : showEmpty ? <EmptyState variant="inline" title={t("library:noUpdates")} /> : null}
        </>
      ) : null}
      {view === "history" ? (
        history === null ? (showEmpty ? <EmptyState variant="inline" title={t("library:historyNotLoaded")} /> : null) : history.length ? <div className="vx-resource-list">{history.map((entry) => (
          <div className="vx-resource-row" key={entry.updateId}>
            <div><strong>{entry.name}</strong><small className="vx-resource-meta"><span>{formatDate(entry.createdAt, i18n.language)}</span>{" "}<span>{t(`library:historyStatus.${entry.status}`)}</span></small></div>
            {entry.canRecover ? (
              <Button variant="secondary" disabled={Boolean(busy)}
                onClick={() => void manager.recover(entry, t("library:recoverTransactionConfirm", { name: entry.name }))}>
                {t("library:recoverTransaction")}
              </Button>
            ) : entry.status === "committed" ? <Button variant="ghost" onClick={() => void manager.rollback(entry, t("library:rollbackConfirm", { name: entry.name }))}>{t("library:rollback")}</Button> : null}

          </div>
        ))}</div> : showEmpty ? <EmptyState variant="inline" title={t("library:noHistory")} /> : null
      ) : null}
      </SectionPanel>
    </div>
  );
}
