// SPDX-License-Identifier: GPL-3.0-only
import { resolve } from "node:path";

const scopes = ["card-theme", "global-glass", "reference-alignment", "round6", "transitions", "world-acceptance"] as const;
type EvidenceScope = typeof scopes[number];
type EvidenceEnvironment = Readonly<Record<string, string | undefined>>;

// All custom writers share this one root. For example:
// VOXELIGHT_E2E_EVIDENCE=E:/.../playwright-evidence writes transitions below
// E:/.../playwright-evidence/transitions, never to a separate implicit root.
const obsoleteVariables = [
  "VOXELIGHT_E2E_OUTPUT_DIR",
  "VOXELIGHT_TRANSITION_OUTPUT_DIR",
  "VOXELIGHT_WORLD_GATE_OUTPUT_DIR",
  "VOXELIGHT_TRANSITION_EVIDENCE",
  "VOXELIGHT_TASK8_EVIDENCE",
] as const;

export function evidenceDirectory(scope: EvidenceScope, environment: EvidenceEnvironment = process.env): string {
  const obsolete = obsoleteVariables.filter(name => environment[name] !== undefined);
  if (obsolete.length) throw new Error(
    "Unsupported evidence environment variable(s): " + obsolete.join(", ")
    + ". Use only VOXELIGHT_E2E_EVIDENCE as the root for every evidence writer; remove the obsolete variables.",
  );
  if (!scopes.includes(scope)) throw new Error("Unknown evidence scope");
  const configured = environment.VOXELIGHT_E2E_EVIDENCE;
  if (configured !== undefined && !configured.trim()) throw new Error("VOXELIGHT_E2E_EVIDENCE must be nonempty when configured");
  return resolve(configured?.trim() ?? "test-results", scope);
}
