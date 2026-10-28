import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaults } from "./launcher";

const project = fileURLToPath(new URL("../../", import.meta.url));
const backend = readFileSync(`${project}src-tauri/src/lib.rs`, "utf8");
const handler = backend.match(/tauri::generate_handler!\[([\s\S]*?)\]\s*\)/)?.[1] ?? "";
const registered = new Set(
  [...handler.matchAll(/^\s*[a-z_]+::([a-z0-9_]+),?\s*$/gm)].map((match) => match[1]),
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const invoked = new Set<string>();
for (const file of sourceFiles(`${project}src`)) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(/\bcommand(?:<[^>\n]+>)?\(\s*["']([a-z0-9_]+)["']/g)) {
    invoked.add(match[1]);
  }
}

describe("Tauri IPC registration contract", () => {
  it("registers every literal command used by the frontend", () => {
    const missing = [...invoked].filter((name) => !registered.has(name));
    expect(missing).toEqual([]);
    expect(invoked.size).toBeGreaterThan(40);
  });

  it("registers resource transaction and managed server capabilities", () => {
    const expected = [
      "check_resource_updates",
      "update_resource",
      "list_resource_update_history",
      "rollback_resource_update",
      "list_managed_servers",
      "create_managed_server",
      "update_managed_server",
      "set_managed_server_eula",
      "start_managed_server",
      "stop_managed_server",
      "send_managed_server_command",
      "read_managed_server_logs",
    ];
    expect(expected.filter((name) => !registered.has(name))).toEqual([]);
  });

  it("exposes the new visual defaults and system appearance command", () => {
    expect(defaults).toMatchObject({
      effects: "full",
      accentSource: "system",
      language: "system",
      soundEnabled: false,
    });
    expect(registered.has("get_system_appearance")).toBe(true);
  });
});
