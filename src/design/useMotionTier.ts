// SPDX-License-Identifier: GPL-3.0-only
import { useAppearance } from "../app/AppearanceProvider";
import { resolveMotionTier } from "./motion";

export function useMotionTier() {
  return resolveMotionTier(useAppearance());
}
