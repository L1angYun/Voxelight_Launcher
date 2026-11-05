import { useEffect, useState, type ReactNode } from "react";
import { MOTION } from "../../design/motion";
import { cn } from "../../lib/utils";

export function LoadingStatus({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    const timer = window.setTimeout(() => setVisible(true), MOTION.delay.loadingMs);
    return () => window.clearTimeout(timer);
  }, [active]);
  return <p role="status" className={cn("vx-loading-status", className, !(active && visible) && "sr-only")}>{active && visible ? children : null}</p>;
}
