import { useTranslation } from "react-i18next";
import { useState } from "react";
import { ArrowDownToLine, Download } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ResourceProject } from "../../lib/launcher";
import type { ResourceProjectDetails, ResourceSource } from "./types";
import { Button } from "../../components/ui/Button";
import { Dialog } from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/Feedback";
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
  const [externalError, setExternalError] = useState("");
  if (!project) return null;
  const external = project.external_url || (source === "curseforge"
    ? `https://www.curseforge.com/projects/${project.project_id}`
    : `https://modrinth.com/${project.project_type}/${project.slug}`);
  return (
    <Dialog
      open={Boolean(project)}
      onOpenChange={(open) => { if (!open) onClose(); }}
      title={project.title}
      closeLabel={t("common:actions.close")}
      className="vx-project-details"
      footer={<><Button variant="ghost" onClick={() => { setExternalError(""); void openUrl(external).catch((cause) => setExternalError(errorText(cause, t))); }}>{t("discover:external")}</Button><Button variant="primary" icon={<Download size={15} />} aria-label={`${t("discover:install")} · ${targetName}`} onClick={onInstall}>{t("discover:install")}</Button></>}
    >
      <div className="vx-project-details__target"><ArrowDownToLine size={16} aria-hidden="true" /><span>{t("discover:target")}</span><strong>{targetName}</strong></div>
      {loading ? <p role="status">{t("common:status.loading")}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {externalError ? <p role="alert">{externalError}</p> : null}
      <p className="vx-project-details__description">{project.description || t("discover:noDescription")}</p>
      <p className="vx-project-details__meta">{project.author || t("discover:authorUnknown")} · {formatNumber(project.downloads, i18n.language, { notation: "compact" })}</p>
      {details ? (
        <>
          <section className="vx-project-details__section">
            <h2>{t("discover:versions")}</h2>
            {details.versions.length ? <div className="vx-resource-list">{details.versions.map((version) => (
              <div className="vx-resource-row" key={version.id}>
                <div><strong>{version.name || version.versionNumber}</strong><small>{version.gameVersions.join(", ")}{version.loaders.length ? ` · ${version.loaders.join(", ")}` : ""}</small></div>
                <small>{formatDate(version.datePublished, i18n.language)}</small>
              </div>
            ))}</div> : <EmptyState title={t("discover:noVersions")} />}
          </section>
          <section className="vx-project-details__section">
            <h2>{t("discover:dependencies")}</h2>
            {details.dependencies.length ? <div className="vx-resource-list">{details.dependencies.map((dependency) => (
              <div className="vx-resource-row" key={`${dependency.projectId}-${dependency.kind}`}>
                <div><strong>{dependency.name || dependency.projectId}</strong><small>{dependency.projectId}</small></div>
                <span className="vx-dependency-kind" data-kind={dependency.kind}>{t(`discover:dependency.${dependency.kind}`)}</span>
              </div>
            ))}</div> : <EmptyState title={t("discover:noDependencies")} />}
          </section>
        </>
      ) : null}
    </Dialog>
  );
}
