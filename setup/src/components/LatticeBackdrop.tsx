// SPDX-License-Identifier: GPL-3.0-only

/**
 * The same static dotted lattice the launcher pages paint behind their glass
 * surfaces (22px pitch, 0.7px dots, `--text-primary` at 12% over `--world-ink`).
 * It is CSS-only, so it costs no WebGL context and never moves.
 */
export function LatticeBackdrop() {
  return <div className="vx-setup-backdrop" aria-hidden="true" />;
}
