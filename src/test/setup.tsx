// SPDX-License-Identifier: GPL-3.0-only
import { vi } from "vitest";
import type { ReactNode } from "react";

// Keep production presets intact and exercise real Motion presence/lifecycles.
// Child transitions override the default duration, so skipAnimations also makes
// explicit transitions immediate. reducedMotion covers layout projection.
vi.mock("react-dom/client", async importOriginal => {
  const client = await importOriginal<typeof import("react-dom/client")>();
  const { cloneElement, createElement, isValidElement, StrictMode } = await vi.importActual<typeof import("react")>("react");
  // Some focused tests mock motion.span; the root still needs the real provider.
  const { MotionConfig } = await vi.importActual<typeof import("motion/react")>("motion/react");
  return {
    ...client,
    createRoot(...args: Parameters<typeof client.createRoot>) {
      const root = client.createRoot(...args);
      const render = root.render.bind(root);
      const configure = (children: ReactNode) => createElement(MotionConfig, {
        transition: { duration: 0 }, skipAnimations: true, reducedMotion: "always",
      }, children);
      // React only replays initial effects when StrictMode stays at the root.
      root.render = children => render(isValidElement<{ children?: ReactNode }>(children) && children.type === StrictMode
        ? cloneElement(children, undefined, configure(children.props.children)) : configure(children));
      return root;
    },
  };
});
