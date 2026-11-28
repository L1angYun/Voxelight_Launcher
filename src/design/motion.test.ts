// SPDX-License-Identifier: GPL-3.0-only
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MOTION, resolveMotionTier, pageVariants, motionDuration, identityTransition, sectionTransition } from "./motion";

type SpringTuning = { stiffness: number; damping: number };
type MotionSprings = { identity: SpringTuning; section: SpringTuning; press: SpringTuning };
interface SpringTokenCurve {
  stiffness: number;
  sourceDamping: number;
  damping: number;
  durationMs: number;
  peak: number;
  values: number[];
}
interface SpringGenerator {
  START_MARKER: string;
  END_MARKER: string;
  SPRING_TOKEN_SOURCES: { token: string; path: string[]; fallback: string }[];
  readMotionSprings(source: string, filename?: string): MotionSprings;
  computeSpringToken(spring: SpringTuning): SpringTokenCurve;
  buildSpringTokenBlock(springs: MotionSprings): string;
  extractSpringTokenBlock(css: string): string;
  checkSpringTokens(css: string, springs: MotionSprings): string[];
}

// The generator is a plain Node ESM build script without a declaration file.
// @ts-ignore
import * as springEasingModule from "../../scripts/generate-spring-easing.mjs";
const springEasing = springEasingModule as unknown as SpringGenerator;

const designDirectory = fileURLToPath(new URL(".", import.meta.url));
const sourceDirectory = fileURLToPath(new URL("..", import.meta.url));
const tokensCss = readFileSync(join(designDirectory, "tokens.css"), "utf8");
const motionSource = readFileSync(join(designDirectory, "motion.ts"), "utf8");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

function declarations(css: string, name: string): string[] {
  return [...css.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map(match => match[1].trim());
}

function linearValues(css: string, token: string): number[] {
  const value = declarations(css, `ease-spring-${token}`).find(declaration => declaration.startsWith("linear("));
  if (!value) throw new Error(`Missing linear() value for --ease-spring-${token}`);
  return value.slice("linear(".length, -1).split(",").map(point => Number(point.trim()));
}

function cssDurations() {
  const css = readFileSync("src/design/tokens.css", "utf8");
  const declarations = new Map(
    [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
  const resolve = (name: string, seen: Set<string> = new Set()): number | null => {
    const value = declarations.get(name);
    if (!value || seen.has(name)) return null;
    const direct = /^(\d+(?:\.\d+)?)ms$/.exec(value);
    if (direct) return Number(direct[1]);
    const reference = /^var\((--[\w-]+)\)$/.exec(value);
    return reference ? resolve(reference[1], new Set([...seen, name])) : null;
  };
  return { resolve };
}

describe("CSS ↔ TypeScript motion durations", () => {
  it("derives every motion duration token from the single MOTION table", () => {
    const { resolve } = cssDurations();
    const pairs = [
      ["--duration-exit", MOTION.duration.exit],
      ["--duration-fast", MOTION.duration.content],
      ["--duration-normal", MOTION.duration.enter],
      ["--duration-slow", MOTION.duration.slow],
      ["--duration-menu-enter", MOTION.duration.menuEnter],
      ["--duration-menu-exit", MOTION.duration.menuExit],
    ] as const;
    for (const [token, seconds] of pairs)
      expect(resolve(token), token).toBe(Math.round(seconds * 1000));
  });

  it("merges the menu enter/exit into the content and exit steps", () => {
    expect(MOTION.duration.menuEnter).toBe(MOTION.duration.content);
    expect(MOTION.duration.menuExit).toBe(MOTION.duration.exit);
  });
});

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

describe("spring easing tokens", () => {
  const springs = springEasing.readMotionSprings(motionSource);
  const block = springEasing.buildSpringTokenBlock(springs);

  it("reads the shared spring parameters straight from motion.ts", () => {
    expect(springs).toEqual({
      identity: MOTION.identity,
      section: MOTION.section,
      press: MOTION.lens.press,
    });
  });

  it("keeps tokens.css in lockstep with motion.ts", () => {
    expect(springEasing.checkSpringTokens(tokensCss, springs)).toEqual([]);
    expect(springEasing.extractSpringTokenBlock(tokensCss).replace(/\r\n/g, "\n")).toBe(block);
    const changed = { ...springs, identity: { ...springs.identity, stiffness: springs.identity.stiffness + 10 } };
    expect(springEasing.checkSpringTokens(tokensCss, changed)).not.toEqual([]);
    expect(springEasing.buildSpringTokenBlock(changed)).not.toBe(block);
  });

  it("commits a cubic-bezier fallback before every linear() curve", () => {
    const supportsAt = block.indexOf("@supports (transition-timing-function: linear(0, 1))");
    expect(supportsAt).toBeGreaterThan(block.indexOf(":root {"));
    const fallbackRoot = block.slice(block.indexOf(":root {"), supportsAt);
    const enhancedRoot = block.slice(supportsAt, block.indexOf("/* Lite and reduced-transparency", supportsAt));
    for (const { token } of springEasing.SPRING_TOKEN_SOURCES) {
      const fallbackAt = block.indexOf(`--ease-spring-${token}: cubic-bezier(`);
      const linearAt = block.indexOf(`--ease-spring-${token}: linear(`);
      expect(fallbackAt, `${token} needs a cubic-bezier fallback`).toBeGreaterThan(-1);
      expect(linearAt, `${token} needs a linear() enhancement`).toBeGreaterThan(fallbackAt);
      expect(fallbackRoot).toContain(`--ease-spring-${token}: cubic-bezier(`);
      expect(fallbackRoot).not.toContain("linear(");
      expect(enhancedRoot).toContain(`--ease-spring-${token}: linear(`);
    }
  });

  it("bounds every sampled curve to the motion budget", () => {
    for (const tuning of [springs.identity, springs.section, springs.press]) {
      const curve = springEasing.computeSpringToken(tuning);
      expect(curve.values).toHaveLength(32);
      expect(curve.values[0]).toBe(0);
      expect(curve.values.at(-1)).toBe(1);
      expect(Math.max(...curve.values)).toBeLessThanOrEqual(1.02);
      expect(Math.min(...curve.values)).toBeGreaterThanOrEqual(0);
      expect(curve.durationMs).toBeGreaterThan(0);
      expect(curve.durationMs).toBeLessThanOrEqual(300);
      expect(curve.durationMs % 10).toBe(0);
    }
    const press = springEasing.computeSpringToken(springs.press);
    expect(press.damping).toBeGreaterThan(springs.press.damping);
    expect(press.peak).toBeGreaterThan(1.005);
    expect(press.peak).toBeLessThanOrEqual(1.02);
  });

  it("writes the committed curves with their generated durations", () => {
    const curves: Record<string, ReturnType<SpringGenerator["computeSpringToken"]>> = {
      enter: springEasing.computeSpringToken(springs.identity),
      section: springEasing.computeSpringToken(springs.section),
      press: springEasing.computeSpringToken(springs.press),
    };
    for (const { token } of springEasing.SPRING_TOKEN_SOURCES) {
      expect(declarations(block, `duration-spring-${token}`)[0]).toBe(`${curves[token].durationMs}ms`);
      expect(linearValues(block, token)[0]).toBe(0);
      expect(linearValues(block, token).at(-1)).toBe(1);
      expect(Math.max(...linearValues(block, token))).toBeLessThanOrEqual(1.02);
    }
  });

  it("drops springs to the flat ease-out and zero-duration tiers", () => {
    const liteStart = block.indexOf('[data-effects="lite"]');
    const liteEnd = block.indexOf("/* Static", liteStart);
    const liteSelectors = block.slice(liteStart, block.indexOf("{", liteStart));
    const liteRule = block.slice(liteStart, liteEnd);
    expect(liteSelectors).toContain('[data-reduced-transparency="true"]');
    for (const { token } of springEasing.SPRING_TOKEN_SOURCES) {
      expect(liteRule).toContain(`--ease-spring-${token}: var(--ease-out);`);
    }

    const staticStart = block.indexOf('[data-reduced-motion="true"]');
    const staticEnd = block.indexOf("@media (prefers-reduced-motion: reduce)", staticStart);
    const staticSelectors = block.slice(staticStart, block.indexOf("{", staticStart));
    const staticRule = block.slice(staticStart, staticEnd);
    expect(staticSelectors).toContain('[data-high-contrast="true"]');
    expect(staticSelectors).toContain('[data-motion-tier="none"]');
    for (const { token } of springEasing.SPRING_TOKEN_SOURCES) {
      expect(staticRule).toContain(`--ease-spring-${token}: var(--ease-out);`);
      expect(staticRule).toContain(`--duration-spring-${token}: 0s;`);
    }

    const reducedMotionStart = block.indexOf("@media (prefers-reduced-motion: reduce)");
    const reducedTransparencyStart = block.indexOf("@media (prefers-reduced-transparency: reduce)");
    const reducedMotion = block.slice(reducedMotionStart, reducedTransparencyStart);
    for (const { token } of springEasing.SPRING_TOKEN_SOURCES) {
      expect(reducedMotion).toContain(`--duration-spring-${token}: 0s;`);
    }
  });

  it("uses the spring tokens in the full-tier CSS transitions", () => {
    const globalCss = readFileSync(join(designDirectory, "global.css"), "utf8");
    const listboxCss = readFileSync(join(sourceDirectory, "components/ui/AnchoredListbox.css"), "utf8");
    expect(globalCss).toMatch(/\.vx-button\s*\{[^}]*transform var\(--duration-spring-press\) var\(--ease-spring-press\)/);
    expect(listboxCss).toMatch(/\[data-animate="true"\][^{]*\{[^}]*opacity var\(--duration-spring-enter\) var\(--ease-spring-enter\)/);
  });

  it("never writes spring tokens to the runtime root", () => {
    const writers = sourceFiles(sourceDirectory).filter(file => /\.(ts|tsx)$/.test(file)).filter(file => {
      const text = readFileSync(file, "utf8");
      return /setProperty\(\s*["'`]--(?:ease|duration)-spring-/.test(text)
        || /["'`]--(?:ease|duration)-spring-[^"'`]*["'`]\s*:/.test(text);
    });
    expect(writers).toEqual([]);
  });
});
