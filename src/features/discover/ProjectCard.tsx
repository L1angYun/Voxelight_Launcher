import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDownToLine, CircleCheck, Download, Package, PanelRight } from "lucide-react";
import type { ResourceProject } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { ICON } from "../../design/icons";
import { formatNumber } from "../../i18n/format";
import { cn } from "../../lib/utils";

/** The project's icon over a Package tile. The tile shows while the icon loads and again if it fails; it hides once the icon has loaded so transparent icons do not show it through. */
export function ProjectArt({ iconUrl, className }: { iconUrl: string | null; className: string }) {
  const [loaded, setLoaded] = useState<string | null>(null);
  return (
    <div className={className} aria-hidden="true" data-loaded={iconUrl && loaded === iconUrl ? "true" : undefined}>
      <Package size={ICON.xl} />
      {iconUrl ? <img key={iconUrl} src={iconUrl} alt="" loading="lazy" onLoad={() => setLoaded(iconUrl)} onError={(event) => { event.currentTarget.hidden = true; }} /> : null}
    </div>
  );
}

export function ProjectCard({ project, targetName, gameVersion, targetLoader, selected = false, onOpen, onInstall }: {
  project: ResourceProject;
  targetName: string;
  /** The resolved game version of the install target; drives the compatibility badge. */
  gameVersion?: string;
  /** The install target's loader: null or "vanilla" for a target that cannot load mods, undefined when unknown. */
  targetLoader?: string | null;
  selected?: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const titleId = useId();
  const installLabel = t("discover:install");
  // A mod never works on a vanilla target, whatever its game versions say.
  const cannotLoadMods = project.project_type === "mod" && targetLoader !== undefined && (!targetLoader || targetLoader.toLowerCase() === "vanilla");
  const compatible = gameVersion && !cannotLoadMods ? project.versions.includes(gameVersion) : false;
  const compatibilityText = cannotLoadMods ? t("discover:installTarget.reason.vanilla")
    : compatible ? t("discover:compatibleWith", { version: gameVersion }) : t("discover:noVersionFor", { version: gameVersion });
  return (
    <article className={cn("vx-project-card", selected && "is-selected")} data-project-id={project.project_id} data-visual-owner="lattice" tabIndex={-1} aria-labelledby={titleId} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }} onClick={(event) => {
      // The Details button's ::after stretches over the whole card. This
      // fallback keeps the card clickable without layout hit-testing too.
      if ((event.target as Element).closest("button, a, input, select, textarea, [role='button']")) return;
      onOpen();
    }}>
      <LatticeFrame hovered={hovered} focused={focused} selected={selected} signature={project.project_id} />
      <ProjectArt iconUrl={project.icon_url} className="vx-project-card__art" />
      <div className="vx-project-card__body">
        <div className="vx-project-card__identity"><h3 id={titleId}>{project.title}</h3>{project.author ? <span>{project.author}</span> : null}</div>
        <p className="vx-project-card__description">{project.description || t("discover:noDescription")}</p>
        <div className="vx-project-card__meta">
          <span className="vx-project-card__downloads" title={t("downloads:title")}><ArrowDownToLine size={ICON.xs} aria-hidden="true" />{formatNumber(project.downloads, i18n.language, { notation: "compact" })}</span>
          {gameVersion ? <span className="vx-project-card__compatibility" data-compatible={compatible ? "true" : "false"}>
            {compatible ? <CircleCheck size={ICON.xs} aria-hidden="true" /> : null}
            {compatibilityText}
          </span> : null}
        </div>
      </div>
      <div className="vx-project-card__actions">
        <Button variant="secondary" size="sm" icon={<Download size={ICON.sm} />} aria-label={t("discover:installTarget.installInto", { name: targetName })} onClick={onInstall}>{installLabel}</Button>
        <Button variant="ghost" size="sm" className="vx-project-card__details" icon={<PanelRight size={ICON.sm} />} aria-current={selected || undefined} onClick={onOpen}>{t("discover:details")}</Button>
      </div>
    </article>
  );
}
