import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Box } from "lucide-react";
import type { Instance } from "../../lib/launcher";
import { LatticeFrame } from "../../visual/lattice/LatticeFrame";
import { cn } from "../../lib/utils";

export function RecentInstances({
  instances,
  selectedId,
  onSelect,
}: {
  instances: Instance[];
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  if (instances.length < 2) return null;
  const recent = [...instances]
    .sort((a, b) => (b.lastPlayed ?? b.createdAt).localeCompare(a.lastPlayed ?? a.createdAt))
    .slice(0, 4);
  return (
    <section className="vx-recent" aria-labelledby="recent-instances-title">
      <div className="vx-section-heading">
        <h2 id="recent-instances-title">{t("home:recentInstances")}</h2>
      </div>
      <div className="vx-recent__grid">
        {recent.map((instance) => {
          const selected = instance.id === selectedId;
          return (
            <button
              key={instance.id}
              type="button"
              className={cn("vx-recent-card", selected && "is-selected")}
              data-instance-id={instance.id}
              data-visual-owner="lattice"
              aria-current={selected || undefined}
              onClick={() => onSelect(instance.id)}
              onMouseEnter={() => setHovered(instance.id)}
              onMouseLeave={() => setHovered(undefined)}
              onFocus={(event) => setFocused(event.currentTarget.matches(":focus-visible") ? instance.id : undefined)}
              onBlur={() => setFocused(undefined)}
            >
              <LatticeFrame signature={instance.id} hovered={hovered === instance.id} focused={focused === instance.id} selected={selected} />
              <Box className="vx-recent-card__icon" size={25} strokeWidth={1.2} aria-hidden="true" />
              <span className="vx-recent-card__name" title={instance.name}>{instance.name}</span>
              <span className="vx-recent-card__meta">{instance.versionId} · {!instance.loader || instance.loader === "vanilla" ? t("home:vanilla") : instance.loader}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
