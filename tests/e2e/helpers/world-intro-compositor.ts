// SPDX-License-Identifier: GPL-3.0-only
import type { Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { analyzeTextContrast, collectTextContrastMetadata, glyphHidingStyle, validateContrastLayout,
  type ContrastTarget, type TextContrastMetadata, type WorldContrastReport, type WorldContrastState } from "./world-contrast-probe";

interface IntroStore {
  observations: TextContrastMetadata[];
  lastState: WorldContrastState;
  seenOn: boolean;
  finished: boolean;
  metadataErrors: string[];
  dispose(): void;
}
interface ScreencastFrame {
  data: string;
  metadata: { timestamp?: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number;
    offsetTop: number; scrollOffsetX: number; scrollOffsetY: number };
  sessionId: number;
}
export interface IntroContrastCapture {
  capture(path: string): Promise<WorldContrastReport>;
  dispose(): Promise<void>;
}

/** This function is serialized into the next document, before application code. */
function initializeIntroObserver(options: { key: string; css: string; targets: ContrastTarget[] },
  collect: (targets: ContrastTarget[]) => TextContrastMetadata) {
  const host = window as unknown as Record<string, IntroStore>;
  const style = document.createElement("style"); style.textContent = options.css;
  let frame = 0, disposed = false;
  const observer = new MutationObserver(installStyle);
  function installStyle() {
    if (document.head && !style.isConnected) { document.head.prepend(style); observer.disconnect(); }
  }
  const store: IntroStore = { observations: [], lastState: {}, seenOn: false, finished: false, metadataErrors: [],
    dispose() { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); style.remove(); } };
  host[options.key] = store;
  observer.observe(document, { childList: true, subtree: true }); installStyle();
  function sample() {
    if (disposed) return;
    installStyle();
    const scene = document.querySelector<HTMLElement>(".vx-global-scene");
    const intro = document.documentElement?.dataset.worldIntro;
    store.lastState = { theme: document.documentElement?.dataset.theme, intro, phase: scene?.dataset.worldPhase, front: scene?.dataset.worldFront,
      frames: scene?.dataset.worldFrames, tier: scene?.dataset.worldTier, material: scene?.dataset.worldMaterial,
      epochMs: performance.timeOrigin + performance.now(), now: performance.now() };
    if (intro === "on") {
      store.seenOn = true;
      const canvas = scene?.querySelector<HTMLCanvasElement>(".world-scene__canvas");
      const box = canvas?.getBoundingClientRect();
      if (style.isConnected && scene?.dataset.worldTier === "animated" && scene.dataset.worldMaterial === "lattice" &&
        Number(scene.dataset.worldFrames) > 0 && box && box.width > 0 && box.height > 0 &&
        canvas?.checkVisibility() && document.fonts.status === "loaded") {
        try {
          const metadata = collect(options.targets);
          // State is read from the current document in this RAF, never inferred
          // from the eventual arrival time of a MutationObserver notification.
          if (metadata.before.intro === "on") store.observations.push(metadata);
        } catch (error) {
          if (store.metadataErrors.length < 8) store.metadataErrors.push(String(error));
        }
      }
    } else if (store.seenOn) store.finished = true;
    if (!store.finished) frame = requestAnimationFrame(sample);
  }
  frame = requestAnimationFrame(sample);
}

/**
 * Begin streaming before goto. The chosen PNG is a real compositor swap bracketed
 * by two ready, layout-identical intro-on observations. Capture return time is
 * deliberately independent of the 2.5-second entrance deadline.
 */
export async function prepareIntroContrast(page: Page, targets: ContrastTarget[]): Promise<IntroContrastCapture> {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Set a fixed CSS viewport before preparing intro contrast");
  const key = `__voxelightIntroContrast_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const session = await page.context().newCDPSession(page);
  const frames: Array<ScreencastFrame & { receivedEpochMs: number }> = [];
  let disposed = false, captured = false, identifier: string | undefined;
  const receive = (event: ScreencastFrame) => {
    // Acknowledge immediately; PNG decoding and analysis happen after streaming.
    void session.send("Page.screencastFrameAck", { sessionId: event.sessionId }).catch(() => {});
    if (!disposed) frames.push({ ...event, receivedEpochMs: Date.now() });
  };
  async function dispose() {
    if (disposed) return;
    disposed = true; session.off("Page.screencastFrame", receive);
    if (!page.isClosed()) await page.evaluate(key => {
      const host = window as unknown as Record<string, IntroStore>;
      host[key]?.dispose(); delete host[key];
    }, key).catch(() => {});
    await session.send("Page.stopScreencast").catch(() => {});
    if (identifier) await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => {});
    await session.detach().catch(() => {}); frames.length = 0;
  }
  try {
    await session.send("Page.enable");
    const source = `(${initializeIntroObserver.toString()})(${JSON.stringify({ key, css: glyphHidingStyle(targets), targets })},${collectTextContrastMetadata.toString()});`;
    ({ identifier } = await session.send("Page.addScriptToEvaluateOnNewDocument", { source }));
    session.on("Page.screencastFrame", receive);
    await session.send("Page.startScreencast", { format: "png", maxWidth: viewport.width, maxHeight: viewport.height, everyNthFrame: 1 });
  } catch (error) { await dispose(); throw error; }
  return {
    dispose,
    async capture(path) {
      if (disposed || captured) throw new Error("An intro compositor capture can be consumed once");
      captured = true;
      try {
        await page.waitForFunction(key => (window as unknown as Record<string, IntroStore>)[key]?.finished,
          key, { timeout: 15_000, polling: 50 });
        await session.send("Page.stopScreencast");
        // Drain already encoded notifications without extending or freezing intro.
        await new Promise(resolve => setTimeout(resolve, 50));
        const observed = await page.evaluate(key => {
          const store = (window as unknown as Record<string, IntroStore>)[key];
          return { observations: store.observations, lastState: store.lastState, metadataErrors: store.metadataErrors };
        }, key);
        const after = await page.evaluate(collectTextContrastMetadata, targets);
        const observations = observed.observations.sort((a, b) => a.epochMs - b.epochMs);
        const candidates: Array<{ report: WorldContrastReport; data: Buffer; timestamp: number; before: TextContrastMetadata;
          after: TextContrastMetadata; frame: ScreencastFrame & { receivedEpochMs: number } }> = [];
        for (const frame of [...frames].sort((a, b) => (a.metadata.timestamp ?? 0) - (b.metadata.timestamp ?? 0))) {
          if (!Number.isFinite(frame.metadata.timestamp)) continue;
          const timestamp = frame.metadata.timestamp! * 1000;
          const before = observations.filter(item => item.epochMs <= timestamp).at(-1);
          const next = observations.find(item => item.epochMs >= timestamp);
          if (!before || !next || before === next || before.before.intro !== "on" || next.before.intro !== "on") continue;
          validateContrastLayout(before, next);
          if (before.scrim !== next.scrim || JSON.stringify(before.regions.map(region => [region.text, region.foreground, region.paintOpacity, region.paintVisible])) !==
            JSON.stringify(next.regions.map(region => [region.text, region.foreground, region.paintOpacity, region.paintVisible])))
            throw new Error("Intro text color, visibility or scrim changed across a compositor bracket");
          if (frame.metadata.pageScaleFactor !== 1 || frame.metadata.offsetTop !== 0 || frame.metadata.scrollOffsetX !== 0 || frame.metadata.scrollOffsetY !== 0 ||
            frame.metadata.deviceWidth !== viewport.width || frame.metadata.deviceHeight !== viewport.height)
            throw new Error("Intro screencast geometry does not match the measured CSS viewport");
          const data = Buffer.from(frame.data, "base64");
          candidates.push({ report: analyzeTextContrast(data, before, after.before), data, timestamp, before, after: next, frame });
        }
        if (!candidates.length) throw new Error(`No real compositor frame has two ready intro-on observations: ${JSON.stringify({
          frames: frames.length, observations: observations.length, lastState: observed.lastState, metadataErrors: observed.metadataErrors })}`);
        // Retain the worst contrast margin among the bounded, proven intro frames,
        // rather than selecting a later/earlier frame because it passes a threshold.
        candidates.sort((a, b) => Math.min(...a.report.regions.map(region => region.contrast / region.minimum)) -
          Math.min(...b.report.regions.map(region => region.contrast / region.minimum)));
        const chosen = candidates[0];
        chosen.report.frameEvidence = { source: "CDP Page.screencastFrame", timestampEpochMs: chosen.timestamp,
          receivedEpochMs: chosen.frame.receivedEpochMs, metadata: chosen.frame.metadata,
          domBefore: chosen.before.before, domAfter: chosen.after.before,
          beforeEpochMs: chosen.before.epochMs, afterEpochMs: chosen.after.epochMs,
          candidateFrames: candidates.length, observedFrames: frames.length, observations: observations.length,
          selection: "lowest contrast margin among the captured, double-on-bracketed compositor frames",
          candidateTimestampsEpochMs: candidates.map(candidate => candidate.timestamp) };
        await writeFile(path, chosen.data);
        return chosen.report;
      } finally { await dispose(); }
    },
  };
}
