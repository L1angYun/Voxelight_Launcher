import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defaults } from "./launcher";

const project = fileURLToPath(new URL("../../", import.meta.url));
const backend = readFileSync(`${project}src-tauri/src/lib.rs`, "utf8");
const handler = backend.match(/tauri::generate_handler!\[([\s\S]*?)\]\s*\)/)?.[1] ?? "";
const registered = new Set(
  [...handler.matchAll(/^\s*(?:[a-z_]+::)+([a-z0-9_]+),?\s*$/gm)].map((match) => match[1]),
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

  it("registers proxy commands only in the launcher settings permission family", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split(/\[\[permission\]\]/);
    for (const command of ["test_proxy_connection", "set_proxy_credentials"]) {
      expect(registered.has(command)).toBe(true);
      expect(invoked.has(command)).toBe(true);
      const allowed = families.filter((family) => family.includes(`"${command}"`));
      expect(allowed).toHaveLength(1);
      expect(allowed[0]).toContain('identifier = "launcher-settings"');
    }
  });

  it("registers resource transaction and managed server capabilities", () => {
    const expected = [
      "read_local_mod_icon",
      "check_resource_updates",
      "update_resource",
      "list_resource_update_history",
      "recover_resource_update",
      "recover_instance_restore",
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

  it("registers the modpack update commands only in the library permission family", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split(/\[\[permission\]\]/);
    for (const command of ["check_modpack_update", "plan_modpack_update", "apply_modpack_update"]) {
      expect(registered.has(command)).toBe(true);
      expect(invoked.has(command)).toBe(true);
      const allowed = families.filter((family) => family.includes(`"${command}"`));
      expect(allowed).toHaveLength(1);
      expect(allowed[0]).toContain('identifier = "launcher-library"');
    }
  });

  it("registers the download source verdict only in the settings permission family", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split("[[permission]]");
    expect(registered.has("get_download_source_verdict")).toBe(true);
    expect(invoked.has("get_download_source_verdict")).toBe(true);
    const allowed = families.filter((family) => family.includes(`"get_download_source_verdict"`));
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toContain('identifier = "launcher-settings"');
  });

  it("registers the memory overview in the settings permission family", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const settings = permissions.split("[[permission]]").find((block) => block.includes('identifier = "launcher-settings"'));
    expect(registered.has("get_memory_overview")).toBe(true);
    expect(settings).toContain('"get_memory_overview"');
  });

  it("exposes the new visual defaults and system appearance command", () => {
    expect(defaults).toMatchObject({
      theme: "system",
      effects: "full",
      accentSource: "system",
      language: "system",
      proxyMode: "system",
      gameProxyMode: "system",
      soundEnabled: false,
    });
    expect(registered.has("get_system_appearance")).toBe(true);
  });

  it("registers assistant and MCP commands only in the assistant permission family", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split("[[permission]]");
    for (const command of [
      "get_assistant_status",
      "set_assistant_api_key",
      "assistant_chat",
      "start_mcp_server",
      "stop_mcp_server",
      "rotate_mcp_token",
      "get_mcp_token",
    ]) {
      expect(registered.has(command)).toBe(true);
      expect(invoked.has(command)).toBe(true);
      const allowed = families.filter((family) => family.includes(`"${command}"`));
      expect(allowed).toHaveLength(1);
      expect(allowed[0]).toContain('identifier = "launcher-assistant"');
    }
  });
});
