import { useState } from "react";
import { motion } from "motion/react";
import { MOTION, motionDuration } from "../../design/motion";
import { ICON } from "../../design/icons";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Activity,
  ChevronRight,
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
import { instanceIssueBlocksLaunch } from "../../lib/gameFolders";

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
  const blocked = instanceIssueBlocksLaunch(instance.issue);
  const issueText = instance.issue ? t(`library:instanceIssue.${instance.issue}`) : "";
  const directoryParts = /^(.*[\\/])([^\\/]+[\\/]*)$/.exec(instance.gameDirectory);
  const directoryHead = directoryParts?.[1] ?? "", directoryTail = directoryParts?.[2] ?? instance.gameDirectory;
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
          <InstanceIdentity name={instance.name} identity={instance.id} iconPath={instance.iconPath}
            loader={instance.loader} versionId={instance.versionId} />
        </span>
        <span className="vx-instance-card__information">
          <span className="vx-instance-card__name" title={instance.name}>{instance.name}</span>
          <span
            className="vx-instance-card__technical"
            title={t("library:runtimeSummary", { version: instance.versionId, loader: runtime })}
          >
            <span>{instance.versionId}</span>{" "}
            <span className="vx-instance-card__runtime">{runtime}</span>
          </span>
          <span className="vx-instance-card__secondary-line">
            {instance.lastPlayed ? (
              <span className="vx-instance-card__path" title={instance.lastPlayed}>
                <Clock3 size={ICON.xs} aria-hidden="true" />
                <span>{t("library:lastPlayed")}</span>
                <time dateTime={instance.lastPlayed}>{formatDate(instance.lastPlayed, i18n.language)}</time>
              </span>
            ) : (
              <span className="vx-instance-card__path" title={instance.gameDirectory}>
                <Folder size={ICON.xs} aria-hidden="true" />
                <span className="sr-only">{t("library:directory")}: </span>
                <span className="vx-instance-card__path-value"><span className="vx-instance-card__path-head">{directoryHead}</span><span className="vx-instance-card__path-tail">{directoryTail}</span></span>
              </span>
            )}
            {playtime ? (
              <span className="vx-instance-card__playtime" title={t("library:playtime")}>
                <Timer size={ICON.xs} aria-hidden="true" />
                <span>{playtime}</span>
              </span>
            ) : null}
          </span>
        </span>
        <span className="vx-instance-card__open"><ChevronRight size={ICON.md} aria-hidden="true" /></span>
      </button>
      <div className="vx-instance-card__footer">
        {running ? (
          <span className="vx-instance-card__state">
            <Activity size={ICON.xs} aria-hidden="true" />
            {t("library:running")}
          </span>
        ) : null}
        {blocked ? (
          <span className="vx-instance-card__issue" role="status" title={issueText}>
            {t("library:launchBlocked")}
          </span>
        ) : null}
        <Button className="vx-instance-card__launch" variant="secondary" size="sm" data-launch
          disabled={blocked} title={blocked ? issueText : undefined}
          icon={<Play size={ICON.sm} />} onClick={onLaunch}>{t("common:actions.launch")}</Button>
      </div>
    </motion.article>
  );
}
