import { LayoutGroup, motion } from "motion/react";
import { useId, type ReactNode } from "react";
import { sectionTransition } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";

export function SelectionGroup({ children }: { children: ReactNode }) {
  const id = useId();
  return <LayoutGroup id={id}>{children}</LayoutGroup>;
}

export function SelectionMark({ location }: { location: string }) {
  const { tier } = useMotionTier();
  return <motion.span aria-hidden="true" className="vx-selection__mark" data-selection-mark=""
    layoutId={tier === "full" ? "selected" : undefined}
    layoutDependency={location} transition={sectionTransition(tier)} />;
}
