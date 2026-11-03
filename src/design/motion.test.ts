// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { MOTION, resolveMotionTier, pageVariants, motionDuration } from "./motion";

describe("frontend motion policy", () => {
  const full = { effects: "full" as const, reducedMotion: false, reducedTransparency: false, highContrast: false };
  it("keeps the scene policy separate from opacity and layout policy", () => {
    expect(resolveMotionTier(full)).toEqual({ tier: "full", sceneStatic: false });
    expect(resolveMotionTier({ ...full, effects: "lite" })).toEqual({ tier: "fade", sceneStatic: true });
    expect(resolveMotionTier({ ...full, reducedTransparency: true })).toEqual({ tier: "fade", sceneStatic: false });
    expect(resolveMotionTier({ ...full, reducedMotion: true })).toEqual({ tier: "none", sceneStatic: true });
    expect(resolveMotionTier({ ...full, highContrast: true })).toEqual({ tier: "none", sceneStatic: true });
  });
  it("has a single source for page, lens, drill and camera vocabulary", () => {
    expect(MOTION.duration).toMatchObject({ exit: .08, enter: .18, content: .14, slow: .24 });
    expect(MOTION.lens.x).toMatchObject({ stiffness: 340, damping: 30, pressedDamping: 34 });
    expect(MOTION.identity).toEqual({ stiffness: 380, damping: 36 });
    expect(MOTION.camera).toEqual({ stiffness: 36, damping: 12 });
  });
  it("starts content from the selected navigation side and keeps home still", () => {
    expect(pageVariants("full", false).enter(1)).toMatchObject({ opacity: 0, x: 10 });
    expect(pageVariants("full", false).enter(-1)).toMatchObject({ opacity: 0, x: -10 });
    expect(pageVariants("full", true).enter(1)).toMatchObject({ opacity: 0, x: 0 });
    expect(pageVariants("full", false).exit(-1)).toMatchObject({ opacity: 0, x: 6 });
  });
  it("never fades a Lite stage containing glass and makes reduced motion immediate", () => {
    for (const home of [false, true]) {
      expect(pageVariants("fade", home).enter(1)).toMatchObject({ opacity: 1, x: 0 });
      expect(pageVariants("none", home).exit(1)).toMatchObject({ opacity: 1, x: 0 });
    }
    expect(motionDuration("none", "enter")).toBe(0);
  });
});
