import { createContext, useContext, useState, type ReactNode } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { motion } from "motion/react";
import { desktop } from "../../lib/launcher";
import { identityTransition, type MotionTier } from "../../design/motion";

const IconFailures = createContext<{
  tier: MotionTier;
  paths: ReadonlySet<string>;
  remember: (path: string) => void;
} | null>(null);

/** Keep a known fallback across the directly unmounted card/detail trees. */
export function InstanceIdentityProvider({ tier, children }: { tier: MotionTier; children: ReactNode }) {
  const [paths, setPaths] = useState<ReadonlySet<string>>(() => new Set());
  return <IconFailures.Provider value={{ tier, paths, remember: (path) => {
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
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <motion.span
      className="vx-instance-identity"
      data-identity={identity}
      data-identity-kind={kind}
      data-layout-id={layoutId}
      {...(layoutId ? { layoutId, layoutDependency: `${identity}:${placement}`, transition: identityTransition(tier) } : {})}
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
