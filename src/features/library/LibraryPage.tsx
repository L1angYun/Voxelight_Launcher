import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { LayoutGroup, motion } from "motion/react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Folder,
  Grid2X2,
  LibraryBig,
  List,
  Play,
  Plus,
  Search,
  Upload,
} from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Select";
import { PageShell, PageHeader } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { InstanceCard } from "./InstanceCard";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { LibraryLaunchStatus } from "./LibraryLaunchStatus";
import { VersionDirectoryDetailPage } from "./VersionDirectoryDetailPage";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { InstanceIdentity, InstanceIdentityProvider } from "./InstanceIdentity";
import { MOTION, motionDuration } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import type { Instance, InstalledVersion } from "../../lib/launcher";
import "./library.css";

type DetailKind = "instance" | "version-directory";

export function LibraryPage({ navResetTick = 0 }: { navResetTick?: number }) {
  const { t } = useTranslation();
  const { tier } = useMotionTier();
  const contentDuration = motionDuration(tier, "content");
  const [searching, setSearching] = useState(false);
  const groupId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const previousDetail = useRef<{ key: string; kind: DetailKind; id: string } | null>(null);
  const previousResetTick = useRef(navResetTick);
  const resetReturn = useRef(false);
  const {
    data,
    running,
    reload,
    selectInstance,
    selectVersion,
    launch,
    progress,
    busy,
    selectedRunningGame,
    selectedInstance: activeInstance,
    selectedVersionId,
    gamePid,
    cancelPreparation,
  } = useLauncher();
  const { play } = useOverture();
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("recent");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedVersionDirectory, setSelectedVersionDirectory] =
    useState<string>();
  const [scope, setScope] = useState<"instances" | "versions">("instances");
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [revealListing, setRevealListing] = useState(false);
  const selectedInstance = data.instances.find(
    (instance) => instance.id === selectedId,
  );
  const versionDirectory = data.installedVersions.find(
    (version) => version.id === selectedVersionDirectory,
  );
  const detailKind = versionDirectory ? "version-directory" : selectedInstance ? "instance" : undefined;
  const detailId = versionDirectory?.id ?? selectedInstance?.id;
  const actualDetailKey = detailKind && detailId ? `${detailKind}:${detailId}` : null;

  function openDetail(kind: DetailKind, id: string) {
    // The browser can clamp scroll as soon as the shorter detail tree replaces
    // the listing, so snapshot it before requesting that replacement.
    if (!actualDetailKey) listScroll.current = rootRef.current?.closest("main")?.scrollTop ?? 0;
    resetReturn.current = false;
    setSelectedId(kind === "instance" ? id : undefined);
    setSelectedVersionDirectory(kind === "version-directory" ? id : undefined);
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
      setSelectedVersionDirectory(undefined);
      if (actualDetailKey) return;
    }

    const previous = previousDetail.current;
    if (actualDetailKey && detailKind && detailId) {
      if (previous?.key === actualDetailKey) return;
      previousDetail.current = { key: actualDetailKey, kind: detailKind, id: detailId };
      if (main) main.scrollTop = 0;
      root.querySelector<HTMLElement>(".vx-detail-header h1")?.focus({ preventScroll: true });
      return;
    }
    const resetting = resetReturn.current;
    resetReturn.current = false;
    if (!previous) return;
    previousDetail.current = null;
    // An external reload can remove the resolved entity without changing the
    // selected ID. Clear it so a later reload cannot reopen a stale detail.
    if (selectedId !== undefined) setSelectedId(undefined);
    if (selectedVersionDirectory !== undefined) setSelectedVersionDirectory(undefined);

    const card = [...root.querySelectorAll<HTMLButtonElement>(".vx-instance-card__select")].find((button) =>
      previous.kind === "instance" ? button.closest<HTMLElement>("[data-instance-id]")?.dataset.instanceId === previous.id
        : button.dataset.versionId === previous.id);
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
  }, [actualDetailKey, contentDuration, detailId, detailKind, navResetTick, selectedId, selectedVersionDirectory]);
  const scopeCount =
    scope === "versions"
      ? data.installedVersions.length
      : data.instances.length;
  const instances = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = data.instances.filter(
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
  }, [data.instances, query, sort]);
  const versions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const filtered = data.installedVersions.filter(
      (version) => !normalized || version.id.toLowerCase().includes(normalized),
    );
    return sort === "recent"
      ? filtered
      : [...filtered].sort((a, b) =>
          a.id.localeCompare(b.id, undefined, { numeric: true }),
        );
  }, [data.installedVersions, query, sort]);

  async function launchInstance(instance: Instance) {
    selectInstance(instance.id);
    await launch(instance.id);
  }
  async function installed(versionId: string, instanceId?: string) {
    await reload();
    if (instanceId) selectInstance(instanceId);
    else selectVersion(versionId);
    if (instanceId) openDetail("instance", instanceId);
    setCreateOpen(false);
    setImportOpen(false);
    play({
      id: `instance-installed-${instanceId ?? versionId}-${Date.now()}`,
      kind: "instance-installed",
    });
  }
  async function launchVersion(versionId: string) {
    selectVersion(versionId);
    await launch(undefined, versionId);
  }

  const launchStatus = (
    <LibraryLaunchStatus
      busy={busy}
      running={Boolean(selectedRunningGame || gamePid)}
      progress={progress}
      onCancel={cancelPreparation}
    />
  );
  const content = versionDirectory ? (
    <VersionDirectoryDetailPage key={actualDetailKey} version={versionDirectory}
      onBack={() => setSelectedVersionDirectory(undefined)} onLaunch={() => void launchVersion(versionDirectory.id)} />
  ) : selectedInstance ? (
    <InstanceDetailPage key={actualDetailKey} instance={selectedInstance} onBack={() => setSelectedId(undefined)}
      onChanged={reload} onLaunch={() => void launchInstance(selectedInstance)} />
  ) : (
    <PageShell className="vx-library-page" data-drill-return={revealListing && contentDuration > 0 ? "" : undefined}
      onAnimationEnd={(event) => { if (event.animationName === "vx-library-content-reveal") setRevealListing(false); }}>
      <PageHeader className="vx-page-heading" title={t("library:title")}
        description={scope === "versions" ? t("library:subtitleVersions", { count: scopeCount }) : t("library:subtitle", { count: scopeCount })}
        actions={<Segmented semantic="toggle" className="vx-library-scope" label={t("library:scopeLabel")} value={scope}
          onChange={setScope} options={[{value:"instances",label:t("library:scope.instances")},{value:"versions",label:t("library:scope.versions")}]} />} />
      <div className="vx-library-commandbar">
        <label className="vx-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label={
              scope === "versions"
                ? t("library:searchVersions")
                : t("library:search")
            }
            value={query}
            onFocus={() => setSearching(true)}
            onBlur={() => setSearching(false)}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              scope === "versions"
                ? t("library:searchVersionsPlaceholder")
                : t("library:searchPlaceholder")
            }
          />
        </label>
        <div className="vx-library-commandbar__tools">
          <Select
            className="vx-library-sort-select"
            aria-label={t("library:sort")}
            value={sort}
            onChange={setSort}
            options={[
              { value: "recent", label: t("library:sortRecent") },
              { value: "name", label: t("library:sortName") },
              { value: "version", label: t("library:sortVersion") },
            ]}
          />
          <Segmented className="vx-library-view" semantic="toggle" label={t("library:viewLabel")} value={view} onChange={setView}
            options={[{value:"grid",label:<span className="sr-only">{t("library:gridView")}</span>,icon:<Grid2X2 size={16} />},
              {value:"list",label:<span className="sr-only">{t("library:listView")}</span>,icon:<List size={16} />}]} />
        </div>
        <div className="vx-library-commandbar__actions">
          <Button
            variant="secondary"
            icon={<Upload size={15} />}
            onClick={() => setImportOpen(true)}
          >
            {t("library:importPack")}
          </Button>
          <Button
            variant="primary"
            icon={<Plus size={16} />}
            onClick={() => setCreateOpen(true)}
          >
            {t("library:createInstance")}
          </Button>
        </div>
      </div>
      <SectionPanel selectionKey={`${scope}:${view}`}>
      {scope === "versions" ? (
        versions.length ? (
          <div className={`vx-instance-sheet vx-instance-sheet--${view}`}>
            {versions.map((version) => (
              <VersionDirectoryCard
                key={version.id}
                version={version}
                layoutOrder={tier === "full" && versions.length <= 40 && !searching ? `${sort}:${view}` : undefined}
                selected={!activeInstance && version.id === selectedVersionId}
                onOpen={() => openDetail("version-directory", version.id)}
                onLaunch={() => void launchVersion(version.id)}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            className="vx-library-empty"
            icon={<LibraryBig size={24} />}
            title={
              query ? t("library:noSearchResults") : t("library:noVersions")
            }
            description={
              query
                ? t("library:noSearchDescription")
                : t("library:noVersionsDescription")
            }
            action={
              query ? (
                <Button variant="ghost" onClick={() => setQuery("")}>
                  {t("library:clearSearch")}
                </Button>
              ) : undefined
            }
          />
        )
      ) : data.instances.length === 0 ? (
        <div className="vx-instance-sheet vx-instance-sheet--create">
          <CreateInstanceTile onCreate={() => setCreateOpen(true)} />
        </div>
      ) : instances.length ? (
        <div className={`vx-instance-sheet vx-instance-sheet--${view}`}>
          {instances.map((instance) => (
            <InstanceCard
              key={instance.id}
              instance={instance}
              layoutOrder={tier === "full" && instances.length <= 40 && !searching ? `${sort}:${view}` : undefined}
              selected={instance.id === activeInstance?.id}
              running={running.some((game) => game.instanceId === instance.id)}
              onOpen={() => openDetail("instance", instance.id)}
              onLaunch={() => void launchInstance(instance)}
            />
          ))}
          {!query ? (
            <CreateInstanceTile onCreate={() => setCreateOpen(true)} />
          ) : null}
        </div>
      ) : (
        <EmptyState
          className="vx-library-empty"
          icon={<LibraryBig size={24} />}
          title={t("library:noSearchResults")}
          description={t("library:noSearchDescription")}
          action={
            <Button variant="ghost" onClick={() => setQuery("")}>
              {t("library:clearSearch")}
            </Button>
          }
        />
      )}
      </SectionPanel>
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
    <InstanceIdentityProvider tier={tier} returningIdentity={!actualDetailKey ? previousDetail.current?.key : undefined}>
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
          <Plus size={22} strokeWidth={1.5} />
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
        <span className="vx-instance-card__open">
          <ArrowUpRight size={16} aria-hidden="true" />
        </span>
      </button>
    </article>
  );
}

function VersionDirectoryCard({
  version,
  selected,
  onOpen,
  onLaunch,
  layoutOrder,
}: {
  version: InstalledVersion;
  selected: boolean;
  onOpen: () => void;
  onLaunch: () => void;
  layoutOrder?: string;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const title = t("library:minecraftVersion", { version: version.id });
  const channel =
    version.type === "release" || version.type === "snapshot"
      ? t(`library:${version.type}`)
      : version.type;
  const java = version.javaMajor
    ? t("library:javaVersion", { version: version.javaMajor })
    : null;
  const technical = java
    ? t("library:versionRuntimeSummary", { channel, java })
    : channel;
  return (
    <motion.article
      className={`vx-instance-card${selected ? " is-selected" : ""}`}
      {...(layoutOrder ? { layout: "position" as const, layoutDependency: layoutOrder, transition: { layout: { duration: motionDuration("full", "enter"), ease: MOTION.ease } } } : {})}
      data-visual-owner="lattice"
      data-version-directory={version.id}
      aria-current={selected ? "true" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false);
      }}
    >
      <LatticeFrame
        hovered={hovered}
        focused={focused}
        selected={selected}
        signature={version.id}
      />
      <button
        type="button"
        className="vx-instance-card__select"
        data-version-id={version.id}
        onClick={onOpen}
        aria-label={t("library:openVersionDirectory", { name: version.id })}
      >
        <span className="vx-instance-card__identity">
          <InstanceIdentity
            kind="version-directory"
            name={t("library:minecraft")}
            identity={version.id}
          />
        </span>
        <span className="vx-instance-card__information">
          <span className="vx-instance-card__name" title={title}>
            {title}
          </span>
          <span className="vx-instance-card__technical" title={technical}>
            <span>{technical}</span>
          </span>
          <span
            className="vx-instance-card__path"
            title={t("library:versionDirectory")}
          >
            <Folder size={12} aria-hidden="true" />
            <span>{t("library:versionDirectory")}</span>
          </span>
        </span>
        <span className="vx-instance-card__open">
          <ArrowUpRight size={16} aria-hidden="true" />
        </span>
      </button>
      <div className="vx-instance-card__footer">
        <Button
          className="vx-instance-card__launch"
          variant="secondary"
          data-launch
          icon={<Play size={14} />}
          onClick={onLaunch}
        >
          {t("common:actions.launch")}
        </Button>
      </div>
    </motion.article>
  );
}
