import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowUpRight,
  Check,
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
import { Button, IconButton } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/Feedback";
import { Select } from "../../components/ui/Select";
import { InstanceCard } from "./InstanceCard";
import { InstanceDetailPage } from "./InstanceDetailPage";
import { CreateInstanceDialog } from "./CreateInstanceDialog";
import { LibraryLaunchStatus } from "./LibraryLaunchStatus";
import { VersionDirectoryDetailPage } from "./VersionDirectoryDetailPage";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { InstanceIdentity } from "./InstanceIdentity";
import type { Instance, InstalledVersion } from "../../lib/launcher";
import "./library.css";

export function LibraryPage(_props: { navResetTick?: number } = {}) {
  const { t } = useTranslation();
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
  const selectedInstance = data.instances.find(
    (instance) => instance.id === selectedId,
  );
  const versionDirectory = data.installedVersions.find(
    (version) => version.id === selectedVersionDirectory,
  );
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
    setSelectedId(instanceId);
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
  if (versionDirectory)
    return (
      <>
        <VersionDirectoryDetailPage
          version={versionDirectory}
          onBack={() => setSelectedVersionDirectory(undefined)}
          onLaunch={() => void launchVersion(versionDirectory.id)}
        />
        {launchStatus}
      </>
    );
  if (selectedInstance)
    return (
      <>
        <InstanceDetailPage
          instance={selectedInstance}
          onBack={() => setSelectedId(undefined)}
          onChanged={reload}
          onLaunch={() => void launchInstance(selectedInstance)}
        />
        {launchStatus}
      </>
    );

  return (
    <div className="vx-library-page">
      <header className="vx-page-heading">
        <div className="vx-page-heading__copy">
          <h1>{t("library:title")}</h1>
          <p>
            {scope === "versions"
              ? t("library:subtitleVersions", { count: scopeCount })
              : t("library:subtitle", { count: scopeCount })}
          </p>
        </div>
        <div
          className="vx-segmented vx-library-scope"
          role="group"
          aria-label={t("library:scopeLabel")}
        >
          <button
            type="button"
            aria-pressed={scope === "instances"}
            onClick={() => setScope("instances")}
          >
            {t("library:scope.instances")}
          </button>
          <button
            type="button"
            aria-pressed={scope === "versions"}
            onClick={() => setScope("versions")}
          >
            {t("library:scope.versions")}
          </button>
        </div>
      </header>
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
          <div
            className="vx-library-view"
            role="group"
            aria-label={t("library:viewLabel")}
          >
            <IconButton
              label={t("library:gridView")}
              icon={<Grid2X2 size={16} />}
              aria-pressed={view === "grid"}
              onClick={() => setView("grid")}
            />
            <IconButton
              label={t("library:listView")}
              icon={<List size={16} />}
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
            />
          </div>
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
      {scope === "versions" ? (
        versions.length ? (
          <div className={`vx-instance-sheet vx-instance-sheet--${view}`}>
            {versions.map((version) => (
              <VersionDirectoryCard
                key={version.id}
                version={version}
                selected={!activeInstance && version.id === selectedVersionId}
                onOpen={() => {
                  setSelectedVersionDirectory(version.id);
                  setSelectedId(undefined);
                }}
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
              selected={instance.id === activeInstance?.id}
              running={running.some((game) => game.instanceId === instance.id)}
              onOpen={() => {
                setSelectedId(instance.id);
                setSelectedVersionDirectory(undefined);
              }}
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
      {launchStatus}
    </div>
  );
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
}: {
  version: InstalledVersion;
  selected: boolean;
  onOpen: () => void;
  onLaunch: () => void;
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
    <article
      className={`vx-instance-card${selected ? " is-selected" : ""}`}
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
      {selected ? <Check className="vx-lattice-selection" data-selected-mark size={16} aria-hidden="true" /> : null}
      <button
        type="button"
        className="vx-instance-card__select"
        data-version-id={version.id}
        onClick={onOpen}
        aria-label={t("library:openVersionDirectory", { name: version.id })}
      >
        <span className="vx-instance-card__identity">
          <InstanceIdentity
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
    </article>
  );
}
