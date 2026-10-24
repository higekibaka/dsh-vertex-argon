# Changelog

All notable changes to `dsh-vertex-argon` are documented in this file.

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
