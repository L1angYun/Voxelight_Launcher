import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { desktop } from "../../lib/launcher";
import { identityTransition, type MotionTier } from "../../design/motion";
import { InstanceGlyph, glyphLoader, glyphLoaderForVersionDirectory, glyphVersion } from "./instanceGlyphs";

const IconFailures = createContext<{
  tier: MotionTier;
  returningIdentity?: string;
  paths: ReadonlySet<string>;
  remember: (path: string) => void;
} | null>(null);

/** Keep a known fallback across the directly unmounted card/detail trees. */
export function InstanceIdentityProvider({ tier, returningIdentity, children }:
  { tier: MotionTier; returningIdentity?: string; children: ReactNode }) {
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => new Set());
  return <IconFailures.Provider value={{ tier, returningIdentity, paths, remember: (path) => {
    setPaths((previous) => previous.has(path) ? previous : new Set([...previous, path]));
  } }}>{children}</IconFailures.Provider>;
}

/** An identity derived from the user's name/icon, never a fabricated world preview. */
export function InstanceIdentity({
  name,
  identity,
  iconPath,
  kind = "instance",
  placement = "card",
  loader,
  versionId,
  versionType,
}: {
  name: string;
  identity: string;
  iconPath?: string | null;
  kind?: "instance" | "version-directory";
  placement?: "card" | "detail";
  loader?: string | null;
  versionId?: string;
  versionType?: string | null;
}) {
  const sharedFailures = useContext(IconFailures);
  const tier = sharedFailures?.tier ?? "none";
  const [failedIcon, setFailedIcon] = useState<string>();
  const icon =
    desktop && iconPath && failedIcon !== iconPath && !sharedFailures?.paths.has(iconPath)
      ? convertFileSrc(iconPath)
      : undefined;
  const layoutId = tier === "full" ? `${kind}-identity-${identity}` : undefined;
  const identityKey = `${kind}:${identity}`;
  const returning = useRef(tier === "full" && placement === "card" && sharedFailures?.returningIdentity === identityKey
    ? identityKey : undefined);
  const element = useRef<HTMLSpanElement>(null);
  const elevatedCard = useRef<HTMLElement | null>(null);
  const restoreCard = useCallback(() => {
    elevatedCard.current?.removeAttribute("data-identity-flight");
    elevatedCard.current = null;
  }, []);
  useLayoutEffect(() => {
    if (!layoutId || placement !== "card") returning.current = undefined;
    return restoreCard;
  }, [layoutId, placement, restoreCard]);
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";
  const loaderFamily = glyphLoader(loader);
  const versionLoader = glyphLoaderForVersionDirectory(versionId ?? "");
  // A missing or unrecognised loader family can still be named by the version
  // folder: "26.2-fabric-0.19.3" is a Fabric profile even when `loader` is null.
  const resolvedLoader =
    (loaderFamily === "vanilla" || loaderFamily === "unknown") && versionLoader !== "vanilla"
      ? versionLoader
      : loaderFamily;
  const glyph = !icon && (loader !== undefined || versionId !== undefined)
    ? { loader: resolvedLoader, version: glyphVersion(versionId ?? "", versionType) }
    : undefined;
  return (
    <motion.span
      ref={element}
      className="vx-instance-identity"
      data-identity={identity}
      data-identity-kind={kind}
      data-identity-face={glyph ? "glyph" : undefined}
      data-layout-id={layoutId}
      {...(layoutId ? { layoutId, layoutDependency: `${identity}:${placement}`, transition: identityTransition(tier),
        onLayoutAnimationStart: () => {
          if (placement !== "card" || returning.current !== identityKey) return;
          const card = element.current?.closest<HTMLElement>(".vx-instance-card");
          if (card) {
            elevatedCard.current = card;
            card.setAttribute("data-identity-flight", "");
          }
        },
        onLayoutAnimationComplete: () => { returning.current = undefined; restoreCard(); },
      } : {})}
      aria-hidden="true"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          onError={() => {
            if (!iconPath) return;
            if (sharedFailures) sharedFailures.remember(iconPath);
            else setFailedIcon(iconPath);
          }}
        />
      ) : glyph ? (
        <>
          <InstanceGlyph loader={glyph.loader} version={glyph.version} />
          {/* Keep the initial in the DOM as a non-visual fallback. */}
          <span className="vx-instance-identity__letter" hidden>{letter}</span>
        </>
      ) : (
        <>
          <span className="vx-instance-identity__plane" />
          <span className="vx-instance-identity__letter">{letter}</span>
        </>
      )}
    </motion.span>
  );
}
