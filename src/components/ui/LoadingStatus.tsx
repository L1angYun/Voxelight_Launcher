import { useEffect, useState, type ReactNode } from "react";
import { MOTION } from "../../design/motion";

export function LoadingStatus({ active, children, className }: { active: boolean; children: ReactNode; className?: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!active) { setVisible(false); return; }
    const timer = window.setTimeout(() => setVisible(true), MOTION.delay.loadingMs);
    return () => window.clearTimeout(timer);
  }, [active]);
  return active && visible ? <p role="status" className={className}>{children}</p> : null;
}
