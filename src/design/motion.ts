// SPDX-License-Identifier: GPL-3.0-only
export type MotionTier = "full" | "fade" | "none";
const testing = typeof process !== "undefined" && process.env.VITEST === "true";
export const MOTION = {
  duration: { exit: .08, enter: .18, content: .14, slow: .24 },
  delay: { characterMs: 280 },
  ease: [.23, 1, .32, 1] as const,
  page: { enterOffset: 10, exitOffset: 6 },
  lens: {
    x: { stiffness: 340, damping: 30, pressedDamping: 34 },
    y: { stiffness: 340, damping: 30 },
    press: { stiffness: 310, damping: 18 },
    stretch: { stiffness: 230, damping: 15 },
    bend: { stiffness: 190, damping: 14 },
    settleFrames: 3, navigationFrames: 1,
  },
  identity: { stiffness: 380, damping: 36 },
  section: { stiffness: 420, damping: 38 },
  camera: { stiffness: 36, damping: 12 },
} as const;

export function resolveMotionTier(input: {
  effects: "full" | "lite"; reducedMotion?: boolean; reducedTransparency?: boolean; highContrast?: boolean;
}): { tier: MotionTier; sceneStatic: boolean } {
  return {
    tier: input.reducedMotion || input.highContrast ? "none" : input.effects === "lite" || input.reducedTransparency ? "fade" : "full",
    sceneStatic: input.effects === "lite" || Boolean(input.reducedMotion || input.highContrast),
  };
}

// jsdom has no presentation clock. Tests still exercise presence/focus with an
// immediate exit; browser acceptance exercises the actual durations and geometry.
export function motionDuration(tier: MotionTier, word: keyof typeof MOTION.duration): number {
  return tier === "none" || testing ? 0 : MOTION.duration[word];
}

export function identityTransition(tier: MotionTier) {
  return tier === "full" && !testing
    ? { type: "spring" as const, ...MOTION.identity }
    : { duration: motionDuration(tier, "content"), ease: MOTION.ease };
}

export function pageVariants(tier: MotionTier, home: boolean) {
  const animated = tier === "full";
  return {
    enter: (direction: number) => ({ opacity: animated ? 0 : 1, x: animated && !home ? direction * MOTION.page.enterOffset : 0 }),
    ready: { opacity: 1, x: 0, transition: { duration: animated ? motionDuration(tier, "enter") : 0, ease: MOTION.ease } },
    exit: (direction: number) => ({ opacity: animated ? 0 : 1, x: animated && !home ? -direction * MOTION.page.exitOffset : 0,
      transition: { duration: animated ? motionDuration(tier, "exit") : 0, ease: MOTION.ease } }),
  };
}
