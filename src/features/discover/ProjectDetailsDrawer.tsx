import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Download } from "lucide-react";
import { ExternalLink } from "../../components/ui/ExternalLink";
import type { ResourceProject } from "../../lib/launcher";
import type { ResourceProjectDetails, ResourceSource, ResourceVersion } from "./types";
import { instancesFitting, type FittableInstance } from "./versionFits";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/Feedback";
import { LoadingStatus } from "../../components/ui/LoadingStatus";
import { SectionPanel } from "../../components/ui/SectionPanel";
import { formatDate, formatNumber } from "../../i18n/format";
import { errorText } from "../library/utils";
import "./discover.css";

export function ProjectDetailsDrawer({
  project,
  details,
  loading,
  error,
  onInstall,
  onInstallVersion,
  onClose,
  source,
  targetName,
  hasTarget,
  instances = [],
}: {
  project?: ResourceProject;
  details?: ResourceProjectDetails;
  loading: boolean;
  error: string;
  onInstall: () => void;
  onInstallVersion: (versionId: string) => void;
  onClose: () => void;
  source: ResourceSource;
  targetName: string;
  hasTarget: boolean;
  instances?: readonly FittableInstance[];
}) {
  const { t, i18n } = useTranslation();
  const [fittingProject, setFittingProject] = useState<string>();
  const snapshot = useRef<{ project: ResourceProject; details?: ResourceProjectDetails; loading: boolean; error: string; source: ResourceSource; targetName: string; hasTarget: boolean } | undefined>(undefined);
  const current = project ? { project, details, loading, error, source, targetName, hasTarget } : undefined;
  if (current) snapshot.current = current;
  // The parent can close the drawer by dropping `project`, without going
  // through Dialog.onOpenChange. Reset the filter for every open/close so it
  // defaults to off when a project is opened again.
  const openProjectKey = project ? `${source}:${project.project_id}` : undefined;
  useEffect(() => { setFittingProject(undefined); }, [openProjectKey]);
  const view = current ?? snapshot.current;
  if (!view) return null;
  const shown = view.project;
  const projectKey = `${view.source}:${shown.project_id}`;
  const hasPinnedInstall = shown.project_type !== "modpack";
  const onlyFitting = hasPinnedInstall && fittingProject === projectKey;
  const installLabel = t("discover:install");
  const versions = view.details?.versions ?? [];
  const fitted = (version: ResourceVersion) => instancesFitting(version, instances, shown.project_type);
  const visibleVersions = onlyFitting ? versions.filter(version => fitted(version).length > 0) : versions;
  const fittingTitle = (matches: readonly FittableInstance[]) => {
    if (!matches.length) return undefined;
    const names = matches.slice(0, 5).map(instance => instance.name);
    const remaining = matches.length - names.length;
    return remaining > 0
      ? `${names.join(", ")}${t("discover:fits.more", { count: remaining })}`
      : names.join(", ");
  };
  const external = shown.external_url || (view.source === "curseforge"
    ? `https://www.curseforge.com/projects/${shown.project_id}`
    : `https://modrinth.com/${shown.project_type}/${shown.slug}`);
  return (
    <Dialog
      open={Boolean(project)}
      onOpenChange={(open) => { if (!open) { setFittingProject(undefined); onClose(); } }}
      title={shown.title}
      closeLabel={t("common:actions.close")}
      className="vx-project-details"
      footer={<><ExternalLink url={external} variant="ghost">{t("discover:external")}</ExternalLink><Button variant="primary" icon={<Download size={15} />} aria-label={`${installLabel} · ${view.targetName}`} onClick={onInstall}>{installLabel}</Button></>}
    >
      <div className="vx-project-details__target"><ArrowDownToLine size={16} aria-hidden="true" /><span>{t("discover:target")}</span><strong>{view.targetName}</strong></div>
      <LoadingStatus active={view.loading}>{t("common:status.loading")}</LoadingStatus>
      {view.error ? <p role="alert">{view.error}</p> : null}
      <p className="vx-project-details__description">{shown.description || t("discover:noDescription")}</p>
      <p className="vx-project-details__meta">{shown.author || t("discover:authorUnknown")} · {formatNumber(shown.downloads, i18n.language, { notation: "compact" })}</p>
      {view.details ? (
        <SectionPanel selectionKey={projectKey}>
          <section className="vx-project-details__section">
            <h2>{t("discover:versions")}</h2>
            {hasPinnedInstall && view.source === "modrinth" && versions.length > 0 ? <p>{t("discover:installVersionNotice")}</p> : null}
            {hasPinnedInstall && versions.length ? <label className="vx-project-details__version-filter">
              <input type="checkbox" checked={onlyFitting} onChange={event => setFittingProject(event.target.checked ? projectKey : undefined)} />
              <span>{t("discover:fits.onlyMine")}</span>
            </label> : null}
            {versions.length ? (visibleVersions.length ? <div className="vx-resource-list">{visibleVersions.map((version) => {
              const matches = fitted(version);
              const title = fittingTitle(matches);
              return (
                <div className="vx-resource-row" key={version.id}>
                  <div>
                    <strong>{version.name || version.versionNumber}</strong>
                    <small>{version.gameVersions.join(", ")}{version.loaders.length ? ` · ${version.loaders.join(", ")}` : ""}</small>
                    {hasPinnedInstall ? <small className="vx-project-details__fits" data-fits={matches.length ? "true" : "false"} title={title}>
                      {matches.length ? t("discover:fits.count", { count: matches.length }) : t("discover:fits.none")}
                    </small> : null}
                  </div>
                  <small>{formatDate(version.datePublished, i18n.language)}</small>
                  {hasPinnedInstall ? <Button variant="secondary" size="sm"
                    disabled={view.hasTarget && !version.compatible}
                    aria-label={t("discover:installVersion", { version: version.name || version.versionNumber || version.id })}
                    onClick={() => onInstallVersion(version.id)}>{t("discover:install")}</Button> : null}
                </div>
              );
            })}</div> : <p className="vx-project-details__version-empty" role="status">{t("discover:fits.empty")}</p>) : <EmptyState title={t("discover:noVersions")} />}
          </section>
          <section className="vx-project-details__section">
            <h2>{t("discover:dependencies")}</h2>
            {view.details.dependencies.length ? <div className="vx-resource-list">{view.details.dependencies.map((dependency) => (
              <div className="vx-resource-row" key={`${dependency.projectId}-${dependency.kind}`}>
                <div><strong>{dependency.name || dependency.projectId}</strong><small>{dependency.projectId}</small></div>
                <span className="vx-dependency-kind" data-kind={dependency.kind}>{t(`discover:dependency.${dependency.kind}`)}</span>
              </div>
            ))}</div> : <EmptyState title={t("discover:noDependencies")} />}
          </section>
        </SectionPanel>
      ) : null}
    </Dialog>
  );
}
