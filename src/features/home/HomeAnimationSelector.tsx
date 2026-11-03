// SPDX-License-Identifier: GPL-3.0-only
import { Footprints, PersonStanding, Timer } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppearance } from "../../app/AppearanceProvider";
import { Select } from "../../components/ui/Select";
import type { CharacterAnimation } from "../../visual/character/CharacterCanvas";
import "./HomeAnimationSelector.css";

export type HomeAnimationMode = Exclude<CharacterAnimation, "none">;
export interface HomeAnimationSelectorProps {
  value: HomeAnimationMode;
  onChange(value: HomeAnimationMode): void;
  visible?: boolean;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-describedby"?: string;
}

export function HomeAnimationSelector({ value, onChange, visible = false, disabled = false,
  "aria-label": label, "aria-describedby": describedBy }: HomeAnimationSelectorProps) {
  const { t } = useTranslation();
  const { effects, reducedMotion, reducedTransparency, highContrast } = useAppearance();
  const staticMotion = effects !== "full" || reducedMotion || reducedTransparency || highContrast;
  return <div className="vx-home-animation-selector" data-visible={visible} data-motion={staticMotion ? "reduced" : "full"}>
    <Select material="glass" value={value} onChange={next => {
      if (next === "idle" || next === "walk" || next === "run") onChange(next);
    }} disabled={disabled} aria-label={label ?? t("home:animationMode")} aria-describedby={describedBy}
      minimumMenuWidth={180} options={[
        { value: "idle", label: t("home:anim.idle"), icon: <PersonStanding size={16} aria-hidden="true" /> },
        { value: "walk", label: t("home:anim.walk"), icon: <Footprints size={16} aria-hidden="true" /> },
        { value: "run", label: t("home:anim.run"), icon: <Timer size={16} aria-hidden="true" /> },
      ]} />
  </div>;
}
