import { LayoutGroup, motion } from "motion/react";
import { createContext, useContext, useId, type ReactNode } from "react";
import { sectionTransition } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";

export function SelectionGroup({ children }: { children: ReactNode }) {
  const id = useId();
  return <LayoutGroup id={id}>{children}</LayoutGroup>;
}

export const SelectionProjectionContext = createContext(true);

export function SelectionMark({ location }: { location: string }) {
  const { tier } = useMotionTier();
  const sharedLayout = useContext(SelectionProjectionContext);
  return <motion.span aria-hidden="true" className="vx-selection__mark" data-selection-mark=""
    layoutId={tier === "full" && sharedLayout ? "selected" : undefined}
    layoutDependency={location} transition={sectionTransition(tier)} />;
}
