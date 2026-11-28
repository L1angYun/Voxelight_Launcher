// SPDX-License-Identifier: GPL-3.0-only

// jsdom does not implement canvas. The lattice progress component only needs a
// 2D drawing surface, so a no-op context keeps the component under test without
// pulling in the native canvas package.
if (typeof HTMLCanvasElement !== "undefined") {
  const noop = () => {};
  const context = {
    save: noop,
    restore: noop,
    scale: noop,
    clearRect: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    globalAlpha: 1,
    fillStyle: "",
  };
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value(contextId: string) {
      return contextId === "2d" ? context : null;
    },
  });
}
