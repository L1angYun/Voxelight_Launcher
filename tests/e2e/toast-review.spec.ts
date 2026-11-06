// SPDX-License-Identifier: GPL-3.0-only
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

test.use({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, channel: "chromium", launchOptions: { args: ["--use-angle=d3d11"] } });

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

async function traceClick(page: Page, trigger: string, duration = 360, activate?: () => Promise<unknown>): Promise<TraceFrame[]> {
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
  if (activate) await activate(); else await page.locator(trigger).click();
  return page.evaluate(() => (window as unknown as { toastReviewTrace: Promise<TraceFrame[]> }).toastReviewTrace);
}

test("M3 fixed-id replacement updates the focused notification in place and preserves its screen anchor", async ({ page }, info) => {
  await page.addInitScript(() => {
    const host = window as unknown as { staleInfoTimer?: () => void };
    const schedule = window.setTimeout.bind(window);
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout === 5000 && typeof handler === "function") host.staleInfoTimer = () => handler(...args);
      return schedule(handler, timeout, ...args);
    }) as typeof window.setTimeout;
  });
  await prepare(page);
  await page.locator("#notify-long").click();
  await expect(page.locator(".vx-toast")).toHaveCSS("opacity", "1");
  const originalNode = await page.locator(".vx-toast").elementHandle();
  const originalClose = await page.locator(".vx-toast button").elementHandle();
  await page.locator(".vx-toast button").focus();
  // Model an asynchronous notification update without moving focus to the
  // harness's trigger button. The production notify handler is unchanged.
  const frames = await traceClick(page, "#notify-short", 360,
    () => page.evaluate(() => document.querySelector<HTMLButtonElement>("#notify-short")!.click()));
  await writeFile(info.outputPath("toast-replacement.json"), JSON.stringify(frames, null, 2));
  const original = frames[0].toasts[0];
  const replacements = frames.flatMap(frame => frame.toasts.filter(toast => toast.text === "Failed."));
  expect(replacements.length).toBeGreaterThan(0);
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.every(frame => frame.toasts.length === 1)).toBe(true);
  expect(await originalNode!.evaluate(element => element === document.querySelector(".vx-toast"))).toBe(true);
  expect(await originalClose!.evaluate(element => element === document.activeElement)).toBe(true);
  for (const frame of frames.filter(frame => frame.toasts.some(toast => toast.text === "Failed."))) {
    expect(frame.toasts.filter(toast => toast.role === "alert" || toast.role === "status")).toHaveLength(1);
    expect(frame.toasts.filter(toast => toast.closeEnabled)).toHaveLength(1);
  }
  expect(frames.flatMap(frame => frame.toasts).every(toast => !toast.inert && !toast.hidden && toast.closeEnabled)).toBe(true);
  expect.soft(Math.max(...replacements.map(toast => Math.abs(toast.right - original.right))), "replacement right edge stays fixed while its text shrinks").toBeLessThan(1.5);
  expect.soft(Math.max(...replacements.map(toast => Math.abs(toast.layoutBottom - original.layoutBottom))), "replacement bottom edge stays fixed").toBeLessThan(1.5);
  await expect(page.locator(".vx-toast")).toHaveCount(1);
  await page.evaluate(() => {
    const callback = (window as unknown as { staleInfoTimer?: () => void }).staleInfoTimer;
    if (!callback) throw new Error("The previous notification's timer was not captured");
    callback();
  });
  await expect(page.getByRole("alert")).toHaveText(/Failed\./);
  await expect(page.locator("#dismissed-count")).toHaveText("0");
  expect(await originalClose!.evaluate(element => element === document.activeElement)).toBe(true);
  await page.locator(".vx-toast button").click();
  await expect(page.locator(".vx-toast")).toHaveCount(0);
  await expect(page.locator("#dismissed-count")).toHaveText("1");
});

test("M3 same-kind fixed-id updates preserve the status role and the only visible notification", async ({ page }, info) => {
  await prepare(page);
  await page.locator("#notify-long").click();
  const toast = page.locator(".vx-toast"), close = toast.locator("button");
  await expect(toast).toHaveCSS("opacity", "1");
  await expect(toast).toHaveAttribute("role", "status");
  const original = await toast.elementHandle();
  await close.focus();
  const frames = await traceClick(page, "#notify-info-update", 360,
    () => page.evaluate(() => document.querySelector<HTMLButtonElement>("#notify-info-update")!.click()));
  await writeFile(info.outputPath("toast-same-role-replacement.json"), JSON.stringify(frames, null, 2));
  expect(frames.length).toBeGreaterThan(1);
  expect(frames.some(frame => frame.toasts.some(value => value.text === "Still preparing."))).toBe(true);
  for (const frame of frames) {
    expect(frame.toasts).toHaveLength(1);
    expect(frame.toasts[0]).toMatchObject({ role: "status", hidden: false, inert: false, closeEnabled: true });
  }
  expect(await original!.evaluate(element => element === document.querySelector(".vx-toast"))).toBe(true);
  await expect(toast).toHaveCount(1);
  await expect(close).toBeFocused();
  await close.click();
  await expect(toast).toHaveCount(0);
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

type MaterialPreference = "reduced-transparency" | "contrast-more" | "forced-colors";

async function toastMaterial(page: Page) {
  return page.locator(".vx-toast").evaluate(element => {
    const style = getComputedStyle(element), root = document.documentElement;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d")!;
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    const rgba = [...context.getImageData(0, 0, 1, 1).data];
    const rendererCanvas = document.createElement("canvas"), gl = rendererCanvas.getContext("webgl2")!;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : null;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    let effectiveOpacity = 1;
    for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) effectiveOpacity *= Number(getComputedStyle(ancestor).opacity);
    return {
      theme: root.dataset.theme, effects: root.dataset.effects, dpr: devicePixelRatio, renderer,
      reducedMotion: root.dataset.reducedMotion, reducedTransparency: root.dataset.reducedTransparency,
      highContrast: root.dataset.highContrast, surfaceToken: getComputedStyle(root).getPropertyValue("--surface-solid").trim(),
      media: {
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        reducedTransparency: matchMedia("(prefers-reduced-transparency: reduce)").matches,
        contrastMore: matchMedia("(prefers-contrast: more)").matches,
        forcedColors: matchMedia("(forced-colors: active)").matches,
      },
      host: element.closest("dialog") ? "dialog" : "root",
      background: style.backgroundColor, rgba, opacity: Number(style.opacity), effectiveOpacity,
      backdropFilter: style.backdropFilter,
      beforeBackdropFilter: getComputedStyle(element, "::before").backdropFilter,
      afterBackdropFilter: getComputedStyle(element, "::after").backdropFilter,
    };
  });
}

function assertToastMaterial(value: Awaited<ReturnType<typeof toastMaterial>>, theme: "dark" | "light", mode: MaterialPreference) {
  expect(value.theme).toBe(theme);
  expect(value.effects).toBe("full");
  expect(value.dpr).toBe(1);
  expect(value.renderer).toMatch(/D3D11|Direct3D11/);
  expect(value.renderer).not.toMatch(/swiftshader|llvmpipe|software|basic render/i);
  expect(value.surfaceToken, "real appearance tokens have loaded").not.toBe("");
  expect(value.reducedMotion, "motion reduction is not the material preference under test").toBe("false");
  expect(value.media.reducedMotion).toBe(false);
  expect(value.reducedTransparency).toBe(String(mode === "reduced-transparency"));
  expect(value.highContrast).toBe(String(mode !== "reduced-transparency"));
  expect(value.media.reducedTransparency).toBe(mode === "reduced-transparency");
  expect(value.media.contrastMore).toBe(mode === "contrast-more");
  expect(value.media.forcedColors).toBe(mode === "forced-colors");
  expect.soft(value.rgba[3], `${value.host} Toast background is solid: ${value.background}`).toBe(255);
  expect.soft(value.opacity, `${value.host} Toast is fully entered`).toBe(1);
  expect.soft(value.effectiveOpacity, `${value.host} Toast has no translucent ancestor`).toBe(1);
  expect.soft(value.backdropFilter, `${value.host} Toast has no backdrop blur`).toBe("none");
  expect.soft(value.beforeBackdropFilter, `${value.host} Toast ::before has no backdrop blur`).toBe("none");
  expect.soft(value.afterBackdropFilter, `${value.host} Toast ::after has no backdrop blur`).toBe("none");
}

for (const theme of ["dark", "light"] as const) {
  for (const mode of ["reduced-transparency", "contrast-more", "forced-colors"] as const) {
    test(`Toast material ${theme}/${mode}: root and modal notifications stay opaque without backdrop blur`, async ({ page }, info) => {
      await page.emulateMedia({ reducedMotion: "no-preference", contrast: mode === "contrast-more" ? "more" : "no-preference",
        forcedColors: mode === "forced-colors" ? "active" : "none" });
      // Keep this session alive through navigation, both captures and assertions.
      // A matchMedia stub does not exercise Chromium's CSS media evaluation.
      const media = mode === "reduced-transparency" ? await page.context().newCDPSession(page) : null;
      try {
        if (media) await media.send("Emulation.setEmulatedMedia", { features: [
          { name: "prefers-reduced-transparency", value: "reduce" },
          { name: "prefers-reduced-motion", value: "no-preference" },
          { name: "prefers-contrast", value: "no-preference" },
          { name: "forced-colors", value: "none" },
        ] });
        await page.goto(`/tests/e2e/harness/toast-review.html?theme=${theme}`);
        await expect(page.locator("#notify-short")).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await expect(page.locator("html")).toHaveAttribute(mode === "reduced-transparency" ? "data-reduced-transparency" : "data-high-contrast", "true");
        await page.locator("#notify-short").click();
        await expect(page.locator(".vx-toast")).toHaveCSS("opacity", "1");
        const root = await toastMaterial(page);
        await page.screenshot({ path: info.outputPath("toast-root-material.png"), scale: "css" });
        await page.locator("#open-dialog").click();
        await expect(page.locator("dialog .vx-toast")).toHaveCSS("opacity", "1");
        await expect(page.locator("dialog")).toHaveCSS("opacity", "1");
        const dialog = await toastMaterial(page);
        await page.screenshot({ path: info.outputPath("toast-dialog-material.png"), scale: "css" });
        await writeFile(info.outputPath("toast-material.json"), JSON.stringify({ theme, mode, root, dialog }, null, 2));
        expect(root.host).toBe("root");
        expect(dialog.host).toBe("dialog");
        assertToastMaterial(root, theme, mode);
        assertToastMaterial(dialog, theme, mode);
      } finally {
        await media?.detach();
      }
    });
  }
}
