import { useEffect, useState } from "react";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function readStaticMotion(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  return root.dataset.effects === "lite" || root.dataset.reducedMotion === "true" || prefersReducedMotion();
}

/** True when the lite effect level or reduced motion asks every lattice mark to hold still. */
export function useLatticeStaticMotion(): boolean {
  const [staticMotion, setStaticMotion] = useState(readStaticMotion);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setStaticMotion(readStaticMotion());
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(root, { attributes: true, attributeFilter: ["data-effects", "data-reduced-motion"] });
    const media = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    media?.addEventListener?.("change", update);
    media?.addListener?.(update);
    update();
    return () => {
      observer?.disconnect();
      media?.removeEventListener?.("change", update);
      media?.removeListener?.(update);
    };
  }, []);

  return staticMotion;
}
