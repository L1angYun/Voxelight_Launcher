import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(css|tsx?)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  });
}

describe("CSS custom properties", () => {
  it("never reads a variable without a fallback that nothing defines", () => {
    const files = sourceFiles("src");
    const defined = new Set<string>();
    const used = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) defined.add(match[1]);
      // Variables set from script (style objects, setProperty) count as defined.
      for (const match of text.matchAll(/["'](--[A-Za-z0-9_-]+)["']/g)) defined.add(match[1]);
      if (file.endsWith(".css")) {
        for (const match of text.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*\)/g)) {
          if (!used.has(match[1])) used.set(match[1], file);
        }
      }
    }
    const missing = [...used].filter(([name]) => !defined.has(name)).map(([name, file]) => `${name} in ${file}`);
    expect(missing).toEqual([]);
  });
});
