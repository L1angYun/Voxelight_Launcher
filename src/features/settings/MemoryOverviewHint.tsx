import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../components/ui/Button";
import { command, type MemoryOverview } from "../../lib/launcher";

export function MemoryOverviewHint({ instanceId }: { instanceId?: string }) {
  const { t, i18n } = useTranslation("settings");
  const [overview, setOverview] = useState<{ instanceId?: string; value: MemoryOverview }>();
  const [revision, refresh] = useState(0);

  useEffect(() => {
    let active = true;
    void command<MemoryOverview>("get_memory_overview", instanceId ? { instanceId } : undefined)
      .then((value) => { if (active) setOverview({ instanceId, value }); })
      .catch(() => { if (active) setOverview(undefined); });
    return () => { active = false; };
  }, [instanceId, revision]);

  const value = overview?.instanceId === instanceId ? overview?.value : undefined;
  if (!value || value.totalMb == null || value.availableMb == null) return null;
  const gb = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 });
  return <div className="vx-action-row">
    <small aria-live="polite">{t("memory.overview", {
      total: gb.format(value.totalMb / 1024), available: gb.format(value.availableMb / 1024),
      recommended: value.recommendedMb,
    })}</small>
    <Button type="button" size="sm" variant="secondary" onClick={() => refresh((value) => value + 1)}>{t("memory.refresh")}</Button>
  </div>;
}
