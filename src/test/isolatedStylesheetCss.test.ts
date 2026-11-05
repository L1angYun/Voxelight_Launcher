// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { parse } from "postcss";
import { isolatedStylesheetCss } from "./isolatedStylesheetCss";

afterEach(() => { document.head.innerHTML = ""; document.body.innerHTML = ""; });

it("retains real declarations and their order when loading one component stylesheet in jsdom", () => {
  const style = document.createElement("style");
  style.textContent = isolatedStylesheetCss(`@layer features {
    .probe { height: 56px; opacity: 1; border: 2px dotted black; }
    .probe[data-hidden="true"] { opacity: 0; }
  }`, ["features"]);
  document.head.append(style);
  document.body.innerHTML = '<div class="probe" data-hidden="true"></div>';
  const probe = document.querySelector<HTMLElement>(".probe")!;
  expect(getComputedStyle(probe).height).toBe("56px");
  expect(getComputedStyle(probe).borderStyle).toBe("dotted");
  expect(getComputedStyle(probe).opacity).toBe("0");
  delete probe.dataset.hidden;
  expect(getComputedStyle(probe).opacity).toBe("1");
});

it("preserves nested conditions, keyframes, comments and braces inside string values", () => {
  const css = isolatedStylesheetCss(`/* outer { brace } */ @layer primitives {
    .probe::before { content: "{ quoted }"; }
    @media (forced-colors: active) { /* nested } */ .probe { border-color: Highlight; } }
    @supports (display: grid) { .probe { display: grid; } }
    @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  }`, ["primitives"]);
  const parsed = parse(css);
  expect(parsed.nodes.map(node => node.type)).toEqual(["comment", "rule", "atrule", "atrule", "atrule"]);
  const conditions: string[] = [];
  parsed.walkAtRules(rule => { conditions.push(`${rule.name} ${rule.params}`); });
  expect(conditions).toEqual(["media (forced-colors: active)", "supports (display: grid)", "keyframes fade"]);
  const contents: string[] = [];
  parsed.walkDecls("content", declaration => { contents.push(declaration.value); });
  expect(contents).toEqual(['"{ quoted }"']);
});

it.each([
  '.probe { opacity: 0; }',
  '@layer features { .probe {} } .unlayered {}',
  '@layer base, features; @layer features { .probe {} }',
  '@layer features { .a {} } @layer overrides { .b {} }',
  '@layer features { @layer nested { .probe {} } }',
])("rejects stylesheets whose cascade this isolated adapter cannot represent: %s", css => {
  expect(() => isolatedStylesheetCss(css, ["features"])).toThrow();
});

it("preserves declared layer order and rejects an unexpected order", () => {
  const css = '@layer features { .probe { opacity: .4; } } @layer overrides { .probe { opacity: .8; } }';
  const declarations: string[] = [];
  parse(isolatedStylesheetCss(css, ["features", "overrides"])).walkDecls("opacity", node => { declarations.push(node.value); });
  expect(declarations).toEqual([".4", ".8"]);
  expect(() => isolatedStylesheetCss(css, ["overrides", "features"])).toThrow();
});
