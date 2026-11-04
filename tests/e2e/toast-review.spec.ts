// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test.use({ viewport: { width: 1280, height: 720 }, channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] } });

type ToastFrame = {
  text: string; opacity: number; right: number; bottom: number; layoutBottom: number;
  role: string | null; hidden: boolean; inert: boolean; closeEnabled: boolean; host: "dialog" | "root";
  animations: { duration: number | string; easing: string }[];
};
type TraceFrame = {
  at: number; toasts: ToastFrame[]; dialogOpacity: number; backdropOpacity: number;
  dialogCurve: string; backdropCurve: string;
  animations: { property: string; pseudo: string | null; duration: number | string; easing: string }[];
};

async function prepare(page: Page) {
  await page.goto("/tests/e2e/harness/toast-review.html");
  await expect(page.locator("#notify-long")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "full");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "false");
}

async function traceClick(page: Page, trigger: string, duration = 360): Promise<TraceFrame[]> {
  await page.evaluate(({ trigger, duration }) => {
    const traceWindow = window as unknown as { toastReviewTrace: Promise<TraceFrame[]> };
    traceWindow.toastReviewTrace = new Promise(resolve => {
      const frames: TraceFrame[] = [];
      const durationValue = (value: ReturnType<AnimationEffect["getTiming"]>["duration"]) =>
        typeof value === "number" ? value : String(value ?? "auto");
      const sample = (start: number) => {
        const dialog = document.querySelector<HTMLDialogElement>("dialog")!;
        frames.push({ at: performance.now() - start,
          toasts: [...document.querySelectorAll<HTMLElement>(".vx-toast")].map(toast => {
            const style = getComputedStyle(toast), rect = toast.getBoundingClientRect();
            const translateY = style.transform === "none" ? 0 : new DOMMatrixReadOnly(style.transform).m42;
            return { text: toast.querySelector("span")!.textContent!, opacity: Number(style.opacity),
              right: rect.right, bottom: rect.bottom, layoutBottom: rect.bottom - translateY,
              role: toast.getAttribute("role"), hidden: toast.getAttribute("aria-hidden") === "true", inert: toast.inert,
              closeEnabled: !toast.querySelector<HTMLButtonElement>("button")!.disabled,
              animations: toast.getAnimations().map(animation => ({ duration: durationValue(animation.effect?.getTiming().duration),
                easing: animation.effect?.getTiming().easing ?? "" })),
              host: toast.closest("dialog") ? "dialog" : "root" };
          }), dialogOpacity: Number(getComputedStyle(dialog).opacity), backdropOpacity: Number(getComputedStyle(dialog, "::backdrop").opacity),
          dialogCurve: getComputedStyle(dialog).transitionTimingFunction, backdropCurve: getComputedStyle(dialog, "::backdrop").transitionTimingFunction,
          animations: document.getAnimations().flatMap(animation => {
            const effect = animation.effect as KeyframeEffect | null;
            if (effect?.target !== dialog) return [];
            return [{ property: "transitionProperty" in animation ? String(animation.transitionProperty) : "",
              pseudo: effect.pseudoElement, duration: durationValue(effect.getTiming().duration), easing: effect.getTiming().easing ?? "" }];
          }),
        });
      };
      const clicked = (event: Event) => {
        if (!(event.target instanceof Element) || !event.target.closest(trigger)) return;
        document.removeEventListener("click", clicked, true);
        const start = performance.now(); sample(start);
        const frame = () => { sample(start); if (performance.now() - start < duration) requestAnimationFrame(frame); else resolve(frames); };
        requestAnimationFrame(frame);
      };
      document.addEventListener("click", clicked, true);
    });
  }, { trigger, duration });
  await page.locator(trigger).click();
  return page.evaluate(() => (window as unknown as { toastReviewTrace: Promise<TraceFrame[]> }).toastReviewTrace);
}

test("review D2: fixed-id long-to-short replacement preserves the exiting toast's screen anchor", async ({ page }, info) => {
  await prepare(page);
  await page.locator("#notify-long").click();
  await expect(page.locator(".vx-toast")).toHaveCSS("opacity", "1");
  const frames = await traceClick(page, "#notify-short");
  await writeFile(info.outputPath("toast-replacement.json"), JSON.stringify(frames, null, 2));
  const original = frames[0].toasts[0];
  const outgoing = frames.flatMap(frame => frame.toasts.filter(toast => toast.hidden));
  const replacements = frames.flatMap(frame => frame.toasts.filter(toast => toast.text === "Failed."));
  expect(outgoing.length, "replacement keeps the previous node for its exit").toBeGreaterThan(0);
  expect(replacements.some(toast => toast.opacity > .01 && toast.opacity < .99), "replacement has actual entry frames").toBe(true);
  expect(outgoing.some(toast => toast.opacity > .01 && toast.opacity < .99), "old notification has actual exit frames").toBe(true);
  for (const frame of frames.filter(frame => frame.toasts.some(toast => toast.text === "Failed."))) {
    expect(frame.toasts.filter(toast => toast.role === "alert" || toast.role === "status")).toHaveLength(1);
    expect(frame.toasts.filter(toast => toast.closeEnabled)).toHaveLength(1);
  }
  expect(outgoing.every(toast => toast.inert && toast.hidden && toast.role === null && !toast.closeEnabled)).toBe(true);
  expect.soft(Math.max(...outgoing.map(toast => Math.abs(toast.right - original.right))), "outgoing right edge stays fixed while host width shrinks").toBeLessThan(1.5);
  expect.soft(Math.max(...outgoing.map(toast => Math.abs(toast.layoutBottom - original.layoutBottom))), "outgoing bottom edge stays fixed apart from its intentional 8px exit").toBeLessThan(1.5);
  await expect(page.locator(".vx-toast")).toHaveCount(1);
  await page.locator(".vx-toast button").click();
  await expect(page.locator(".vx-toast")).toHaveCount(0);
  await expect(page.locator("#dismissed-count")).toHaveText("1");
});

test("review D2: dialog hosting and return both replay entrance without stealing focus", async ({ page }, info) => {
  await prepare(page);
  await page.locator("#notify-short").click();
  await expect(page.locator(".vx-toast")).toHaveCSS("opacity", "1");
  const opened = await traceClick(page, "#open-dialog");
  await expect(page.locator("#dialog-first")).toBeFocused();
  const closed = await traceClick(page, "#close-dialog");
  await writeFile(info.outputPath("toast-rehosting.json"), JSON.stringify({ opened, closed }, null, 2));
  expect(opened.some(frame => frame.toasts.some(toast => toast.host === "dialog" && toast.opacity > .01 && toast.opacity < .99))).toBe(true);
  expect(closed.some(frame => frame.toasts.some(toast => toast.host === "root" && toast.opacity > .01 && toast.opacity < .99))).toBe(true);
  expect([...opened, ...closed].every(frame => frame.toasts.length === 1)).toBe(true);
  await expect(page.locator("#open-dialog")).toBeFocused();
  await page.locator("#dismiss-launcher").click();
  await expect(page.locator(".vx-toast")).toHaveCount(0);
  await expect(page.locator("#dismissed-count")).toHaveText("1");
});

test("review D2: a stale fixed-id timer cannot dismiss its replacement", async ({ page }) => {
  await page.addInitScript(() => {
    const timerWindow = window as unknown as { staleInfoTimer?: () => void };
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5000 && typeof handler === "function") timerWindow.staleInfoTimer = () => handler(...args);
      return schedule(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  await prepare(page);
  await page.locator("#notify-long").click();
  await expect(page.locator(".vx-toast")).toHaveCSS("opacity", "1");
  await page.locator("#notify-short").click();
  await expect(page.locator(".vx-toast")).toHaveCount(1);
  await page.evaluate(() => {
    const callback = (window as unknown as { staleInfoTimer?: () => void }).staleInfoTimer;
    if (!callback) throw new Error("The previous notification's timer was not captured");
    callback();
  });
  await expect(page.getByRole("alert")).toHaveText(/Failed\./);
  await expect(page.locator("#dismissed-count")).toHaveText("0");
  await page.locator("#dismiss-launcher").click();
  await expect(page.locator(".vx-toast")).toHaveCount(0);
  await expect(page.locator("#dismissed-count")).toHaveText("1");
});

test("review D1: native dialog and backdrop retain actual intermediate exit frames with ease-in", async ({ page }, info) => {
  await prepare(page);
  await page.locator("#open-dialog").click();
  await expect(page.locator("dialog")).toHaveCSS("opacity", "1");
  const frames = await traceClick(page, "#close-dialog");
  await writeFile(info.outputPath("dialog-exit.json"), JSON.stringify(frames, null, 2));
  const expectedCurve = "cubic-bezier(0.4, 0, 1, 1)";
  expect(frames.some(frame => frame.dialogOpacity > .01 && frame.dialogOpacity < .99), "dialog has exit intermediates").toBe(true);
  expect(frames.some(frame => frame.backdropOpacity > .01 && frame.backdropOpacity < .99), "backdrop has exit intermediates").toBe(true);
  for (const pseudo of [null, "::backdrop"]) {
    expect(frames.some(frame => frame.animations.some(animation => animation.pseudo === pseudo && animation.property === "opacity" && animation.easing === expectedCurve)), `native ${pseudo ?? "dialog"} opacity animation uses exit curve`).toBe(true);
  }
  expect(frames.at(-1)!.dialogCurve).toContain(expectedCurve);
  expect(frames.at(-1)!.backdropCurve).toContain(expectedCurve);
});
