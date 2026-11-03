import type { CSSProperties, HTMLAttributes, Key } from "react";
import { motionDuration } from "../../design/motion";
import { useMotionTier } from "../../design/useMotionTier";
import { cn } from "../../lib/utils";
import "./selection.css";

/** The outgoing subtree unmounts immediately; only its replacement fades in. */
export function SectionPanel({ selectionKey, className, style, ...props }: HTMLAttributes<HTMLDivElement> & { selectionKey: Key }) {
  const { tier } = useMotionTier();
  return <div {...props} key={selectionKey} className={cn("vx-section-panel", className)}
    data-section-motion={tier}
    style={{ ...style, "--section-duration": `${motionDuration(tier, "content")}s` } as CSSProperties} />;
}
