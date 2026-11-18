import { useTranslation } from "react-i18next";
import { useRef } from "react";
import { ArrowDownToLine, Download } from "lucide-react";
import { ExternalLink } from "../../components/ui/ExternalLink";
import type { ResourceProject } from "../../lib/launcher";
import type { ResourceProjectDetails, ResourceSource } from "./types";
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
}) {
  const { t, i18n } = useTranslation();
  const snapshot = useRef<{ project: ResourceProject; details?: ResourceProjectDetails; loading: boolean; error: string; source: ResourceSource; targetName: string; hasTarget: boolean } | undefined>(undefined);
  const current = project ? { project, details, loading, error, source, targetName, hasTarget } : undefined;
  if (current) snapshot.current = current;
  const view = current ?? snapshot.current;
  if (!view) return null;
  const shown = view.project;
  const projectKey = `${view.source}:${shown.project_id}`;
  const hasPinnedInstall = shown.project_type !== "modpack";
  const localPackOnly = view.source === "curseforge" && shown.project_type === "modpack";
  const installLabel = t(localPackOnly ? "discover:importCurseforgeZip" : "discover:install");
  const external = shown.external_url || (view.source === "curseforge"
    ? `https://www.curseforge.com/projects/${shown.project_id}`
    : `https://modrinth.com/${shown.project_type}/${shown.slug}`);
  return (
    <Dialog
      open={Boolean(project)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={shown.title}
      closeLabel={t("common:actions.close")}
      className="vx-project-details"
      footer={<><ExternalLink url={external} variant="ghost">{t("discover:external")}</ExternalLink><Button variant="primary" icon={<Download size={15} />} aria-label={`${installLabel} · ${localPackOnly ? shown.title : view.targetName}`} onClick={onInstall}>{installLabel}</Button></>}
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
            {hasPinnedInstall && view.source === "modrinth" && view.details.versions.length > 0 ? <p>{t("discover:installVersionNotice")}</p> : null}
            {view.details.versions.length ? <div className="vx-resource-list">{view.details.versions.map((version) => (
              <div className="vx-resource-row" key={version.id}>
                <div><strong>{version.name || version.versionNumber}</strong><small>{version.gameVersions.join(", ")}{version.loaders.length ? ` · ${version.loaders.join(", ")}` : ""}</small></div>
                <small>{formatDate(version.datePublished, i18n.language)}</small>
                {hasPinnedInstall ? <Button variant="secondary" size="sm"
                  disabled={view.hasTarget && !version.compatible}
                  aria-label={t("discover:installVersion", { version: version.name || version.versionNumber || version.id })}
                  onClick={() => onInstallVersion(version.id)}>{t("discover:install")}</Button> : null}
              </div>
            ))}</div> : <EmptyState title={t("discover:noVersions")} />}
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
