// @vitest-environment jsdom
import { act, StrictMode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AnimatePresence, motion } from "motion/react";
import { afterEach, beforeEach, expect, it } from "vitest";

let container: HTMLDivElement;
let root: Root;

// Motion still completes through its presentation queue when duration is zero.
async function present() {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

it("completes explicit long component transitions through the test MotionConfig", async () => {
  await act(async () => root.render(
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 60 }}>
      <button>Focus remains available</button>
    </motion.div>,
  ));
  await present();
  expect(container.firstElementChild?.getAttribute("style")).toContain("opacity: 1");
  const button = container.querySelector("button")!;
  button.focus(); expect(document.activeElement).toBe(button);
});

it("keeps real AnimatePresence exit completion despite explicit long variant timing", async () => {
  const render = (visible: boolean) => root.render(<AnimatePresence initial={false}>
    {visible && <motion.div key="content" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 60 } }}>Content</motion.div>}
  </AnimatePresence>);
  await act(async () => render(true));
  expect(container.textContent).toBe("Content");
  await act(async () => render(false));
  await present();
  expect(container.childElementCount).toBe(0);
});

it.each([false, true])("preserves root effect replay when StrictMode is %s", async strict => {
  const events: string[] = [];
  function Lifecycle() {
    useEffect(() => { events.push("mount"); return () => { events.push("cleanup"); }; }, []);
    return null;
  }
  await act(async () => root.render(strict ? <StrictMode><Lifecycle /></StrictMode> : <Lifecycle />));
  expect(events).toEqual(strict ? ["mount", "cleanup", "mount"] : ["mount"]);
});
