import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { desktop } from "../../lib/launcher";
import { identityTransition, type MotionTier } from "../../design/motion";

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
}: {
  name: string;
  identity: string;
  iconPath?: string | null;
  kind?: "instance" | "version-directory";
  placement?: "card" | "detail";
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
  return (
    <motion.span
      ref={element}
      className="vx-instance-identity"
      data-identity={identity}
      data-identity-kind={kind}
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
      ) : (
        <>
          <span className="vx-instance-identity__plane" />
          <span className="vx-instance-identity__letter">{letter}</span>
        </>
      )}
    </motion.span>
  );
}
