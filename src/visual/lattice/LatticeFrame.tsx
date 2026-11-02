import { cn } from "../../lib/utils";
import { latticeSelection } from "./model";
import "./lattice.css";

/** Static target and keyboard fallback; the shared cursor owns interaction points. */
export function LatticeFrame({
  hovered = false,
  focused = false,
  selected = false,
  signature = "lattice",
  className,
}: {
  hovered?: boolean;
  focused?: boolean;
  selected?: boolean;
  signature?: string;
  className?: string;
}) {
  const { shape } = latticeSelection({ hovered, focused, selected });
  return (
    <span
      className={cn("vx-lattice-frame", `vx-lattice-frame--${shape}`, className)}
      data-state={shape}
      data-hovered={hovered}
      data-focused={focused}
      data-selected={selected}
      data-signature={signature}
      data-point-count={0}
      data-static="true"
      data-priority={shape}
      data-visual-owner="lattice"
      aria-hidden="true"
    />
  );
}
