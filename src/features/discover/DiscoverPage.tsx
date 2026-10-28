import { useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Box, Layers3, Package, Search, Sparkles } from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { GlassSurface } from "../../visual/glass/GlassSystem";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { EmptyState, ToastRegion } from "../../components/ui/Feedback";
import { ProjectCard } from "./ProjectCard";
import { ProjectDetailsDrawer } from "./ProjectDetailsDrawer";
import { CreateInstanceDialog } from "../library/CreateInstanceDialog";
import { useDiscover } from "./useDiscover";
import type { DiscoverType } from "./types";
import { errorText } from "../library/utils";
import { formatNumber } from "../../i18n/format";
import "./discover.css";

const resourceTypes = ["mod", "resourcepack", "shader", "modpack"] as const;
const resourceIcons = { mod: Box, resourcepack: Layers3, shader: Sparkles, modpack: Package };

export function DiscoverPage() {
  const { t, i18n } = useTranslation();
  const { data, selectedVersionId, selectedInstance, selectInstance, selectVersion } = useLauncher();
  const { play } = useOverture();
  const [creating, setCreating] = useState(false);
  const discover = useDiscover();
  const {
    source, setSource, resourceType, setResourceType, query, setQuery, setSearch,
    resources, loading, error, notice, selectedProject, details, detailsLoading, detailsError,
    modpackProject, setModpackProject, loadProject, closeProject, installProject, installed, clearNotice,
  } = discover;
  const targetName = selectedInstance?.name || (selectedVersionId ? t("library:versionDirectory") + " · " + selectedVersionId : t("discover:versionDirectory"));

  async function installedWithOverture(versionId: string, instanceId?: string) {
    await installed(versionId, instanceId);
    setCreating(false);
    play({ id: "discover-instance-installed-" + (instanceId ?? versionId) + "-" + Date.now(), kind: "instance-installed" });
  }

  function navigateType(event: KeyboardEvent<HTMLButtonElement>, current: DiscoverType) {
    const index = resourceTypes.indexOf(current);
    const next = event.key === "ArrowDown" || event.key === "ArrowRight" ? resourceTypes[(index + 1) % resourceTypes.length]
      : event.key === "ArrowUp" || event.key === "ArrowLeft" ? resourceTypes[(index + resourceTypes.length - 1) % resourceTypes.length]
      : event.key === "Home" ? resourceTypes[0] : event.key === "End" ? resourceTypes[resourceTypes.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    setResourceType(next);
    document.getElementById("discover-type-" + next)?.focus();
  }

  return (
    <div className="vx-discover-page">
      <header className="vx-discover-heading"><h1>{t("discover:title")}</h1></header>
      <div className="vx-discover-workspace">
        <aside className="vx-discover-catalog" aria-label={t("discover:typeLabel")}>
          <GlassSurface className="vx-discover-destination" variant="control">
            <label className="vx-discover-target">
              <span><ArrowDownToLine size={15} aria-hidden="true" />{t("discover:target")}</span>
              <select aria-label={t("discover:target")} value={selectedInstance?.id ?? ""} onChange={(event) => {
                const id = event.target.value;
                if (id) selectInstance(id);
                else selectVersion(selectedVersionId);
              }}>
                <option value="">{t("discover:versionDirectory")}{selectedVersionId ? " · " + selectedVersionId : ""}</option>
                {data.instances.map((instance) => <option key={instance.id} value={instance.id}>{instance.name} · {instance.versionId}</option>)}
              </select>
            </label>
            <dl className="vx-discover-context">
              <div><dt>{t("library:version")}</dt><dd>{selectedVersionId || "—"}</dd></div>
              <div><dt>{t("library:loader")}</dt><dd>{selectedInstance?.loader || (selectedVersionId ? "Vanilla" : "—")}</dd></div>
            </dl>
            {!selectedVersionId ? <Button variant="secondary" onClick={() => setCreating(true)}>{t("library:createInstance")}</Button> : null}
          </GlassSurface>
          <label className="vx-discover-source"><span>{t("discover:source")}</span>
            <Select
              aria-label={t("discover:source")}
              value={source}
              onChange={(v) => setSource(v as typeof source)}
              options={[
                { value: "modrinth", label: "Modrinth" },
                { value: "curseforge", label: "CurseForge" },
              ]}
            />
          </label>
          <div className="vx-discover-types" role="tablist" aria-label={t("discover:typeLabel")} aria-orientation="vertical">
            {resourceTypes.map((value) => {
              const Icon = resourceIcons[value];
              return <button key={value} type="button" role="tab" id={"discover-type-" + value} aria-controls="discover-results" tabIndex={resourceType === value ? 0 : -1} aria-selected={resourceType === value} onClick={() => setResourceType(value)} onKeyDown={(event) => navigateType(event, value)}><Icon size={17} aria-hidden="true" /><span>{t("discover:type." + value)}</span><span className="vx-discover-type-mark" aria-hidden="true" /></button>;
            })}
          </div>
        </aside>
        <section className="vx-discover-results" id="discover-results" role="tabpanel" aria-labelledby={"discover-type-" + resourceType}>
          <GlassSurface className="vx-discover-search-lens" variant="control">
            <form className="vx-discover-search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }} role="search">
              <Search size={20} aria-hidden="true" />
              <input type="search" aria-label={t("discover:search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("discover:searchPlaceholder")} />
              <Button variant="primary" type="submit">{t("common:actions.search")}</Button>
            </form>
          </GlassSurface>
          <div className="vx-discover-results-heading"><h2>{t("discover:type." + resourceType)}</h2><span>{source === "modrinth" ? "Modrinth" : "CurseForge"}{!loading && !error ? " · " + formatNumber(resources.length, i18n.language) : ""}</span></div>
          {loading ? <p className="vx-discover-feedback" role="status">{t("common:status.loading")}</p> : null}
          {error ? <p className="vx-discover-feedback vx-discover-feedback--error" role="alert">{errorText(error, t)}</p> : null}
          {!loading && !error && resources.length === 0 ? <EmptyState title={t("discover:noResults")} description={t("discover:noResultsDescription")} /> : null}
          <div className="vx-project-grid" aria-busy={loading}>
            {resources.map((project) => <ProjectCard key={source + "-" + project.project_id} project={project} targetName={targetName} selected={selectedProject?.project_id === project.project_id} onOpen={() => void loadProject(project)} onInstall={() => void installProject(project)} />)}
          </div>
        </section>
      </div>
      <ProjectDetailsDrawer source={source} project={selectedProject} details={details} loading={detailsLoading} error={detailsError ? errorText(detailsError, t) : ""} targetName={targetName} onInstall={() => selectedProject && installProject(selectedProject)} onClose={closeProject} />
      {modpackProject || creating ? <CreateInstanceDialog project={modpackProject} open onOpenChange={(open) => { if (!open) { setModpackProject(undefined); setCreating(false); } }} onInstalled={installedWithOverture} /> : null}
      {notice ? <ToastRegion message={t("discover:notice." + notice)} kind="info" onDismiss={clearNotice} closeLabel={t("common:actions.close")} /> : null}
    </div>
  );
}
