import { expect, test, type Page } from "@playwright/test";
import { installLauncherFixture } from "./fixtures";

const pageIds = ["home", "library", "discover", "multiplayer", "downloads", "accounts", "settings"] as const;

async function navigate(page: Page, id: typeof pageIds[number]) {
  await page.locator(`[data-page="${id}"]`).click();
  await expect(page.locator(`[data-page="${id}"]`)).toHaveAttribute("aria-current", "page");
  const ready = {
    home: "text=Christopher Alexander Montgomery III",
    library: "text=Christopher Alexander Montgomery III",
    discover: "text=Advanced Rendering Performance",
    multiplayer: "text=Community Survival",
    downloads: '[data-task-id="task-long"]',
    accounts: "text=LongPlayer_12345",
    settings: ".vx-settings-layout",
  }[id];
  await expect(page.locator(ready).first()).toBeVisible();
}

async function expectUsable(page: Page) {
  const result = await page.evaluate(() => {
    const viewport = window.innerWidth;
    const offenders = [...document.querySelectorAll<HTMLElement>("button,input,select,textarea,a,h1,h2,h3,p,strong,small")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.left < -2 || rect.right > viewport + 2);
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return `${element.tagName}.${element.className}@${Math.round(rect.left)}..${Math.round(rect.right)}`;
      });
    const unnamed = [...document.querySelectorAll<HTMLElement>("button,a,input,select,textarea")]
      .filter((element) => {
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden" || element.closest("[aria-hidden='true']")) return false;
        const labels = "labels" in element && element.labels ? Array.from(element.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent).join(" ") : "";
        const name = element.getAttribute("aria-label") || element.textContent || element.getAttribute("title") || labels || element.getAttribute("placeholder");
        return !name?.trim();
      })
      .map((element) => `${element.tagName}.${element.className}`);
    return { scrollWidth: document.documentElement.scrollWidth, viewport, offenders, unnamed };
  });
  expect(result.scrollWidth, JSON.stringify(result)).toBeLessThanOrEqual(result.viewport);
  expect(result.offenders, JSON.stringify(result)).toEqual([]);
  expect(result.unnamed, JSON.stringify(result)).toEqual([]);
}

async function expectKeyboardFocus(page: Page) {
  await page.keyboard.press("Tab");
  const focus = await page.evaluate(() => {
    const element = document.activeElement as HTMLElement | null;
    if (!element) return { name: "", outline: "" };
      const labels = "labels" in element && element.labels ? Array.from(element.labels as NodeListOf<HTMLLabelElement>).map((label) => label.textContent).join(" ") : "";
    return {
      name: element.getAttribute("aria-label") || element.textContent || element.getAttribute("title") || labels || element.getAttribute("placeholder") || "",
      outline: getComputedStyle(element).outlineStyle,
    };
  });
  expect(focus.name.trim()).not.toBe("");
  expect(focus.outline).not.toBe("none");
}

test("200% pseudo-locale and schema-backed worst-case data stay usable at every supported width", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installLauncherFixture(page, { stress: true });
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        hits: [{
          project_id: "advanced-rendering",
          slug: "advanced-rendering",
          title: "Advanced Rendering Performance and Compatibility Toolkit for Community Modpacks",
          description: "A detailed rendering toolkit for long-running community worlds, modpack reviewers, and players who need predictable frame pacing across many different hardware configurations.",
          icon_url: null,
          downloads: 12345678,
          author: "Senior Product Design Engineer, Platform Infrastructure",
          project_type: "mod",
          versions: ["1.21.1"],
        }],
      }),
    });
  });
  await page.goto("/?next-ui&stress-locale");
  await expect(page.locator("body")).toContainText("⟦");
  for (const width of [1050, 1440, 1920]) {
    await page.setViewportSize({ width, height: width === 1050 ? 720 : width === 1440 ? 930 : 1080 });
    for (const id of pageIds) {
      await navigate(page, id);
      await expectUsable(page);
    }
  }
  await navigate(page, "home");
  const overlap = await page.evaluate(() => {
    const launch = document.querySelector("[data-launch-primary]")!.getBoundingClientRect();
    const controls = document.querySelector(".vx-window-chrome__controls")!.getBoundingClientRect();
    return launch.left < controls.right && launch.right > controls.left && launch.top < controls.bottom && launch.bottom > controls.top;
  });
  expect(overlap).toBe(false);
  await expectKeyboardFocus(page);
  expect(errors).toEqual([]);
});

test("empty accounts, instances, resources and tasks keep one useful state and no overflow", async ({ page }) => {
  await installLauncherFixture(page, { noAccount: true, noInstances: true });
  await page.route("https://api.modrinth.com/v2/search?**", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ hits: [] }) });
  });
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.goto("/?next-ui");
  for (const id of pageIds) {
    await page.locator(`[data-page="${id}"]`).click();
    await expect(page.locator(`[data-page="${id}"]`)).toHaveAttribute("aria-current", "page");
    await expectUsable(page);
    expect(await page.locator(".vx-empty").count()).toBeLessThanOrEqual(1);
  }
});

test("the maximum download history scrolls to its last task", async ({ page }) => {
  await installLauncherFixture(page, { stress: true });
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.goto("/?next-ui");
  await page.locator('[data-page="downloads"]').click();
  await expect(page.locator('[data-task-id="task-long"]')).toBeVisible();
  await page.locator("main").hover();
  await expect.poll(async () => {
    await page.mouse.wheel(0, 20000);
    return page.locator("main").evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
  }, { timeout: 30000 }).toBeLessThanOrEqual(2);
  const bounds = await page.locator('[data-task-id="history-0"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
  });
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport);
});

for (const theme of ["dark", "light"] as const) {
  for (const effects of ["lite", "full"] as const) {
    test(`${theme} theme and ${effects} effects preserve content and focus`, async ({ page }) => {
      await installLauncherFixture(page, { theme, effects });
      await page.setViewportSize({ width: 1050, height: 720 });
      await page.goto("/?next-ui");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("html")).toHaveAttribute("data-effects", effects);
      for (const id of ["home", "library", "downloads"] as const) {
        await page.locator(`[data-page="${id}"]`).click();
        await expectUsable(page);
      }
      await expectKeyboardFocus(page);
    });
  }
}

test("reduced motion, reduced transparency and high contrast keep the saved quality and every action", async ({ page }) => {
  await installLauncherFixture(page, { effects: "full" });
  await page.addInitScript(() => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => {
      const media = original(query);
      const forced = query === "(prefers-reduced-motion: reduce)" || query === "(prefers-reduced-transparency: reduce)" || query === "(forced-colors: active)" || query === "(prefers-contrast: more)";
      if (!forced) return media;
      return new Proxy(media, {
        get(target, property, receiver) {
          if (property === "matches") return true;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
  });
  await page.setViewportSize({ width: 1050, height: 720 });
  await page.goto("/?next-ui");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-motion", "true");
  await expect(page.locator("html")).toHaveAttribute("data-reduced-transparency", "true");
  await expect(page.locator("html")).toHaveAttribute("data-high-contrast", "true");
  await expect(page.locator("html")).toHaveAttribute("data-effects", "full");
  await expect(page.locator("[data-launch-primary]")).toBeVisible();
  for (const id of pageIds) {
    await page.locator(`[data-page="${id}"]`).click();
    await expectUsable(page);
  }
});
