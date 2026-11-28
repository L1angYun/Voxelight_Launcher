// @vitest-environment node
// SPDX-License-Identifier: GPL-3.0-only
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./setup.css", import.meta.url)), "utf8");

describe("setup visual contract", () => {
  it("paints the launcher's 22px / 0.7px dotted lattice behind the card", () => {
    expect(css).toMatch(/background-color:\s*var\(--world-ink\)/);
    expect(css).toMatch(/var\(--text-primary\) 12%/);
    expect(css).toMatch(/0\.7px/);
    expect(css).toMatch(/background-size:\s*22px 22px/);
    expect(css).not.toMatch(/mask-image:\s*radial-gradient/);
    expect(css).toMatch(/\.vx-setup-card \{[\s\S]*?width: min\(100%, 680px\)/);
    expect(css).toMatch(/\.vx-setup-chrome__bar \{[\s\S]*?width: min\(100%, 680px\)/);
  });

  it("suppresses focus rings on step headings while leaving the global control ring alone", () => {
    expect(css).toMatch(/\.vx-setup-heading h1:focus[^{]*\{[^}]*outline:\s*none/);
    expect(css).not.toMatch(/\.vx-setup-heading h1[^{]*\{[^}]*outline:\s*2px/);
  });

  it("keeps the options card compact enough for its third row at 760x500", () => {
    expect(css).toMatch(/\.vx-setup-card \{[\s\S]*?padding: var\(--space-4\) var\(--space-5\)/);
    expect(css).toMatch(/\.vx-setup-body \{[\s\S]*?gap: var\(--space-2\)/);
    expect(css).toMatch(/\.vx-setup-option \{[\s\S]*?padding: var\(--space-2\) var\(--space-3\)/);
    expect(css).toMatch(/\.vx-setup-option__copy span \{[^}]*line-height: 1\.4/);
    expect(css).toMatch(/\.vx-setup-summary \{[^}]*padding: var\(--space-2\) var\(--space-3\)/);
  });
});
