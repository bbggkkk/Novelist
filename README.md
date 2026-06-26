# Novelist MCP

AI agents can use this MCP server to run a resumable novel-writing pipeline.
The storage model is:

```text
data/
  franchises/{franchise_id}/
    world.md
    canon/
    works/{work_id}/
      work.md
      volumes/{volume_id}/
        outline.md
        state.json
        draft/
        chapters/{chapter_no}/beats/{beat_no}.md
```

## Tools

- `novel_health`: returns operational readiness and storage/job-store health without exposing sensitive paths or provider URLs.
- `novel_new_project`: creates a franchise/work/volume and returns an initial outline that requires user confirmation.
- `novel_confirm`: approves or revises a pending confirmation and resumes the pipeline; resolved confirmation IDs are one-time tokens and cannot be replayed.
  Repeated revision instructions replace the pending instruction instead of appending to the stored outline, and a stored
  pending instruction is reused when that same confirmation is later approved without a new instruction.
  Calls with `approved:false` must include a non-empty `revisionInstruction`.
- `novel_continue`: writes and reviews the next beat; identify a volume with all three IDs together or use the current pipeline with no IDs or `current:true`.
- `novel_status`: returns current progress, pending confirmations, and unresolved conflicts; identify a volume with all three IDs together or use the current pipeline with no IDs or `current:true`.
- `novel_revise`: reuses the write/edit/proofread/continuity loop for a target beat.
- `novel_build_epub`: builds a valid EPUB 3 archive for completed volumes.
- `novel_job_start`: runs a long mutating operation in the background.
- `novel_job_status`: returns background job status, result, or error.
- `novel_job_list`: lists background jobs, optionally filtered by status.
- `novel_job_cleanup`: deletes finished job snapshots older than the configured retention period.
- `novel_job_cancel`: requests cooperative cancellation for a queued or running background job.

## Development

```bash
npm ci
npm run build
npm test
npm run verify
npm start
```

## Installation

After publishing, the package exposes a `novelist-mcp` executable:

```bash
npm install -g novelist-mcp
novelist-mcp
```

`novelist-mcp --help` prints CLI usage, `novelist-mcp --version` prints the package version, and malformed
or unsupported arguments fail with one structured startup error on stderr instead of being ignored while the stdio server starts.
CLI arguments are bounded by both character count and UTF-8 bytes and reject control characters before unsupported-argument previews are formatted;
unsupported-argument previews are also truncated by both measures before startup errors are emitted.

For local development without a global install, use `npm start` after `npm run build`, or point your MCP
client at the built `dist/src/cli.js` file as shown below.
GitHub installs are supported through the reviewed `prepare` script, which builds `dist/src/cli.js` before
`npx` runs the `novelist-mcp` executable from a source checkout.
The package library entrypoint exports the MCP server, pipeline, storage, agents, `ExecutionDeadline`,
its timeout/cancellation error classes, validation helpers, EPUB helpers, `PACKAGE_NAME`, `PACKAGE_VERSION`,
and matching TypeScript declarations.

The implementation intentionally uses a provider-agnostic agent interface. The default `StubNovelAgents`
class produces deterministic local output for tests and development. Replace that class with a real LLM
adapter when connecting the planner, worldbuilder, writer, editor, proofreader, and continuity otaku
roles to model calls. EPUB packaging is deterministic local code and does not require a model call.

To use an OpenAI-compatible chat completions endpoint instead of the local stub:

```bash
NOVELIST_AGENT_PROVIDER=openai \
NOVELIST_OPENAI_API_KEY=... \
NOVELIST_OPENAI_MODEL=gpt-4.1-mini \
npm start
```

Use `NOVELIST_OPENAI_BASE_URL` for compatible gateways and `NOVELIST_OPENAI_TIMEOUT_MS` to tune request timeouts.
Model request timeouts and retry sleeps share one `NOVELIST_OPERATION_TIMEOUT_MS` deadline, so an upstream
call sequence cannot outlive the configured operation deadline.
Remote OpenAI-compatible gateways must use HTTPS; plain HTTP is accepted only for localhost or loopback development endpoints.
The raw and normalized base URL are capped at 2048 characters and must not include URL credentials, query strings, or fragments.
The exported `createNovelAgents` factory rejects invalid direct provider config instead of falling back to the stub,
requires a plain supported-field config object, reads `agentProvider` through a descriptor check, reports unreadable
reflection metadata as bounded config errors, and snapshots provider selection before returning agents.
The exported `OpenAiNovelAgents` adapter revalidates direct config objects with the same supported-field
surface, descriptor checks, unreadable-reflection handling, and character/UTF-8-byte bounds, snapshots the validated OpenAI settings before requests, and validates
injected fetch/sleep implementations before making requests. Exact native `Response` objects are accepted with
their bound `text()` method only after their core response fields are not instance-overridden and their status is confirmed to be a normal HTTP status code; custom response objects returned by injected fetch implementations must expose
`ok`, `status`, and `text` as enumerable data fields/functions before the adapter reads them, so
accessor-shaped custom response objects and subclassed native responses are rejected without invoking getters.
Unreadable native/custom response metadata and response-header metadata is reported as bounded validation
errors instead of raw provider trap messages, and native `Headers.get("content-type")` failures are wrapped
before they can expose provider credentials.
OpenAI prompt context snapshots also report unreadable object or array reflection metadata as bounded
serialization errors before any request is sent.
Successful responses that provide `content-type` headers must report `application/json` or a `+json`
media type before the adapter reads and parses the body; custom response headers are capped at 100 entries,
with header names and content-type values bounded by both character count and UTF-8 bytes.
Successful OpenAI-compatible response bodies are capped at 8 MiB, reject duplicate JSON object keys before
semantic parsing, and validate nested response metadata such as `usage`, `finish_reason`, `logprobs`,
`refusal`, and `annotations` through descriptor-checked snapshots. Unreadable reflection metadata in nested
response arrays, usage details, or annotations is reported as bounded validation errors before
`choices[0].message.content` is accepted as manuscript text.
Transient model API failures such as `429`, `5xx`, request timeouts, and fetch network failures are
retried with exponential backoff.
Each OpenAI-compatible retry delay is capped by the remaining operation time and 60000 ms.
Model API error bodies are validated as strings and capped by both character count and UTF-8 bytes before formatting; error bodies and fetch/network error messages are truncated by both measures, error names are read through guarded metadata helpers, accepted only within small character/UTF-8-byte bounds, normalize non-printing control
characters including newlines and tabs, and redact configured
OpenAI settings plus inline bearer-token, OpenAI-style key, and common key-value secrets such as
`api_key=...`, `x-api-key: ...`, `access_token=...`, `refresh_token=...`, `password=...`, and
`secret=...` before being surfaced in job errors or logs,
so large or sensitive upstream HTML/JSON failures do not bloat or leak through persisted job snapshots.
OpenAI-compatible request bodies are capped at 1048576 characters and 2097152 UTF-8 bytes and must be
JSON-serializable before fetch is called, so oversized accumulated context fails locally with a clear error. Request bodies are
serialized from validated data-only snapshots, so inherited `toJSON` hooks cannot rewrite model prompts.
OpenAI-compatible response bodies are similarly capped before JSON parsing by both character count and
UTF-8 bytes, and returned assistant content is bounded by both measures before it can enter the pipeline.
Prompt context passed into OpenAI-compatible requests is validated as lossless JSON-compatible data before
serialization: sparse arrays, non-finite numbers, unsafe integers, BigInt/function/symbol values, circular references,
class instances, symbol properties, and non-enumerable or accessor properties are rejected locally.
Undefined object fields and undefined array items are rejected instead of being silently omitted or coerced,
so prompt context cannot lose fields before it reaches the provider. Prompt context strings and object keys
are bounded by both character count and UTF-8 bytes before request-body serialization. Array items are read through
enumerable data descriptors, object keys are snapshotted once before descriptor reads, and prototype-like object keys such as `__proto__` are preserved as ordinary JSON fields
instead of mutating the normalized prompt object's prototype.
Successful model response bodies must be strings and are capped before JSON parsing as well, direct parser role labels are
bounded printable strings by both character count and UTF-8 bytes, and response `choices` arrays above 16 entries are rejected before the first choice is used. Parsed response objects are read through
enumerable data properties, require assistant messages when a role is provided, and reject non-null `refusal`
fields instead of treating refusal payloads as usable draft text, so accessor-shaped `choices`, `message`, or
`content` fields are rejected without invoking getters.
For proofreader and continuity roles, OpenAI-compatible responses that use `ISSUE:` lines are converted
to review issues with non-printing control-character rejection, a 100-item cap, and 4000-character/4000-UTF-8-byte caps per issue before pipeline validation;
when more than 100 issue lines are returned, the last retained issue records how many were omitted.
The exported issue-prefixed parser also validates direct runtime inputs and caps source text by both character count and UTF-8 bytes before
splitting lines, without invoking accessor properties; unreadable result or issue-array reflection metadata
is reported as bounded validation errors.

## Operations

Environment variables:

- `NOVELIST_DATA_DIR`: absolute path for storing manuscripts somewhere other than `./data`; capped at 4096 characters, rejected when it contains control characters, and cannot be the filesystem root.
- `NOVELIST_LOCK_TIMEOUT_MS`: maximum time to wait for a per-volume file lock. Default: `5000`.
- `NOVELIST_LOCK_RETRY_MS`: retry interval while waiting for a lock. Default: `50`.
- `NOVELIST_LOCK_STALE_MS`: age after which an abandoned lock can be reclaimed. Default: `600000`.
- `NOVELIST_LOG_LEVEL`: `debug`, `info`, `warn`, `error`, or `silent`. Default: `warn`.
- `NOVELIST_OPERATION_TIMEOUT_MS`: deadline for one MCP pipeline operation. Default: `300000`.
- `NOVELIST_REVIEW_MAX_RETRIES`: retry count before repeated review issues require user confirmation. Default: `2`.
- `NOVELIST_JOB_RETENTION_MS`: retention period for finished background job snapshots. Default: `604800000`.
- `NOVELIST_MAX_CONCURRENT_JOBS`: maximum background jobs that may run at once. Default: `4`.
- `NOVELIST_MAX_JOBS`: maximum total in-memory background jobs retained before cleanup is required. Default: `1024`.
- `NOVELIST_STDIO_MAX_LINE_LENGTH`: maximum characters accepted for one stdio JSON-RPC line. Default: `1048576`.
- `NOVELIST_AGENT_PROVIDER`: `stub` or `openai`. Default: `stub`.
- `NOVELIST_OPENAI_API_KEY`: required when `NOVELIST_AGENT_PROVIDER=openai`; capped at 4096 characters and cannot contain control characters or whitespace.
- `NOVELIST_OPENAI_BASE_URL`: OpenAI-compatible API base URL. Default: `https://api.openai.com/v1`.
  Remote URLs must use HTTPS; HTTP is allowed only for localhost or loopback hosts. The URL is capped at
  2048 characters before and after URL normalization, and must not include control characters, credentials,
  query strings, or fragments.
- `NOVELIST_OPENAI_MODEL`: model name for OpenAI-compatible calls. Default: `gpt-4.1-mini`; capped at 200 characters and cannot contain control characters or whitespace.
- `NOVELIST_OPENAI_TIMEOUT_MS`: request timeout for model calls. Default: `60000`.
- `NOVELIST_OPENAI_MAX_RETRIES`: retry count for transient model API failures. Default: `2`.
- `NOVELIST_OPENAI_RETRY_BASE_MS`: base delay for exponential retry backoff. Default: `250`.
- `NOVELIST_EPUBCHECK_COMMAND`: optional external EPUB validator executable, such as `java`. Use a PATH command name containing only letters, numbers, dot, underscore, or hyphen, or an absolute executable path; put arguments in `NOVELIST_EPUBCHECK_ARGS`.
- `NOVELIST_EPUBCHECK_ARGS`: whitespace-separated validator args or a JSON string array when args contain spaces. Use exactly one `{epub}` for the generated file path. Default: `{epub}`. The raw value is capped before parsing, JSON array entries must be non-empty and cannot have leading or trailing whitespace, and explicit args require `NOVELIST_EPUBCHECK_COMMAND`.

Numeric settings are bounded: duration values are capped at 30 days, retry counts at `20`,
`NOVELIST_MAX_CONCURRENT_JOBS` at `64`, `NOVELIST_MAX_JOBS` at `100000`, and
`NOVELIST_STDIO_MAX_LINE_LENGTH` from `256` through `16777216`. Numeric values must be decimal integer
strings of at most 32 raw digits, not exponent or hexadecimal notation; the background job manager enforces
the same concurrency, retention, and total-job bounds even when constructed directly, and direct
`NovelStorage` config objects enforce the same lock duration and job snapshot count bounds. They must be
plain data objects using supported `AppConfig` fields only, so accessor, non-enumerable, symbol, and
unsupported fields are rejected without invoking getters, and unreadable reflection metadata is reported
as bounded config errors. Exported
Shared validation helpers normalize expected object shapes through descriptor-checked data snapshots before
checking supported fields and types.
`NovelPipeline` instances require direct config to be a plain data object using supported `AppConfig` fields,
report unreadable reflection metadata as bounded config errors, snapshot it at construction, and validate operation deadlines, review retries, job bounds,
stdio bounds, provider selection, OpenAI health strings with character/UTF-8-byte bounds, and external EPUB validator command/argument
settings before any operation runs. Direct EPUB validator args require a configured command unless they are
the default `{epub}` placeholder. Exported
direct pipeline and background-job tool arguments reject multibyte titles, options, and revision instructions
against the same UTF-8-byte budgets used by persisted state before any state files are written. Exported
`ExecutionDeadline` instances also reject non-integer, zero, negative, or over-30-day timeout values and
malformed direct cancellation signals; `isCancelled` must be an enumerable own data function, and unreadable
signal reflection metadata is reported as bounded validation errors. Direct
operation labels are bounded printable strings capped at 256 characters and 512 UTF-8 bytes before they
are included in timeout/cancellation errors. When a
sub-operation needs a positive remaining budget, exhausted deadlines surface as operation timeouts rather
than downstream validator configuration errors.
Direct `NovelPipeline`, `McpServer`, and `JobManager` constructors validate injected agent, pipeline,
logger, and storage method surfaces with descriptor checks before starting recovery, queue work, or novel
operations, and report unreadable injected-object reflection metadata as bounded validation errors. When an `McpServer` is constructed with storage but without a pipeline, its default pipeline
and background job store share that injected storage.
Injected storage roots must be enumerable non-empty absolute paths capped at 4096 characters and 4096 UTF-8 bytes without control characters and must not
resolve to the filesystem root before they are used for persistence or error redaction.
Direct `Logger` instances reject unknown log levels before any log filtering occurs.
Logger metadata and final JSON entries are copied through safe own-key/property-descriptor snapshots, so
accessors, symbol properties, unreadable reflection metadata, and polluted prototypes cannot rewrite log output.
Enum-like settings ignore surrounding whitespace, and `NOVELIST_OPENAI_MODEL` is trimmed, capped at
200 characters and 200 UTF-8 bytes, and rejected when it contains control characters or whitespace.
Configuration names and values are bounded by both character count and UTF-8 bytes: numeric and enum-like
raw environment values are capped at 1024 characters/bytes before trimming, while path, OpenAI, and
external-validator command values have small raw padding caps above their post-trim limits. Post-trim
path, OpenAI, and external-validator argument values also enforce UTF-8 byte caps matching their published
character caps. This prevents oversized whitespace-only or multibyte environment values from causing
unbounded startup work or passing a character-only limit before reaching downstream APIs.
Programmatic `loadConfig(env)` calls require a non-array environment object, read only enumerable data
properties for known environment names, and reject accessor, non-enumerable, or non-string values without
invoking getters. Unreadable environment prototypes, key lists, or property descriptors are reported as
bounded configuration errors instead of leaking proxy trap failures.
User-provided title fields are capped at 512 characters, option fields at 256 characters, and revision
instructions at 16384 characters; non-printing control characters are rejected before requests reach
state files, Markdown output, or model prompts. Title, option, and revision-target selector fields must
be single-line strings, while free-form revision instructions may contain tabs or line breaks. MCP schemas
also require at least one non-whitespace character for these fields, matching runtime validation, and
the `novel_revise.target` schema and runtime validation accept only the supported selectors
`chapter:<n>,beat:<n>`, `chapter:<n> beat:<n>`, `<chapter>-<beat>`, and `<chapter>/<beat>`.
Safe ID fields such as franchise, work, volume, confirmation, and job IDs reject leading or trailing
whitespace instead of trimming it before filesystem or snapshot lookup.
The JSON-RPC request envelope also rejects non-printing control characters in nested string values while
still allowing tabs and line breaks for fields that explicitly support multiline text.
The `novel_continue`, `novel_status`, and async `novel_continue` job schemas explicitly advertise both
current-volume fallback forms as distinct schema branches: omitted arguments or `current:true`.
Safe-ID schema descriptions note the runtime 120 UTF-8 byte cap.
Direct pipeline and job API argument objects must be plain enumerable data objects; class instances,
symbol properties, non-enumerable properties, and accessor properties are rejected without invoking getters.
Shared exported string validation helpers also cap UTF-8 payload size at 1 MiB even when a larger character
limit is requested, so direct embedders cannot pass multi-byte text that is character-bounded but byte-unbounded.
Shared object validation helpers cap direct object field names by both character count and UTF-8 bytes
before reading field descriptors and report unreadable object reflection metadata as bounded validation errors.
Persisted state string fields are also bounded on load: title fields are capped at 512 characters,
confirmation and feedback text at 262144 characters, revision instructions at 16384 characters, and
conflict text fields at 4000 characters.
Persisted state numeric fields are bounded too: beat target words are capped at 1000000, chapter target
words at 200000000, and beat retry counts at 1000.
Persisted state arrays are bounded as well: at most 200 chapters, 200 beats per chapter, 5000 total
beats, 1000 confirmation records, and 1000 conflict records can be loaded from one volume state file.
Runtime confirmation and conflict appends stop at those stored-record limits instead of rewriting an oversized
state file.
State objects passed directly to `saveState` must be plain enumerable data objects and dense data arrays;
class instances, symbol properties, non-enumerable properties, accessor properties, and sparse/accessor array
items are rejected without invoking getters. State array objects may contain only canonical array-index data
properties and `length`; known-field checks also use guarded descriptor reads, so extra string or symbol
fields are rejected without switching to prototype-sensitive enumeration.
Unreadable state object or array reflection metadata is reported as bounded validation errors instead of
leaking raw runtime trap messages.

Mutating operations are serialized per volume with hashed filesystem locks under `data/.locks`, so concurrent
MCP calls do not write the same `state.json` or beat file out of order. Stale lock directories and stale
lock files are reclaimed after `NOVELIST_LOCK_STALE_MS` instead of blocking forever, and lock owner files
are size-capped before parsing during release. Lock owner metadata is restricted to enumerable `token` and
`updatedAt` fields through guarded descriptor checks, written from data-only JSON snapshots, and `updatedAt` must be a canonical UTC timestamp when present. Lock heartbeats refresh only the originally acquired lock
directory and matching owner token, and release checks the same directory identity before unlinking, so a
paused operation cannot overwrite or remove a newer reclaimed lock owner. Lock acquisition also rechecks
the lock directory identity after writing the owner file, so a directory replacement during owner
initialization cannot let work run without owning the original lock.
Direct volume lock calls reject non-function operations before creating lock directories.
File writes create same-directory temporary files with exclusive creation, sync written temporary content,
use atomic rename, and then sync the parent directory metadata where the platform supports directory sync;
custom temporary paths must remain distinct from the target and in the target directory. If temp file writing,
syncing, closing, validation, or final rename fails after a temp file was created, that temp file is removed
so failed attempts do not accumulate orphaned artifacts. Direct atomic write calls reject malformed paths
including control-character or over-8192-character paths, and non-string/non-`Uint8Array` content before
creating temporary files. Unreadable `Uint8Array` prototype, byte length, or snapshot metadata is reported as
bounded validation errors before temporary-file creation. String byte limits are counted up to the configured cap instead of first
materializing a full encoded copy, so multibyte oversized direct writes fail before temporary-file creation
without an extra large UTF-8 allocation.
Atomic writes that require an already-existing parent directory also verify that exact parent realpath before
creating the temporary file.
New project creation removes the initial `outline.md` again if the subsequent authoritative `state.json`
publish fails, so failed creates do not leave a visible draft without a loadable volume state.
Storage reads, writes, lock paths, generated directory creation, and job directory scans verify real filesystem
paths stay inside `NOVELIST_DATA_DIR`, so symlinked directories or files cannot redirect artifacts outside the data root.
Project directory scans for franchises, works, and volumes stop with a clear error once a level contains
more than 1000 safe child directories, preventing a noisy data directory from forcing unbounded confirmation
lookups. Directory scan entries that disappear during a scan are ignored, but other filesystem errors are
reported instead of being silently skipped.
Direct `NovelStorage` construction applies the same explicit storage-root policy as `NOVELIST_DATA_DIR`:
non-empty absolute paths only, capped by both character count and UTF-8 bytes, no control characters, and no filesystem root.
JSON metadata files such as `state.json`, `current.json`, and persisted job snapshots are capped at 2 MiB
before writing or parsing, and bounded reads pull at most the configured cap plus one byte from disk, so
the server does not create metadata it cannot later read; unreadable or
oversized primary state/current files can still recover from a valid backup, while oversized job snapshots
are quarantined during recovery.
Storage errno classification reads `code` through guarded descriptors and prototype traversal, so filesystem
error handling does not invoke accessor-shaped error metadata.
JSON metadata writes serialize a descriptor-validated, data-only snapshot rather than the caller's original
object graph, with object keys bounded by both characters and UTF-8 bytes, so inherited `toJSON` hooks or
later prototype pollution cannot alter the bytes written. Unreadable reflection metadata on JSON write
inputs and state save metadata snapshots is reported as bounded validation errors before writing, and
metadata known-field checks reuse guarded descriptor reads instead of generic object enumeration.
Markdown frontmatter writes are also bounded to 20 fields and 64 KiB by both character count and UTF-8 bytes before the file is created, reject
control characters in string values and unsafe integers in numeric values, require plain enumerable data properties, and enforce
field-count limits while descriptor-checking metadata, so symbol, non-enumerable, accessor, non-plain-object, and unreadable-reflection metadata are rejected before any getter can run or raw trap message can leak. These write limits
match the beat frontmatter limits enforced when EPUB builds read draft files. Beat frontmatter reads also
preserve special keys such as `__proto__` as ordinary fields, so unsupported metadata cannot hide by
mutating the parser object's prototype.
Storage text reads reject symbolic links before opening files, detect path swaps between metadata checks and
open file handles, and require valid UTF-8, so corrupted metadata or Markdown bytes fail explicitly instead
of being loaded with replacement characters.
State and current-pointer recovery treats parsed-but-invalid JSON metadata, such as escaped control
characters in string values or metadata values that exceed global JSON bounds, as recoverable primary
metadata corruption when a valid backup exists.
Generated Markdown artifacts must have string body text capped before trimming, must have non-empty trimmed
body text, and are capped before writing at the same 10 MiB limit used when reading beat and world files,
so oversized or empty drafts cannot later break collection or EPUB builds.
Direct Markdown overwrite helpers for world, work, outline, and beat files enforce the same read/write
byte caps before creating temporary files, so operator-driven replacements cannot leave artifacts the
server later refuses to read.
Project IDs are deterministic bounded slugs; long safe titles are shortened with a stable hash suffix,
and titles that contain no safe slug characters fall back to a stable SHA-256-derived `item-...` ID so
duplicate requests still resolve to the same volume identity. The exported `slugify` helper rejects
non-string inputs and strings over 16384 characters before hashing. Directly supplied IDs are capped at
120 UTF-8 bytes before filesystem paths are touched. The exported `exists` helper rejects malformed direct
path inputs instead of silently treating them as missing files.
The stdio transport also processes newline-delimited JSON-RPC requests sequentially and flushes a final
trailing request on EOF, which keeps responses ordered for clients that write multiple requests at once.
The CLI explicitly resumes stdin after installing handlers, so MCP clients can spawn the process first and
send requests afterward without the server exiting before the first message arrives.
When stdio shutdown begins, the server removes its stdin and signal listeners and clears the keepalive
timer after draining accepted requests, so direct embeddings or test harnesses do not accumulate stale
process listeners after EOF or signal-triggered teardown.
If startup configuration fails before stdio is ready, the CLI writes one bounded JSON error line to stderr
with `event: "novelist_startup_failed"`, normalizes non-printing control characters, redacts inline
bearer-token/OpenAI-style secrets, serializes the error entry from a data-only snapshot so inherited `toJSON`
hooks cannot rewrite startup stderr, caps the error by both characters and UTF-8 bytes, and exits non-zero.
CLI stdout/stderr writes are best-effort, so a closed stdio stream cannot turn startup failure reporting into
a second uncaught exception; direct calls also ignore invalid writer/fd/data inputs and cap emitted text at
64 KiB by both characters and UTF-8 bytes.
Each stdio JSON-RPC input or output line is capped by `NOVELIST_STDIO_MAX_LINE_LENGTH` in both characters
and UTF-8 bytes; overlong inputs return a parse error and are discarded until the next newline, while
overlong responses are replaced with a bounded JSON-RPC error.
If preserving a maximum-size request id would exceed the line cap, the bounded transport error uses `id:null`.
The exported `StdioLineProcessor` constructor enforces the same 256 to 16777216 character/byte line-length
range for direct library embeddings and rejects malformed handler, writer, or closed plain-data options
objects before processing input. Accessor, symbol, and unsupported option fields are rejected before
reading `maxLineLength`, and unreadable option reflection metadata is reported as bounded validation errors.
Direct `push()` calls also reject non-string chunks before touching the input buffer.
Direct MCP JSON-RPC error messages are also truncated by both characters and UTF-8 bytes with byte-overflow counts in truncation markers, normalize non-printing
control characters, and redact inline bearer-token/OpenAI-style secrets before logging or returning to clients. JSON-RPC response validation
rejects `error.data` payloads so internal structured diagnostics are not accidentally exposed over stdio.
Validated JSON-RPC response snapshots are serialized instead of handler-returned object graphs, so inherited
`toJSON` hooks cannot rewrite stdio responses after validation. The nested tool-result JSON string returned
inside `tools/call` content is serialized from the same kind of validated snapshot. Tool-result messages
and nested string data are also capped at 32768 UTF-8 bytes, so multi-byte output cannot exceed the
intended transport budget while staying under a character-count limit.
Background job result snapshot size checks also serialize null-prototype data snapshots, so inherited
`toJSON` hooks cannot rewrite or shrink successful results before persistence, and unreadable result
reflection metadata is reported as bounded validation errors instead of raw trap messages.
JSON-RPC request IDs are accepted only when they are `null`, safe integers, or strings up to 256
characters and 256 UTF-8 bytes without control characters; invalid IDs are answered as `null` instead of being echoed.
Unsupported batch arrays and other non-object top-level JSON-RPC values also receive a bounded `id:null`
error instead of being silently treated as notifications.
Raw JSON-RPC request objects with duplicate keys at any object level are rejected as parse errors before
dispatch, including escaped-equivalent keys such as `"method"` and `"\u006dethod"`; this pre-parse scan
uses the same 32-level nesting cap as request validation.
JSON-RPC method names and `tools/call.params.name` values are capped at 128 characters and 128 UTF-8 bytes and reject control characters or leading/trailing whitespace.
Parsed JSON-RPC request objects are also bounded to 32 nesting levels, 100 fields per object, 256 characters
and 512 UTF-8 bytes per object key, no control characters in object keys, 1000 items per
array, 10000 total JSON values, and 16384 characters per string. Circular direct API inputs, `undefined`
fields, non-finite numbers, unsafe integers, sparse arrays, non-plain objects, symbol properties, non-enumerable or accessor
object properties, non-enumerable or accessor array items, non-index array properties, and other non-JSON-compatible values are rejected
through guarded descriptor checks before request/response known-field validation runs.
without invoking getters; unreadable request/response reflection metadata is reported as bounded validation errors instead of raw trap messages. Error logging and response id selection also inspect only enumerable data
properties through guarded descriptors, so malformed or unreadable top-level `id` or `method` metadata is not invoked after validation fails.
Repeated shared references that are not circular are accepted and serialize as repeated JSON objects.
`tools/list` returns schema copies from descriptor-validated snapshots, so polluted inherited `toJSON`
hooks cannot rewrite advertised tool schemas.
Direct MCP tool responses must have a supported status, a bounded printable message, JSON-compatible
`data` values with no circular references, `undefined`, non-finite numbers, unsafe integers, functions, symbols, or BigInt,
bounded per-string values, and serialize to bounded character and UTF-8 byte JSON before they are returned to clients. Tool result objects and nested `data`
objects must be plain enumerable data objects; object field counts and key bounds are enforced during
descriptor-entry checks, including UTF-8 byte bounds for object keys; symbol, non-enumerable, and accessor properties are rejected
without invoking getters, unreadable reflection metadata is reported as bounded validation errors, array items are descriptor-checked the same way, and validated tool results are
sanitized and returned as canonical plain JSON values through guarded descriptor checks. Prototype-like keys such as `__proto__` are preserved as ordinary
data fields during validation, so they cannot hide from supported-field checks or mutate result prototypes.
Repeated shared references that are not circular serialize as repeated JSON
objects. Direct responses and background job
snapshots share the same tool-result status, message, and JSON-compatible data validation. Direct
tool-result validator calls also bound their diagnostic label and message-length limit before using them
in validation errors. Shared exported validation helpers similarly reject malformed diagnostic labels,
including multiline labels, length bounds, revision target selectors, and shape definitions without invoking
accessor properties. The shared JSON preflight helper also validates direct-call labels, caps those labels
by both character count and UTF-8 bytes, and checks depth bounds before using them in duplicate-key or
nesting diagnostics.
Direct pipeline agent results are bounded by both character count and UTF-8 bytes before any state or
artifact write, so a multibyte provider response cannot pass character validation and then exceed downstream
storage or response budgets.
Storage JSON metadata writes apply the same loss-prevention policy before serialization: circular
references, `undefined`, non-finite numbers, unsafe integers, functions, symbols, sparse arrays, non-plain objects, unsafe
object keys including oversized multibyte keys, accessor or non-enumerable object properties, accessor or non-enumerable array items, and
excessive depth or collection size are rejected before any file is created or replaced. JSON metadata values
are capped at 64 nesting levels, 1000 object fields, 10000 array items, and 100000 total JSON nodes. Repeated shared
references that are not circular are serialized as repeated JSON objects. JSON metadata reads report corrupt
JSON, invalid UTF-8, raw non-printing control characters, and parsed metadata bound violations with the
affected path before backup recovery, quarantine, or root-redaction handling continues. JSON metadata and
lock owner reads also reject duplicate object keys before parsing, including escaped-equivalent keys, while
applying the same 64-level nesting cap during that pre-parse scan.
Direct atomic storage writes also cap string and binary payloads at 64 MiB before creating a temporary file.
If writing a stdio response throws because the output stream is temporarily unavailable, the request
processor suppresses that write failure and continues draining later requests instead of leaving the
stdio queue permanently rejected.
MCP tool results are validated, redacted, and snapshotted again immediately before client serialization,
so response redaction does not rely on mutable result objects, inherited `toJSON`, or array prototype methods.
Structured log metadata is sanitized before JSON serialization, including circular references and BigInt values;
`undefined`, function, symbol, and non-finite numeric metadata values are preserved as explicit sanitized
markers instead of disappearing from JSON output or being coerced to `null`;
non-printing control characters in log messages, string values, and metadata keys are normalized, oversized
metadata keys are truncated, and large strings, arrays, objects, and deeply nested values
are truncated to keep stderr output bounded by both character count and UTF-8 bytes. Metadata sanitization does not invoke object or array accessors;
symbol, non-enumerable, accessor, and sparse array entries are represented as bounded markers instead of
leaking hidden values or throwing from the logger. Prototype-like keys such as `__proto__` are preserved as
ordinary log fields instead of mutating sanitized metadata prototypes, and metadata cannot override core
`ts`, `level`, or `message` log fields. Final log entries and sanitized arrays are serialized from data-only
snapshots, so inherited `toJSON` hooks cannot rewrite stderr JSON. If stderr writes fail, logging remains best-effort and
does not throw back into the request path.
Valid JSON-RPC notifications without `id` are executed without emitting responses, matching JSON-RPC semantics.

`novel_health` performs a real storage write probe, reports persisted job-store readability, current pointer
readability including whether the pointed current state can be loaded, normal job snapshot count, quarantined job snapshot count, and agent provider readiness. It returns
`status: "blocked"` when the configured data directory cannot be written or the selected provider is
not ready, so supervisors can distinguish configuration or filesystem failures from a healthy idle server.
Health payloads do not expose the absolute data directory or OpenAI-compatible base URL; the storage root
is represented by a short stable hash, and storage errors redact the root path as `<data-root>`.
Injected storage health-check payloads are normalized through enumerable data properties before being
returned, with boolean/count fields type-checked and long error strings truncated; the configured storage
root, not the returned payload's root field, is used for hashing and path redaction. Unreadable health
payload reflection metadata is reported as bounded validation errors instead of raw storage trap messages.
Direct public pipeline errors and pipeline cleanup errors also redact that storage root before surfacing
storage or combined operation/cleanup failures.
Storage-layer error strings also redact inline bearer-token/OpenAI-style secrets and common key-value
secrets such as API keys, access tokens, passwords, and generic `secret=` values before they are placed
in health, quarantine, or metadata error payloads.
OAuth-style `client_secret=` values are covered by the same inline redaction path.
The exported inline redaction helper also coerces direct runtime inputs to strings, absorbs failed string
coercion as a placeholder, caps direct input and returned text by both character count and UTF-8 bytes
before applying patterns, so library callers cannot force unbounded redaction work with a single value.
Shared error-formatting paths call this helper before non-Error values are stringified, so unstringifiable
thrown values cannot bypass normal error handling.
Current pointer read failures are reported with a redacted `currentPointerError` but do not by themselves
block health, because per-volume `state.json` files are the authoritative source and explicit IDs can still
be used while the shortcut pointer is repaired.
If persisted job recovery fails during MCP startup, other tools are blocked but `novel_health` remains
available and includes the startup recovery error in its payload, with the data root and inline secrets
redacted when they appear in the error text. The health tool result is validated before startup status is
merged through safe descriptor snapshots, so accessor-backed injected pipeline results cannot run getters
on the recovery-failure path.
The OpenAI provider can still be constructed without an API key so `novel_health` remains available;
actual model calls fail clearly until `NOVELIST_OPENAI_API_KEY` is configured.

Long mutating tools can be started through `novel_job_start` and inspected with `novel_job_status`
or `novel_job_list`.
`novel_job_start` applies the same bounded, single-line, and safe-id argument validation as direct tool
calls before a job is queued, so malformed work does not occupy queue capacity only to fail at runtime.
Async job tool names and job-list status filters also reject control characters and leading/trailing
whitespace before enum matching, matching the JSON-RPC method and tool-name boundary.
Validated background-job arguments are snapshotted when the job is queued, so later caller-side mutation
of the original argument object cannot change queued work before it starts; job argument and persisted-job
known-field checks also use guarded descriptor reads rather than generic object enumeration.
`novel_job_list` is paginated with optional `limit` and `offset` arguments; it returns at most 100 jobs
by default and allows up to 1000 per call, while reporting the total number of matching jobs plus
server-computed `hasMore` and `nextOffset` pagination fields. Job list ordering is deterministic across
restarts: newest `createdAt` first, with `jobId` as a stable tie breaker.
List items omit `result`, `error`, and `persistenceError` payloads and expose `hasError` and
`hasPersistenceError` flags plus a `persistencePending` flag; use `novel_job_status` for one job when
full details are needed. Direct job status, list, and cancel calls reject accessor-shaped argument objects
without invoking getters.
`novel_status` and pending `novel_continue` responses report total pending confirmation/conflict counts
plus `pendingConfirmationHasMore` and `unresolvedConflictHasMore` flags, but include only the first 20
pending confirmations and first 20 unresolved conflicts, each with text inline-secret-redacted and truncated
to 1000 characters, so a large or sensitive state file cannot produce an oversized or token-leaking status response.
Background jobs above `NOVELIST_MAX_CONCURRENT_JOBS` stay `queued` until a running job finishes.
New background jobs are rejected once `NOVELIST_MAX_JOBS` retained jobs exist; job directory scans also
reject more safe snapshot files than that configured limit before loading them into memory, and health
checks apply the same limit to quarantined snapshot counts. Use
`novel_job_cleanup` or raise the configured limit after reviewing memory capacity.
Persisted job recovery also stops loading snapshots once `NOVELIST_MAX_JOBS` is reached and reports the
skipped snapshots in the startup recovery result, preventing an oversized job directory from being loaded
fully into memory during restart.
Injected storage `listJobIds()` results must be standard enumerable data arrays, and unreadable reflection
metadata is reported as bounded validation errors instead of raw storage trap messages.
Injected storage quarantine cleanup failure samples are validated the same way before being returned from
`novel_job_cleanup`, so unreadable failure-array reflection metadata cannot leak raw storage trap messages.
Legacy persisted job snapshots that still contain tool arguments are revalidated against the same
tool-specific schemas used when starting new jobs; invalid snapshots are quarantined instead of loaded.
Persisted job `toolName` and `status` enum fields are likewise rejected when they contain leading/trailing
whitespace, so manually edited snapshots cannot be normalized into valid work during recovery.
Recovered legacy `error` and `persistenceError` fields are redacted again before they become observable
through job status responses, so older snapshots cannot leak secrets that predate current redaction rules.
Persisted job recovery counts all skipped or failed snapshots but returns only the first 20 detailed
load errors with data-root paths redacted, while confirmation lookup similarly reports the number of
unreadable states and includes only the first 20 bounded diagnostics with data-root paths redacted.
Cancellation is cooperative: queued jobs stop immediately and do not block later queued jobs, while
running jobs stop at pipeline checkpoints between model, review, and file-write stages. `novel_job_cancel`
waits only briefly for the cancellation snapshot to persist and returns `persistencePending: true` when
that durability write is still in progress.
On stdio EOF, `SIGINT`, or `SIGTERM`, the server drains already accepted JSON-RPC requests and runs job
shutdown once: queued jobs are snapshotted as cancelled and running jobs persist a cancellation request
before the process exits. Shutdown marks all queued/running jobs for cancellation before waiting on any
snapshot persistence, so a running job that finishes during shutdown cannot start another queued job.
Shutdown waits for in-flight runs and job snapshot persistence only up to the
bounded shutdown window and logs a structured `mcp_shutdown_jobs` summary with queued, running, settled,
still-running, and pending-persistence counts. The direct shutdown-once helper validates its server and
pre-shutdown hook before installing the one-shot wrapper. Direct job-manager shutdown calls accept only integer wait
windows from 0 to 60000ms, then report any still-pending persistence work instead of hanging indefinitely.
`novel_job_start` validates tool-specific arguments before queueing, so malformed background work is rejected
without leaving a job snapshot behind, and `tools/list` exposes matching per-tool `args` schemas for async jobs.
Job snapshots are persisted under `data/jobs`; after process restart, completed jobs remain inspectable
and interrupted queued/running jobs are recovered as failed with an interruption error unless a cancellation
request had already been persisted, in which case they recover as cancelled. New job snapshots
do not persist original tool arguments, reducing long-term storage of manuscript prompts or revision instructions.
Legacy snapshots that still contain `args` are tolerated for inspection and interruption recovery, but those
stored arguments are not used to restart work.
Successful job results must have a supported status, a bounded printable message, and loss-safe JSON-serializable
content below the snapshot size cap in both characters and UTF-8 bytes before they are snapshotted; invalid or oversized results turn the job
into a failed job with a clear error.
Agent/provider results are also schema-checked and bounded before they are written to state, Markdown,
or EPUB outputs; unsupported or excessive top-level fields, oversized text, non-printing control characters, excessive issue lists,
explicit `undefined` conflict fields instead of omitted optional conflicts, malformed conflicts, multiline conflict scope labels, non-plain result objects, descriptor-checked top-level fields, symbol or unsupported issue
array fields, unreadable issue-array reflection metadata, and accessor or non-enumerable issue array entries fail fast without invoking provider-defined getters or leaking raw provider trap messages.
Agents receive defensive state snapshots in planning, beat drafting/review, and EPUB build contexts, so
provider code cannot alter the live pipeline state or contaminate the next agent call by mutating its input context.
Those state snapshots are produced through state validation rather than JSON round-tripping, so inherited
`toJSON` hooks cannot rewrite agent context state or rollback state copies.
When valid review issues from multiple agents are combined, the pipeline caps the stored feedback to
50 items with 1000 characters per item and records how many review issues were omitted, so a valid but
verbose review pass cannot make `state.json` or MCP responses exceed production bounds.
Review-feedback responses return defensive beat summaries and inline-secret-redacted issue text instead of
the mutable in-memory beat object, so library callers cannot alter saved pipeline state by mutating a
returned `novel_continue` payload and provider tokens are not echoed in immediate review responses.
On startup the MCP server finishes persisted job recovery before serving tool calls, so job status and
job list responses are consistent immediately after restart.
Queued, running, and terminal background job snapshots are captured at the moment each persistence write is
enqueued, then written in order, so delayed filesystem writes cannot accidentally serialize a later in-memory
job state into an earlier snapshot slot.
Queued tool arguments are copied from validated own data properties instead of JSON round-tripping, so
inherited `toJSON` hooks cannot rewrite arguments between validation and execution.
Direct background job start/status/cancel result envelopes and job snapshot objects are returned as data-only
objects assembled through safe descriptor copies, so inherited object `toJSON` hooks cannot rewrite
library-call JSON serialization of those job snapshots.
Unreadable reflection metadata inside background job result data is replaced with bounded unredactable sentinels,
so status/list redaction does not expose raw provider trap messages or embedded credentials.
All fire-and-forget job snapshot requests use the same guarded queue, so unexpected persistence-chain
errors are recorded on the job instead of becoming unhandled promise rejections.
Job execution does not wait for the running-state snapshot to reach disk; if snapshot persistence stalls,
the job keeps running and status/list responses expose `persistencePending` until the ordered write chain catches up.
Corrupt, structurally invalid, tool-args-invalid, timestamp/status-inconsistent, cancellation-flag-inconsistent,
far-future timestamp, outcome-inconsistent, result-invalid, or prototype-like-keyed job snapshot files are quarantined under
`data/jobs/quarantine` during startup recovery; valid job snapshots continue loading instead of blocking the whole server.
Quarantine filenames include both a timestamp and UUID suffix, so repeated quarantines for the same job id
cannot overwrite earlier forensic snapshots even when they happen in the same millisecond.
Job snapshot symlinks are rejected on read and the link itself is moved to quarantine without following or
modifying the target, even when the target is a directory.
Job root directory scans and direct quarantine operations both reject `data/jobs` roots that resolve
outside the storage root.
If a running job cannot persist its latest snapshot, the job continues in memory and `novel_job_status`
exposes `persistenceError` while `novel_job_list` exposes `hasPersistenceError` so operators can detect
failed durability writes. When a snapshot write is still in progress, both status and list responses expose
`persistencePending` so operators can distinguish delayed durability from failed durability; terminal
in-memory job status is exposed before the final snapshot write settles. Runtime job
`error` and `persistenceError` strings redact inline bearer-token, OpenAI-style key, and common key-value
secrets, redact the storage root as `<data-root>`, then normalize non-printing control characters including
newlines and tabs and are truncated by both character count and UTF-8 bytes before snapshotting, with
byte-overflow counts retained in truncation markers;
persisted snapshots with invalid error strings are quarantined during startup recovery.
Use `novel_job_cleanup` to prune finished snapshots and quarantined invalid snapshots older than `NOVELIST_JOB_RETENTION_MS`;
deletion failures are returned as `blocked` with total failure counts and up to 20 per-file failure
details for normal snapshots and quarantine snapshots, with the response capped even if storage reports
more failure samples. Quarantine cleanup payloads returned by injected storage implementations are
validated through enumerable data properties, and returned failure paths/errors are normalized, truncated,
and inline-secret-redacted before they appear in cleanup responses. Finished jobs with still-pending snapshot persistence
are retained and counted as `persistencePendingSkipped` instead of blocking cleanup indefinitely. Cleanup
also scans persisted snapshots that were not loaded because `NOVELIST_MAX_JOBS` was reached and deletes
old valid terminal snapshots from disk, so operators can recover from an oversized retained job set without
raising the in-memory job limit first. Quarantine cleanup applies the same safe-snapshot count cap before
deleting old quarantined files. The storage layer also caps collected quarantine failure samples before
the MCP response is assembled. Quarantined symlinks are counted and cleaned up as links without following
or deleting their targets.

Volume state files must include `schemaVersion: 1` and are validated on load, including cursor validity, active cursor consistency, first-incomplete-beat cursor positioning,
chapter/beat count limits, string length limits, safe-integer numeric limits, canonical ISO timestamps, timestamp ordering,
a 24-hour future timestamp skew cap, unique chapter/beat numbering, single pending-confirmation enforcement,
pending confirmation/status consistency, confirmation resolution consistency,
blocking-conflict status and confirmation-kind consistency, blocked-status reason consistency, complete-status beat consistency, pending beat ordering, and revision-feedback consistency,
including rejecting stale beat feedback unless the beat is in `needs_revision`. Prototype-like keys such as
`__proto__` are preserved as ordinary fields during state validation, so unsupported state metadata cannot
hide from supported-field checks or mutate validation object prototypes. State title and label fields such as
franchise/work/volume titles, chapter/beat titles, and conflict scope must stay single-line, while prose fields
such as confirmation messages, conflict descriptions, and revision feedback may remain multiline; all of these state strings are bounded by both character count and UTF-8 bytes. Before each state rewrite, the previous `state.json` is copied to
`state.json.bak` only after it validates for the same volume, and the next state is validated before any
derived chapter/beat directories are created. Storage-managed `schemaVersion` and `updatedAt` values are
applied to a plain save snapshot instead of mutating the caller's state object before validation. Direct layout creation and collected-volume Markdown reads
also validate the provided state before creating directories or reading beat files; if the primary state file is unreadable,
unparseable, or oversized, the loader attempts to recover from that backup, and failed rewrites preserve
the last valid backup. Parsed primary states that fail semantic validation are reported directly instead
of being hidden by backup recovery, and file-integrity errors such as symbolic-link primary metadata are
also reported directly, so invalid schemas, unsupported fields, path/body identity mismatches, and unsafe
primary metadata paths cannot be silently accepted.
The `current.json` pointer used by `current: true` calls is also backed up to `current.json.bak` only after
it validates, and direct current-pointer writes validate the provided volume state before replacing the
pointer, so a corrupt or missing primary current pointer can recover to the last valid pointer and failed
rewrites preserve that backup. File-integrity errors on the primary current pointer, including symbolic
links, are not recovered from backup. Backup refresh also requires the existing pointer to resolve to a
loadable state before it can replace the previous backup, so a stale but syntactically valid pointer does
not destroy the last useful backup. Health checks validate a backup-only current pointer instead of
ignoring it.
State rewrites remain authoritative even when best-effort current pointer refresh fails after a successful
state write. If the current pointer is missing and exactly one loadable volume state exists with no other
unreadable volume states, `current: true` falls back to that volume; when multiple volumes or unreadable
states exist it refuses to guess and asks callers to provide explicit IDs. Unreadable-state fallback
errors include a bounded, root-redacted sample of failing volume identities and causes. Automatic
state discovery for `current: true` and confirmation lookup stops after 100000 volume candidates and
requires explicit IDs rather than allowing unbounded repository scans.
If approved planning cannot publish its updated state, the initial outline plus any preexisting world/work
artifacts are restored, and newly written planning artifacts are removed so the remaining pending state is
not paired with a partial draft.
When a completed beat cannot publish the matching `state.json`, the beat Markdown file is restored to its
previous content or removed if it was newly created, preventing visible draft artifacts from getting ahead
of the authoritative volume state.
Completed volumes must still have every referenced beat Markdown file present, no larger than 10 MiB,
with matching frontmatter and non-empty body text before EPUB collection; missing, oversized, or malformed
beat artifacts fail clearly instead of producing a partial book. Direct volume Markdown collection also
requires a complete volume state, matching `novel_build_epub` instead of assembling drafts from incomplete
states. Beat frontmatter headers are capped at 64 KiB by both character count and UTF-8 bytes and 20 fields before field parsing. Direct beat-file
storage helpers also reject non-integer, zero, negative, or excessively large chapter/beat path indexes
before constructing a file path.
Direct Markdown and EPUB storage helpers inspect volume state as plain data before deriving paths or
frontmatter, so accessor-backed or malformed state objects cannot run getters, overwrite files, or delete
existing artifacts.
Markdown readers and writers reject NUL/ESC-style non-printing control characters in body text while still
allowing normal prose whitespace such as newlines and tabs.
Collected volume Markdown and direct EPUB Markdown input are capped by both character count and 16 MiB
of UTF-8 bytes before EPUB generation, so many individually valid beat files or multibyte prose cannot
combine into an unbounded in-memory manuscript.
Direct EPUB build failures redact the storage root as `<data-root>` before surfacing storage-path errors.
The exported EPUB builder also validates the state metadata it directly renders, rejecting malformed IDs,
oversized or accessor-backed titles, non-string manuscripts, and impossible calendar timestamps with
explicit validation errors instead of leaking low-level `RangeError` failures.
EPUB builds write and validate a candidate archive before promoting it to the final `{volumeId}.epub`
path, so failed internal or external validation does not overwrite the previous successful EPUB.
Direct final and candidate EPUB storage writes also require a semantically valid complete volume state
and a valid internal EPUB archive. Candidate promotion repeats those checks before replacing the final EPUB,
even when the candidate file was created outside the storage writer, and rejects oversized candidate files
by filesystem size before reading them into memory.
When a beat is rewritten by continuation, revision, direct beat-file storage repair, or direct beat deletion,
any previously promoted final EPUB for that volume is removed so callers cannot mistake a stale export for
the current manuscript. Revision keeps a valid previous EPUB only long enough to restore it if revision-state
publication fails; an already corrupt or unreadable previous EPUB is treated as stale and does not block
the revision from invalidating and replacing the manuscript state.
Candidate promotion and validation-failure cleanup both verify the file belongs to the target volume and
uses the expected `{volumeId}.candidate-*.epub` filename before moving or deleting it; promotion also
requires the candidate path to be a regular file, not a directory or symlink, and rechecks the final EPUB
parent directory before the rename.
The internal EPUB validator rejects archives over 32 MiB before ZIP parsing and bounds entry count, hard ZIP parse entry count, reported entry lists,
entry names, and issue payloads, rejects unsafe ZIP entry paths, reports duplicate entries, verifies required
OPF manifest/spine links, and returns structured issues for malformed ZIP input before promotion without
producing oversized tool responses.
Reported EPUB validation issues and entry paths redact inline secrets, normalize control characters, and
truncate by both character count and UTF-8 bytes before they are returned to callers.
If candidate cleanup itself fails, the original validation failure is preserved in the surfaced error, while
direct pipeline errors still redact inline bearer-token/OpenAI-style secrets and cap composed error text by
both character count and UTF-8 bytes.
Beat and joined-beat review retries are capped by `NOVELIST_REVIEW_MAX_RETRIES`; repeated review failures
or blocking continuity conflicts move the volume back to `pending_user_confirmation` instead of retrying indefinitely.
Blocking continuity conflicts do this even when the agent returns only a conflict object and no separate
review issue text, preventing unresolved blocking conflicts from surfacing later as state-save failures.
Runtime retry increments also stop before the persisted beat retry-count cap of 1000, so revision requests
cannot create a state file that validation would later reject.
When a conflict/review confirmation is approved, the current revision retry counter is reset and any
approval-time revision instruction is carried into the next writer context as feedback.
Continuity conflict IDs returned by agents are treated as untrusted input and are made unique at storage
time, so repeated agent IDs cannot corrupt the volume state.
Agent-provided conflict `resolved` flags are also treated as untrusted and normalized to unresolved at
storage time; only user confirmation or an explicit revision flow can resolve blocking conflicts.
Volumes in `blocked` state are reported without advancing drafts, so operator-held pipelines stay stopped
until they are explicitly revised or unblocked. A `novel_revise` call against a blocked volume treats the
revision instruction as the operator's conflict-resolution action, marks unresolved blocking conflicts as
resolved, and resumes the target beat through the normal write/edit/proofread/continuity loop.
Revision targets cannot skip earlier incomplete beats; callers must finish or revise the earliest incomplete
beat before jumping to a later pending beat.

Release tags matching `v*.*.*` run the full verification suite and publish the package to npm when
`NPM_TOKEN` is configured in GitHub Actions. CI and release jobs run with bounded timeouts and minimal
repository permissions, pin GitHub Actions to reviewed concrete version tags instead of major-only tags,
disable checkout credential persistence in the workspace, and npm publish uses provenance and
`--ignore-scripts` after verification.
`npm run verify` performs a clean build and checks the
packed tarball, package metadata including object-shaped `package.json`, `main`, `types`, typed `exports`, `bin`, UTF-8-byte-bounded `files` entries, reviewed exact `scripts`, install-time lifecycle scripts,
duplicate pack paths, character- and UTF-8-byte-bounded safe package-relative paths, the reviewed `tsconfig.json` compiler policy, package version/description length caps, pack metadata size caps, pack file count and size caps, local filesystem size caps
even when pack metadata omits or undersizes file sizes, character- and UTF-8-byte-bounded single-argument pack metadata path validation, regular-file verification for every packed entry and metadata input,
exactly one array-shaped `npm pack --json` metadata object, concrete pack name/version/entryCount/unpackedSize/bundled summary metadata, bundled dependency
metadata, raw JSON duplicate-key rejection before semantic checks, byte-bounded parse diagnostics, parsed JSON metadata shape plus control-character and UTF-8 byte bounds before semantic checks, reviewed metadata equality through data descriptors without invoking inherited `toJSON` or accessors, reviewed npm pack summary and file-entry metadata fields, numeric packed-file mode metadata including regular-file Unix type bits when present, reviewed `publishConfig` policy,
the package-lock root plus reviewed TypeScript-only dependency entries, and the package allowlist so stale
`dist/src` artifacts, source files, tests, scripts, and local data are not shipped. Packed JavaScript
artifacts and generated `.d.ts` declaration files must appear as matching pairs, every runtime `src/*.ts`
file must have packed JavaScript and declaration artifacts, the shared JSON preflight runtime artifact is
explicitly required and checked for reviewed scanner code plus its public declaration signature when its source exists, local development type shims such as
`node.d.ts` must not ship, `tsconfig.json` pins the server runtime library surface to `ES2022` with
`skipLibCheck` disabled while Node 22 globals are declared only in the local shim, the compiled
`PACKAGE_VERSION` artifact must match `package.json`, the package bin entrypoint must be a regular executable file before it is read, its executable bit is checked from the same opened file descriptor used for content validation,
the package bin entrypoint must contain the reviewed CLI startup imports and calls, the public library entrypoint and declaration entrypoint must expose exports and must not be CLI shebang files,
package top-level metadata is restricted to reviewed fields, package `bin` and `engines`
subfields are restricted to reviewed entries, runtime dependency
fields are rejected unless the packaging policy is explicitly reviewed, development dependencies are restricted to the reviewed TypeScript toolchain, and
the published package metadata fixes `publishConfig` to `access: "public"` and `provenance: true`.
The `npm test` script builds the package and then runs the compiled test suite directly, avoiding an
extra `node --test` wrapper process around the already instrumented TAP-producing tests. The suite
creates all per-test storage roots under one process-scoped `/tmp/novelist-test-run-*` directory and
removes it after the run, keeping repeated verification from exhausting temporary mount targets.
The `pack:check` script rebuilds first, then streams `npm pack --dry-run --json` directly into
`pack-check.mjs -`, so standalone packaging checks do not inspect stale `dist` output and parallel
verification runs do not share a fixed `/tmp` pack metadata path.

EPUB source Markdown is capped at 16 MiB and must be non-empty before XHTML rendering, and EPUB output is capped at 32 MiB during archive generation and rejected before ZIP parsing during direct validation. Direct EPUB archive builds require `state.status: "complete"`. EPUB rendering rejects XML 1.0-invalid text,
and is always checked by the internal structural validator, including stored-entry CRC, supported ZIP entry flags and local/central flag agreement, central directory,
local-header truncation checks, EOCD checks, strict UTF-8 decoding for ZIP entry names and required EPUB text
files, XML entity and numeric-character-reference validity, and the EPUB OCF rule that the first `mimetype` ZIP entry has no extra field, before promotion.
Direct validator calls return a
bounded invalid result for non-`Uint8Array` archive inputs or unreadable archive metadata instead of throwing. When `NOVELIST_EPUBCHECK_COMMAND` is configured, `novel_build_epub` also runs
that external validator and fails the build if it exits non-zero. For EPUBCheck this can be configured as `NOVELIST_EPUBCHECK_COMMAND=java` and
`NOVELIST_EPUBCHECK_ARGS="-jar /path/to/epubcheck.jar {epub}"`; use a JSON array such as
`NOVELIST_EPUBCHECK_ARGS='["-jar","/path with spaces/epubcheck.jar","{epub}"]'` when an argument contains spaces.
The validator command is capped at 1024 characters and 1024 UTF-8 bytes and rejected when it is empty or contains control
characters, whitespace, an unsafe PATH command name, or a relative executable path. Absolute validator
command paths are checked before execution, must resolve to byte-bounded regular files, and are redacted before they
appear in validation errors. When an absolute configured command resolves through a symlink or other
canonicalization, validator results include both the configured `command` and the actual
`resolvedCommand` executed for auditability.
The generated candidate EPUB path exported to the validator is also checked before process execution:
it must be a string, absolute, non-empty, at most 4096 characters and 4096 UTF-8 bytes, contain no control characters, and
resolve to a readable regular file no larger than the internal EPUB archive size limit.
The exported `runExternalEpubCheck` function repeats config-object, command, bounded `{epub}` argument-template,
argument-array shape, control-character, and timeout validation for direct library callers instead of
trusting pre-parsed config objects. Direct validator argument arrays also report unreadable reflection
metadata as bounded validation errors before any process execution.
Direct calls without `epubCheckCommand` return an unconfigured valid result without requiring validator args;
when a command is configured, `epubCheckArgs` must be present and include exactly one `{epub}`.
Captured external validator stdout/stderr and reported command, argument, and process-error fields are
redacted, normalized, and capped by both character count and UTF-8 bytes before they are returned in tool
results, so multibyte validator output cannot exceed the intended response budget.
Direct config objects must be plain enumerable data objects using supported `AppConfig` fields, so accessor,
symbol, non-enumerable, unsupported, and unreadable-reflection fields are rejected before command or arg values are read.
Direct `NovelPipeline` config construction also validates external validator commands and configured
arguments up front: configured validators must include `{epub}`, commands are capped at 1024
characters/UTF-8 bytes, args are capped at 64 configured items and 4096 characters/UTF-8 bytes each,
leading/trailing whitespace or control characters are rejected, and unreadable argument-array reflection
metadata is reported as bounded validation errors before a build can start.
Expanded validator arguments are rechecked immediately before execution: at most 64 args, 4096
characters per configured template, 8192 characters per expanded arg, 256 KiB total argv payload, and no
control characters after `{epub}` path expansion.
External validator process time is capped by the remaining `NOVELIST_OPERATION_TIMEOUT_MS` deadline rather
than a fresh full operation timeout, so validation cannot make a build outlive its overall operation budget.
External validator processes run with a minimal environment containing only a deterministic
`PATH=/usr/local/bin:/usr/bin:/bin` and a deterministic working directory `/`, so parent cwd, PATH
entries, application secrets, and model-provider configuration are not inherited by the validator
process; unsafe or oversized parent `PATH` values fall back to `/usr/local/bin:/usr/bin:/bin`.
Direct CLI argument arrays must be standard enumerable data arrays, and unreadable argument-array
reflection metadata is reported as bounded validation errors rather than raw trap messages.
Captured external validator stdout, stderr, error messages, command, and expanded args normalize non-printing
control characters, redact inline bearer-token/OpenAI-style secrets, and are truncated in tool results so
verbose validators or long paths cannot produce oversized MCP responses.
Returned external validator result objects and reported argument arrays also carry stable JSON snapshots, so
polluted inherited `toJSON` hooks cannot rewrite validator results when callers serialize them.

The test suite includes a production smoke path that runs the OpenAI-compatible adapter with a fake
model response, completes a volume, builds EPUB, and runs the configured external validator hook.

## MCP Configuration Example

Installed package:

```json
{
  "mcpServers": {
    "novelist": {
      "command": "novelist-mcp",
      "env": {
        "NOVELIST_DATA_DIR": "/absolute/path/to/novelist/data"
      }
    }
  }
}
```

Local source checkout:

```json
{
  "mcpServers": {
    "novelist": {
      "command": "node",
      "args": ["/absolute/path/to/novelist/dist/src/cli.js"],
      "env": {
        "NOVELIST_DATA_DIR": "/absolute/path/to/novelist/data"
      }
    }
  }
}
```

GitHub source via `npx`:

```json
{
  "mcpServers": {
    "novelist": {
      "command": "npx",
      "args": [
        "--yes",
        "--package",
        "git+ssh://git@github.com/bbggkkk/Novelist.git",
        "novelist-mcp"
      ],
      "env": {
        "NOVELIST_DATA_DIR": "/absolute/path/to/novelist/data"
      }
    }
  }
}
```

## License

MIT
