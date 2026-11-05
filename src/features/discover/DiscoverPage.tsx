import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Box, Layers3, Package, Search, Sparkles } from "lucide-react";
import { useLauncher } from "../../app/controller/LauncherProvider";
import { useOverture } from "../../visual/overture/OvertureProvider";
import { Button } from "../../components/ui/Button";
import { Select } from "../../components/ui/Select";
import { EmptyState } from "../../components/ui/Feedback";
import { ProjectCard } from "./ProjectCard";
import { ProjectDetailsDrawer } from "./ProjectDetailsDrawer";
import { CreateInstanceDialog } from "../library/CreateInstanceDialog";
import { useDiscover } from "./useDiscover";
import type { ResourceProject } from "../../lib/launcher";
import { PageHeader, PageShell } from "../../components/ui/PageShell";
import { Segmented } from "../../components/ui/Segmented";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { useToast } from "../../components/ui/ToastProvider";
import { errorText } from "../library/utils";
import { formatNumber } from "../../i18n/format";
import "./discover.css";

const resourceTypes = ["mod", "resourcepack", "shader", "modpack"] as const;
const resourceIcons = { mod: Box, resourcepack: Layers3, shader: Sparkles, modpack: Package };

export function DiscoverPage() {
  const { t, i18n } = useTranslation();
  const { data, selectedVersionId, selectedInstance, selectInstance, selectVersion } = useLauncher();
  const { play } = useOverture();
  const { notify } = useToast();
  const lastModpack = useRef<ResourceProject | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const discover = useDiscover();
  const {
    source, setSource, resourceType, setResourceType, query, setQuery, setSearch,
    resources, loading, stale, resultKey, error, notice, selectedProject, details, detailsLoading, detailsError,
    modpackProject, setModpackProject, loadProject, closeProject, installProject, installed, clearNotice,
  } = discover;
  const createOpen = Boolean(modpackProject || creating);
  if (createOpen) lastModpack.current = modpackProject;
  useEffect(() => {
    if (!notice) return;
    notify({ message: t("discover:notice." + notice), kind: "success" });
    clearNotice();
  }, [clearNotice, notice, notify, t]);
  const targetName = selectedInstance?.name || (selectedVersionId ? t("library:versionDirectory") + " · " + selectedVersionId : t("discover:versionDirectory"));

  async function installedWithOverture(versionId: string, instanceId?: string) {
    await installed(versionId, instanceId);
    setCreating(false);
    play({ id: "discover-instance-installed-" + (instanceId ?? versionId) + "-" + Date.now(), kind: "instance-installed" });
  }


  return (
    <PageShell className="vx-discover-page">
      <PageHeader title={t("discover:title")} />
      <div className="vx-discover-workspace vx-workspace">
        <aside className="vx-discover-catalog" aria-label={t("discover:typeLabel")}>
          <div className="vx-discover-destination vx-panel">
            <label className="vx-discover-target">
              <span><ArrowDownToLine size={15} aria-hidden="true" />{t("discover:target")}</span>
              <Select embedded aria-label={t("discover:target")} value={selectedInstance?.id ?? ""} onChange={(id) => {
                if (id) selectInstance(id);
                else selectVersion(selectedVersionId);
              }} options={[
                { value: "", label: t("discover:versionDirectory"), metadata: selectedVersionId },
                ...data.instances.map((instance) => ({ value: instance.id, label: instance.name, metadata: instance.versionId })),
              ]} />
            </label>
            <dl className="vx-discover-context">
              <div><dt>{t("library:version")}</dt><dd>{selectedVersionId || "—"}</dd></div>
              <div><dt>{t("library:loader")}</dt><dd>{selectedInstance?.loader || (selectedVersionId ? "Vanilla" : "—")}</dd></div>
            </dl>
            {!selectedVersionId ? <Button variant="secondary" onClick={() => setCreating(true)}>{t("library:createInstance")}</Button> : null}
          </div>
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
          <Segmented className="vx-discover-types" semantic="tabs" orientation="vertical"
            label={t("discover:typeLabel")} value={resourceType} onChange={setResourceType}
            idPrefix="discover-type" panelId="discover-results"
            options={resourceTypes.map((value) => {
              const Icon = resourceIcons[value];
              return { value, icon: <Icon size={17} aria-hidden="true" />, label: t("discover:type." + value) };
            })} />
        </aside>
        <section className="vx-discover-results vx-panel" id="discover-results" role="tabpanel" aria-labelledby={"discover-type-" + resourceType}>
          <div className="vx-discover-search-lens">
            <form className="vx-discover-search" onSubmit={(event) => { event.preventDefault(); setSearch(query.trim()); }} role="search">
              <Search size={20} aria-hidden="true" />
              <input type="search" aria-label={t("discover:search")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("discover:searchPlaceholder")} />
              <Button variant="primary" type="submit">{t("common:actions.search")}</Button>
            </form>
          </div>
          <div className="vx-discover-results-heading"><h2>{t("discover:type." + resourceType)}</h2><span>{source === "modrinth" ? "Modrinth" : "CurseForge"}{!loading && !error ? " · " + formatNumber(resources.length, i18n.language) : ""}</span></div>
          <LoadingStatus active={loading} className="vx-discover-feedback">{t("common:status.loading")}</LoadingStatus>
          {error ? <p className="vx-discover-feedback vx-discover-feedback--error" role="alert">{errorText(error, t)}</p> : null}
          {!loading && !error && resources.length === 0 ? <EmptyState title={t("discover:noResults")} description={t("discover:noResultsDescription")} /> : null}
          <SectionPanel selectionKey={resultKey} className="vx-project-grid" aria-busy={loading} inert={loading || stale}>
            {resources.map((project) => <ProjectCard key={source + "-" + project.project_id} project={project} targetName={targetName} selected={selectedProject?.project_id === project.project_id} onOpen={() => void loadProject(project)} onInstall={() => void installProject(project)} />)}
          </SectionPanel>
        </section>
      </div>
      <ProjectDetailsDrawer source={source} project={selectedProject} details={details} loading={detailsLoading} error={detailsError ? errorText(detailsError, t) : ""} targetName={targetName} onInstall={() => selectedProject && installProject(selectedProject)} onClose={closeProject} />
      <CreateInstanceDialog project={createOpen ? modpackProject : lastModpack.current} open={createOpen}
        onOpenChange={(open) => { if (!open) { setModpackProject(undefined); setCreating(false); } }} onInstalled={installedWithOverture} />
    </PageShell>
  );
}
