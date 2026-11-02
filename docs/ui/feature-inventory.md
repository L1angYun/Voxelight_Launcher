# Liquid UI feature inventory

This checklist is the replacement gate for the legacy presentation. IPC behavior stays in the existing Rust services; the page and automated evidence below own each user action in the new UI.

| User action | New owner | Evidence |
| --- | --- | --- |
| Select an instance or version directory; launch, cancel preparation, stop | Home and `useLauncherController` | `next-shell.spec.ts`, `HomePage.test.tsx`, controller tests |
| Create, import, search, sort, select, and switch instance views | Library | `library.spec.ts`, `LibraryPage.test.tsx` |
| Edit instance metadata and per-instance Java, memory, window, and JVM overrides | Instance settings | `LibraryPage.test.tsx`, `review-regressions.spec.ts` |
| Clone, back up, restore, export, and remove registrations without deleting game data | Instance overview | `LibraryPage.test.tsx`, Rust instance tests |
| List, import, enable/disable, update, view history, and roll back local content | Instance content | `review-regressions.spec.ts`, Rust resource transaction tests |
| Import, back up, export, and inspect worlds and screenshots | Instance worlds | `LibraryPage.test.tsx`, Rust world round-trip tests |
| Read logs, inspect crash diagnostics, and export redacted diagnostics | Instance logs | `LibraryPage.test.tsx`, Rust diagnostics tests |
| Search either resource source, inspect real versions/dependencies, and install to the selected target | Discover | `discover.spec.ts`, `DiscoverPage.test.tsx` |
| Install a Modrinth modpack through the shared instance-create flow | Discover and library create dialog | `discover.spec.ts` |
| Observe live task state and actual progress; pause, resume, cancel, and retry supported tasks | Downloads and shared task store | `downloads.spec.ts`, `DownloadsPage.test.tsx` |
| Add, select, refresh, and remove offline or online accounts | Players | `accounts.spec.ts`, `AccountsPage.test.tsx` |
| Start/cancel Microsoft device authorization and complete it without late account resurrection | Login dialog and `accountLogin` | `accounts.spec.ts`, `AccountManager.test.ts`, `accountLogin.test.ts` |
| Complete Authlib sign-in and choose among returned profiles | Login dialog | `accounts.spec.ts` |
| Read profile failures/empty profiles without inventing account appearance | Players and `useAccountSkin` | `accounts.spec.ts`, `accountSkin.test.tsx` |
| Upload/reset Microsoft skins and change/hide capes only after explicit action | Account appearance | `accounts.spec.ts`, `AccountAppearance.test.ts` |
| Choose default characters, import local PNG/URL previews, change model/animation/rotation, and reset the camera | Local appearance preview | `AccountsPage.test.tsx`, `accounts.spec.ts`, `CharacterCanvas.test.tsx` |
| Add/remove/ping saved servers and discover LAN worlds | Multiplayer servers | `multiplayer.spec.ts`, `MultiplayerPage.test.tsx` |
| Direct-connect with the selected server address | `launchMultiplayer` | Controller direct-launch test and `multiplayer.spec.ts` |
| Create a managed server without accepting EULA or auto-starting | Managed servers | `multiplayer.spec.ts`, Rust EULA tests |
| Explicitly accept/revoke EULA, start, save/stop, force stop | Managed servers | `multiplayer.spec.ts`, Rust process tests |
| Save complete server settings, send console/player commands, and read live logs | Managed servers | `MultiplayerPage.test.tsx`, `multiplayer.spec.ts` |
| Configure Microsoft Client ID and encrypted CurseForge secrets | Settings → General | `settings.spec.ts`, `SettingsPage.test.tsx` |
| Import/export presets without credentials | Settings → General | `settings.spec.ts`, Rust preset/config tests |
| Preview/save language, theme, two effect levels, accent source/color, and sound | Settings → Appearance | `settings.spec.ts`, `AppearanceProvider.test.tsx` |
| Choose and clear a custom home background | Settings → Appearance | `settings.spec.ts` |
| Configure game directory, isolation, and window defaults | Settings → Game | `settings.spec.ts` |
| Detect/select Java and configure memory, JVM arguments, and automatic preparation | Settings → Java | `settings.spec.ts` |
| Configure official/mirror source, concurrency, and rate limit | Settings → Downloads | `settings.spec.ts` |
| Inspect version, license, source, and data-retention behavior | Settings → About | `settings.spec.ts` |
| Minimize, maximize/restore, drag, and close the frameless window; keyboard navigation and visible focus | Window chrome and floating navigation | `next-shell.spec.ts`, `ui-stress.spec.ts` |
| WebGL fallback/context recovery, reduced motion/transparency, high contrast, and both quality levels | GlassSystem and appearance providers | `glass.spec.ts`, `ui-stress.spec.ts` |
| Empty, one-item, maximum-history, long-text, broken-image, and 200% pseudo-locale layouts | All pages | `ui-stress.spec.ts` |

No inventory row is owned by a placeholder or by a removed legacy-only selector.
