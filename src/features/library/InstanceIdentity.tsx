import { useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { desktop } from "../../lib/launcher";

/** An identity derived from the user's name/icon, never a fabricated world preview. */
export function InstanceIdentity({
  name,
  identity,
  iconPath,
}: {
  name: string;
  identity: string;
  iconPath?: string | null;
}) {
  const [failedIcon, setFailedIcon] = useState<string>();
  const icon =
    desktop && iconPath && failedIcon !== iconPath
      ? convertFileSrc(iconPath)
      : undefined;
  const letter = Array.from(name.trim())[0]?.toLocaleUpperCase() ?? "";
  return (
    <span
      className="vx-instance-identity"
      data-identity={identity}
      aria-hidden="true"
    >
      {icon ? (
        <img
          src={icon}
          alt=""
          onError={() => setFailedIcon(iconPath ?? undefined)}
        />
      ) : (
        <>
          <span className="vx-instance-identity__plane" />
          <span className="vx-instance-identity__letter">{letter}</span>
        </>
      )}
    </span>
  );
}
