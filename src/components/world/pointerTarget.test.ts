// SPDX-License-Identifier: GPL-3.0-only
// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { isBlankPress } from "./pointerTarget";

afterEach(() => { document.body.replaceChildren(); });
it("only claims empty layout space", () => {
  const space = document.createElement("div");
  document.body.append(space);
  expect(isBlankPress(space)).toBe(true);
  expect(isBlankPress(null)).toBe(false);
});
it("leaves controls, character canvases, drag regions and editable content alone", () => {
  for (const markup of ['<button><span></span></button>', '<a href="#"><span></span></a>', '<input>', '<select>', '<textarea>', '<canvas tabindex="0"></canvas>', '<div role="combobox"><span></span></div>', '<div data-tauri-drag-region><span></span></div>', '<div contenteditable="true"><span></span></div>']) {
    document.body.innerHTML = markup;
    expect(isBlankPress(document.body.firstElementChild!.lastElementChild ?? document.body.firstElementChild), markup).toBe(false);
  }
});
it("preserves text selection on the target and on descendants of readable copy", () => {
  document.body.innerHTML = '<p>Readable copy <span><i></i></span></p><div><section></section></div>';
  expect(isBlankPress(document.querySelector("p"))).toBe(false);
  expect(isBlankPress(document.querySelector("i"))).toBe(false);
  expect(isBlankPress(document.querySelector("p")!.firstChild)).toBe(false);
  expect(isBlankPress(document.querySelector("section"))).toBe(true);
});
