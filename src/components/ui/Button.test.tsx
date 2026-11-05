// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Play } from "lucide-react";
import { expect, it } from "vitest";
import { Button, IconButton } from "./Button";

it.each([{ size: "sm", pixels: 14 }, { size: "md", pixels: 16 }, { size: "lg", pixels: 18 }] as const)(
  "fits a supplied icon to the $size button while retaining the action label",
  async ({ size, pixels }) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<><Button size={size} icon={<Play size={99} />}>Launch</Button>
        <IconButton size={size} label="Open folder" icon={<Play size={99} />} /></>));
      for (const icon of container.querySelectorAll(".vx-button__icon svg")) {
        expect(icon.getAttribute("width")).toBe(String(pixels));
        expect(icon.getAttribute("height")).toBe(String(pixels));
      }
      expect(container.querySelectorAll(".vx-button__icon svg")).toHaveLength(2);
      expect(container.querySelector(".vx-button__label")?.textContent).toBe("Launch");
      expect(container.querySelector(".vx-button--icon")?.getAttribute("aria-label")).toBe("Open folder");
    } finally { await act(async () => root.unmount()); container.remove(); }
  },
);
