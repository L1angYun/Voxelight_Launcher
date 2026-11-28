import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LayoutGroup } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  Grid2X2,
  LibraryBig,
  List,
  MoreHorizontal,
  Plus,
  RotateCcw,
  Search,
  Upload,
} from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useViewState } from "../../app/viewState";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { command, type Config } from "../../lib/launcher";
import { gameFolderChoices, instancesInGameFolder, sameGameFolderPath } from "../../lib/gameFolders";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Select";
import { PageShell, PageHeader } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { Dialog } from "../../components/ui/Dialog";
import { InstanceCard } from "./InstanceCard";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { LibraryLaunchStatus } from "./LibraryLaunchStatus";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { InstanceIdentity, InstanceIdentityProvider } from "./InstanceIdentity";
import { motionDuration } from "../../design/motion";
import { ICON } from "../../design/icons";
import { useMotionTier } from "../../design/useMotionTier";
import type { Instance } from "../../lib/launcher";
import "./library-grid.css";

const LIBRARY_BATCH = 48;

export function LibraryPage({ navResetTick = 0 }: { navResetTick?: number }) {
  const { t } = useTranslation();
  const { tier } = useMotionTier();
  const contentDuration = motionDuration(tier, "content");
  const [searching, setSearching] = useState(false);
  const groupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const previousDetail = useRef<{ key: string; id: string } | null>(null);
  const previousResetTick = useRef(navResetTick);
  const resetReturn = useRef(false);
  const {
    data,
    config,
    running,
    reload,
    selectInstance,
    launch,
    progress,
    preparing,
    selectedRunningGame,
    selectedInstance: activeInstance,
    gamePid,
    cancelPreparation,
    run,
  } = useLauncher();
  const { play } = useOverture();
  const [query, setQuery] = useViewState("library.query", "");
  const [sort, setSort] = useViewState("library.sort", "recent");
  const [view, setView] = useViewState<"grid" | "list">("library.view", "grid");
  const [visibleLimit, setVisibleLimit] = useState(LIBRARY_BATCH);
  const [selectedId, setSelectedId] = useState<string>();
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenInstances, setHiddenInstances] = useState<Instance[]>([]);
  const [hiddenError, setHiddenError] = useState("");
  const [revealListing, setRevealListing] = useState(false);
  const folders = useMemo(() => gameFolderChoices(config), [config]);
  const folderInstances = useMemo(
    () => instancesInGameFolder(data.instances, config.gameDirectory),
    [config.gameDirectory, data.instances],
  );
  const selectedInstance = data.instances.find(
    (instance) => instance.id === selectedId,
  );
  const detailKey = selectedInstance ? `instance:${selectedInstance.id}` : null;

  function openDetail(id: string) {
    if (!detailKey) listScroll.current = rootRef.current?.closest("main")?.scrollTop ?? 0;
    resetReturn.current = false;
    setSelectedId(id);
  }

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const main = root.closest("main");
    if (previousResetTick.current !== navResetTick) {
      previousResetTick.current = navResetTick;
      if (main) main.scrollTop = 0;
      resetReturn.current = true;
      setSelectedId(undefined);
      if (detailKey) return;
      setVisibleLimit(LIBRARY_BATCH);
    }

    const previous = previousDetail.current;
    if (detailKey && selectedInstance) {
      if (previous?.key === detailKey) return;
      previousDetail.current = { key: detailKey, id: selectedInstance.id };
      if (main) main.scrollTop = 0;
      root.querySelector<HTMLElement>(".vx-detail-header h1")?.focus({ preventScroll: true });
      return;
    }
    const resetting = resetReturn.current;
    resetReturn.current = false;
    if (!previous) return;
    previousDetail.current = null;
    // An external reload can remove the resolved instance without changing the
    // selected ID. Clear it so a later reload cannot reopen a stale detail.
    if (selectedId !== undefined) setSelectedId(undefined);

    const card = [...root.querySelectorAll<HTMLButtonElement>(".vx-instance-card__select")].find((button) =>
      button.closest<HTMLElement>("[data-instance-id]")?.dataset.instanceId === previous.id);
    const heading = root.querySelector<HTMLElement>(".vx-library-page h1");
    let focusTarget = card ?? heading;
    if (main) {
      main.scrollTop = card && !resetting ? listScroll.current : 0;
      if (resetting && card) {
        const viewport = main.getBoundingClientRect();
        const bounds = card.getBoundingClientRect();
        if (bounds.height && viewport.height && (bounds.top < viewport.top || bounds.bottom > viewport.bottom)) focusTarget = heading;
      }
    }
    focusTarget?.focus({ preventScroll: true });
    setRevealListing(contentDuration > 0);
  }, [contentDuration, detailKey, navResetTick, selectedId, selectedInstance]);

  const instances = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = folderInstances.filter(
      (instance) =>
        !normalized ||
        [
          instance.name,
          instance.versionId,
          instance.loader,
          instance.category,
        ].some((value) => value.toLowerCase().includes(normalized)),
    );
    return [...filtered].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name);
      if (sort === "version") return a.versionId.localeCompare(b.versionId);
      return (b.lastPlayed ?? b.createdAt).localeCompare(
        a.lastPlayed ?? a.createdAt,
      );
    });
  }, [folderInstances, query, sort]);
  const remainingCount = Math.max(0, instances.length - visibleLimit);
  const hasInstances = folderInstances.length > 0;

  async function launchInstance(instance: Instance) {
    selectInstance(instance.id);
    await launch(instance.id);
  }

  async function switchGameFolder(path: string) {
    if (sameGameFolderPath(path, config.gameDirectory)) return;
    await run("folder.switch", async () => {
      await command<Config>("set_active_game_folder", { path });
      await reload();
      setSelectedId(undefined);
      setVisibleLimit(LIBRARY_BATCH);
    });
  }

  async function openHidden() {
    try {
      setHiddenError("");
      setHiddenInstances(await command<Instance[]>("list_hidden_instances"));
      setHiddenOpen(true);
    } catch (cause) {
      setHiddenError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function restoreHidden(instance: Instance) {
    await run("instance.restore", async () => {
      await command("restore_instance", { instanceId: instance.id });
      await reload();
      setHiddenInstances((list) => list.filter((item) => item.id !== instance.id));
    });
  }

  async function installed(versionId: string, instanceId?: string) {
    await reload();
    if (instanceId) {
      selectInstance(instanceId);
      openDetail(instanceId);
    }
    setCreateOpen(false);
    setImportOpen(false);
    play({
      id: `instance-installed-${instanceId ?? versionId}-${Date.now()}`,
      kind: "instance-installed",
    });
  }

  const launchStatus = (
    <LibraryLaunchStatus
      preparing={preparing}
      running={Boolean(selectedRunningGame || gamePid)}
      progress={progress}
      onCancel={cancelPreparation}
    />
  );
  const content = selectedInstance ? (
    <InstanceDetailPage key={detailKey} instance={selectedInstance} onBack={() => setSelectedId(undefined)}
      onChanged={reload} onLaunch={() => void launchInstance(selectedInstance)} />
  ) : (
    <PageShell className="vx-library-page" data-drill-return={revealListing && contentDuration > 0 ? "" : undefined}
      onAnimationEnd={(event) => { if (event.animationName === "vx-library-content-reveal") setRevealListing(false); }}>
      <PageHeader title={t("library:title")}
        description={t("library:subtitle", { count: folderInstances.length })} />
      <div className="vx-library-commandbar" data-empty={hasInstances ? undefined : ""}>
        {folders.length > 1 ? (
          <Select
            className="vx-library-folder-select"
            aria-label={t("library:gameFolder")}
            value={folders.find((folder) => sameGameFolderPath(folder.path, config.gameDirectory))?.path ?? folders[0]?.path}
            onChange={(path) => void switchGameFolder(path)}
            options={folders.map((folder) => ({
              value: folder.path,
              label: folder.label,
              metadata: folder.label === folder.path ? undefined : folder.path,
            }))}
          />
        ) : null}
        {hasInstances ? <label className="vx-search">
          <Search size={ICON.md} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("library:search")}
            value={query}
            onFocus={() => setSearching(true)}
            onBlur={() => setSearching(false)}
            onChange={(event) => { setQuery(event.target.value); setVisibleLimit(LIBRARY_BATCH); }}
            placeholder={t("library:searchPlaceholder")}
          />
        </label> : null}
        <div className="vx-library-commandbar__tools">
          {hasInstances ? <>
          <Select
            className="vx-library-sort-select"
            aria-label={t("library:sort")}
            value={sort}
            onChange={(value) => { setSort(value); setVisibleLimit(LIBRARY_BATCH); }}
            options={[
              { value: "recent", label: t("library:sortRecent") },
              { value: "name", label: t("library:sortName") },
              { value: "version", label: t("library:sortVersion") },
            ]}
          />
          <Segmented className="vx-library-view" semantic="toggle" label={t("library:viewLabel")} value={view} onChange={setView}
            options={[{value:"grid",label:<span className="sr-only">{t("library:gridView")}</span>,icon:<Grid2X2 size={ICON.md} />},
              {value:"list",label:<span className="sr-only">{t("library:listView")}</span>,icon:<List size={ICON.md} />}]} />
          </> : null}
          <details className="vx-library-more">
            <summary aria-label={t("library:moreActions")} title={t("library:moreActions")}>
              <MoreHorizontal size={ICON.md} aria-hidden="true" />
            </summary>
            <div className="vx-library-more__menu">
              <button type="button" onClick={() => void openHidden()}>{t("library:showHiddenInstances")}</button>
            </div>
          </details>
          {hiddenError ? <span role="alert">{hiddenError}</span> : null}
        </div>
        <div className="vx-library-commandbar__actions">
          <Button
            variant="secondary"
            size="md"
            icon={<Upload size={ICON.md} />}
            onClick={() => setImportOpen(true)}
          >
            {t("library:importPack")}
          </Button>
          <Button
            variant="primary"
            size="md"
            icon={<Plus size={ICON.md} />}
            onClick={() => setCreateOpen(true)}
          >
            {t("library:createInstance")}
          </Button>
        </div>
      </div>
      <SectionPanel selectionKey={view}>
      {!hasInstances ? (
        <div className="vx-instance-sheet vx-instance-sheet--create">
          <CreateInstanceTile onCreate={() => setCreateOpen(true)} />
        </div>
      ) : instances.length ? (
        <div className={`vx-instance-sheet vx-instance-sheet--${view}`}>
          {instances.slice(0, visibleLimit).map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              layoutOrder={tier === "full" && instances.length <= 40 && !searching ? `${sort}:${view}` : undefined}
              selected={instance.id === activeInstance?.id}
              running={running.some((game) => game.instanceId === instance.id)}
              onOpen={() => openDetail(instance.id)}
              onLaunch={() => void launchInstance(instance)}
            />
          ))}
        </div>
      ) : (
        <EmptyState
          className="vx-library-empty"
          icon={<LibraryBig size={ICON.xl} />}
          title={t("library:noSearchResults")}
          description={t("library:noSearchDescription")}
          action={
            <Button variant="secondary" onClick={() => { setQuery(""); setVisibleLimit(LIBRARY_BATCH); }}>
              {t("library:clearSearch")}
            </Button>
          }
        />
      )}
      </SectionPanel>
      {remainingCount > 0 && (
        <Button variant="secondary" size="md" onClick={() => setVisibleLimit(limit => limit + LIBRARY_BATCH)}>
          {t("library:showMore", { count: Math.min(LIBRARY_BATCH, remainingCount), remaining: remainingCount })}
        </Button>
      )}
      <Dialog open={hiddenOpen} onOpenChange={setHiddenOpen}
        title={t("library:hiddenInstancesTitle")}
        description={t("library:hiddenInstancesDescription")}
        footer={<Button variant="ghost" onClick={() => setHiddenOpen(false)}>{t("common:actions.close")}</Button>}>
        {hiddenInstances.length ? (
          <ul className="vx-hidden-instances">
            {hiddenInstances.map((instance) => (
              <li key={instance.id}>
                <span>
                  <strong>{instance.name}</strong>
                  <small>{instance.versionId}</small>
                </span>
                <Button variant="secondary" size="sm" icon={<RotateCcw size={ICON.sm} />}
                  onClick={() => void restoreHidden(instance)}>
                  {t("library:restoreInstance")}
                </Button>
              </li>
            ))}
          </ul>
        ) : <p>{t("library:noHiddenInstances")}</p>}
      </Dialog>
      <CreateInstanceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onInstalled={installed}
      />
      <CreateInstanceDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onInstalled={installed}
        initialMode="import"
      />
    </PageShell>
  );
  return <LayoutGroup id={groupId}>
    <InstanceIdentityProvider tier={tier} returningIdentity={!detailKey ? previousDetail.current?.key : undefined}>
      <div className="vx-library-drill" ref={rootRef} data-content-motion={contentDuration > 0 ? "" : undefined}
        style={{ "--vx-drill-content-duration": `${contentDuration}s` } as CSSProperties}>
        {content}
        {launchStatus}
      </div>
    </InstanceIdentityProvider>
  </LayoutGroup>;
}

function CreateInstanceTile({ onCreate }: { onCreate: () => void }) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <article
      className="vx-instance-card vx-instance-card--create"
      data-create-instance
      data-visual-owner="lattice"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) =>
        setFocused(event.target.matches(":focus-visible"))
      }
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <LatticeFrame
        hovered={hovered}
        focused={focused}
        signature="create-instance"
      />
      <button
        type="button"
        className="vx-instance-card__select vx-instance-create__select"
        aria-label={t("library:createInstance")}
        onClick={onCreate}
      >
        <span className="vx-instance-create__mark" aria-hidden="true">
          <Plus size={ICON.xl} />
          <i />
          <i />
          <i />
          <i />
        </span>
        <span className="vx-instance-card__information">
          <span className="vx-instance-card__name">
            {t("library:createInstance")}
          </span>
          <span className="vx-instance-create__description">
            {t("library:createInstanceDescription")}
          </span>
        </span>
      </button>
    </article>
  );
}
