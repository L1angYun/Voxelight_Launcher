import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Download, Package } from "lucide-react";
import type { ResourceProject } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { formatNumber } from "../../i18n/format";
import { cn } from "../../lib/utils";

export function ProjectCard({ project, targetName, selected = false, onOpen, onInstall }: {
  project: ResourceProject;
  targetName: string;
  selected?: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return (
    <article className={cn("vx-project-card", selected && "is-selected")} data-project-id={project.project_id} data-visual-owner="lattice" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
      <LatticeFrame hovered={hovered} focused={focused} selected={selected} signature={project.project_id} />
      <div className="vx-project-card__art" aria-hidden="true">{project.icon_url ? <img src={project.icon_url} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} /> : <Package size={27} strokeWidth={1.3} />}</div>
      <div className="vx-project-card__body">
        <div className="vx-project-card__identity"><h3>{project.title}</h3>{project.author ? <span>{project.author}</span> : null}</div>
        <p className="vx-project-card__description">{project.description || t("discover:noDescription")}</p>
        <div className="vx-project-card__meta"><span title={t("downloads:title")}><Download size={12} aria-hidden="true" />{formatNumber(project.downloads, i18n.language, { notation: "compact" })}</span><span>{project.versions.slice(-3).join(" · ")}</span></div>
      </div>
      <div className="vx-project-card__actions">
        <Button variant="secondary" icon={<Download size={14} />} aria-label={t("discover:install") + " · " + targetName} onClick={onInstall}>{t("discover:install")}</Button>
        <Button variant="ghost" icon={<ArrowUpRight size={14} />} onClick={onOpen}>{t("discover:details")}</Button>
      </div>
    </article>
  );
}
