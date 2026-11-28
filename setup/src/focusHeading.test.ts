// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusHeading } from "./focusHeading";

describe("focusHeading", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("moves focus to the heading without asking for a visible focus ring", () => {
    const heading = document.createElement("h1");
    heading.tabIndex = -1;
    document.body.append(heading);
    const focus = vi.spyOn(heading, "focus");

    focusHeading(heading);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true, focusVisible: false });
    expect(document.activeElement).toBe(heading);
  });

  it("ignores a missing heading", () => {
    expect(() => focusHeading(null)).not.toThrow();
  });
});
