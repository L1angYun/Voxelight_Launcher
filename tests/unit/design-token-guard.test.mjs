import test from "node:test";
import assert from "node:assert/strict";
import { inspectStylesheet, compareSpacingBudget, repeatedSelectorLists } from "../../scripts/check-design-tokens.mjs";
test("design guard rejects independent pixel radii and literal pixel font sizes", () => {
  const result = inspectStylesheet(".card { border-radius: 8px; font-size: 11px; padding: 8px 12px; }", "src/features/demo.css");
  assert.equal(result.errors.length, 2); assert.equal(result.spacingPixels, 2);
});
test("design guard preserves declared curves and tokenized sizes without accepting arbitrary inherit", () => {
  assert.equal(inspectStylesheet(".card { border-radius: var(--radius-md); font-size: var(--text-sm); } .circle { border-radius: 50%; }", "src/features/demo.css").errors.length, 0);
  assert.equal(inspectStylesheet(".card { border-radius: inherit; }", "src/features/demo.css").errors.length, 1);
  assert.equal(inspectStylesheet(".vx-select__button { border-radius: inherit; }", "src/components/ui/AnchoredListbox.css").errors.length, 0);
});
test("spacing budget is a ratchet and token definitions retain their literal values", () => {
  assert.deepEqual(compareSpacingBudget(9, 10), []);
  assert.equal(compareSpacingBudget(11, 10).length, 1);
  assert.equal(inspectStylesheet(":root { --radius-md: 12px; --text-sm: 13px; }", "src/design/tokens.css").errors.length, 0);
});
test("split library styles cannot repeat a selector list in the same condition", () => {
  assert.equal(repeatedSelectorLists({ "grid.css": ".a,.b {color:red} .b,.a {color:blue}" }).length, 1);
  assert.equal(repeatedSelectorLists({ "grid.css": ".a {color:red}", "detail.css": ".a {color:blue}" }).length, 1);
  assert.equal(repeatedSelectorLists({ "grid.css": ".a {color:red} @media (forced-colors:active) {.a {color:CanvasText}}" }).length, 0);
});
test("split library guard detects overlapping selector lists without confusing distinct conditions", () => {
  assert.equal(repeatedSelectorLists({ "grid.css": ".a,.b {color:red} .b,.c {color:blue}" }).length, 1);
  assert.equal(repeatedSelectorLists({ "grid.css": "@layer features {.a,.b {color:red}} @layer overrides {.b,.c {color:blue}}" }).length, 0);
});

test("design guard rejects pixel-encoded custom property definitions and references", () => {
  const css = ":root { --space-13px: 13px; --radius-7: 7px; --text-29: 29px; } .row { padding: var(--space-13px); border-radius: var(--radius-7); font-size: var(--text-29); }";
  const result = inspectStylesheet(css, "src/features/demo.css");
  for (const name of ["--space-13px", "--radius-7", "--text-29"])
    assert(result.errors.some(error => error.includes(name) && error.includes("pixel-encoded")), name);
  assert(inspectStylesheet(".row { gap: var(--custom-gap-13px); }", "src/features/demo.css")
    .errors.some(error => error.includes("--custom-gap-13px")));
});

test("design guard keeps the real spacing scale and explicit semantic roles usable", () => {
  const result = inspectStylesheet(":root { --space-1: 4px; --space-8: 64px; --text-emblem-small: 21px; --text-matrix-count: 15px; } .row { gap: var(--space-1); padding-inline-start: calc(var(--space-8) + var(--space-6)); font-size: var(--text-emblem-small); }", "src/design/tokens.css");
  assert.deepEqual(result.errors, []);
  assert.equal(result.spacingPixels, 0);
  assert(inspectStylesheet(":root { --space-1: 13px; }", "src/design/tokens.css").errors.some(error => error.includes("--space-1")));
});

test("feature styles cannot override button geometry through modifiers or selector groups", () => {
  for (const property of ["height", "min-height", "block-size", "min-block-size", "border-radius", "border-top-left-radius"]) {
    const result = inspectStylesheet(`@layer features { .page :is(.vx-button, .vx-button--md) { ${property}: var(--space-5); } }`, "src/features/demo.css");
    assert(result.errors.some(error => error.includes("button geometry") && error.includes(property)), property);
  }
  assert(inspectStylesheet("@layer features { .vx-button { height: 32px; } }", "src/app/shell.css")
    .errors.some(error => error.includes("button geometry")));
});

test("button geometry guard distinguishes real buttons from descendants and predicates", () => {
  const css = ".vx-button > svg { height: 16px; } .vx-button__icon { min-height: 16px; } .row:has(.vx-button) { height: 40px; } .row:not(.vx-button) { height: 40px; } .vx-button::before { height: 2px; }";
  assert.deepEqual(inspectStylesheet(css, "src/features/demo.css").errors, []);
  assert.deepEqual(inspectStylesheet("@layer primitives { .vx-button--md { height: 38px; border-radius: var(--radius-pill); } }", "src/design/surfaces.css").errors, []);
});

test("R2-05 window-control exemption is limited to its documented selector and values", () => {
  const selector = ".vx-window-chrome__controls .vx-button";
  const accepted = `@layer features { ${selector} { min-height: 34px; border-radius: var(--radius-window-control); } }`;
  assert.deepEqual(inspectStylesheet(accepted, "src/app/shell.css").errors, []);
  for (const css of [
    `@layer features { ${selector} { min-height: 40px; } }`,
    `@layer features { ${selector} { border-radius: var(--radius-md); } }`,
    `@layer features { ${selector}, .page .vx-button { min-height: 34px; } }`,
  ]) assert(inspectStylesheet(css, "src/app/shell.css").errors.some(error => error.includes("button geometry")));
  assert(inspectStylesheet(accepted, "src/features/demo.css").errors.some(error => error.includes("button geometry")));
  assert.deepEqual(inspectStylesheet(":root { --radius-window-control: 8px; }", "src/design/tokens.css").errors, []);
  assert(inspectStylesheet(":root { --radius-window-control: 9px; }", "src/design/tokens.css").errors.some(error => error.includes("--radius-window-control")));
});

test("panel and card curves only use the six or twelve pixel scale", () => {
  for (const value of ["var(--radius-pill)", "var(--unknown-radius)", "0", "50%"]) {
    const result = inspectStylesheet(`.page :is(.vx-panel, .vx-card) { border-radius: ${value}; }`, "src/features/demo.css");
    assert(result.errors.some(error => error.includes("panel/card") && error.includes(value)), value);
  }
  assert.deepEqual(inspectStylesheet(".vx-panel { border-radius: var(--radius-lg); } .vx-card { border-radius: var(--radius-sm); } .vx-card .art { border-radius: var(--radius-pill); }", "src/features/demo.css").errors, []);
  assert(inspectStylesheet(":root { --radius-md: 24px; }", "src/design/tokens.css").errors.some(error => error.includes("--radius-md")));
  assert(inspectStylesheet(".vx-panel { border-bottom-right-radius: var(--radius-pill); }", "src/features/demo.css")
    .errors.some(error => error.includes("panel/card")));
});

test("token detection reads actual var references rather than quoted content", () => {
  assert.deepEqual(inspectStylesheet('.note::before { content: "--space-13px"; }', "src/features/demo.css").errors, []);
  assert.deepEqual(inspectStylesheet('.note::before { content: "var(--space-13px)"; }', "src/features/demo.css").errors, []);
  assert(inspectStylesheet(".row { gap: var(--gap, var(--space-13px)); }", "src/features/demo.css").errors.some(error => error.includes("--space-13px")));
});
