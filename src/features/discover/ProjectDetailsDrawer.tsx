import { useTranslation } from "react-i18next";
import { useRef, useState } from "react";
import { ArrowDownToLine, Download } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
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
  onClose,
  source,
  targetName,
}: {
  project?: ResourceProject;
  details?: ResourceProjectDetails;
  loading: boolean;
  error: string;
  onInstall: () => void;
  onClose: () => void;
  source: ResourceSource;
  targetName: string;
}) {
  const { t, i18n } = useTranslation();
  const [externalError, setExternalError] = useState({ key: "", message: "" });
  const snapshot = useRef<{ project: ResourceProject; details?: ResourceProjectDetails; loading: boolean; error: string; source: ResourceSource; targetName: string } | undefined>(undefined);
  const current = project ? { project, details, loading, error, source, targetName } : undefined;
  if (current) snapshot.current = current;
  const view = current ?? snapshot.current;
  if (!view) return null;
  const shown = view.project;
  const projectKey = `${view.source}:${shown.project_id}`;
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
      footer={<><Button variant="ghost" onClick={() => { setExternalError({ key: projectKey, message: "" }); void openUrl(external).catch((cause) => setExternalError({ key: projectKey, message: errorText(cause, t) })); }}>{t("discover:external")}</Button><Button variant="primary" icon={<Download size={15} />} aria-label={`${t("discover:install")} · ${view.targetName}`} onClick={onInstall}>{t("discover:install")}</Button></>}
    >
      <div className="vx-project-details__target"><ArrowDownToLine size={16} aria-hidden="true" /><span>{t("discover:target")}</span><strong>{view.targetName}</strong></div>
      <LoadingStatus active={view.loading}>{t("common:status.loading")}</LoadingStatus>
      {view.error ? <p role="alert">{view.error}</p> : null}
      {externalError.key === projectKey && externalError.message ? <p role="alert">{externalError.message}</p> : null}
      <p className="vx-project-details__description">{shown.description || t("discover:noDescription")}</p>
      <p className="vx-project-details__meta">{shown.author || t("discover:authorUnknown")} · {formatNumber(shown.downloads, i18n.language, { notation: "compact" })}</p>
      {view.details ? (
        <SectionPanel selectionKey={projectKey}>
          <section className="vx-project-details__section">
            <h2>{t("discover:versions")}</h2>
            {view.details.versions.length ? <div className="vx-resource-list">{view.details.versions.map((version) => (
              <div className="vx-resource-row" key={version.id}>
                <div><strong>{version.name || version.versionNumber}</strong><small>{version.gameVersions.join(", ")}{version.loaders.length ? ` · ${version.loaders.join(", ")}` : ""}</small></div>
                <small>{formatDate(version.datePublished, i18n.language)}</small>
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
