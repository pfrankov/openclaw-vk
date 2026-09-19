# VK OpenClaw Plugin Agent Guide

## Scope
This directory contains the OpenClaw VK channel plugin (`id: vk`) implemented as a native OpenClaw plugin.

## Durability Rules
- Keep this file focused on durable repository knowledge.
- Do not store secrets, private infrastructure details, exact server addresses, user-specific absolute paths, temporary backup filenames, or one-off rollout outcomes here.
- Do not pin exact package versions or test counts here unless the version itself is the point of the instruction.
- Put machine-specific or environment-specific notes into `AGENTS.local.md` if needed; that file is gitignored and may not exist.

## Local Code Map
- `index.ts`: channel plugin entry (`defineChannelPluginEntry`)
- `setup-entry.ts`: setup wizard entry (`defineSetupPluginEntry`)
- `doctor-contract-api.ts`: OpenClaw Doctor contract (`stateMigrations`, mirrored by `doctorContract` in the manifest)
- `openclaw.plugin.json`: plugin manifest (`id`, channels, `doctorContract`, config schema)
- `src/config-schema.ts`: account/channel config JSON schema builder
- `src/channel.ts`: main channel behavior (routing, security, status, gateway start/stop)
- `src/channel.setup.ts`: setup-time plugin surface
- `src/setup-core.ts`: setup-side core operations (probe, account persistence)
- `src/setup-surface.ts`: setup UI/runtime bridge used by setup entry
- `src/accounts.ts`: account resolution and normalization helpers
- `src/format.ts`: outbound Markdown-to-VK adapter; prepares `{ text, formatData }` chunks via `markdown-to-vk`
- `src/sanitize.ts`: plain-text cleanup for VK outbound text before markdown-aware rendering
- `src/send-support.ts`: target normalization, allowlist edits, and directory helpers shared by VK send surfaces
- `src/runtime.ts`: runtime singleton access (`getVkRuntime` / `setVkRuntime`)
- `src/monitor.ts`: VK updates polling and inbound event bridge
- `src/inbound.ts`: inbound normalization, policy checks, dispatch to OpenClaw runtime
- `src/send.ts`: outbound messaging via VK API and VK-specific delivery flow
- `src/probe.ts`: token/bot probe via `groups.getById`
- `src/media.ts`: inbound attachment extraction, outbound media loading (HTTP, data URL, local files)
- `src/keyboard.ts`: VK keyboard/button building, text menu auto-parsing
- `src/types.ts`: shared plugin runtime/config/message types

## Module Format
- The plugin is already **TypeScript + ESM**:
  - `package.json` has `"type": "module"`
  - entrypoints are `.ts` files compiled by OpenClaw build/runtime scripts
- Converting to plain JS ESM is optional and usually only useful when you want to drop TS toolchain/tests.

## Minimal Runtime Smoke Check
Run from this repo root:
1. `npm ci`
2. `npm test`
3. `npm run check:pack`

Expected checkpoints:
- tests stay green
- pack output includes `src/media.ts` and all runtime entrypoints

This standalone repository is npm-managed and commits `package-lock.json`. Use
`npm`, not `pnpm`, for installs and checks here; do not create a second lockfile
or a `pnpm-workspace.yaml` in this repository.

`npm run check:runtime` is intentionally a host-compatibility check, not a
standalone post-`npm ci` command. The `openclaw` peer dependency is optional for
plugin consumers, so install the host version being tested without changing the
lockfile, build, and then run the smoke check:

```bash
npm install --no-save --package-lock=false "openclaw@<version>"
npm run build
npm run check:runtime
```

Important:
- inspecting a sibling OpenClaw checkout can tell you about the bundled VK extension there, not necessarily about this external plugin package. Do not treat that as proof that the package in this repo is valid.

## Telegram Reference Implementation
Use the Telegram channel in the sibling extension as the primary style and architecture reference:

- `../telegram/index.ts`
- `../telegram/setup-entry.ts`
- `../telegram/src/channel.ts`

When in doubt, mirror Telegram’s patterns for:
- plugin entry wiring
- account-scoped config and security behavior
- outbound/inbound adapter shape

## Aggregated External Sources
Collected from the requested links on **March 18, 2026**.

### 1) VK/Habr onboarding article
- URL: https://habr.com/ru/companies/vk/articles/570486/
- Why useful: practical bot-development flow (idea -> community setup -> update delivery -> token -> messaging features).
- Key points to retain:
  - choose update transport: Callback API or Long Poll
  - configure community messages before bot launch
  - use scoped access tokens and do not expose them publicly
  - message delivery relies on `messages.send`
  - group chat bot permissions and bot levels matter for behavior in chats

### 2) VK Bots overview (official)
- URL: https://dev.vk.com/ru/api/bots/overview
- Why useful: official product-level definition and scope of VK community bots.
- Key points to retain:
  - bots are built around **community messages**
  - platform is cross-client/cross-platform for VK users
  - primary docs path starts from the bots quick start

### 3) OpenClaw channel catalog
- URL: https://docs.openclaw.ai/channels
- Why useful: channel-level expectations inside OpenClaw and plugin positioning.
- Key points to retain:
  - channels can run simultaneously
  - group behavior and DM safety policies are first-class concerns
  - Telegram is the fastest baseline setup and a useful behavior benchmark

### 4) OpenClaw CLI plugin operations
- URL: https://docs.openclaw.ai/cli/plugins
- Why useful: authoritative operational commands and packaging constraints.
- Key points to retain:
  - core commands: `list`, `inspect`, `enable`, `disable`, `install`, `uninstall`, `update`, `doctor`
  - native plugins require `openclaw.plugin.json` with inline JSON schema (`configSchema`, even if empty)
  - bundled plugins start disabled and are explicitly enabled

### 5) vk-io introduction
- URL: https://negezor.github.io/vk-io/ru/guide/introduction.html
- Why useful: runtime SDK characteristics used by this plugin.
- Key points to retain:
  - Node.js SDK with 1:1-ish API mapping (`vk.api.*`)
  - broad VK API coverage with TypeScript-first ergonomics
  - supports bot ecosystem patterns used by Long Poll / updates handling

### 6) OpenClaw plugin architecture
- URL: https://docs.openclaw.ai/tools/plugin
- Why useful: defines plugin capability model and runtime boundaries.
- Key points to retain:
  - native plugin runtime behavior comes from `register(api)`
  - channel plugins register messaging capability (`registerChannel`)
  - discovery/validation should be manifest-driven without executing plugin code
  - plugin shape and capability ownership are explicit and inspectable

## Test Quality Guidelines (updated 2026-03-21)

### Test trustworthiness — what to avoid
Tests must verify **contracts and behavior**, not just confirm the current implementation works. After writing or modifying tests, audit them against these anti-patterns:

1. **Tautological tests** — tests that only assert `typeof x === "function"` or `Array.isArray(result)` without checking content. These pass regardless of correctness. Either test concrete output or delete the test.

2. **Pure delegation tests** — `expect(mockFn).toHaveBeenCalledWith(...)` against a fully-mocked dependency proves only that the call was made, not that the result is correct. Instead: verify that **specific arguments are correctly mapped** (e.g., `replyToId`, `forceDocument`, `accountId`) and that the **return value is shaped correctly**.

3. **"No error thrown" assertions** — `primeVkGroupId("", 123)` with no assertions only proves the function didn't crash. Add a follow-up assertion that the state was NOT mutated (e.g., subsequent `sendTypingVk` call does NOT include the primed `group_id`).

4. **`expect.any(String)` on structured data** — when testing keyboard/button JSON, parse the actual JSON and verify labels, payloads, or colors. `expect.any(String)` would pass even if the keyboard was completely wrong.

### Test trustworthiness — what to do
- **Test business rules with zero coverage** — e.g., GIF exclusion from image classification (`image/gif` → `document`), command aliases (`thinking` → `think`), wildcard `*` in allowlists, `vk:` prefix matching.
- **Test all retry error codes** — not just one. The `isRetryableVkError` function recognizes codes 6, 9, 10 and regex patterns (`ECONNRESET`, `timeout`, `429`, `5xx`). Each should have a test.
- **Test fallback/error paths** — `markRead` failure should not block dispatch; typing failure should be logged via `logTypingFailure`; pairing reply errors should be caught and logged.
- **After every batch of new tests, run `npm run test:coverage`** and inspect the uncovered lines to find untested branches.

### Test structure
- Keep shared factories in `src/test-helpers.ts`
- `src/test-helpers.ts` — shared factories: `createVkRuntimeEnv()`, `makeVkRuntime()`, `makeAccount()`, `makeMessage()`
- Coverage: `@vitest/coverage-v8`, configured in `vitest.config.ts`, run via `npm run test:coverage`

## Testing Gotchas (discovered 2026-03-18)

### vk-io VK class mock — must use regular function, not arrow
```ts
vi.mock("vk-io", () => ({
  VK: vi.fn().mockImplementation(function () { return { api: ..., updates: ... }; }),
}));
```
Arrow functions cannot be called with `new`; Vitest warns and throws `is not a constructor`.

### Reset VK mock call count in beforeEach
```ts
vi.mocked(VK).mockClear(); // after clearVkInstances()
```
Required when asserting `toHaveBeenCalledTimes` on the constructor — counts accumulate across tests otherwise.

### Registering openclaw/plugin-sdk/vk alias for Vitest
`"vk"` must be present in `scripts/lib/plugin-sdk-entrypoints.json` in the monorepo.
Without it, Vitest cannot resolve the `openclaw/plugin-sdk/vk` alias and the inbound test suite fails to load entirely.

### AbortController in fake-timer tests
The mock fetch must listen to `opts?.signal` and reject with `AbortError`; otherwise the promise never settles and the test times out at 120 s.
```ts
global.fetch = vi.fn().mockImplementation((_url, opts) => new Promise((_, reject) => {
  opts?.signal?.addEventListener("abort", () =>
    reject(new DOMException("The operation was aborted.", "AbortError")));
})) as unknown as typeof fetch;
```

### Token scopes and Long Poll selection
- `manage` scope → `groups.getLongPollServer` succeeds → Bots LP (`vk.updates.start()`)
- `messages` scope only → `groups.getLongPollServer` throws → User LP (`vk.updates.startPolling()`)

### Test commands
- Run all tests: `npm test`
- Run with coverage: `npm run test:coverage`
- Single file: `npx vitest run src/inbound.test.ts`
- Watch mode: `npm run test:watch`
- In an OpenClaw monorepo checkout, follow that checkout's package-manager and
  extension-test instructions; do not copy its lockfile workflow into this
  standalone npm package.

## Deployment Notes

### General rollout checklist
- Verify the plugin package locally before publishing: `npm test`, `npm run check:pack`
- After install on a target host, verify plugin load state with `openclaw plugins info vk --json`
- Restart the gateway after rollout and verify the service status/logs from that host's service manager

### Release and publish flow
- Official release automation lives in `.github/workflows/publish-npm.yml`.
- The workflow runs on pushed tags matching `v*`.
- The pushed tag must match `package.json` version exactly (example: package version `2026.3.22` requires tag `v2026.3.22`).
- On tag push the workflow runs `npm ci`, `npm test`, `npm pack --dry-run`, publishes to npm, and creates the GitHub Release.
- Preferred operator flow:
  1. land changes on `main`
  2. bump `package.json` version
  3. commit the version bump
  4. create tag `v<version>`
  5. push `main` and the tag
  6. verify the npm version is visible before deploying it anywhere

### Installer failure mode
Older OpenClaw installations may fail or partially wedge config when repeatedly running `openclaw plugins install ... --pin`.

### Manual recovery/install path
If the CLI installer misbehaves:
1. Remove the target plugin directory under the current OpenClaw data root
2. Run `npm pack @openclaw-vk/vk@<version>` on the target host
3. Extract the tarball into the plugin directory with `--strip-components=1`
4. Run `npm install --omit=dev --ignore-scripts` inside the extracted plugin directory
5. Restore the plugin config from the host's current backup or source-of-truth config
6. Verify `openclaw plugins info vk --json`
7. Restart the gateway

Prefer deploying the published npm package version over reusing a locally copied tarball. This avoids stale-artifact mistakes and guarantees the deployed bits match the public release tag.

### Manual install gotcha
If you only unpack the tarball and skip `npm install --omit=dev --ignore-scripts`, the plugin will fail to load with:

```text
Error: Cannot find module 'zod'
```

## Changelog Maintenance

- Keep `CHANGELOG.md` up to date for release-relevant changes. Changelog entries must be written in Russian.
- Changelog format must be tag-based: each tag section summarizes changes from the previous tag to the current tag. Section heading is the tag name only (e.g. `## v2026.4.1`) — no separate date, since the version already encodes it.
- **UX-first principle:** every item leads with what the user sees or can do differently — not the mechanism behind it. Start from the observable effect, then add just enough context to locate the relevant setting if needed. Example: "Bold and italic text in agent replies now renders correctly in VK" — not "Added format_data conversion" or "Implemented VkFormatItem mapping". A good entry passes this test: would a user who only runs `openclaw` and chats via VK understand it without reading the code?
- Changelog section headings must be in Russian: `Добавлено`, `Улучшено`, `Исправлено`, `Сопровождение`, `Для разработки`.
- Before finalizing a release entry, compare the previous tag with current `HEAD` and ensure every **user-visible** change in that diff is reflected in the new section. Do not rely on memory.
- Do not add meta/disclaimer lines in release sections (for example: "this section covers all changes between versions"). Start immediately with user-visible changes.
- Only log changes that are meaningful to someone deciding whether to update: new capabilities, fixed problems, or raised minimum version. Skip everything else — internal refactors, test additions, `.gitignore`, style fixes. If a release contains only such changes, the entire release section can be omitted or reduced to a single `Сопровождение` line without `Кому важно` / `Что проверить`.
- For substantive changes, each release entry must include two operational sections:
  - `Кому важно` — name a specific scenario or user type, not just "all users". Example: "Users whose agent replies include formatted text". When it genuinely affects everyone, say what they will notice differently.
  - `Что проверить после обновления` — concrete steps tied to VK channel behavior (pairing, allowlists, group policy, token, gateway restart, plugin status). Not "check that the plugin works" but "send a reply with `**bold**` text and confirm it appears bold in VK".
- User impact ("why it matters") must always appear in the entry body. Implementation motivation ("why it was built") is included only when clearly supported by evidence (commit message, code comment) — do not guess.
- Prefer plain UX language in the first sentence of each bullet. Error codes/method names are allowed only as secondary clarification in parentheses, not as the lead.
- Avoid terms users would not recognise: internal module names, SDK function names, file paths. Retain terms users encounter directly: `dmPolicy`, `groupPolicy`, `pairing`, `token`, `openclaw gateway restart`, `openclaw channels status`.
- If an item maps to a single commit, append only a short commit hash (no URL).

## Practical Rules For Future Changes
- Keep VK plugin behavior aligned with OpenClaw channel policy patterns (pairing, allowlists, group policy).
- Keep manifest/schema valid and minimal; never remove `configSchema` from `openclaw.plugin.json`.
- Prefer Telegram extension behavior as the compatibility reference when implementing channel lifecycle changes.
- Outbound VK text chunking/formatting is owned by `markdown-to-vk` via `src/format.ts`; do not reintroduce OpenClaw generic text chunker fallbacks or single-message trimming helpers.
- For OpenClaw-facing outbound delivery, prefer the formatted seams (`sendFormattedText` / `sendFormattedMedia`) plus `textChunkLimit` metadata over generic string chunkers, because VK delivery needs both text chunks and `format_data`.
- Do not mark VK as `markdownCapable` in OpenClaw metadata: VK supports converted rich text, but OpenClaw uses `markdownCapable` as a broader signal for markdown-native channel behavior.
- Keep private rollout details in `AGENTS.local.md`, not here.
- When adding new features, write tests that verify **behavior**, not just wiring. Run `npm run test:coverage` to check for uncovered branches.
- After writing tests, audit them: would each test fail if the feature it covers was broken? If not, rewrite or remove the test.
- Re-run these checks after edits:
  1. `npm test` (all tests pass)
  2. `npm run check:pack`
  3. If releasing: bump `package.json`, push matching `v<version>` tag, and verify the publish workflow succeeds
  4. If deploying: install the published npm package version, verify plugin load, and restart the gateway on the target host
