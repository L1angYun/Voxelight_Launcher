# Round 2 final verification and phase 2–3 follow-up

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans for the primary implementation; independent read-only reviews may use parallel agents. Steps use checkbox syntax for tracking.

**Goal:** Finish stage 4 under M2 revision 5, then close the user's fourteen phase 2–3 review findings in a separate commit.

**Architecture:** Keep all uniform instrumentation in test helpers. Preserve product rendering and existing visual thresholds. Add behavior and browser regressions at the components named by the review; keep the two requested commits separate.

**Tech Stack:** React, TypeScript, CSS cascade layers, WebGL2, Vitest, Node test runner, Playwright/D3D11, Tauri/Rust.

**Spec:** `../specs/2026-11-05-voxelight-review-round2-fixes.md`, M2 fifth revision, and the user's phase 2–3 review numbered 1–14.

## Global constraints

- Work only on `main`; no version or dependency changes, installer, AI commit trailers, skipped hooks, force push, or PR.
- Preserve the existing stage 4 working tree and historical failed measurements.
- User-approved execution order supersedes the skill's default worktree, extra approval, and frequent-commit workflow: exactly one stage 4 implementation commit first, then one review follow-up implementation commit.
- Each commit requires `npm test`, `npx tsc -b`, and the complete Playwright suite; world gates must assert actual D3D11 rendering. Push normally and confirm with `git ls-remote origin`.
- Stop if uniform convergence, measurement region, thresholds, or product parameters conflict with the actual renderer. Do not choose a different criterion.

## Review focus

- Missing, stale, cross-program, or context-restored uniform observations must never count as stable.
- Fixed-time instrumentation must compose with uniform observation in either installation order; record applied GPU values.
- Dynamic convergence uses three independent uniform deltas, a real reading interval of at least 400ms, and coverage stability; `uT` is recorded, not required to stabilize.
- Keyboard/current-selection contracts must survive unrelated busy operations, hover, and device-code state.
- Browser color/cascade and nonempty CSS assertions must validate actual rendering, not equal empty values or two equally wrong colors.

## Task 1 — Stage 4 M2 revision 5

Files: `tests/e2e/helpers/world-uniform-probe.ts` (new), `tests/e2e/helpers/world-appearance-capture.ts`, `tests/e2e/world-acceptance.spec.ts`, `tests/unit/world-appearance-stability.test.mjs`, probe unit tests, report and parent specification.

- [x] Add failing tests for dynamic uniform convergence, missing/stale generations, strict thresholds, actual read intervals, fixed mean stability, and the unchanged 20s deadline.
- [x] Implement a test-only `installWorldUniformProbe(page)` plus snapshot reader; wrap WebGL uniform calls, distinguish programs, retain applied `uLat/uCry/uIsland/uT`, timestamps and write provenance.
- [x] Give the capture helper an explicit fixed/dynamic stability mode. Fixed mode keeps mean difference <1. Dynamic mode requires coverage difference <0.3pp and each crystallization uniform difference <1e-3 at readings ≥400ms apart. Keep all other gates unchanged.
- [x] Run the focused Node tests, then native three-width world gates and remaining world cases. Inspect three fixed-startup normal screenshots separately from numeric results.
- [x] Run the complete required checks, update evidence, commit stage 4 with checklist revision 5, push and confirm the remote. Completed as `8a9ed455ccbaf48df01ab2a69d4693a82282258a`; remote main confirmed before Task 2 edits.

## Task 2 — Separate phase 2–3 review closure

- [x] Findings 1/2/11: verify earliest complete layer declaration and real refraction; add native solid/no-blur glass and chrome assertions for reduced transparency and high contrast. Keep repository stripe tests. Explicitly document any external CSS scripts not integrated into guards. C4 retains layer/refraction coverage; revision 6 native material/geometry checks passed. External source scripts remain explicitly outside npm guards.
- [x] Findings 3/4: reproduce Stop during `instance.install` and authlib two-line profile overflow. Narrow Stop blocking to `game.stop`; use an unconstrained-height profile list row with native nonoverlap/content-bound tests. Behavior unit 68/68 and native Authlib 1050/1440 content-bound checks passed.
- [x] Findings 5/6: verify the updated same-id Toast and current-item ARIA tests; preserve node identity, single live node, usable close, and the new focusable ownership contract. Follow-up Toast/S2 native 3/3 passed; info-to-info preserves status while info-to-error changes appropriately to alert.
- [x] Findings 7/8: resolve system Highlight in the browser, test every keyboard station, and assert global focus, focused input border, and Lattice outline against the actual indicator and adjacent pixels. Expanded full/Lite/reduced routes retain 42 visited plus 6 named stations per mode and all 576 original pixel points. Initial expanded run failed 3/3; the user's one permitted reference recalculation yielded `#91918c` and default indicator `#1c4f00`. Rerun passed 3/3 with minimum 3.219723461690725 at the unchanged Vanilla-adjacent point. System Highlight remains independently resolved as rgb(55,0,110).
- [x] Findings 9/10: pin selected row/tab/sidebar fills and hover exclusions; move ProjectCard current semantics onto its focusable control, retaining only the card dot frame. Add committed pixel hierarchy/allowed-fill checks; cover detail pages or explicitly record their unverified scope. Valid flat-menu RED 2 failures preceded one-rule correction; combined design/behavior native 23/23 passed. Both default detail outer panels covered; nested 24%-solid fact cells and every hidden tab remain explicitly unverified, with no opacity change.
- [x] Findings 12/13: inject each split library stylesheet through `isolatedStylesheetCss` and require nonempty colors; reproduce and correct the loader-status 6px offset. Library identity RED 1/13 then helper/component GREEN 21/21; actual Select-relative status now 12px left/bottom in revision 6 native evidence.
- [x] Finding 14: correct the stage 3 report's original cascade claim and attribute the actual stage 4 repair and its committed tests. Remove the isolated `.vx-settings-heading` rule.
- [x] Independently review the final diff and every numbered finding, run all required checks, and finalize the numbered report and evidence. Final results: 677 Vitest + 77 Node, TypeScript exit 0, complete Playwright 265/265 with no failures/skips/flaky. The separate commit, normal push and remote confirmation execute after this verification snapshot and are recorded in `review23/commit-receipt.json`.

The user has already approved the requirements and execution order; this document records that plan and introduces no additional design decision or approval gate.

### Revision 6 progress, before final C23 validation

The actual Lite/reduced adjacent-background contrast conflict triggered the required STOP and was reported before product changes. The user approved an initial fourth indicator reference from 48 saved compositor samples, `(228,226,220)` minus four per channel = `#e0ded8`, with initial indicator `#558c00`. Expanded real Tab routes then reproduced grid-adjacent `(208,204,197)` and Vanilla-adjacent `(149,149,144)` failures in all three modes; the latter includes neighboring label-edge compositing and is not halo paint. No point moved or was excluded. The user's one allowed recalculation has now been used: darkest of all 576 saved samples minus four = final reference `#91918c`, default indicator `#1c4f00`. Both accent RED/GREEN cycles retain 4 failures/5 passes then 9 passes. Final eight-case source comparison preserves every nonindicator role and all dark indicators. Ink stays `#3f7400`; its final-reference contrast 1.788052911976136 is a known unhandled shortfall explicitly retained by the user.

Revision 6 first focus/loader batch passed 11/11, expanded real routes failed 3/3, and the one recalculation rerun passed 3/3 in 33.0s. Each mode retains 192 samples, all 576 total, minimum 3.219723461690725 at the same Vanilla-adjacent pixel. Per-Tab halo 2D diagnostics use same-coordinate under-halo captures only where actual halo foreground is detected; normal captures and original four-point contracts remain. Evidence is `revision6-expanded-reference.json`, `revision6-accent-recalculated.json`, `revision6-focus-recalculated.json/.log`, and `revision6-focus-final-summary.json` under `E:/CodeX/VoxelightLauncher-worklogs/review-round2/2026-11-05/review23/`. Combined design/behavior native checks passed 23/23. Final current-worktree npm passed 68 files/677 Vitest plus77 Node; TypeScript exited0 with empty log and the pipeline proceeded. Evidence: `revision6-final-npm.log` and `revision6-final-tsc.log`. Full265 Playwright pipeline is still running; no final suite result or C23 commit/push is claimed yet. The already pushed C4 `8a9ed455ccbaf48df01ab2a69d4693a82282258a`, M2 fifth revision and all three fixed-startup width gates remain unchanged; no world or opacity parameters changed.


Final verification: `revision6-final-npm.log`, `revision6-final-tsc.log`, `revision6-full.json`, `revision6-full-summary.json` and `revision6-final-review.md`. All required precommit checks pass; normal commit/push and remote confirmation are the remaining release operations recorded in `review23/commit-receipt.json`.
