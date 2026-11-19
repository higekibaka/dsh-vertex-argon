# Changelog

All notable changes to **Gemini 4 Adapter** (`dsh-vertex-argon`) are documented in this file.

## [2.2.7] - 2026-11-19

### Fixed
- **Same-Chunk Part Splitting & Dual-Key Field Validation (`google-signatures.js`)**:
  - Split subsequent `text` / `thinking` parts within the same candidate `parts` array even when neither carries a `thoughtSignature`, aligning streaming and non-streaming block counts 1:1.
  - Enforced strict individual validation on `thoughtSignature` / `thought_signature` and `functionCall` / `function_call` (rejecting empty/`null`/conflicting dual spellings, missing or empty `functionCall.name`, unsupported keys outside `name`/`args`/`id`/`call_id`, non-plain-object `args`, and conflicting `id`/`call_id`).
- **Unindexed Visible Interactions Frame Guard (`interactions.js`)**:
  - Tracked un-indexed visible output (`unindexedVisibleOutput`) even after an earlier `event_id`, failing closed instead of replaying from an older cursor unless a subsequent `event_id` advances `lastEventId`.
- **Pre-Handler Interactions Reasoning Validation & Recursive Descriptor Freeze (`adapter.js`)**:
  - Validated `resolveGemini4ReasoningLevel` inside `ArgonAdapter.prepareCall` before invoking custom `interactionHandler` instances, returning an in-band `{ type: 'finish', reason: { kind: 'error' } }` frame on invalid or conflicting options.
  - Upgraded `freezeDescriptor` to recursive `deepFreezeClone` across nested objects, arrays, and symbol properties.
- **Thinking-Dropout Heal Token Budget Deduction (`generate-content.js`)**:
  - Evaluated Hop 1 usage before deciding `hideStop` / `canHeal()` and deducted Hop 1 spent candidate + thought tokens from `maxOutputTokens` / `max_output_tokens` across both `request.body` and cloned `httpOptions.extraBody` on synthetic (`!hopToken`) replay hops (refusing synthetic healing when no budget remains), while leaving checkpointed `hopToken` requests untouched.

## [2.2.6] - 2026-11-19

### Fixed
- **Fail-Closed Unsupported Part Validation (`google-signatures.js`)**:
  - Validated every candidate Part inside `observe(chunk)` against the supported `pi-ai` replay contract (`text`, `thought`, `thoughtSignature` / `thought_signature`, `functionCall` / `function_call`); unrepresentable parts (`executableCode`, `codeExecutionResult`, `functionResponse`, `inlineData`, `fileData`, mixed `text + functionCall`, `functionCall` with `thought: true`, or bare `{ thought: true }`) now fail closed with `ARGON_SIGNATURE_REPLAY` instead of being silently dropped.
- **Symmetric Cross-Chunk & Same-Chunk Text/Thinking Merge (`google-signatures.js`)**:
  - Made `splitSigned` symmetric between `text` and `thinking`: cross-chunk continuations from a non-empty signed block to an unsigned block merge while preserving the signature, whereas same-chunk signature boundaries, conflicting signatures (`S1` → `S2`), and explicit empty signed carriers split 1:1.
- **Immutable Deep-Frozen Model Descriptors (`adapter.js`)**:
  - Added `freezeDescriptor` deep-freezing returned/registered model descriptors (`input`, `thinkingLevelMap`, `cost`, and the descriptor object itself while preserving `MAX_TOKENS_CEILING`) in both `getProfiles()` and `argonProvider()`, preventing callers from mutating cached descriptor state via `getModels()`.

## [2.2.5] - 2026-11-19

### Fixed
- **Same-Chunk Unsigned-to-Signed Part Boundaries (`google-signatures.js`)**:
  - Tracked `currentFromThisChunk` inside `observe(chunk)` so an unsigned part followed immediately by a signed part (`text` or `thinking`) within the same `candidates[0].content.parts` array always splits 1:1 into separate blocks while preserving cross-chunk delta merging.
- **Strict `extraBody` Effort/Null Hardening & Direct-Provider Origin Pinning (`adapter.js`)**:
  - Added `'reasoningEffort'`, `'reasoning_effort'`, `'thinkingLevel'`, and `'thinking_level'` to `EXTRA_BODY_STRIPPED_KEYS` (and stripped `reasoningEffort` / `reasoning_effort` on `body` & `cleanConfig` in `gemini4StreamSimple`), and rejected explicit `null` / non-plain-object values for `httpOptions.extraBody`, `extraBody.generationConfig`, and `extraBody.generation_config` with `INVALID_REQUEST`.
  - Pinned `baseUrl` and `contextWindow` on `effectiveModel` in `argonProvider.streamSimple` from `configured` alongside `id`, `provider`, `api`, `maxTokens`, `thinkingLevelMap`, and `[MAX_TOKENS_CEILING]`.
- **Two-Stage `apply()` Cleanup Rollback (`index.js`)**:
  - Rolled back both `registration?.()` and `unpatchPiAi()` in `try/finally` inside both the `ctx.effect` disposer and `catch` handler if `ctx.effect(...)` throws after `ctx.llm.registerAdapter()` has succeeded.

## [2.2.4] - 2026-11-19

### Fixed
- **Google Background Interactions `longDecode: false` Clamp & `maxTokens: null` Guard (`interaction-adapter.js`, `interactions-input.js`)**:
  - Clamped outbound `maxTokens` / `generation_config.max_output_tokens` to `65,536` when `longDecode === false` (including Google background Interactions where `explicitMaxTokensCap > 65536`), and rejected explicit `maxTokens: null` in both `buildInteractionRequest` and `argonProvider.streamSimple`.
- **GenerateContent `onPayload` `extraBody` Thinking Sanitization, Mandatory Output Cap & Cloned Model Ceiling Retention (`adapter.js`)**:
  - Sanitized `httpOptions.extraBody` and `extraBody.generationConfig` / `generation_config` (`thinkingConfig`, `thinkingBudget`, `includeThoughts`, sampling keys) for all Gemini 4 models (plus explicit cache fields on Hydrogen/Neon), and ensured omitted `config.maxOutputTokens` after upstream `onPayload` hooks is restored to the resolved output budget.
  - Preserved trusted `configured` model properties and `MAX_TOKENS_CEILING` symbols in `argonProvider.streamSimple` so JSON-cloned model descriptors cannot bypass configured caps.
- **Signed Thinking Part Boundaries & Startup Registration Rollback (`google-signatures.js`, `index.js`)**:
  - Split subsequent unsigned thinking parts away from preceding signed thinking parts in `observe()` so empty signed thinking parts preserve 1:1 boundaries.
  - Registered `installGemini4PiAiPatch()` disposal immediately and rolled back the lease if `ctx.llm.registerAdapter()` throws.

## [2.2.3] - 2026-11-19

### Fixed
- **Signature Part Boundary Preservation (`google-signatures.js`)**:
  - Split consecutive signed parts (`text` / `thinking`) and signed empty-text parts in `observe()` so distinct signatures and original wire Part boundaries round-trip 1:1 without merging.
- **Outbound Payload Cap Enforcement & Full `1,048,576` Long-Decode Headroom (`adapter.js`)**:
  - Enforced the resolved route/mode `maxOutputTokens` ceiling after `onPayload` transforms (including `httpOptions.extraBody` and `config.maxOutputTokens` / `max_output_tokens`) and separated host compaction headroom (`contextWindow - 131,072`) from the protocol ceiling (`1,048,576`) so explicit `1,048,576` long-decode budgets are reachable.
- **Eager Interactions Budget/Option Validation & Model-Aware Defaults (`adapter.js`, `interaction-adapter.js`, `interactions-input.js`)**:
  - Validated `maxTokens` (including `null` and configured caps) and explicit conflicting dual reasoning fields synchronously in `ArgonAdapter.prepareCall` before entering the Interactions async generator.
  - Added `defaultReasoningForModel` (`'high'` for Hydrogen / Neon when user config omits `reasoning`, keeping `'medium'` for Argon / Carbon and channel-level UI defaults).
- **Overlapping `installGemini4PiAiPatch` / `ensureGemini4ApiClientPatch` Safety (`adapter.js`)**:
  - Managed active installers via an ordered owner stack + shared first-touch model state and reference-counted `ApiClient.prototype.requestStream` leases so out-of-order disposal preserves remaining active patches and restores original properties cleanly when the last installer unmounts.

## [2.2.2] - 2026-11-19

### Fixed
- **Hook/Adapter Dual-Field Reasoning Parity & `maxTokens` Guard (`index.js`, `adapter.js`)**:
  - Added `syncGemini4ReasoningOptions` so `agent/request`, `ArgonAdapter.prepareCall().stream` (both GenerateContent and Interactions), and native `PiAiAdapter` wrappers agree on explicit `{ reasoning, reasoningEffort }` pairs (e.g., `{ reasoning: 'low', reasoningEffort: 'max' }` resolves cleanly while keeping invalid inputs rejected), and write both fields when explicit so omitted `reasoningEffort` cannot fall back to profile defaults.
  - Enforced positive safe integer and declared route `maxTokens` ceiling (`<= 1,048,576`, honoring explicit route/config limits while preserving `longDecode=false` 64K clamping) in `gemini4StreamSimple`.
- **Turn-Scoped `toolCallId` Pairing & Complete Native `google`/`google-vertex` Coverage (`interactions-input.js`, `google-signatures.js`, `adapter.js`)**:
  - Scoped tool-call result pairing in `buildInteractionRequest`, `generateContentHistory`, and `createGoogleSignatureBridge` strictly to `[assistantIndex + 1, nextAssistant)` turn boundaries so an interrupted prior call with a reused `toolCallId` cannot claim a subsequent turn's result, and upgraded `createGoogleSignatureBridge` to downgrade cross-model `toolCall` / `thinking` turns even without standalone codecs.
  - Routed native `google` / `google-vertex` `PiAiAdapter.prototype.prepareCall` and `stream` through `generateContentHistory`, tracked modified model descriptors so `unpatch` restores original `reasoning` / `thinkingLevelMap` properties, and honored `active` inside retained prepared closures.

## [2.2.1] - 2026-11-19

### Fixed
- **Strict 8-Model Parsing & Prepared Target Pinning (`interactions-input.js`, `adapter.js`, `interaction-adapter.js`)**:
  - Unified official 8-model parsing (`resolveOfficialGemini4Model`) across `isGoogleApiModel`, `officialUpstreamModel`, `isHydrogenModel`, `isNeonModel`, `supportsXhighReasoning`, and `buildInteractionRequest` (`models/` prefix, case-insensitive, explicit `UNKNOWN_MODEL` / `Error` rejection for unknown non-empty IDs while retaining default `'gemini-4-argon'` when omitted, and exact model resolution when `settings.upstreamModel` is omitted in Interactions).
  - Tightened `detectPiAiArgonRoutes` regex tails from `\b` to `$` so `-preview` / experimental suffixes are not treated as official routes.
  - Hardened `ArgonAdapter.prepareCall` to synchronously reject non-object options or mismatched `provider` / `model` (`INVALID_REQUEST`) and pin `(provider, model)` on omitted fields across both GenerateContent and Interactions branches.
- **Dual-Field Reasoning Guards (`interactions-input.js`, `interaction-adapter.js`, `adapter.js`)**:
  - Added shared `resolveGemini4ReasoningLevel` so explicit `reasoning` and `reasoningEffort` are both checked at `ArgonAdapter.stream`, `prepareCall().stream`, `gemini4StreamSimple`, `assertInteractionOptions`, and `buildInteractionRequest`, rejecting explicit invalid efforts (such as `{ reasoning: 'off' }`) or conflicting non-`max` fields instead of falling back to defaults, and guarding `narrowMaxReasoning` when a sibling field is invalid.
- **Complete Native Patch & Explicit Cache Cleanup (`adapter.js`)**:
  - Updated `installGemini4PiAiPatch` to apply `thinkingLevelMap` to pre-enabled `isGemini4Model` entries regardless of existing `m.reasoning`, wrap `piProvider.stream` alongside `piProvider.streamSimple`, wrap `PiAiAdapter.prototype.prepareCall` / `PiAiAdapter.prototype.stream` for native `google` / `google-vertex` Gemini 4 routes, strip `httpOptions.extraBody.cachedContent` / `cached_content` non-mutatingly on Hydrogen/Neon, and cleanly restore all patched prototypes/methods on disposal.
- **Cross-Turn Reused `toolCallId` History Isolation (`interactions-input.js`, `google-signatures.js`)**:
  - Replaced global `Map` / `Set` tracking with per-`toolCallId` FIFO queues and unclaimed-after-position lookup in `buildInteractionRequest`, `generateContentHistory`, and `createGoogleSignatureBridge`, preventing earlier downgraded turns from corrupting reused native `toolCallId` turns or masking later unfinished calls.

## [2.2.0] - 2026-11-19

### Added
- **Gemini 4 Neon Support Across Both Official Channels (`adapter.js`, `index.js`, `package.json`)**:
  - Added `NEON_MODEL = 'gemini-4-neon'` (Vertex AI) and `GOOGLE_API_NEON_MODEL = 'gemini-4-neon-google'` (Gemini API), `isNeonModel()`, and `supportsXhighReasoning()` (`isHydrogenModel(modelId) || isNeonModel(modelId)`).
  - Updated `isGoogleApiModel`, `officialUpstreamModel`, `detectPiAiArgonRoutes` (`hasVertexNeon` / `hasGoogleNeon` explicit, auto-detection, and empty Argon fallback), and `createArgonAdapter().getProfiles()` (`vn` / `gn` cache keys, `HYDROGEN_THINKING_MAP`), expanding the official matrix to 8 models with 1M context window (`1,048,576`), `65,536` single-hop / `1,048,576` long decode, four reasoning levels (`low` / `medium` / `high` / `xhigh`, `max` → `xhigh`, rejecting `minimal` / `off`), and outbound `cachedContent` / `cached_content` stripping.

### Fixed
- **Interactions `xhigh` & `max` → `xhigh` Convergence Parity (`interaction-adapter.js`, `interactions-input.js`, `adapter.js`, `index.js`)**:
  - Updated `assertInteractionOptions` and `buildInteractionRequest` to share model-scoped validation (`supportsXhighReasoning`), allowing `['low', 'medium', 'high', 'xhigh']` and narrowing `max` → `xhigh` for both `gemini-4-hydrogen*` and `gemini-4-neon*` across `adapter.stream`, `prepareCall().stream`, and `agent/request` hooks, while keeping Argon and Carbon strictly 3-level (`max` → `high`) and rejecting unsupported efforts before dispatch.

### Changed
- **Settings UI, Locale & Documentation (`client.js`, `locale/zh.json`, `locale/en.json`, `README.md`, `AGENTS.md`, `docs/implementation/`)**:
  - Bumped version to `2.2.0`, added `gemini-4-neon` keyword, and updated Chinese and English descriptions and setup instructions for the 8-model matrix and Hydrogen/Neon `XHigh` support.

## [2.1.0] - 2026-11-15

### Added
- **Gemini 4 Hydrogen Support Across Both Official Channels (`adapter.js`, `interaction-adapter.js`, `client.js`, `package.json`)**:
  - Added `HYDROGEN_MODEL = 'gemini-4-hydrogen'` (Vertex AI) and `GOOGLE_API_HYDROGEN_MODEL = 'gemini-4-hydrogen-google'` (Gemini API) alongside Argon and Carbon via `officialUpstreamModel` and `detectPiAiArgonRoutes`, expanding the official matrix to 6 models with shared long-decode, service-tier validation, and cross-model tool-history downgrade protection.
- **Model-Scoped `xhigh` Reasoning Effort for Hydrogen (`adapter.js`, `interactions-input.js`, `diagnostics.js`, `diagnostic-store.js`, `client.js`)**:
  - Added `HYDROGEN_LEVELS = ['low', 'medium', 'high', 'xhigh']`, `HYDROGEN_THINKING_MAP`, `levelsForModel()`, and `thinkingLevelMapFor()`: Hydrogen supports four reasoning levels (default `high`, mapping `max` → `xhigh` and stripping unsupported `cachedContent` / `cached_content` outbound fields), while Argon and Carbon remain strictly 3-level and reject `xhigh` before dispatch with `UNSUPPORTED_REASONING_EFFORT`.
  - Expanded diagnostic enums and validators to preserve `XHIGH` instead of silently downgrading it to `MEDIUM`.

### Fixed
- **DSH 0.2.2-rc.2+ Host Bundle Loader Compatibility (`test/host-internals.mjs`)**:
  - Updated client bundle injection marker matching to tolerate `return module.exports` without a trailing semicolon.

## [2.0.0] - 2026-11-11

### Breaking Changes
- **Focused Dual Official Channels & Proxy Route Removal (`adapter.js`, `index.js`, `interaction-adapter.js`, `client.js`)**:
  - Removed the third-party Antigravity reverse-proxy route (`gemini-4-argon-proxy`, `gemini-3.8-flash-proxy`), dedicated `proxy*` settings (`proxyEnabled`, `proxyBaseUrl`, `proxyApiKey`), and the reverse-proxy settings card introduced in `1.6.0`–`1.6.3`, streamlining volatile plugin settings from 16 to **13** and focusing exclusively on official **Vertex AI** and **Gemini Developer API** channels.

### Added
- **Gemini 4 Carbon Support Across Both Official Channels (`adapter.js`, `interaction-adapter.js`, `client.js`, `package.json`)**:
  - Added `CARBON_MODEL = 'gemini-4-carbon'` (Vertex AI) and `GOOGLE_API_CARBON_MODEL = 'gemini-4-carbon-google'` (Gemini API) alongside the Argon models via `officialUpstreamModel` and `detectPiAiArgonRoutes`, forming a 4-model official matrix with shared long-decode, service-tier validation, and cross-model tool-history downgrade protection.

### Changed
- **Rebranded Display Surface to Gemini 4 Adapter (`locale/zh.json`, `locale/en.json`, `adapter.js`, `client.js`, `README.md`)**:
  - Updated UI display titles, model-picker group name, diagnostics views (**Gemini 4 诊断** / **Gemini 4 diagnostics**), and package metadata to **Gemini 4 Adapter** while preserving the npm package name (`dsh-vertex-argon`), provider ID (`google-vertex-argon`), patch row ID (`local-vertex-argon`), tool name (`argon_inspect`), and storage domains (`vertex_argon_*`) for seamless in-place upgrades.
  - Rewrote `README.md` for clarity, onboarding, and full `v2.0.0` architecture alignment.

### Fixed
- **Direct-Adapter `max` → `high` Reasoning Convergence & Test Isolation (`adapter.js`, `interaction-adapter.js`, `interactions-input.js`, `test/*.test.mjs`)**:
  - Added `narrowMaxReasoning` across `ArgonAdapter.prepareCall`, `gemini4StreamSimple`, `interaction-adapter`, and `interactions-input` so callers invoking `adapter.stream` or `prepareCall().stream` directly (bypassing `agent/request`, such as advisor plugins) consistently normalize `max` reasoning effort to `high` while continuing to reject `off` / `minimal` / `xhigh`.
  - Isolated per-test `globalThis.fetch` mocks and SDK prototype patches across the offline test suite so single-process `--test-isolation=none` runs match per-file isolated runs.

## [1.6.4] - 2026-11-05

### Fixed
- **MALFORMED_FUNCTION_CALL & Stream-Timeout Tool-Mode Auto-Fallback (`adapter.js`)**:
  - Added a bounded 180-second fallback map (`autoToolModeFallbacks`) keyed by session, model, and message tail so retries after `MALFORMED_FUNCTION_CALL`, transient stop reasons, or `STREAM_PHASE_TIMEOUT` automatically downgrade `toolConfig.functionCallingConfig.mode` from `VALIDATED` to `AUTO` and clear the fallback once a turn completes cleanly.
- **Role-Safe Tool Demotion & Polluted History Scrubbing (`google-signatures.js`, `interactions-input.js`)**:
  - Moved demoted `[Previously executed tool ...]` headers out of `role: "model"` assistant content and prepended them to the corresponding `role: "user"` tool-result message across both `createGoogleSignatureBridge` and `generateContentHistory` / `buildInteractionRequest`, preventing the model from seeing and imitating self-authored pseudo tool-call tags in assistant history.
  - Added `scrubPollutedAssistantText` and `scrubPollutedCheckpointText` to strip leaked `[:thinking:]` / `思考过程：` prefixes and trailing forged tool-call blocks from historical assistant turns and compacted `[Checkpoint N]` summaries while preserving inline backtick diagnostic quotes and `[PASS]` replies.
  - Preserved ordinary empty-text `thoughtSignature` parts without standalone codecs across same-model replays.

### Changed
- **Host Compatibility (`package.json`, `test/plugin-lifecycle.test.mjs`)**:
  - Broadened `engines.dsh`, `dsh.engines.dsh`, and `@deepseek-ai/*` peer ranges to `>=0.2.0-rc.2` (and `@earendil-works/pi-ai` to `>=1.1.0`, `@google/genai` to `>=2.21.0`) for seamless compatibility with DSH `0.2.2-rc.1+`, and updated `test/plugin-lifecycle.test.mjs` to mount `@deepseek-ai/dsh-tool-executor-native` when testing against `0.2.2+` tool runtimes.

## [1.6.3] - 2026-10-28

### Added
- **Gemini 3.8 Flash on the Antigravity Proxy (`adapter.js`, `interaction-adapter.js`, `client.js`)**:
  - Added `PROXY_FLASH_MODEL = 'gemini-3.8-flash-proxy'` (`Gemini 3.8 Flash (Antigravity)`) next to `PROXY_MODEL`; both register only when `proxyEnabled || explicitRoutes.hasProxy`, share the proxy base URL and the dedicated `ANTIGRAVITY_API_KEY` / `proxyApiKey` credential, and never touch Google / Vertex credentials.
  - Added `isProxyModel` / `proxyUpstreamBaseModel` / `resolveProxyUpstreamModel` as the single proxy-map; `gemini-3.8-flash-proxy` maps `low` / `medium` / `high` 1:1 to `gemini-3.8-flash-low` / `gemini-3.8-flash-medium` / `gemini-3.8-flash-high` across both GenerateContent and Interactions, while official Vertex AI and Gemini API routes keep `gemini-4-argon`.
  - Inspector shows **Antigravity Proxy** for both proxy model IDs. The 16 volatile settings are unchanged.

### Fixed
- **Cross-Model GenerateContent History Downgrade (`interactions-input.js`, `adapter.js`)**:
  - `generateContentHistory(options, model)` now also downgrades history when switching between `gemini-4-argon-proxy` and `gemini-3.8-flash-proxy` (or across providers) and the message carries `reasoning` / `tool-call` blocks: thought blocks are dropped, completed tool round-trips become explicit text, unfinished calls throw, and `replayState` is stripped. pi-ai no longer emits a signature-stripped native `functionCall` or an orphan `functionResponse` after a proxy-model switch, and old reasoning is no longer replayed as public prose. Same-model history keeps native signature replay; pure-text cross-model messages still fall through to the signature bridge.

## [1.6.2] - 2026-10-26

### Fixed
- **Interactions `2026-05-20` Lifecycle Events, Terminal Guards & `user_input` Replay (`interactions.js`, `interaction-lifecycle.js`, `inspector-service.js`)**:
  - Supported dedicated `2026-05-20` lifecycle events (`interaction.in_progress`, `interaction.requires_action`, `interaction.failed`, `interaction.cancelled`, `interaction.incomplete`, `interaction.budget_exceeded`) and `budget_exceeded` terminal mapping (`max-tokens`).
  - Finalized streams at EOF when `interaction.status_update` carries `failed`, `cancelled`, or `budget_exceeded`, enforced monotonic terminal-state guards against late non-terminal notices, ignored unknown `interaction.*` notices without cancelling paid cloud tasks, and safely skipped structural `user_input` steps during replay.
  - Normalized in-stream `error` event codes case-insensitively and prioritized `remote-error` over simultaneous local aborts so terminal provider errors never trigger redundant `/cancel` requests or leave `cancel-failed` locks.
- **Background Recovery Zombie-Lock Reconciliation & Conservative Error Probes (`interaction-state.js`)**:
  - Reconciled historical same-session `accepted` handles via a bounded non-streaming `GET` probe when the user submits a changed prompt: automatically dropped dead records (`failed`, `cancelled`, or HTTP `404`), retained un-replayed terminal handles (`completed`, `requires_action`, `incomplete`, `budget_exceeded`) for cold resume by their original `requestKey` while releasing session-wide exclusivity for the new prompt, and kept conservative blocks when the remote task is still `in_progress` / `queued` or the probe fails with non-404 errors.
  - Verified cloud state via a bounded non-streaming probe before dropping recovery handles on unrecoverable in-stream `error` frames, and hardened post-ID persistence retry on initial save failure.
- **Interactions `Retry-After` Backoff & First-Hop Input Watermark Window (`interaction-transport.js`, `interactions.js`, `interaction-adapter.js`)**:
  - Extracted `Retry-After` delays from non-2xx Interactions response headers without reading error bodies, failed fast above `60s`, and recorded reconnect `backoffDelayMs` on the subsequent `interaction-resume` hop.
  - Kept the first-hop input watermark window open across same-hop `function_call` steps and trailing `interaction.completed` / `interaction.requires_action` events until a second `model_output` step (64K hop boundary) begins; suppressed host `usage` chunks and kept `reportedInputTokens: null` whenever first-hop input tokens were never reported rather than leaking cumulative multi-hop inputs or fabricating `0`.
- **GenerateContent Watchdog Pseudo-Progress Hardening & Snake-Case Signature Replay (`generate-content.js`, `google-signatures.js`, `test/host-internals.mjs`)**:
  - Prevented empty heartbeat frames `{}`, empty thought frames `{ thought: true, text: '' }`, nameless `{ functionCall: {} }` parts, alternating empty frames, repeated `continuationToken` / `finishReason` values, and repeated `thoughtSignature` values (deduplicated per hop via a bounded 8,192-entry `seenSignatures` set) from renewing phase timeout budgets.
  - Supported snake_case `thought_signature` parts in `createGoogleSignatureBridge` and relaxed the `dshDesktopBoot` minifier identifier match in `test/host-internals.mjs` for `0.2.1-rc.3` compatibility.

## [1.6.1] - 2026-10-25

### Changed
- **1-to-1 Tiered Upstream Model Mapping on Antigravity Proxy (`adapter.js`, `interaction-adapter.js`)**:
  - Mapped `Gemini 4 Argon (Antigravity)` (`gemini-4-argon-proxy`) reasoning levels (`Low` / `Medium` / `High`) directly to the tiered upstream model IDs expected by `Antigravity Tools` (`gemini-4-argon-low`, `gemini-4-argon-medium`, `gemini-4-argon-high`) across both `GenerateContent` and `Interactions` while keeping official Vertex AI and Gemini API routes on `gemini-4-argon`.

## [1.6.0] - 2026-10-25

### Added
- **Antigravity Reverse Proxy 3rd Route & Direct Settings Configuration (`adapter.js`, `index.js`, `google-connection.js`, `interaction-adapter.js`, `client.js`)**:
  - Added independent `PROXY_MODEL = 'gemini-4-argon-proxy'` (`Gemini 4 Argon (Antigravity)`) under `google-vertex-argon` so local/remote Antigravity proxy endpoints can be used alongside official `providers.google` (`GOOGLE_API_KEY`) and `google-vertex` without credential collision.
  - Added `proxyEnabled`, `proxyBaseUrl` (default `http://127.0.0.1:8045/v1beta` with `normalizeProxyBaseUrl` root `/v1beta` completion and trailing-slash normalization), and `proxyApiKey` settings with a dedicated **Antigravity Proxy** settings card in `client.js` and strict credential isolation (`proxyApiKey` → `ANTIGRAVITY_API_KEY`).
- **Four-Stage Stream Resilience & Auto-Heal Inspired by Antigravity-Manager (`generate-content.js`)**:
  - **Structured Retry-Delay Parsing (`parseUpstreamRetryDelayMs`, `computeReconnectDelayMs`)**: Parsed `Retry-After` headers, Google error `details[].retryDelay` / `quotaResetDelay`, and natural-language retry hints with a `+200ms` safety buffer; failed fast when required cooldown exceeds `MAX_SERVER_RETRY_DELAY_MS` (`60s`).
  - **Phase-Aware Stream Watchdog**: Replaced flat 20-minute per-request waits with per-hop phase timeouts (`initial-ttft` `180s`, `thinking` `180s`, `transition` `180s` for large tool-call JSON buffering after thoughts, and `streaming` `120s` sliding timeout).
  - **Pre-Commit Initial Retry (`retry-initial`)**: Permitted bounded internal retries (`MAX_SAME_TOKEN_RETRIES = 3`) on Hop 1 before a 32K `continuationToken` is acquired whenever zero chunks have been yielded to the caller (`hopChunks === 0`).
  - **Thinking-Only Dropout Auto-Heal (`thinking-dropout-heal`)**: Detected turns that emit `thought: true` parts and terminate with `finishReason === 'STOP'` but zero visible text or tool calls, automatically triggering up to `MAX_THINKING_DROPOUT_HEALS = 1` continuation hop preserving signed thoughts.

### Changed & Removed
- **Streamlined Debug Inspector & Removal of Cost/Modality/Overview Aggregations (`diagnostics.js`, `diagnostic-store.js`, `inspector-service.js`, `inspector-tool.js`, `client.js`)**:
  - Removed `pricing.js`, `usage-details.js`, and `inspector-overview.js` along with the `getOverview` RPC and `argon_inspect` `overview` action.
  - Focused `Argon Inspector` (`Debug` & `Operations`) on per-request summary, basic token watermarks, 11-column step/hop trajectory table, paginated raw JSON response evidence, Cloud Interaction ID lookup, and global background recovery lock management while preserving backwards-compatible diagnostic storage reads.
- **Host Compatibility**:
  - Declared compatibility with `dsh` `0.2.1-rc.2 || 0.2.1-rc.3`.

## [1.5.3] - 2026-10-24

### Fixed
- **Pre-Checkpoint Real-Time Streaming & Fast-Fail Outer Retry Handoff (`generate-content.js`)**:
  - Streamed incoming `GenerateContent` SSE chunks in real time before the first 32,768-token `continuationToken` checkpoint is acquired (`!token`), eliminating buffering delay on thought summaries, text, and tool calls for `< 32K` turns when `longDecode` is enabled.
  - Surfaced pre-checkpoint stream drops and errors immediately to the DSH outer retry handler on the first hop instead of silently looping 4 internal hops without a checkpoint token, while preserving `pending` checkpoint buffering and internal `continuationToken` resume once a 32K+ checkpoint is active.
- **Inspector Usage Ledger, Cache Coverage & Hop Accounting (`usage-details.js`, `pricing.js`, `inspector-overview.js`, `client.js`, `generate-content.js`)**:
  - Added `selectGcUsageRows` to strip contiguous unanswered pre-progress `retry-original` hops when a subsequent hop completes, keeping cost and token completeness accurate across historical and multi-hop records.
  - Computed weighted cache-hit percentage across requests with complete valid cache/input counts and recorded `hopTracker.onChunk({ status: 200 })` before throwing on malformed or non-JSON SSE chunks.

## [1.5.2] - 2026-10-22

### Fixed
- **Usage Counter Normalization & Cost Estimation (`usage-details.js`, `pricing.js`, `inspector-overview.js`, `diagnostic-store.js`)**:
  - Resolved omitted optional zero usage counters (`cachedTokens`, `toolTokens`, `thoughtTokens`, and conserved zero `outputTokens` on tool-only `GenerateContent` turns) via `resolveUsageCounts` so completed turns with omitted zero counters no longer drop USD cost estimates to `null` or under-report `allComplete` scope totals, while preserving durable `invalidCounts` markers for malformed wire values.
- **Native Patch & Request Association Lifecycle (`adapter.js`, `index.js`, `generate-content.js`)**:
  - Updated `installGemini4PiAiPatch` and `ensureGemini4ApiClientPatch` to follow live `longDecode`, service-tier, and `retainRawResponses` settings on patched native providers and cleanly deactivate upon disposal without overwriting downstream wrappers.
  - Cleared `request-association` tracking state on plugin unload and guarded `continueArgonRequestStream` when `signal` is already aborted before the first stream attempt.
- **Offline Test Guard & Host Module Loader (`package.json`, `test/offline-guard.mjs`, `test/host-loader.mjs`, `test/host-internals.mjs`)**:
  - Enforced `--import ./test/offline-guard.mjs` in `npm test`, added IPv6 loopback bracket handling, and decoupled offline UI/SSR tests from checkout-only internals via verified read-only host bundle loading.

### Changed
- **Inspector & Client Rendering Performance (`inspector-overview.js`, `client.js`)**:
  - Computed `oldestAt` / `newestAt` overview bounds in a single pass and cached module-level `Intl.DateTimeFormat` / `Intl.NumberFormat` instances.

## [1.5.1] - 2026-10-19

### Changed
- **Performance Optimization (`client.js`, `diagnostic-store.js`, `interaction-state.js`, `response-store.js`)**:
  - Replaced the remaining 5 ISO 8601 timestamp `String.prototype.localeCompare()` sorts with direct lexicographical relational operators (`<` / `>`) across recovery lists, recent diagnostics, background task eviction, and raw response retention trimming.
  - Reused precomputed `sumParts` when available in `extractTokenMix` (`client.js`) to avoid redundant segment filtering and reduction.

## [1.5.0] - 2026-10-18

### Added
- **Argon Inspector Dashboard (Right-Sidebar, Conversation Tab & Per-Message Shortcut)**:
  - Added full-featured Inspector UI in `client.js` mounted in both the Right Sidebar (`Argon`) and Conversation View (`dsh-vertex-argon/inspector`), plus a per-message Argon header button that jumps directly to `Selected Answer` scope.
  - Added **Current Scope Overview** card (`inspector-overview.js`) summarizing request counts, outcomes, token totals, and estimated USD cost across `This Conversation`, `Selected Answer`, or `All Recent`.
  - Added **Request Association Hub** (`request-association.js`) correlating `llm/stream`, `agent/assistant-stream`, and `session/event` to bind diagnostics to exact finalized assistant `messageId` and `settlementSeq` values across `LlmRuntime` clones.
- **Per-Modality Usage Ledger & Public Cost Estimator (`usage-details.js`, `pricing.js`)**:
  - Normalized `GenerateContent` per-hop and `Interactions` aggregate usage into structured modality breakdowns (`TEXT`, `IMAGE`, `AUDIO`, `VIDEO`, `DOCUMENT`) across input, cache, output, thought, and tool tokens.
  - Added public token price snapshot (`argon-public-2026-10-18`) and USD cost estimation clearly labeled as non-invoice estimates.
- **Explicit Service Tiers & Vertex PayGo Routing (`service-level.js`)**:
  - Added `googleServiceTier`, `vertexServiceTier` (`standard`, `flex`, `priority`), and `vertexPaygoOnly` settings with fail-closed route × protocol capability validation (`ARGON_SERVICE_TIER_UNVERIFIED`) and observed response tier extraction.
- **Opt-In Raw Response Store & Cloud Interaction ID Lookup (`response-store.js`, `interaction-query.js`)**:
  - Added `retainRawResponses` setting and bounded `vertex_argon_responses` storage domain with header/secret sanitization and paged character reading.
  - Added read-only Cloud Interaction ID Lookup (`interactions.get(id)`) in the Inspector `Operations` tab and `argon_inspect` tool without mutating local recovery state or executing cloud tool calls.
- **Deferred Read-Only Agent Tool `argon_inspect` (`inspector-tool.js`)**:
  - Registered `argon_inspect` (`deferLoading: true`) supporting `overview`, `list`, `detail`, `response`, `query`, and `query-response` actions within the current session scope.
- **Signature-Only `Part` Lossless Replay (`google-signatures.js`)**:
  - Preserved opaque `thoughtSignature` / `thought_signature` fields on empty-content `Part` objects across `GenerateContent` and `Interactions` multi-turn replay and tool-call round-trips.

### Changed & Fixed
- **In-Band SSE Error Handling (`generate-content.js`)**:
  - Detected HTTP `200` SSE frames containing top-level `{ error }` payloads, recording the failure in hop diagnostics and retrying from the latest `continuationToken` only when the error status is retryable.
- **Live Long Decode Verification (Odyssey-VII 365-Day Captain's Log Benchmark)**:
  - Verified continuous single-turn `GenerateContent` Long Decode across **98,985 output tokens** (2 hops: `65,536` + `33,449` output tokens in `1,437.9s`, `0` reconnects) on `google-vertex/gemini-4-argon`.
- **Pre-Release Codebase & Package Cleanup**:
  - Removed retired/unmounted experimental modules (`generate-content-checkpoint.js`, `protocol-policy.js`, `management-policy.js`, `management-input.js`, `structured-result-command.js`) and their obsolete tests, keeping the low-level `structured-output.js` wire helper intact.
  - Regenerated `README.md` and `docs/implementation/` directly from the verified 1.5.0 codebase.

## [1.4.3] - 2026-10-18

### Fixed
- **Interactions Resumable Read Stream (`interactions.js`, `interaction-transport.js`)**:
  - Switched background recovery from non-streaming `GET` polling to resumable `interactions.get(id, { stream: true, last_event_id })` whenever an event cursor is available, preventing duplicate block emission on reconnect.

## [1.4.2] - 2026-10-17

### Fixed
- **Interactions Pre-Dispatch Intent & Unknown-Create Lock (`interaction-state.js`, `interactions.js`)**:
  - Recorded `phase: "creating"` before sending `interactions.create` and blocked automatic duplicate resubmission after an interrupted create request until explicitly released by the user.

## [1.4.1] - 2026-10-17

### Fixed
- **Credential Store Fail-Closed Boundary (`adapter.js`)**:
  - Ensured errors thrown by the DSH `credentials` service abort request preparation immediately rather than falling back to ambient environment variables.

## [1.4.0] - 2026-10-16

### Added
- **Dual-Protocol Architecture (`generate-content` & `interactions`)**:
  - Added full `Interactions` (`v1beta`) SSE & durable background task support alongside `GenerateContent` Long Decode (`v1beta1` / `v1`).
  - Added `vertex_argon_diagnostics` and `vertex_argon_interactions` storage domains and dedicated Settings UI.

## [1.3.0] - 2026-10-15

### Added
- Initial multi-hop `GenerateContent` Long Decode (`continuationToken`) and dual-route (`google-vertex` / `google-generative-ai`) adapter for `gemini-4-argon`.
