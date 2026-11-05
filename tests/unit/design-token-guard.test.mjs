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
