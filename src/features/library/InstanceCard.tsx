import { useState } from "react";
import { motion } from "motion/react";
import { MOTION, motionDuration } from "../../design/motion";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Activity,
  ArrowUpRight,
  Clock3,
  Folder,
  Play,
  Timer,
} from "lucide-react";
import type { Instance } from "../../lib/launcher";
import { Button } from "../../components/ui/Button";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { cn } from "../../lib/utils";
import { formatDate } from "../../i18n/format";
import { InstanceIdentity } from "./InstanceIdentity";
import { loaderText } from "./utils";

function playtimeText(seconds: number, t: TFunction): string {
  const totalMinutes = Math.max(1, Math.round(seconds / 60));
  if (totalMinutes < 60) {
    return t("library:minutes", { count: totalMinutes });
  }
  return t("library:playtimeHoursMinutes", {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  });
}

export function InstanceCard({
  instance,
  selected = false,
  running = false,
  onOpen,
  onLaunch,
  layoutOrder,
}: {
  instance: Instance;
  selected?: boolean;
  running?: boolean;
  onOpen: () => void;
  onLaunch: () => void;
  layoutOrder?: string;
}) {
  const { t, i18n } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const runtime = loaderText(instance, t);
  const playtime =
    instance.totalPlayTime > 0
      ? playtimeText(instance.totalPlayTime, t)
      : null;
  return (
    <motion.article
      className={cn("vx-instance-card", selected && "is-selected", running && "is-running")}
      {...(layoutOrder ? { layout: "position" as const, layoutDependency: layoutOrder, transition: { layout: { duration: motionDuration("full", "enter"), ease: MOTION.ease } } } : {})}
      data-instance-id={instance.id}
      data-visual-owner="lattice"
      data-running={running}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    >
      <LatticeFrame hovered={hovered} focused={focused} selected={selected} signature={instance.id} />
      <button
        type="button"
        className="vx-instance-card__select"
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        aria-label={t("library:openInstance", { name: instance.name })}
      >
        <span className="vx-instance-card__identity">
          <InstanceIdentity name={instance.name} identity={instance.id} iconPath={instance.iconPath} />
        </span>
        <span className="vx-instance-card__information">
          <span className="vx-instance-card__name" title={instance.name}>{instance.name}</span>
          <span
            className="vx-instance-card__technical"
            title={t("library:runtimeSummary", { version: instance.versionId, loader: runtime })}
          >
            <span>{instance.versionId}</span>
            <span className="vx-instance-card__separator" aria-hidden="true">·</span>
            <span>{runtime}</span>
          </span>
          <span className="vx-instance-card__secondary-line">
            {instance.lastPlayed ? (
              <span className="vx-instance-card__path" title={instance.lastPlayed}>
                <Clock3 size={12} aria-hidden="true" />
                <span>{t("library:lastPlayed")}</span>
                <time dateTime={instance.lastPlayed}>{formatDate(instance.lastPlayed, i18n.language)}</time>
              </span>
            ) : (
              <span className="vx-instance-card__path" title={instance.gameDirectory} aria-label={t("library:directory")}>
                <Folder size={12} aria-hidden="true" />
                <span>{instance.gameDirectory}</span>
              </span>
            )}
            {playtime ? (
              <span className="vx-instance-card__playtime" title={t("library:playtime")}>
                <Timer size={12} aria-hidden="true" />
                <span>{playtime}</span>
              </span>
            ) : null}
          </span>
        </span>
        <span className="vx-instance-card__open"><ArrowUpRight size={16} aria-hidden="true" /></span>
      </button>
      <div className="vx-instance-card__footer">
        {running ? (
          <span className="vx-instance-card__state">
            <Activity size={13} aria-hidden="true" />
            {t("library:running")}
          </span>
        ) : null}
        <Button className="vx-instance-card__launch" variant="secondary" size="sm" data-launch icon={<Play size={14} />} onClick={onLaunch}>{t("common:actions.launch")}</Button>
      </div>
    </motion.article>
  );
}
