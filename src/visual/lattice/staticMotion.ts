import { useEffect, useState } from "react";

const staticQueries = ["(prefers-reduced-motion: reduce)", "(prefers-contrast: more)", "(forced-colors: active)"];
function prefersStaticMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    staticQueries.some(query => window.matchMedia(query).matches)
  );
}

export function readStaticMotion(): boolean {
  if (typeof document === "undefined") return true;
  const root = document.documentElement;
  return root.dataset.effects === "lite" || root.dataset.reducedMotion === "true" || root.dataset.highContrast === "true" || prefersStaticMotion();
}

/** True when the lite effect level or reduced motion asks every lattice mark to hold still. */
export function useLatticeStaticMotion(): boolean {
  const [staticMotion, setStaticMotion] = useState(readStaticMotion);

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setStaticMotion(readStaticMotion());
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(root, { attributes: true, attributeFilter: ["data-effects", "data-reduced-motion", "data-high-contrast"] });
    const media = typeof window.matchMedia === "function" ? staticQueries.map(query => window.matchMedia(query)) : [];
    media.forEach(query => query.addEventListener?.("change", update));
    update();
    return () => {
      observer?.disconnect();
      media.forEach(query => query.removeEventListener?.("change", update));
    };
  }, []);

  return staticMotion;
}
