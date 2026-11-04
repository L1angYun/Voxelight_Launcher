// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from "vitest";
import { MOTION, resolveMotionTier, pageVariants, motionDuration, identityTransition, sectionTransition } from "./motion";

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
  it("centralizes notification dwell times and the free cursor radius", () => {
    expect(MOTION.toast).toMatchObject({ dwellMs: 5000, errorDwellMs: 11000 });
    expect(MOTION.cursor).toMatchObject({ radiusPx: 18 });
  });
  it("returns production durations and springs independently of the test runner", () => {
    for (const tier of ["full", "fade"] as const) {
      expect(motionDuration(tier, "enter")).toBe(.18);
      expect(motionDuration(tier, "exit")).toBe(.08);
      expect(pageVariants(tier, false).ready.transition.duration).toBe(.18);
      expect(pageVariants(tier, false).exit(1).transition.duration).toBe(.08);
    }
    expect(identityTransition("full")).toEqual({ type: "spring", stiffness: 380, damping: 36 });
    expect(sectionTransition("full")).toEqual({ type: "spring", stiffness: 420, damping: 38 });
    expect(identityTransition("fade")).toEqual({ duration: .14, ease: [.23, 1, .32, 1] });
    expect(identityTransition("none")).toEqual({ duration: 0, ease: [.23, 1, .32, 1] });
    expect(sectionTransition("fade")).toEqual({ duration: 0 });
    expect(sectionTransition("none")).toEqual({ duration: 0 });
  });
  it("starts content from the selected navigation side and keeps home still", () => {
    expect(pageVariants("full", false).enter(1)).toMatchObject({ opacity: 0, transform: "translateX(10px)" });
    expect(pageVariants("full", false).enter(-1)).toMatchObject({ opacity: 0, transform: "translateX(-10px)" });
    expect(pageVariants("full", true).enter(1)).toMatchObject({ opacity: 1, transform: "none" });
    expect(pageVariants("full", false).exit(-1)).toMatchObject({ opacity: 0, transform: "translateX(6px)" });
  });
  it("accelerates content out while keeping its arrival ease-out", () => {
    for (const tier of ["full", "fade"] as const) {
      const variants = pageVariants(tier, false);
      expect(variants.exit(1).transition.ease).toEqual([.4, 0, 1, 1]);
      expect(variants.ready.transition.ease).toEqual([.23, 1, .32, 1]);
    }
  });
  it.each(["full", "fade", "none"] as const)("keeps home glass opaque throughout every %s page transition", (tier) => {
    const variants = pageVariants(tier, true);
    expect(variants.ready).toMatchObject({ opacity: 1, transform: "none", transition: { duration: 0 } });
    for (const direction of [-1, 1]) {
      expect(variants.enter(direction)).toEqual({ opacity: 1, transform: "none" });
      expect(variants.exit(direction)).toMatchObject({ opacity: 1, transform: "none", transition: { duration: 0 } });
    }
  });
  it("fades flat Lite content, keeps its home glass stable and makes reduced motion immediate", () => {
    expect(pageVariants("fade", false).enter(1)).toMatchObject({ opacity: 0, transform: "none" });
    expect(pageVariants("fade", true).enter(1)).toMatchObject({ opacity: 1, transform: "none" });
    for (const home of [false, true]) {
      expect(pageVariants("none", home).exit(1)).toMatchObject({ opacity: 1, transform: "none" });
    }
    expect(motionDuration("none", "enter")).toBe(0);
  });
});
