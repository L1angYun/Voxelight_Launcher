import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Box,
  FileText,
  Globe2,
  MoreHorizontal,
  Play,
  Settings2,
  SlidersHorizontal,
} from "lucide-react";
import { command, type Instance } from "../../lib/launcher";
import { normalizeError } from "../../lib/errors";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { instanceTabRegistry } from "../../app/registry";
import { Button, IconButton } from "../../components/ui/Button";
import { useConfirm } from "../../components/ui/ConfirmDialog";
import { InstanceOverview } from "./InstanceOverview";
import { InstanceContent } from "./InstanceContent";
import { InstanceWorlds } from "./InstanceWorlds";
import { InstanceLogs } from "./InstanceLogs";
import { InstanceSettings } from "./InstanceSettings";
import type { InstanceTab } from "./types";
import { InstanceIdentity } from "./InstanceIdentity";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { Dialog } from "../../components/ui/Dialog";
import "./instance-detail.css";
import { motionDuration } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import { loaderText } from "./utils";
import { errorText } from "./utils";
import { instanceIssueBlocksLaunch } from "../../lib/gameFolders";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { ICON } from "../../design/icons";

const tabIcons = {
  overview: Box,
  content: SlidersHorizontal,
  worlds: Globe2,
  logs: FileText,
  settings: Settings2,
};

function InstanceManageMenu({ label, title, removeLabel, onRemove, deleteLabel, onDelete }: {
  label: string; title: string; removeLabel: string; onRemove: () => void;
  deleteLabel?: string; onDelete?: () => void;
}) {
  const { tier } = useMotionTier();
  const id = useId();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [placement, setPlacement] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
  const syncOpen = useCallback((next: boolean) => {
    if (next) {
      const summary = summaryRef.current;
      setPortalRoot(summary?.closest<HTMLDialogElement>("dialog[open]") ?? summary?.closest<HTMLElement>(".vx-glass-provider") ?? document.body);
      setMounted(true);
    }
    setOpen(next);
  }, []);
  const close = useCallback(() => {
    if (detailsRef.current) detailsRef.current.open = false;
    syncOpen(false);
  }, [syncOpen]);
  // A chosen action opens a modal confirmation or dialog. The menu closes first
  // so its Escape handler cannot swallow the dialog's Escape, and the dialog
  // returns focus to the menu button instead of an unmounted menu item.
  const choose = (action: () => void) => {
    close();
    summaryRef.current?.focus({ preventScroll: true });
    action();
  };
  useEffect(() => {
    if (open || !mounted) return;
    const duration = motionDuration(tier, "menuExit") * 1000;
    if (!duration) { setMounted(false); return; }
    const timeout = window.setTimeout(() => setMounted(false), duration);
    return () => window.clearTimeout(timeout);
  }, [mounted, open, tier]);
  useLayoutEffect(() => {
    const popup = popupRef.current;
    if (!mounted || !popup || typeof popup.showPopover !== "function") return;
    try { popup.showPopover(); } catch { /* The fixed portal remains available. */ }
    return () => { if (typeof popup.hidePopover === "function" && popup.matches(":popover-open")) popup.hidePopover(); };
  }, [mounted]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = summaryRef.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 16, gap = 7;
      if (rect.bottom <= margin || rect.top >= window.innerHeight - margin || rect.right <= margin || rect.left >= window.innerWidth - margin) { close(); return; }
      const width = Math.min(168, Math.max(0, window.innerWidth - margin * 2));
      const naturalHeight = popupRef.current?.scrollHeight || 44;
      const below = Math.max(0, window.innerHeight - margin - rect.bottom - gap);
      const above = Math.max(0, rect.top - margin - gap);
      const bottom = below >= naturalHeight || below >= above;
      const maxHeight = bottom ? below : above;
      const height = Math.min(naturalHeight, maxHeight);
      setPlacement({ width, maxHeight,
        left: Math.max(margin, Math.min(rect.right - width, window.innerWidth - margin - width)),
        top: Math.max(margin, bottom ? rect.bottom + gap : rect.top - gap - height) });
    };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!detailsRef.current?.contains(target) && !popupRef.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); close(); summaryRef.current?.focus({ preventScroll: true });
    };
    const scroll = (event: Event) => { if (!(event.target instanceof Node) || !popupRef.current?.contains(event.target)) position(); };
    position();
    document.addEventListener("pointerdown", outside, true); document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", position); window.addEventListener("scroll", scroll, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (summaryRef.current) observer?.observe(summaryRef.current);
    return () => {
      document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", position); window.removeEventListener("scroll", scroll, true); observer?.disconnect();
    };
  }, [close, open, portalRoot]);
  return <details ref={detailsRef} className="vx-detail-manage" onToggle={(event) => syncOpen(event.currentTarget.open)}>
    <summary ref={summaryRef} aria-label={label} title={title} aria-controls={open ? id : undefined}
      onClick={() => syncOpen(!detailsRef.current?.open)}
      onKeyDown={(event) => {
        if (open && event.key === "Tab" && !event.shiftKey) {
          event.preventDefault(); popupRef.current?.querySelector("button")?.focus({ preventScroll: true });
        }
      }}><MoreHorizontal size={ICON.md} aria-hidden="true" /></summary>
    {mounted && portalRoot ? createPortal(<div ref={popupRef} id={id} popover="manual" className="vx-detail-manage__popover"
      data-open={open} inert={!open || undefined} aria-hidden={!open || undefined}
      style={{ position: "fixed", opacity: 1, left: placement?.left ?? 16, top: placement?.top ?? 16, width: placement?.width ?? 168,
        maxHeight: placement?.maxHeight, visibility: placement ? "visible" : "hidden",
        "--menu-enter": `${motionDuration(tier, "menuEnter")}s`, "--menu-exit": `${motionDuration(tier, "menuExit")}s` } as CSSProperties}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        if (event.shiftKey) { summaryRef.current?.focus({ preventScroll: true }); return; }
        const focusable = [...document.querySelectorAll<HTMLElement>('summary, button, input, textarea, select, a[href], [tabindex]')]
          .filter((element) => element.tabIndex >= 0 && !element.matches(":disabled") && !element.closest("[inert], [hidden]") && !popupRef.current?.contains(element));
        const next = focusable[focusable.indexOf(summaryRef.current!) + 1];
        close(); next?.focus({ preventScroll: true });
      }}>
      <GlassSurface variant="dialog" className="vx-detail-manage__menu">
        <button type="button" onClick={() => choose(onRemove)}>{removeLabel}</button>
        {deleteLabel && onDelete ? <button type="button" className="vx-destructive" onClick={() => choose(onDelete)}>{deleteLabel}</button> : null}
      </GlassSurface>
    </div>, portalRoot) : null}
  </details>;
}

export function InstanceDetailPage({
  instance,
  onBack,
  onChanged,
  onLaunch,
}: {
  instance: Instance;
  onBack: () => void;
  onChanged: () => Promise<void>;
  onLaunch: () => void;
}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const { run } = useLauncher();
  const [tab, setTab] = useState<InstanceTab>("overview");
  useEffect(() => setTab("overview"), [instance.id]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dependants, setDependants] = useState<string[]>([]);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [recycleUnavailable, setRecycleUnavailable] = useState(false);
  const tabs = instanceTabRegistry.enabled({});
  const remove = async () => {
    if (!await confirm(t("library:removeConfirm", { name: instance.name }), { tone: "danger" }))
      return;
    void run("instance.remove", async () => {
      await command("remove_instance", { instanceId: instance.id });
      await onChanged();
      onBack();
    });
  };
  const removeFiles = () => {
    void run("instance.delete", async () => {
      setDeleteError("");
      setRecycleUnavailable(false);
      setDependants(await command<string[]>("list_instance_dependants", { instanceId: instance.id }));
      setDeleteOpen(true);
    });
  };
  const destroy = async (permanent: boolean) => {
    if (permanent && !await confirm(t("library:deletePermanentConfirm", { name: instance.name }), { tone: "danger" })) return;
    void run("instance.delete", async () => {
      setDeleteBusy(true);
      try {
        await command("delete_instance", { instanceId: instance.id, confirmed: true, permanent });
        setDeleteOpen(false);
        await onChanged();
        onBack();
      } catch (cause) {
        const fault = normalizeError(cause);
        setDeleteError(errorText(fault.code, t, fault.params));
        if (fault.code === "instance.recycleUnavailable") setRecycleUnavailable(true);
      } finally {
        setDeleteBusy(false);
      }
    });
  };
  const blockedText = instance.issue ? t(`library:instanceIssue.${instance.issue}`) : "";
  const blocksLaunch = instanceIssueBlocksLaunch(instance.issue);
  return (
    <PageShell className="vx-detail-page">
      <PageHeader className="vx-detail-header">
        <IconButton
          label={t("common:actions.back")}
          icon={<ArrowLeft />}
          onClick={onBack}
        />
        <div className="vx-detail-header__identity">
          <InstanceIdentity
            placement="detail"
            name={instance.name}
            identity={instance.id}
            iconPath={instance.iconPath}
            loader={instance.loader}
            versionId={instance.versionId}
          />
          <div>
            <h1 tabIndex={-1} title={instance.name}>{instance.name}</h1>
            <p className="vx-detail-header__meta">
              <span>{instance.versionId}</span>{" "}
              <span className="vx-detail-header__meta-secondary">{loaderText(instance, t)}</span>
            </p>
          </div>
        </div>
        <Button variant="primary" icon={<Play />} disabled={blocksLaunch}
          title={blocksLaunch ? blockedText : undefined} onClick={onLaunch}>
          {t("common:actions.launch")}
        </Button>
        <InstanceManageMenu key={instance.id} label={t("library:manageInstance", { name: instance.name })}
          title={t("common:actions.manage")} removeLabel={t("library:remove")} onRemove={remove}
          deleteLabel={instance.kind === "version" ? t("library:deleteFiles") : undefined}
          onDelete={instance.kind === "version" ? removeFiles : undefined} />
      </PageHeader>
      {instance.issue ? <p className="vx-inline-notice" role="alert">{blockedText}</p> : null}
      <div className="vx-detail-layout vx-workspace">
        <aside className="vx-detail-context">
          <Segmented className="vx-detail-selection" semantic="tabs" orientation="vertical" fill
            label={t("library:detailTabs")} value={tab} onChange={setTab}
            idPrefix="instance-tab" panelId="instance-detail-panel"
            options={tabs.map((item) => {
              const id = item.id as typeof tab;
              const Icon = tabIcons[id];
              return { value: id, icon: <Icon size={ICON.md} aria-hidden="true" />, label: t(`library:${item.labelKey}`) };
            })} />
        </aside>
        <SectionPanel selectionKey={tab}
          id="instance-detail-panel"
          role="tabpanel"
          aria-labelledby={`instance-tab-${tab}`}
          className="vx-detail-workspace"
        >
          {tab === "overview" ? (
            <InstanceOverview instance={instance} onChanged={onChanged} />
          ) : null}
          {tab === "content" ? (
            <InstanceContent
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "worlds" ? (
            <InstanceWorlds
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "logs" ? (
            <InstanceLogs
              versionId={instance.versionId}
              instanceId={instance.id}
            />
          ) : null}
          {tab === "settings" ? (
            <InstanceSettings instance={instance} onChanged={onChanged} />
          ) : null}
        </SectionPanel>
      </div>
      <Dialog open={deleteOpen} onOpenChange={(open) => { if (!open) setDeleteOpen(false); }}
        title={t("library:deleteFiles")}
        description={t("library:deleteConfirm", { name: instance.name })}
        footer={<>
          <Button variant="ghost" onClick={() => setDeleteOpen(false)}>{t("common:actions.cancel")}</Button>
          {dependants.length === 0 ? (
            <>
              <Button variant="secondary" disabled={deleteBusy} data-delete-permanent
                data-delete-permanent-fallback={recycleUnavailable || undefined}
                {...(recycleUnavailable ? { "data-dialog-autofocus": true } : {})} onClick={() => destroy(true)}>
                {t("library:deletePermanently")}
              </Button>
              {recycleUnavailable ? null : (
                <Button variant="primary" disabled={deleteBusy} data-delete-recycle data-dialog-autofocus onClick={() => destroy(false)}>
                  {t("library:moveToRecycleBin")}
                </Button>
              )}
            </>
          ) : null}
        </>}>
        {dependants.length ? (
          <div role="alert">
            <p>{t("library:deleteDependants")}</p>
            <ul>{dependants.map((name) => <li key={name}>{name}</li>)}</ul>
          </div>
        ) : (
          <p>{t(recycleUnavailable ? "library:deleteRecycleUnavailable" : "library:deleteRecycleHint")}</p>
        )}
        {deleteError ? <p role="alert">{deleteError}</p> : null}
      </Dialog>
    </PageShell>
  );
}
