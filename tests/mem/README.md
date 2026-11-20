# Memory measurement harness

Reproduces the numbers in `docs/superpowers/plans/2026-11-17-voxelight-todo.md` §2. It is not part of `npm test` or the e2e suite.

**What is measured:** the "Memory" column in Task Manager's Processes tab. That column is the *private working set* of the whole process tree. On an integrated GPU, WebGL and compositor allocations live in system memory and show up there.

## Quick A/B in Chromium (no Rust build)

This runs headed Chromium forced onto the low-power (integrated) GPU, at a 1440×930 viewport with DPR 1.5, against the dev frontend on port 1430 and the e2e IPC fixture.

```bash
npx playwright test -c tests/mem/mem.config.ts tests/mem/mem.spec.ts
```

- **mem.spec.ts:** for Full and for Lite, samples the page after it settles, then samples `about:blank` in the same browser as the floor.
- **ceiling.spec.ts:** in Lite, force-loses the character context and then the world context, to bound what releasing them can still save.

The sampler (`sample.ps1`) writes each process's JSON to `VX_OUT`, or to `%TEMP%` if `VX_OUT` is unset. It prints totals for each sample.

## Native WebView2 build

`native/` holds the scripts for the release build:
- `launch.ps1` starts a copied release exe with a temporary data dir and game dir, and opens a CDP port on 9333. Pass `--force_low_power_gpu` through `-ExtraArgs` to render on the integrated GPU.
- `drive.mjs` tours the pages and toggles Lite or Full over CDP.
- `extra.mjs` removes blur and navigates to a blank page.

Sample the launcher's process tree with:

```powershell
tests/mem/sample.ps1 -RootPid <pid> -Label <name> -Out <file>
```

Each scenario is a single run, and instances of the same scenario can differ by about 100MB. Compare A/B pairs within one session.
