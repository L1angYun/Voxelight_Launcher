# Voxelight Liquid UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the complete launcher UI and NSIS presentation with one bilingual, accessible Voxelight design while preserving all current launcher capabilities.

**Architecture:** Build a new `src/app` and `src/features` tree beside the current UI, backed by a shared launcher controller, additive Rust configuration, and feature registries. Use one self-developed WebGL2 GlassSystem, data-driven Lattice components, and event-driven Overture scenes; switch `src/main.tsx` to the completed UI only after every page is implemented.

**Tech Stack:** React 19, TypeScript 6, Tauri 2, Rust 1.85+, Motion, Lucide, skinview3d, i18next, react-i18next, WebGL2, CSS/OKLCH, NSIS, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-26-voxelight-liquid-ui-design.md`

## Global Constraints

- Only two user-facing effect levels exist: `lite` and `full`; default `full`. Capability fallback is not a third level.
- Use one self-developed WebGL2 GlassSystem and one spring clock. Do not add another glass or animation library.
- Lens owns surfaces/manipulation, Lattice owns data/selection, Overture owns rare transitions. One dominant visual effect per state; full quality does not mean simultaneous visual clutter.
- Preserve current startup, account, instance, resource, download, diagnostic, multiplayer, EULA, license, and data-retention behavior. Moving an entry is not deleting a feature.
- New UI code is complete before replacing the old entry point. No empty “coming soon” navigation or placeholder cards.
- Initial locales are `zh-CN` and `en-US`; `language: "system"` follows Windows. All visible text, errors, accessibility names, numbers, dates, and NSIS pages are localized.
- Defaults: `effects: "full"`, `accentSource: "voxelight"`, `soundEnabled: false`. Existing custom accent values migrate to `custom`.
- Respect reduced motion, reduced transparency, and high contrast independently of the selected effect level.
- Support 1050×720, 1440×930, and 1920-wide layouts; minimum touch/click target is 24px and common desktop targets are 36–40px.
- Do not change the product version in this plan. NSIS remains `currentUser`; preserve silent `/S` and `/D=...` behavior and default uninstall data retention.
- Do not copy reference brands, assets, API keys, account data, worlds, or credentials. Any vendored Tauri NSIS template retains its provenance and license.
- This directory is not a Git repository. Do not initialize Git or create commits; each task ends with recorded command/output evidence instead.

## Review Focus

1. Long English, unbroken instance/file names, and 200% pseudo-localized text must wrap or truncate with an accessible full label, never cover controls. **Pinned by Task 14 stress tests.**
2. Missing WebGL2, context loss, reduced motion, and `full` must coexist safely: preserve every action and show a static material without rewriting the saved level. **Pinned by Tasks 5 and 7.**
3. Old state files with missing fields, custom accents, invalid new values, and unknown future fields must migrate without losing accounts or instances. **Pinned by Task 1.**
4. Frameless dragging, maximization, DPI changes, and keyboard use must retain native Windows behavior and visible focus at the minimum window size. **Pinned by Tasks 7 and 14.**
5. NSIS cancel, repeated/upgrade installation, protected paths, and uninstall must not silently elevate, fabricate progress, or delete user data. **Pinned by Task 15.**

---

### Task 1: Additive configuration and Windows appearance service

**Files:**
- Modify: `src-tauri/src/models.rs`
- Modify: `src-tauri/src/storage.rs`
- Modify: `src-tauri/src/commands.rs`
- Create: `src-tauri/src/platform.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/Cargo.lock`
- Modify: `src/lib/launcher.ts`
- Test: `src-tauri/src/storage.rs`, `src-tauri/src/platform.rs`, `src/lib/ipcContract.test.ts`

**Interfaces:**
- Produces: `EffectsLevel = "lite" | "full"`, `AccentSource = "voxelight" | "system" | "custom"` on `Config`; `soundEnabled: boolean`; `language` accepts `system | zh-CN | en-US`.
- Produces: `SystemAppearance { accentColor: string; animationsEnabled: boolean; advancedEffectsEnabled: boolean }`.
- Produces: `command<SystemAppearance>("get_system_appearance")` and `events<SystemAppearance>("launcher://system-appearance", callback)`.

- [ ] **Step 1: Write failing migration and platform tests**

```rust
// Old custom color + missing new fields:
assert_eq!(migrated.config.effects, "full");
assert_eq!(migrated.config.accent_source, "custom");
assert_eq!(migrated.config.language, "system");
assert!(!migrated.config.sound_enabled);
// Unknown future fields do not block parsing; accounts and instances remain intact.
```

Also test `resolve_system_locale("zh-Hans") == "zh-CN"`, `resolve_system_locale("de-DE") == "en-US"`, Windows accent conversion to `#RRGGBB`, and rejection of invalid `effects` / `accentSource` values.

- [ ] **Step 2: Run the tests and confirm the new fields/functions are absent**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked migration` and `npm test -- src/lib/ipcContract.test.ts`.
Expected: FAIL on missing fields and migration behavior; do not weaken old assertions.

- [ ] **Step 3: Implement schema migration and validation**

Add `schema_version: 1` to `Persisted`, `effects`, `accent_source`, and `sound_enabled` to `Config`, and default `language` to `system` for new state. In `storage.rs`, migrate raw JSON before strongly typed deserialization: missing effects become `full`, missing accent source becomes `voxelight` only for `#b4f17a` and `custom` otherwise, missing language becomes `system`, and sound defaults off. Unknown future fields must not block parsing or discard existing accounts/instances; validate new values in `save_config_inner`.

Update the TypeScript `Config` and `defaults` without changing existing IPC command names.

- [ ] **Step 4: Implement `platform.rs` and register its commands/events**

Use the Windows `UISettings` API for accent color, `AnimationsEnabled`, `AdvancedEffectsEnabled`, and `ColorValuesChanged`; keep the settings object and event registration alive for the app lifetime. Use the Windows UI locale for first-run language resolution. Emit normalized `SystemAppearance` on the event above. Non-Windows code remains compilable behind `#[cfg(windows)]` stubs even though this release tests Windows x64.

Run `cargo check --manifest-path src-tauri/Cargo.toml` once to resolve the new `windows` crate features and update the lockfile.

- [ ] **Step 5: Verify configuration and platform behavior**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, and `npm test -- src/lib/ipcContract.test.ts`.
Expected: all pass; record the actual Windows accent/language values in the task evidence without storing personal registry data.

---

### Task 2: Bilingual runtime and structured user errors

**Files:**
- Create: `src/i18n/index.ts`, `src/i18n/format.ts`, `src/i18n/coverage.test.ts`
- Create: `src/i18n/locales/zh-CN/common.json`, `src/i18n/locales/en-US/common.json`
- Create: `src/lib/errors.ts`, `src/lib/errors.test.ts`
- Create: `src-tauri/src/errors.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/launcher.ts`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Produces: `resolveLocale(preference: string, systemLocale: string): "zh-CN" | "en-US"`.
- Produces: `createLauncherI18n(preference: string, systemLocale: string): i18n`.
- Produces: `LauncherError { code: string; params: Record<string, unknown>; detail?: string }`.
- Produces: Rust `AppError { code, params, detail }` and `AppResult<T> = Result<T, AppError>` for expected IPC errors; unexpected legacy details normalize to `internal.unexpected`.
- Consumes: Task 1 language values and platform locale.

- [ ] **Step 1: Write failing locale, fallback, formatting, and error tests**

```ts
expect(resolveLocale("system", "zh-SG")).toBe("zh-CN");
expect(resolveLocale("system", "fr-FR")).toBe("en-US");
expect(normalizeError({ code: "instance.running" }).code).toBe("instance.running");
expect(normalizeError("旧内部错误").code).toBe("internal.unexpected");
```

Assert that locale key sets match recursively, missing keys fall back to English rather than blank text, and `Intl` number/date/byte formatting follows the active locale. Add the Rust assertion `AppError::new("instance.running").with_param("id", "fixture").code == "instance.running"` and verify serialized `params`/`detail`.

- [ ] **Step 2: Run tests before implementation**

Run: `npm test -- src/i18n src/lib/errors.test.ts` and `cargo test --manifest-path src-tauri/Cargo.toml --locked errors`.
Expected: FAIL because the frontend and Rust error modules do not exist.

- [ ] **Step 3: Add i18next and implement localization/error adapters**

Run `npm install i18next react-i18next`, then implement statically bundled resources, full-message interpolation, English fallback, and the `Intl` helpers. Use Vite's eager `import.meta.glob("./locales/*/*.json")` so each feature can add a namespace without network loading or changing a central locale list. `normalizeError` accepts structured IPC errors; legacy strings become `internal.unexpected` with the original string retained only as diagnostic `detail`. `command<T>` throws `LauncherError`, not a display-ready string.

Implement serializable Rust `AppError::new(code)`, `.with_param(key, value)`, and `AppError::internal(detail)`. Expected user errors in Tasks 8–13 use `AppResult<T>` and stable codes; unexpected legacy strings are not shown directly in either locale.

- [ ] **Step 4: Verify both language bundles and existing IPC tests**

Run: `npm test -- src/i18n src/lib/errors.test.ts src/lib/ipcContract.test.ts`, `cargo test --manifest-path src-tauri/Cargo.toml --locked errors`, and `npm run build`.
Expected: PASS; no runtime language fetches and no locale keys rendered as UI text.

---

### Task 3: Shared launcher controller and extension registries

**Files:**
- Create: `src/app/controller/types.ts`, `src/app/controller/useLauncherController.ts`, `src/app/controller/LauncherProvider.tsx`
- Create: `src/app/controller/useLauncherController.test.tsx`
- Create: `src/app/registry.ts`, `src/app/registry.test.ts`

**Interfaces:**
- Produces: `LauncherProvider` and `useLauncher(): LauncherContextValue`.
- `LauncherContextValue` exposes `data`, `config`, `activeAccount`, `selectedInstance`, `selectedVersionId`, `running`, `progress`, `busy`, `reload`, `saveConfig`, `selectInstance`, `selectVersion`, `launch`, `stop`, `cancelPreparation`, and `run`.
- Signatures: `saveConfig(next: Config): Promise<void>`, `selectInstance(id?: string): void`, `selectVersion(id: string): void`, `launch(): Promise<void>`, `stop(): Promise<void>`, `cancelPreparation(): Promise<void>`, and `run<T>(labelKey: string, action: () => Promise<T>): Promise<T | undefined>`.
- Produces: typed registries for `primary | utility | contextual` navigation, `overview | content | worlds | logs | settings` instance tabs, settings sections, resource types, and download task kinds/stages.

- [ ] **Step 1: Write failing controller and registry tests**

```ts
await controller.launch();
expect(command).toHaveBeenCalledWith("launch_game", {
  versionId: "1.21.1",
  instanceId: "fixture-world",
  accountId: "fixture-classic",
});
await controller.cancelPreparation();
expect(command).toHaveBeenCalledWith("cancel_download_task", { taskId: null });
expect(registry.ids()).not.toContain("comingSoon");
```

Also cover event subscription cleanup, selected-instance reconciliation after delete, running-state updates, busy errors, and duplicate registry IDs.

- [ ] **Step 2: Run the controller tests before extraction**

Run: `npm test -- src/app`.
Expected: FAIL because the controller and registries do not exist.

- [ ] **Step 3: Move business state out of the old UI without changing its behavior**

Port bootstrap, selection, launch/stop/cancel, progress/games/log events, account selection, and operation error handling from `src/App.tsx` into the new provider. Use existing `command`, `events`, `useAccountSkin`, and domain utilities. The old UI remains the production entry for now; new pages consume only this controller rather than duplicating state.

Implement registries with localized label keys and `enabled(capabilities)` predicates. Unavailable features are hidden, never rendered as placeholders.

- [ ] **Step 4: Verify controller behavior and current application regression tests**

Run: `npm test -- src/app src/lib/accountSkin.test.tsx src/components/Multiplayer.test.ts` and `npm run test:e2e`.
Expected: PASS; current 0.5.0 UI behavior remains intact.

---

### Task 4: Design tokens, appearance provider, and accessible primitives

**Files:**
- Create: `src/design/tokens.css`, `src/design/global.css`, `src/design/accent.ts`, `src/design/accent.test.ts`
- Create: `src/app/AppearanceProvider.tsx`, `src/app/AppearanceProvider.test.tsx`
- Create: `src/components/ui/Button.tsx`, `src/components/ui/Dialog.tsx`, `src/components/ui/Field.tsx`, `src/components/ui/Feedback.tsx`
- Create: `src/components/ui/primitives.test.tsx`

**Interfaces:**
- Produces: `AppearanceProvider({ config, systemAppearance, children })` and `useAppearance()` with `resolvedTheme`, `effects`, `accent`, `reducedMotion`, `reducedTransparency`, `highContrast`.
- Produces: `Button` with independent `variant: primary | secondary | ghost` and `tone: default | danger`.
- Produces: accessible `Dialog`, `Field`, `EmptyState`, `ToastRegion`, and `GlassSurface`-ready CSS tokens.

- [ ] **Step 1: Write failing contrast and keyboard tests**

```ts
expect(contrast(scale.foreground, scale.base)).toBeGreaterThanOrEqual(4.5);
expect(resolveEffects({ reducedMotion: true, effects: "full" }).ambientMotion).toBe(false);
expect(emptyStateWithoutAction.queryByRole("button")).toBeNull();
```

Dialog tests must pin initial focus, Tab containment, Escape, focus restoration, localized accessible names, and no nested interactive elements.

- [ ] **Step 2: Run foundation tests before implementation**

Run: `npm test -- src/design src/app/AppearanceProvider.test.tsx src/components/ui/primitives.test.tsx`.
Expected: FAIL because the new foundation does not exist.

- [ ] **Step 3: Implement neutral-first tokens and appearance logic**

Define separate dark/light neutral tokens, type/spacing scales, content max widths, semantic statuses, scrims, and focus rings. Generate accent variants in OKLCH and choose foreground by measured contrast. Combine Task 1 system flags with `prefers-reduced-motion`, `prefers-contrast`, and `forced-colors`; these override effects without changing the saved setting.

Implement primitives with semantic DOM and native `<dialog>` behavior. Button hierarchy is independent of danger tone; borders are reserved for focus, selection, and necessary separation.

- [ ] **Step 4: Verify tokens, contrast, and primitive interaction**

Run: `npm test -- src/design src/app/AppearanceProvider.test.tsx src/components/ui/primitives.test.tsx` and `npm run build`.
Expected: PASS at all supplied accent fixtures, including very dark, very light, and saturated system colors.

---

### Task 5: One WebGL2 GlassSystem with two effect levels

**Files:**
- Create: `src/visual/glass/types.ts`, `src/visual/glass/geometry.ts`, `src/visual/glass/renderer.ts`
- Create: `src/visual/glass/GlassSystem.tsx`, `src/visual/glass/glass.css`
- Create: `src/visual/glass/geometry.test.ts`, `src/visual/glass/GlassSystem.test.tsx`

**Interfaces:**
- Produces: `GlassProvider` and `GlassSurface({ variant: "nav" | "control" | "dialog" | "toast", children })`.
- Produces: `createGlassRenderer(canvas): GlassRenderer` with `upsert`, `remove`, `resize`, `update`, `setQuality`, `pause`, and `dispose`.
- Produces: `data-glass-mode="full | lite | fallback"` for diagnostics; DOM retains all text, input, focus, and pointer behavior.

- [ ] **Step 1: Write failing geometry, scheduler, and fallback tests**

```ts
expect(resolveGlassMode({ webgl2: false, effects: "full" })).toBe("fallback");
expect(resolveGlassMode({ effects: "full", reducedTransparency: true })).toBe("fallback");
expect(liteScheduler.idleFrameCount()).toBe(0);
```

Pin rounded-rect bounds, DPR changes, surface unregister, one shared context, paused offscreen rendering, and no continuous Lite idle loop.

- [ ] **Step 2: Run GlassSystem tests before the renderer**

Run: `npm test -- src/visual/glass`.
Expected: FAIL because the renderer does not exist.

- [ ] **Step 3: Implement the shared renderer and DOM surfaces**

Use one glass canvas/context, a registered surface list, controlled scene/static textures, and one Motion-driven spring clock. Full enables dynamic refraction, edge highlights, controlled dispersion, and continuous interaction response. Lite uses lower-cost sampling and updates on state changes. Do not rasterize the DOM or import any liquid-glass package.

Handle `webglcontextlost` without changing saved config; retry restoration and use the same solid tokens as reduced transparency after repeated failure.

- [ ] **Step 4: Verify rendering, cleanup, and fallback**

Run: `npm test -- src/visual/glass` and `npm run build`.
Expected: PASS; repeated mount/unmount and 50 surface changes keep one live glass context and stable listener/texture counts. Real WebGL2/context-loss browser verification is owned by Task 7.

---

### Task 6: Lattice choreography, Overture events, and reusable character canvas

**Files:**
- Create: `src/visual/lattice/LatticeFrame.tsx`, `src/visual/lattice/LatticeProgress.tsx`, `src/visual/lattice/model.ts`, `src/visual/lattice/model.test.ts`
- Create: `src/visual/overture/OvertureProvider.tsx`, `src/visual/overture/OvertureScene.tsx`, `src/visual/overture/audio.ts`, `src/visual/overture/OvertureProvider.test.tsx`
- Create: `src/visual/character/CharacterCanvas.tsx`, `src/visual/character/CharacterCanvas.test.tsx`
- Modify: `src/components/WorldScene.tsx` only to expose required scene state, not to adopt old page chrome.

**Interfaces:**
- Produces: `LatticeFrame({ hovered, focused, selected })`, `LatticeProgress({ completed, total, status })`.
- Produces: `useOverture().play({ id, kind: "first-run" | "instance-installed" | "game-launched" })`; an event ID plays at most once. NSIS uses its own static Overture assets in Task 15.
- Produces: `CharacterCanvas({ skinUrl, capeUrl, model, paused, interactive, label })` using skinview3d.

- [ ] **Step 1: Write failing data-mapping and choreography tests**

```ts
expect(latticeCells({ completed: 37, total: 100 })).toHaveLength(64);
expect(latticeCells({ completed: 37, total: 100 }).filter(done)).toHaveLength(24);
expect(resolveVisualOwner({ overturePlaying: true, cardHovered: true })).toBe("overture");
expect(audioConstructedWhenSoundDisabled).toBe(false);
```

Pin zero/unknown totals, aggregation above 64 files using `Math.round(completed / total * 64)`, hover/focus/selected shape differences, once-only completion, reduced-motion substitution, and 64×32/damaged skin recovery.

- [ ] **Step 2: Run visual model tests before implementation**

Run: `npm test -- src/visual/lattice src/visual/overture src/visual/character`.
Expected: FAIL because the new components do not exist.

- [ ] **Step 3: Implement the three visual responsibilities**

Lattice draws real data/selection geometry without random decorative dots. Overture composes the original WorldScene and CharacterCanvas, coordinates one focal event, and suppresses competing ambient/card motion while it plays. Optional sound is synthesized locally and never constructs/resumes AudioContext while `soundEnabled` is false.

Extract only the proven skin rendering/input behavior from `SkinViewer`; do not carry its old page layout into CharacterCanvas.

- [ ] **Step 4: Verify visual models and existing skin regressions**

Run: `npm test -- src/visual src/components/WorldScene.test.tsx src/components/skinTexture.test.ts` and `npx playwright test tests/e2e/skin-viewer.spec.ts`.
Expected: PASS; visual state never substitutes for real labels, logs, or task data.

---

### Task 7: New application shell, frameless chrome, and Home

**Files:**
- Create: `src/app/NextApp.tsx`, `src/app/AppProviders.tsx`, `src/app/WindowChrome.tsx`, `src/app/FloatingNav.tsx`
- Create: `src/features/home/HomePage.tsx`, `src/features/home/LaunchConsole.tsx`, `src/features/home/RecentInstances.tsx`
- Create: `src/features/home/HomePage.test.tsx`
- Create: `src/i18n/locales/zh-CN/home.json`, `src/i18n/locales/zh-CN/shell.json`, `src/i18n/locales/en-US/home.json`, `src/i18n/locales/en-US/shell.json`
- Modify: `src/main.tsx`
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`
- Create: `tests/e2e/glass.spec.ts`
- Create: `tests/e2e/next-shell.spec.ts`

**Interfaces:**
- Consumes: Tasks 1–6 controller, appearance, registries, GlassSystem, Lattice, Overture, and character canvas.
- Produces: completed Home at the development-only `/?next-ui` entry; production still uses the old UI until Task 14.
- Produces: frameless `minimize`, `toggleMaximize`, `close`, drag region, maximize-state layout, and primary/utility navigation.

- [ ] **Step 1: Write failing shell and Home interaction tests**

```ts
expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(currentInstance.name);
expect(screen.getByRole("button", { name: "home.launch" })).toBeEnabled();
expect(screen.queryByText("YOUR NEXT ADVENTURE")).toBeNull();
```

Pin empty instance/account states, launch/progress/cancel/stop, recent-instance selection, no duplicate breadcrumbs/cards, drag only on blank chrome, and accessible window controls.

- [ ] **Step 2: Run the new shell tests before implementation**

Run: `npm test -- src/features/home` and `npx playwright test tests/e2e/next-shell.spec.ts`.
Expected: FAIL because `NextApp` does not exist.

- [ ] **Step 3: Implement the new shell and Home**

`src/main.tsx` selects `NextApp` only for `import.meta.env.DEV && location.search.has("next-ui")`. Build the single floating Bar, no fixed sidebar or repeated breadcrumb, and a Home composed of current instance name, real metadata, one launch console, recent instances, and the Overture background with a readable scrim.

Set `decorations: false` and verify the `WebviewWindowBuilder::from_config` path. Add only the required window permissions. Use `getCurrentWindow()` for controls and preserve native resize/Snap/taskbar behavior.

- [ ] **Step 4: Verify shell, GlassSystem, and native window behavior**

Run: `npm test -- src/features/home src/visual/glass`, `npx playwright test tests/e2e/next-shell.spec.ts tests/e2e/glass.spec.ts`, and `npm run desktop:dev`.
Expected: browser tests pass; manually verify 1050×720, 1440×930, maximized, restored, Snap, drag, keyboard controls, and at least two DPI values in the real Tauri window. Simulate WebGL2-disabled/context-loss and confirm the same launch action works.

---

### Task 8: Game library and complete instance details

**Files:**
- Create: `src/features/library/LibraryPage.tsx`, `src/features/library/InstanceCard.tsx`, `src/features/library/InstanceDetailPage.tsx`
- Create: `src/features/library/CreateInstanceDialog.tsx`, `src/features/library/useInstanceContent.ts`
- Create: `src/features/library/InstanceOverview.tsx`, `src/features/library/InstanceContent.tsx`, `src/features/library/InstanceWorlds.tsx`, `src/features/library/InstanceLogs.tsx`, `src/features/library/InstanceSettings.tsx`
- Create: `src/features/library/LibraryPage.test.tsx`
- Create: `src/i18n/locales/zh-CN/library.json`, `src/i18n/locales/en-US/library.json`
- Modify: `src-tauri/src/instances.rs`, `src-tauri/src/resources.rs`, `src-tauri/src/content.rs`, `src-tauri/src/processes.rs` for expected `AppError` codes.
- Create: `tests/e2e/library.spec.ts`

**Interfaces:**
- Consumes: Task 3 controller/registries and existing instance/resource/world/diagnostic IPC.
- Produces: `InstanceTab = overview | content | worlds | logs | settings` and shared `CreateInstanceDialog` for vanilla/loaders, modpacks, and imports.

- [ ] **Step 1: Write failing library coverage tests**

```ts
expect(instanceDetail.tabs()).toEqual(["overview", "content", "worlds", "logs", "settings"]);
expect(card.visualOwner()).toBe("lattice");
expect(card.queryByTestId("launch")).not.toHaveAttribute("data-variant", "primary");
```

For each old `InstanceManager`, `InstanceContent`, `ResourceManager`, and `Diagnostics` action, pin its new command and arguments: `create_instance`, `remove_instance`, `clone_instance`, `backup_instance`, `restore_instance_backup`, `export_instance_zip`, `list_local_resources`, `check_resource_updates`, `update_resource`, `rollback_resource_update`, `list_worlds`, `list_screenshots`, `diagnose_instance`, and `update_instance`.

- [ ] **Step 2: Run library tests before the new pages**

Run: `npm test -- src/features/library`.
Expected: FAIL on missing pages/actions; do not delete assertions for less-visible old features.

- [ ] **Step 3: Implement library and instance detail views**

Build searchable/sortable instances, creation/import flow, and contextual detail tabs. Port business behavior into hooks while writing new presentation and localized copy. Lattice exclusively owns card hover/focus/selection; no glass glow/scale stack. Empty search, no instances, missing resources, and failed diagnostics receive specific states and actions.

- [ ] **Step 4: Verify every instance feature and long-name layout**

Run: `npm test -- src/features/library src/components/ResourceManager.test.ts` and `npx playwright test tests/e2e/library.spec.ts`.
Expected: PASS; all old actions are reachable and keyboard tabs, long names, empty states, and running-instance guards work at 1050×720.

---

### Task 9: Resource discovery with real project details

**Files:**
- Create: `src/features/discover/DiscoverPage.tsx`, `src/features/discover/ProjectCard.tsx`, `src/features/discover/ProjectDetailsDrawer.tsx`, `src/features/discover/useDiscover.ts`
- Create: `src/features/discover/types.ts`
- Create: `src/i18n/locales/zh-CN/discover.json`, `src/i18n/locales/en-US/discover.json`
- Create: `src/features/discover/DiscoverPage.test.tsx`
- Modify: `src-tauri/src/resources.rs`, `src-tauri/src/curseforge.rs`, `src-tauri/src/models.rs`, `src-tauri/src/lib.rs`
- Create: `tests/e2e/discover.spec.ts`

**Interfaces:**
- Produces: `get_modrinth_project_details` and `get_curseforge_project_details`, returning `ResourceProjectDetails { project, versions, dependencies }` for the requested target context.
- Produces: `ResourceDependency { projectId: string; kind: "required" | "optional" | "incompatible" | "embedded" | "unknown"; name?: string }`; unknown remote values map to `unknown`, never to `required`.
- Consumes: existing Modrinth/CurseForge search/install commands and Task 8 instance selection/creation.

- [ ] **Step 1: Write failing discovery and API-fixture tests**

```ts
expect(details.versions.every(v => v.compatible)).toBe(true);
expect(details.dependencies.every(d => d.required || d.informational)).toBe(true);
expect(unknownRemoteDescription).not.toBeRenderedAsFact();
```

Pin empty results, offline errors, missing CurseForge key, source switching, target instance requirement, and compatible loader/version filtering using local mock responses only.

- [ ] **Step 2: Run discovery tests before implementation**

Run: `npm test -- src/features/discover` and `cargo test --manifest-path src-tauri/Cargo.toml --locked project_details`.
Expected: FAIL because the detail command/page does not exist.

- [ ] **Step 3: Implement real detail adapters and discovery UI**

Reuse the existing Modrinth `project`/`project_versions` and CurseForge `mods`/`files_page` logic; return only data actually supplied by the source. Show project details, compatible versions, required dependencies, target instance, and install action. Do not add another resource source or invent missing descriptions/version support.

- [ ] **Step 4: Verify both existing sources and installation handoff**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked`, `npm test -- src/features/discover`, and `npx playwright test tests/e2e/discover.spec.ts`.
Expected: PASS; Modrinth modpack handoff uses Task 8 flow and non-modpack installs use the correct existing command.

---

### Task 10: Download task center and data-driven progress

**Files:**
- Create: `src/features/downloads/DownloadsPage.tsx`, `src/features/downloads/TaskList.tsx`, `src/features/downloads/useDownloadTasks.ts`
- Create: `src/features/downloads/DownloadsPage.test.tsx`
- Create: `src/i18n/locales/zh-CN/downloads.json`, `src/i18n/locales/en-US/downloads.json`
- Modify: `src-tauri/src/downloads.rs` only for structured expected errors needed by the new UI.
- Create: `tests/e2e/downloads.spec.ts`

**Interfaces:**
- Consumes: existing `list_download_tasks`, `launcher://tasks`, pause/resume/cancel/retry, and Task 6 `LatticeProgress`.
- Produces: localized task presentation keyed by `kind`, `status`, and `stage`; raw legacy labels/messages remain diagnostics, not English UI.

- [ ] **Step 1: Write failing task-state tests**

```ts
expect(screen.getByText("Downloading")).toBeInTheDocument();
expect(screen.queryByText("等待执行")).toBeNull();
expect(taskActions("completed")).toEqual([]);
expect(taskActions("failed")).toContain("retry");
```

Pin queued/running/paused/interrupted/completed/failed/cancelled, zero and unknown totals, cancellation of the active task followed by the next task, and counts above the Lattice aggregation limit.

- [ ] **Step 2: Run download tests before implementation**

Run: `npm test -- src/features/downloads`.
Expected: FAIL because the task center does not exist.

- [ ] **Step 3: Implement the dedicated task center**

Build active/history sections and real pause/resume/cancel/retry actions. Use `kind`/`stage` translation keys with localized fallback and show rate only when bytes/time data supports it. Keep full logs in instance diagnostics; the Home summary and this page share the same task source without duplicating log panels.

- [ ] **Step 4: Verify task transitions and progress accuracy**

Run: `npm test -- src/features/downloads`, `npx playwright test tests/e2e/downloads.spec.ts`, and `cargo test --manifest-path src-tauri/Cargo.toml --locked downloads`.
Expected: PASS; no fake percentage, fabricated speed, or color-only failure state.

---

### Task 11: Accounts and appearance

**Files:**
- Create: `src/features/accounts/AccountsPage.tsx`, `src/features/accounts/AccountList.tsx`, `src/features/accounts/LoginDialog.tsx`, `src/features/accounts/AppearancePanel.tsx`
- Create: `src/features/accounts/AccountsPage.test.tsx`
- Create: `src/i18n/locales/zh-CN/accounts.json`, `src/i18n/locales/en-US/accounts.json`
- Modify: `src-tauri/src/auth_commands.rs`, `src-tauri/src/auth.rs`, `src-tauri/src/appearance.rs` for expected `AppError` codes.
- Create: `tests/e2e/accounts.spec.ts`

**Interfaces:**
- Consumes: existing `accountLogin`, `useAccountSkin`, account/auth IPC, and Task 6 CharacterCanvas.
- Produces: one page for account selection, offline/Microsoft/Authlib login, skins/capes, and explicit local-preview versus online-account changes.

- [ ] **Step 1: Write failing account flow tests**

```ts
expect(uploadButton).toHaveAccessibleName("Upload skin");
expect(localPreviewNotice).not.toContain("已更新正版");
expect(cancelAuth).toHaveBeenCalledWith("cancel_auth_login", expectedArgs);
```

Pin offline creation, Microsoft device-flow cancellation/profile selection, Authlib profiles, profile failure/retry, empty skin/cape, upload/reset, and no-account states.

- [ ] **Step 2: Run account tests before the new page**

Run: `npm test -- src/features/accounts`.
Expected: FAIL because the new page does not exist.

- [ ] **Step 3: Implement the new account experience**

Move the primary-nav account entry to the avatar utility without removing any flow. Port authentication logic into the new dialogs and use new presentation throughout. Distinguish default preview from real account appearance and never upload/change a skin without the user's explicit action.

- [ ] **Step 4: Verify all existing auth and appearance regressions**

Run: `npm test -- src/features/accounts src/components/AccountManager.test.ts src/components/AccountAppearance.test.ts src/components/accountLogin.test.ts src/lib/accountSkin.test.tsx` and `npx playwright test tests/e2e/accounts.spec.ts tests/e2e/account-appearance.spec.ts`.
Expected: PASS; no credentials or real personal skins are used in fixtures.

---

### Task 12: Multiplayer and managed servers

**Files:**
- Create: `src/features/multiplayer/MultiplayerPage.tsx`, `src/features/multiplayer/ServerList.tsx`, `src/features/multiplayer/ManagedServerPanel.tsx`, `src/features/multiplayer/useMultiplayer.ts`
- Create: `src/features/multiplayer/MultiplayerPage.test.tsx`
- Create: `src/i18n/locales/zh-CN/multiplayer.json`, `src/i18n/locales/en-US/multiplayer.json`
- Modify: `src-tauri/src/servers.rs`, `src-tauri/src/server_manager.rs` for expected `AppError` codes.
- Create: `tests/e2e/multiplayer.spec.ts`

**Interfaces:**
- Consumes: existing server list/ping/LAN, managed-server process/log/settings, launch, and EULA commands.

- [ ] **Step 1: Write failing multiplayer state tests**

```ts
expect(startServerWithoutEula).not.toHaveBeenCalled();
expect(unknownServerStatus).not.toHaveTextContent("online");
expect(launchArgs.serverAddress).toBe(selectedServer.address);
```

Pin add/remove/ping, no LAN results, managed start/stop/command/logs, process failure, and explicit EULA acceptance.

- [ ] **Step 2: Run multiplayer tests before implementation**

Run: `npm test -- src/features/multiplayer`.
Expected: FAIL because the new page does not exist.

- [ ] **Step 3: Implement servers and managed-server views**

Use the two contextual views `servers` and `managed`, with real query/process states and no decorative online indicators. Preserve current launch arguments and all managed-server settings/log behavior.

- [ ] **Step 4: Verify multiplayer and EULA regressions**

Run: `npm test -- src/features/multiplayer src/components/Multiplayer.test.ts` and `npx playwright test tests/e2e/multiplayer.spec.ts`.
Expected: PASS; tests never accept a real EULA or contact a personal server.

---

### Task 13: Complete global settings

**Files:**
- Create: `src/features/settings/SettingsPage.tsx`, `src/features/settings/GeneralSettings.tsx`, `src/features/settings/AppearanceSettings.tsx`
- Create: `src/features/settings/GameSettings.tsx`, `src/features/settings/JavaSettings.tsx`, `src/features/settings/DownloadSettings.tsx`, `src/features/settings/AboutSettings.tsx`
- Create: `src/features/settings/SettingsPage.test.tsx`
- Create: `src/i18n/locales/zh-CN/settings.json`, `src/i18n/locales/en-US/settings.json`
- Modify: `src-tauri/src/commands.rs`, `src-tauri/src/appearance.rs` for expected configuration `AppError` codes.
- Create: `tests/e2e/settings.spec.ts`

**Interfaces:**
- Consumes: all Task 1 config fields, Task 2 locales, Task 4 appearance preview, and existing background/import/export/service settings.
- Produces: `general | appearance | game | java | downloads | about` sections; account service credentials remain within the appropriate general/service group, not About.

- [ ] **Step 1: Write failing settings and immediate-preview tests**

```ts
await user.selectEffects("lite");
expect(appearance.effects).toBe("lite");
expect(command).not.toHaveBeenCalledWith("save_config", expect.anything());
await user.save();
expect(saved.config).toMatchObject({ effects: "lite", accentSource: "system" });
```

Pin exactly two effect options, system/Voxelight/custom accents, three themes, system/two explicit languages, sound off by default, background, game/Java/download fields, service configuration, and import/export.

- [ ] **Step 2: Run settings tests before implementation**

Run: `npm test -- src/features/settings`.
Expected: FAIL because the new settings page does not exist.

- [ ] **Step 3: Implement grouped settings with preview and explicit save**

Build new forms using the primitives and registry. Appearance/language changes preview immediately without reload; the existing explicit Save persists through `saveConfig`. Preserve validation and display localized expected errors. Keep instance overrides exclusively in Task 8 instance settings.

- [ ] **Step 4: Verify every config field and both languages**

Run: `npm test -- src/features/settings`, `npx playwright test tests/e2e/settings.spec.ts`, and `cargo test --manifest-path src-tauri/Cargo.toml --locked save_config`.
Expected: PASS; every field in `Config` has an owner and no obsolete localStorage theme overrides the saved config.

---

### Task 14: Replace the old UI and run the full UI stress matrix

**Files:**
- Modify: `src/main.tsx`, `src/app/NextApp.tsx`
- Move: `src/app/NextApp.tsx` to `src/app/App.tsx` after replacement is proven.
- Delete after replacement is proven: `src/App.tsx`, `src/components/HomeHero.tsx`, `src/components/ui/magic-card.tsx`, `src/components/ui/shimmer-button.tsx`, `src/styles.css`, `src/styles-v03.css`.
- Delete superseded presentation and their old-only tests: `AccountAppearance`, `AccountManager`, `AppearanceSettings`, `DefaultSkinPicker`, `Diagnostics`, `DownloadTasks`, `GameInstaller`, `InstanceContent`, `InstanceManager`, `ModpackInstaller`, `Multiplayer`, `ResourceManager`, `ServerManager`, `ServiceSettings`, and `SkinViewer` files under `src/components`; retain shared logic, `PlayerAvatar`, `WorldScene`, `skinTexture`, and account/auth utilities still consumed by the new tree.
- Modify: `tests/e2e/fixtures.ts`, all affected E2E tests, `scripts/review-ui.mjs`, `package.json`, `package-lock.json`
- Create: `scripts/check-i18n.mjs`, `tests/e2e/ui-stress.spec.ts`

**Interfaces:**
- Produces: the completed `NextApp` renamed to `App` as the only UI entry; no development-only old/new switch remains.
- Consumes: every feature page from Tasks 7–13.

- [ ] **Step 1: Write the final feature-inventory and stress tests before deleting old files**

Create a checklist mapping every old user action to its new page/command and require it to pass before deletion. Add long English, unbroken names, empty datasets, large counts, and a test-only 200% pseudo-locale.

```ts
expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
expect(rectsOverlap(launchButton.boundingBox(), windowControls.boundingBox())).toBe(false);
expect(accessibleNameOf(focusedElement)).not.toBe("");
```

- [ ] **Step 2: Run stress tests and confirm the completed pages are ready**

Run: `npm test` and `npm run test:e2e`.
Expected: all new-page tests pass; old-only selectors are the only identified failures to migrate. Stop if any functional inventory entry lacks a new owner.

- [ ] **Step 3: Switch the entry, remove old presentation, and enforce i18n coverage**

Make `src/app/NextApp.tsx` the sole app and remove the development switch and superseded UI. Keep shared domain utilities and proven WorldScene/skin logic. Remove `clsx`/`tailwind-merge` only if import analysis confirms no use; do not remove Motion, Lucide, or skinview3d to satisfy a cosmetic cleanup.

`check-i18n.mjs` must verify locale parity, nonempty values, and no hardcoded JSX/accessibility strings in the new tree. Expected backend errors use stable codes with translations; backend legacy detail remains diagnostics only.

- [ ] **Step 4: Run complete frontend/Rust/build checks and capture the visual matrix**

Run: `npm test`, `npm run test:e2e`, `npm run build`, `cargo test --manifest-path src-tauri/Cargo.toml --locked`, `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check`, `node scripts/check-i18n.mjs`, `npm run license:update`, and `npm run license:check`.

Update `review-ui.mjs` to capture both locales/themes/effect levels at 1050×720, 1440×930, and 1920 width, plus empty states, reduced motion/transparency, high contrast, and long text. Expected: no browser runtime errors, overflow, missing images, invisible focus, or duplicated legacy UI.

---

### Task 15: Custom bilingual NSIS installer and release validation

**Files:**
- Create: `src-tauri/installer/windows/installer.nsi`, `src-tauri/installer/windows/VoxelightPages.nsh`, `src-tauri/installer/windows/README.md`
- Create: `src-tauri/installer/windows/languages/English.nsh`, `src-tauri/installer/windows/languages/SimpChinese.nsh`
- Create: `scripts/generate-installer-assets.py`, `scripts/verify-installer-ui.ps1`
- Create: `scripts/check-installer.mjs`
- Modify: `src-tauri/tauri.conf.json`, `scripts/smoke-install.mjs`
- Create: `docs/ui/validation.md`

**Interfaces:**
- Produces: custom NSIS pages `welcome -> location -> options -> install -> finish`, English/SimpChinese language selection, native keyboard-accessible controls, and original pre-rendered optical assets.
- Preserves: Tauri template variables, WebView2 handling, `/S`, `/D=...`, current-user registry/shortcuts, licenses, upgrades/reinstall, and default data retention.

- [ ] **Step 1: Add failing installer source checks**

`verify-installer-ui.ps1` and static checks must require both languages, all five pages, actual progress bound to the install phase, keyboard-accessible native controls, no forced admin manifest, and no delete-data action in the default uninstall path. Check that repeated installation preserves an owned fixture and isolated user state.

- [ ] **Step 2: Run source checks before creating the custom installer**

Run: `node scripts/check-installer.mjs`.
Expected: FAIL because the custom pages/assets do not exist; the existing 0.5.0 installer remains the control.

- [ ] **Step 3: Implement the custom template and original assets**

Vendor the `installer.nsi` matching the resolved `tauri-bundler` version into the new installer directory, recording its exact upstream commit/version and license in `README.md`. Preserve all required Handlebars variables and installation logic while customizing the page flow and native controls. Use `installerHooks` only for additions that do not require a template change.

Generate original isometric cube/aperture BMP/ICO assets with Pillow; no WebGL/React runtime and no fake progress. Configure `template`, `languages: ["English", "SimpChinese"]`, `displayLanguageSelector: true`, custom language files, header/sidebar images, and installer/uninstaller icons.

- [ ] **Step 4: Build and test the real installer**

Run: `npm run desktop:build`.
Expected: `src-tauri/target/release/bundle/nsis/Voxelight Launcher_<version>_x64-setup.exe` builds successfully.

Run: `node scripts/smoke-install.mjs` for isolated first install, then repeat with the script's owned upgrade/reinstall fixture. Run `scripts/verify-installer-ui.ps1` once for English and once for SimpChinese, including cancel, protected-path failure, keyboard navigation, and screenshots. Run uninstall last and assert isolated and real user data are unchanged.

- [ ] **Step 5: Run final native and visual verification**

Run with the release executable and isolated fixtures: set `$env:SMOKE_BINARY` to the absolute `src-tauri/target/release/voxelight-launcher.exe` path, then run `node scripts/smoke-native.mjs`, `npm test`, `npm run test:e2e`, `npm run license:check`, and `node scripts/review-ui.mjs`.

Write `docs/ui/validation.md` with exact commands/results, installer hashes, Windows 11 build 26220 / WebView2 157.0.4341.16 reference environment, full/lite performance traces, two-language/two-level screenshots, all twenty design principles, and the explicit limitation that no separate physical low-end device was tested. Do not claim code signing, universal GPU performance, or unexecuted external account/server validation.

