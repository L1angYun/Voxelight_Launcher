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
    for (const command of ["test_proxy_connection", "detect_local_proxies", "set_proxy_credentials", "reset_launcher_state"]) {
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

  it("registers the instance model commands in the family of the page that owns them", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split("[[permission]]");
    // Library and its instance pages create, copy, hide, delete, isolate and
    // convert instances and switch the listed game folder; Settings > Game
    // folders opens a configured folder. Crash recovery of a conversion has no
    // renderer caller yet but belongs with the conversion it completes.
    const owners: [string, string, boolean][] = [
      ...[
        "create_game_instance", "create_instance_from_version", "suggest_instance_name", "copy_instance",
        "delete_instance", "list_instance_dependants", "list_hidden_instances", "restore_instance",
        "set_instance_isolation", "set_active_game_folder", "convert_managed_instance",
      ].map((command): [string, string, boolean] => [command, "launcher-library", true]),
      ["recover_instance_conversion", "launcher-library", false],
      ["open_game_folder", "launcher-settings", true],
    ];
    for (const [command, family, rendererCaller] of owners) {
      expect(registered.has(command)).toBe(true);
      if (rendererCaller) expect(invoked.has(command)).toBe(true);
      const allowed = families.filter((block) => block.includes(`"${command}"`));
      expect(allowed).toHaveLength(1);
      expect(allowed[0]).toContain(`identifier = "${family}"`);
    }
    expect(registered.has("clone_instance")).toBe(false);
    expect(permissions).not.toContain('"clone_instance"');
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

  it("allows every command the frontend invokes in exactly one permission family", () => {
    // The app ACL manifest makes Tauri reject any custom command it does not list.
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split("[[permission]]");
    const notAllowedOnce = [...invoked].filter(
      (command) => families.filter((family) => family.includes(`"${command}"`)).length !== 1,
    );
    expect(notAllowedOnce).toEqual([]);
  });

  it("allows the instance model commands in their permission families", () => {
    const permissions = readFileSync(`${project}src-tauri/permissions/launcher.toml`, "utf8");
    const families = permissions.split("[[permission]]");
    const expected: Array<[string, string]> = [
      ["create_game_instance", "launcher-library"],
      ["create_instance_from_version", "launcher-library"],
      ["suggest_instance_name", "launcher-library"],
      ["copy_instance", "launcher-library"],
      ["delete_instance", "launcher-library"],
      ["list_instance_dependants", "launcher-library"],
      ["list_hidden_instances", "launcher-library"],
      ["restore_instance", "launcher-library"],
      ["set_instance_isolation", "launcher-library"],
      ["convert_managed_instance", "launcher-library"],
      ["recover_instance_conversion", "launcher-library"],
      ["set_active_game_folder", "launcher-library"],
      ["open_game_folder", "launcher-settings"],
    ];
    for (const [command, family] of expected) {
      expect(registered.has(command), command).toBe(true);
      const allowed = families.filter((block) => block.includes(`"${command}"`));
      expect(allowed, command).toHaveLength(1);
      expect(allowed[0], command).toContain(`identifier = "${family}"`);
    }
    // The old clone command is gone from the handler, so the ACL must not keep it.
    expect(registered.has("clone_instance")).toBe(false);
    expect(permissions).not.toContain('"clone_instance"');
  });
});
