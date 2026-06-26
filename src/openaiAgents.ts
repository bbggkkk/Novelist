import type { AppConfig } from "./config.js";
import type { AgentContext, AgentResult, NewProjectInput, NovelAgents, VolumeState } from "./types.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import { assertNoDuplicateJsonObjectKeys } from "./jsonPreflight.js";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: unknown;
  text(): Promise<string>;
}

type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  }
) => Promise<FetchResponseLike>;

const MAX_ERROR_BODY_CHARS = 4000;
const MAX_ERROR_BODY_BYTES = 4000;
const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_JSON_DEPTH = 64;
const MAX_RESPONSE_HEADERS = 100;
const MAX_RESPONSE_HEADER_NAME_CHARS = 256;
const MAX_RESPONSE_HEADER_NAME_BYTES = 256;
const MAX_RESPONSE_CONTENT_TYPE_CHARS = 512;
const MAX_RESPONSE_CONTENT_TYPE_BYTES = 512;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SET_TIMEOUT_MS = 2_147_483_647;
const MAX_RETRY_COUNT = 20;
const MAX_OPENAI_API_KEY_LENGTH = 4096;
const MAX_OPENAI_API_KEY_BYTES = 4096;
const MAX_OPENAI_MODEL_LENGTH = 200;
const MAX_OPENAI_MODEL_BYTES = 200;
const MAX_OPENAI_BASE_URL_LENGTH = 2048;
const MAX_OPENAI_BASE_URL_BYTES = 2048;
const MAX_ISSUE_PREFIXED_ITEMS = 100;
const MAX_ISSUE_PREFIXED_CHARS = 4000;
const MAX_ISSUE_PREFIXED_BYTES = 4000;
const MAX_ISSUE_PREFIXED_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_ISSUE_PREFIXED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_OPENAI_CHOICES = 16;
const MAX_OPENAI_ERROR_CHARS = 4000;
const MAX_OPENAI_ERROR_BYTES = 4000;
const MAX_OPENAI_ERROR_NAME_CHARS = 128;
const MAX_OPENAI_ERROR_NAME_BYTES = 128;
const MAX_OPENAI_ROLE_LABEL_CHARS = 128;
const MAX_OPENAI_ROLE_LABEL_BYTES = 128;
const MAX_OPENAI_RESPONSE_META_CHARS = 512;
const MAX_OPENAI_RESPONSE_META_BYTES = 1024;
const MAX_OPENAI_FINISH_REASON_CHARS = 64;
const MAX_OPENAI_FINISH_REASON_BYTES = 64;
const MAX_OPENAI_CONTENT_CHARS = 8 * 1024 * 1024;
const MAX_OPENAI_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_OPENAI_ANNOTATIONS = 16;
const MAX_OPENAI_ANNOTATION_FIELDS = 50;
const MAX_OPENAI_ANNOTATION_DEPTH = 16;
const MAX_OPENAI_ANNOTATION_ARRAY_ITEMS = 1000;
const MAX_OPENAI_ANNOTATION_TOTAL_NODES = 10000;
const MAX_OPENAI_ANNOTATION_STRING_CHARS = 32 * 1024;
const MAX_OPENAI_ANNOTATION_STRING_BYTES = 64 * 1024;
const MAX_OPENAI_ANNOTATION_KEY_CHARS = 256;
const MAX_OPENAI_ANNOTATION_KEY_BYTES = 512;
const MAX_PROMPT_CONTEXT_DEPTH = 64;
const MAX_PROMPT_CONTEXT_OBJECT_FIELDS = 1000;
const MAX_PROMPT_CONTEXT_OBJECT_KEY_CHARS = 1024;
const MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES = 2048;
const MAX_PROMPT_CONTEXT_STRING_CHARS = 1024 * 1024;
const MAX_PROMPT_CONTEXT_STRING_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_CONTEXT_ARRAY_ITEMS = 10000;
const MAX_PROMPT_CONTEXT_TOTAL_NODES = 100000;
const OPENAI_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const encoder = new TextEncoder();
const OPENAI_CONFIG_FIELDS = new Set<keyof AppConfig>([
  "dataDir",
  "lockTimeoutMs",
  "lockRetryMs",
  "lockStaleMs",
  "logLevel",
  "operationTimeoutMs",
  "reviewMaxRetries",
  "jobRetentionMs",
  "maxConcurrentJobs",
  "maxJobs",
  "stdioMaxLineLength",
  "agentProvider",
  "openaiBaseUrl",
  "openaiApiKey",
  "openaiModel",
  "openaiTimeoutMs",
  "openaiMaxRetries",
  "openaiRetryBaseMs",
  "epubCheckCommand",
  "epubCheckArgs"
]);

export class OpenAiNovelAgents implements NovelAgents {
  private readonly openAiConfig: OpenAiRuntimeConfig;

  constructor(
    config: AppConfig,
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    private readonly sleepImpl: (ms: number) => Promise<void> = sleep
  ) {
    this.openAiConfig = validateOpenAiConfig(config);
    if (typeof fetchImpl !== "function") {
      throw new Error("OpenAiNovelAgents.fetchImpl must be a function.");
    }
    if (typeof sleepImpl !== "function") {
      throw new Error("OpenAiNovelAgents.sleepImpl must be a function.");
    }
  }

  planInitial(input: NewProjectInput): Promise<AgentResult> {
    return this.complete("planner", [
      system("You are a senior Korean fiction planner. Return concise Markdown only."),
      user(`Create an initial user-confirmable story progression.\n\n${json(input)}`)
    ]);
  }

  buildWorld(input: NewProjectInput, approvedOutline: string): Promise<AgentResult> {
    return this.complete("worldbuilder", [
      system("You are a worldbuilding agent. Consolidate canon as Markdown. Avoid contradictions."),
      user(`Create or update the franchise world bible from this approved outline.\n\nRequest:\n${json(input)}\n\nOutline:\n${approvedOutline}`)
    ]);
  }

  planSkeleton(state: VolumeState, input: NewProjectInput): Promise<AgentResult> {
    return this.complete("planner", [
      system("You create chapter and beat skeletons with target word counts. Return Markdown only."),
      user(`Create a chapter/beat skeleton for this volume.\n\nState:\n${json(state)}\n\nRequest:\n${json(input)}`)
    ]);
  }

  writeBeat(context: AgentContext): Promise<AgentResult> {
    return this.complete("writer", [
      system("You write polished Korean prose from a beat brief. Return manuscript Markdown only."),
      user(`Write this beat.\n\n${json(context)}`)
    ]);
  }

  editBeat(context: AgentContext, draft: string): Promise<AgentResult> {
    return this.complete("editor", [
      system("You are a Korean prose editor. Improve style without changing canon. Return edited Markdown only."),
      user(`Edit this beat.\n\nContext:\n${json(context)}\n\nDraft:\n${draft}`)
    ]);
  }

  proofreadBeat(context: AgentContext, edited: string): Promise<AgentResult> {
    return this.complete("proofreader", [
      system("You proofread Korean prose. If there are serious broken sentences, start with 'ISSUE:' lines, then return the corrected text."),
      user(`Proofread this beat.\n\nContext:\n${json(context)}\n\nText:\n${edited}`)
    ]).then(parseIssuePrefixedResult);
  }

  checkContinuity(context: AgentContext, text: string): Promise<AgentResult> {
    return this.complete("continuity_otaku", [
      system("You validate canon continuity. If blocking canon conflicts exist, start with 'ISSUE:' lines, then return the checked text."),
      user(`Check continuity.\n\nContext:\n${json(context)}\n\nText:\n${text}`)
    ]).then(parseIssuePrefixedResult);
  }

  editJoinedBeats(context: AgentContext, text: string): Promise<AgentResult> {
    return this.complete("editor", [
      system("You edit adjacent beats for continuity and flow. Return Markdown only."),
      user(`Edit the joined passage.\n\nContext:\n${json(context)}\n\nText:\n${text}`)
    ]);
  }

  buildEpub(_context: AgentContext, markdown: string): Promise<AgentResult> {
    return Promise.resolve({ text: markdown, issues: [] });
  }

  private async complete(role: string, messages: ChatMessage[]): Promise<AgentResult> {
    let lastError: Error | undefined;
    const deadlineAt = Date.now() + this.openAiConfig.operationTimeoutMs;
    for (let attempt = 0; attempt <= this.openAiConfig.openaiMaxRetries; attempt += 1) {
      try {
        assertOpenAiDeadline(role, deadlineAt);
        return await this.completeOnce(role, messages, deadlineAt);
      } catch (error) {
        lastError = normalizeOpenAiError(error, this.openAiConfig);
        if (attempt >= this.openAiConfig.openaiMaxRetries || !isRetryableError(lastError)) {
          throw lastError;
        }
        const delayMs = Math.min(retryDelayMs(this.openAiConfig, attempt), remainingOpenAiMs(role, deadlineAt));
        try {
          await this.sleepImpl(delayMs);
        } catch (sleepError) {
          throw normalizeOpenAiError(new Error(`OpenAI-compatible retry sleep failed for ${role}: ${errorMessage(sleepError)}`), this.openAiConfig);
        }
      }
    }
    throw lastError ?? new Error(`OpenAI-compatible request failed for ${role}.`);
  }

  private async completeOnce(role: string, messages: ChatMessage[], deadlineAt: number): Promise<AgentResult> {
    if (!this.openAiConfig.openaiApiKey) {
      throw new Error("NOVELIST_OPENAI_API_KEY is required when NOVELIST_AGENT_PROVIDER=openai.");
    }
    const body = openAiRequestBody({
      model: this.openAiConfig.openaiModel,
      temperature: 0.4,
      messages
    }, role);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs(this.openAiConfig, deadlineAt));
    try {
      const response = validateFetchResponse(await this.fetchImpl(`${this.openAiConfig.openaiBaseUrl.replace(/\/+$/g, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.openAiConfig.openaiApiKey ?? ""}`
        },
        body,
        signal: controller.signal
      }), role);
      if (!response.ok) {
        const body = await readResponseText(response, role, deadlineAt);
        const error = new Error(
          `OpenAI-compatible request failed for ${role}: HTTP ${response.status} ${truncateErrorBody(redactSecrets(body, this.openAiConfig))}`
        );
        error.name = `Http${response.status}`;
        throw error;
      }
      validateSuccessfulResponseContentType(response.headers, role);
      const responseBody = await readResponseText(response, role, deadlineAt);
      const text = parseOpenAiTextResponse(parseOpenAiJsonBody(responseBody, role), role);
      return { text, issues: [] };
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface OpenAiRuntimeConfig {
  operationTimeoutMs: number;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  openaiModel: string;
  openaiTimeoutMs: number;
  openaiMaxRetries: number;
  openaiRetryBaseMs: number;
}

function validateOpenAiConfig(config: AppConfig): OpenAiRuntimeConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("OpenAiNovelAgents.config must be an object.");
  }
  validateOpenAiConfigSurface(config);
  const openaiBaseUrl = configField(config, "openaiBaseUrl");
  const openaiApiKey = optionalConfigField(config, "openaiApiKey");
  const openaiModel = configField(config, "openaiModel");
  const operationTimeoutMs = configField(config, "operationTimeoutMs");
  const openaiTimeoutMs = configField(config, "openaiTimeoutMs");
  const openaiMaxRetries = configField(config, "openaiMaxRetries");
  const openaiRetryBaseMs = configField(config, "openaiRetryBaseMs");
  const safeOpenAiBaseUrl = validateOpenAiBaseUrl(openaiBaseUrl);
  validateOptionalApiKey(openaiApiKey);
  validateOpenAiModel(openaiModel);
  const safeOperationTimeoutMs = assertIntegerInRange(operationTimeoutMs, "OpenAiNovelAgents.operationTimeoutMs", 1, MAX_DURATION_MS);
  const safeOpenAiTimeoutMs = assertIntegerInRange(openaiTimeoutMs, "OpenAiNovelAgents.openaiTimeoutMs", 1, MAX_DURATION_MS);
  const safeOpenAiMaxRetries = assertIntegerInRange(openaiMaxRetries, "OpenAiNovelAgents.openaiMaxRetries", 0, MAX_RETRY_COUNT);
  const safeOpenAiRetryBaseMs = assertIntegerInRange(openaiRetryBaseMs, "OpenAiNovelAgents.openaiRetryBaseMs", 1, MAX_DURATION_MS);
  return {
    operationTimeoutMs: safeOperationTimeoutMs,
    openaiBaseUrl: safeOpenAiBaseUrl,
    ...(openaiApiKey === undefined ? {} : { openaiApiKey }),
    openaiModel,
    openaiTimeoutMs: safeOpenAiTimeoutMs,
    openaiMaxRetries: safeOpenAiMaxRetries,
    openaiRetryBaseMs: safeOpenAiRetryBaseMs
  };
}

function validateOpenAiConfigSurface(config: object): void {
  const prototype = safeGetPrototypeOf(config, "OpenAiNovelAgents.config");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("OpenAiNovelAgents.config must be a plain object.");
  }
  for (const key of safeOwnKeys(config, "OpenAiNovelAgents.config")) {
    if (typeof key !== "string") {
      throw new Error("OpenAiNovelAgents.config must not contain symbol properties.");
    }
    if (!OPENAI_CONFIG_FIELDS.has(key as keyof AppConfig)) {
      throw new Error(`OpenAiNovelAgents.${key} is not a supported config field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(config, key, "OpenAiNovelAgents.config");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`OpenAiNovelAgents.${key} must be an enumerable data property.`);
    }
  }
}

function configField(config: object, key: keyof AppConfig): unknown {
  const value = optionalConfigField(config, key);
  if (value === undefined) {
    throw new Error(`OpenAiNovelAgents.${key} is required.`);
  }
  return value;
}

function optionalConfigField(config: object, key: keyof AppConfig): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(config, key, "OpenAiNovelAgents.config");
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`OpenAiNovelAgents.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function safeGetPrototypeOf(value: object, label: string): object | null {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    throw new Error(`${label} prototype must be readable.`);
  }
}

function safeOwnKeys(value: object, label: string): Array<string | symbol> {
  try {
    return Reflect.ownKeys(value);
  } catch {
    throw new Error(`${label} keys must be readable.`);
  }
}

function safeGetOwnPropertyDescriptor(value: object, key: string, label: string): PropertyDescriptor | undefined;
function safeGetOwnPropertyDescriptor(value: object, key: string | symbol, label: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`${label} property descriptors must be readable.`);
  }
}

function validateOpenAiBaseUrl(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must be a non-empty string.");
  }
  if (value.length > MAX_OPENAI_BASE_URL_LENGTH) {
    throw new Error(`OpenAiNovelAgents.openaiBaseUrl must be at most ${MAX_OPENAI_BASE_URL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES) {
    throw new Error(`OpenAiNovelAgents.openaiBaseUrl must be at most ${MAX_OPENAI_BASE_URL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must not contain control characters.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must be a valid http or https URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must be a valid http or https URL.");
  }
  const local = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !local) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must use https unless the host is localhost or loopback.");
  }
  if (url.username || url.password) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must not include username or password credentials.");
  }
  if (url.search || url.hash) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl must not include query strings or fragments.");
  }
  const normalized = url.toString().replace(/\/$/g, "");
  if (normalized.length > MAX_OPENAI_BASE_URL_LENGTH) {
    throw new Error(`OpenAiNovelAgents.openaiBaseUrl normalized URL must be at most ${MAX_OPENAI_BASE_URL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(normalized, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES) {
    throw new Error(`OpenAiNovelAgents.openaiBaseUrl normalized URL must be at most ${MAX_OPENAI_BASE_URL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("OpenAiNovelAgents.openaiBaseUrl normalized URL must not contain control characters.");
  }
  return normalized;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function validateOptionalApiKey(value: unknown): asserts value is string | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OpenAiNovelAgents.openaiApiKey must be a non-empty string when provided.");
  }
  if (value.length > MAX_OPENAI_API_KEY_LENGTH) {
    throw new Error(`OpenAiNovelAgents.openaiApiKey must be at most ${MAX_OPENAI_API_KEY_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_OPENAI_API_KEY_BYTES) > MAX_OPENAI_API_KEY_BYTES) {
    throw new Error(`OpenAiNovelAgents.openaiApiKey must be at most ${MAX_OPENAI_API_KEY_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("OpenAiNovelAgents.openaiApiKey must not contain control characters.");
  }
  if (/\s/u.test(value)) {
    throw new Error("OpenAiNovelAgents.openaiApiKey must not contain whitespace.");
  }
}

function validateOpenAiModel(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("OpenAiNovelAgents.openaiModel must be a non-empty string.");
  }
  if (value.length > MAX_OPENAI_MODEL_LENGTH) {
    throw new Error(`OpenAiNovelAgents.openaiModel must be at most ${MAX_OPENAI_MODEL_LENGTH} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_OPENAI_MODEL_BYTES) > MAX_OPENAI_MODEL_BYTES) {
    throw new Error(`OpenAiNovelAgents.openaiModel must be at most ${MAX_OPENAI_MODEL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("OpenAiNovelAgents.openaiModel must not contain control characters.");
  }
  if (/\s/u.test(value)) {
    throw new Error("OpenAiNovelAgents.openaiModel must not contain whitespace.");
  }
}

function assertIntegerInRange(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`${label} must be an integer.`);
  }
  if (value < min || value > max) {
    throw new Error(`${label} must be between ${min} and ${max}.`);
  }
  return value;
}

function validateFetchResponse(value: unknown, role: string): FetchResponseLike {
  const safeRole = validateRoleLabel(role, "OpenAI-compatible response role");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`OpenAI-compatible response for ${safeRole} must be an object.`);
  }
  if (isNativeFetchResponse(value)) {
    assertNativeFetchResponseSurface(value, `OpenAI-compatible response for ${safeRole}`);
    validateHttpStatus(value.status, `OpenAI-compatible response for ${safeRole}.status`);
    validateResponseOkStatus(value.ok, value.status, `OpenAI-compatible response for ${safeRole}`);
    return {
      ok: value.ok,
      status: value.status,
      headers: value.headers,
      text: value.text.bind(value)
    };
  }
  assertCustomFetchResponseSurface(value, `OpenAI-compatible response for ${safeRole}`);
  const ok = dataProperty(value, "ok", `OpenAI-compatible response for ${safeRole}`);
  const status = dataProperty(value, "status", `OpenAI-compatible response for ${safeRole}`);
  const text = dataProperty(value, "text", `OpenAI-compatible response for ${safeRole}`);
  const headers = dataProperty(value, "headers", `OpenAI-compatible response for ${safeRole}`);
  if (typeof ok !== "boolean") {
    throw new Error(`OpenAI-compatible response for ${safeRole}.ok must be a boolean.`);
  }
  validateHttpStatus(status, `OpenAI-compatible response for ${safeRole}.status`);
  validateResponseOkStatus(ok, status, `OpenAI-compatible response for ${safeRole}`);
  if (typeof text !== "function") {
    throw new Error(`OpenAI-compatible response for ${safeRole}.text must be a function.`);
  }
  return { ok, status, headers, text: text as () => Promise<string> };
}

function assertCustomFetchResponseSurface(value: object, label: string): void {
  const prototype = safeGetPrototypeOf(value, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a native Response or plain response object.`);
  }
  assertKnownFetchResponseFields(value, label, ["ok", "status", "headers", "text"]);
}

function assertNativeFetchResponseSurface(value: Response, label: string): void {
  if (safeGetPrototypeOf(value, label) !== Response.prototype) {
    throw new Error(`${label} must be an exact native Response or plain response object.`);
  }
  for (const key of ["ok", "status", "headers", "text"]) {
    if (safeGetOwnPropertyDescriptor(value, key, label) !== undefined) {
      throw new Error(`${label}.${key} must not be overridden on a native Response instance.`);
    }
  }
}

function assertKnownFetchResponseFields(value: object, label: string, allowedFields: string[]): void {
  const allowed = new Set(allowedFields);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!allowed.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
  }
}

function isNativeFetchResponse(value: object): value is Response {
  if (typeof Response === "undefined") {
    return false;
  }
  try {
    return value instanceof Response;
  } catch {
    return false;
  }
}

function validateHttpStatus(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) {
    throw new Error(`${label} must be an HTTP status integer.`);
  }
}

function validateResponseOkStatus(ok: boolean, status: number, label: string): void {
  const statusIsOk = status >= 200 && status <= 299;
  if (ok !== statusIsOk) {
    throw new Error(`${label}.ok must match whether status is a 2xx HTTP status.`);
  }
}

function validateSuccessfulResponseContentType(headers: unknown, role: string): void {
  if (headers === undefined) {
    return;
  }
  const contentType = responseContentType(headers, `OpenAI-compatible response for ${role}.headers`);
  if (contentType === undefined) {
    return;
  }
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new Error(`OpenAI-compatible response for ${role}.headers.content-type must be application/json or a +json media type.`);
  }
}

function responseContentType(headers: unknown, label: string): string | undefined {
  if (isNativeHeaders(headers)) {
    let value: string | null;
    try {
      value = headers.get("content-type");
    } catch {
      throw new Error(`${label}.content-type must be readable.`);
    }
    return validateOptionalContentType(value ?? undefined, `${label}.content-type`);
  }
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error(`${label} must be a Headers object or plain header object when provided.`);
  }
  const prototype = safeGetPrototypeOf(headers, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a Headers object or plain header object when provided.`);
  }
  const lowerKeys = new Map<string, string>();
  for (const key of safeOwnKeys(headers, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (lowerKeys.size >= MAX_RESPONSE_HEADERS) {
      throw new Error(`${label} must contain at most ${MAX_RESPONSE_HEADERS} headers.`);
    }
    if (key.length > MAX_RESPONSE_HEADER_NAME_CHARS) {
      throw new Error(`${label} header names must be at most ${MAX_RESPONSE_HEADER_NAME_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(key, MAX_RESPONSE_HEADER_NAME_BYTES) > MAX_RESPONSE_HEADER_NAME_BYTES) {
      throw new Error(`${label} header names must be at most ${MAX_RESPONSE_HEADER_NAME_BYTES} UTF-8 bytes.`);
    }
    const lowerKey = key.toLowerCase();
    if (lowerKeys.has(lowerKey)) {
      throw new Error(`${label} must not contain duplicate case-insensitive header names.`);
    }
    lowerKeys.set(lowerKey, key);
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(key)) {
      throw new Error(`${label}.${key} is not a valid header name.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(headers, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
    if (descriptor.value !== undefined && typeof descriptor.value !== "string") {
      throw new Error(`${label}.${key} must be a string when provided.`);
    }
  }
  const originalKey = lowerKeys.get("content-type");
  if (originalKey === undefined) {
    return undefined;
  }
  return validateOptionalContentType(dataProperty(headers, originalKey, label), `${label}.content-type`);
}

function isNativeHeaders(value: unknown): value is Headers {
  if (typeof Headers === "undefined") {
    return false;
  }
  try {
    return value instanceof Headers;
  } catch {
    return false;
  }
}

function validateOptionalContentType(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }
  if (value.length > MAX_RESPONSE_CONTENT_TYPE_CHARS) {
    throw new Error(`${label} must be at most ${MAX_RESPONSE_CONTENT_TYPE_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_RESPONSE_CONTENT_TYPE_BYTES) > MAX_RESPONSE_CONTENT_TYPE_BYTES) {
    throw new Error(`${label} must be at most ${MAX_RESPONSE_CONTENT_TYPE_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return value;
}

export function parseOpenAiTextResponse(payload: unknown, role: string): string {
  const safeRole = validateRoleLabel(role, "OpenAI-compatible response role");
  assertPlainResponseObject(payload, `OpenAI-compatible response for ${safeRole}`);
  assertKnownResponseFields(payload, `OpenAI-compatible response for ${safeRole}`, [
    "id",
    "object",
    "created",
    "model",
    "choices",
    "usage",
    "system_fingerprint",
    "service_tier"
  ]);
  validateResponseMetaString(dataProperty(payload, "id", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.id`);
  validateResponseObjectType(dataProperty(payload, "object", `OpenAI-compatible response for ${safeRole}`), safeRole);
  validateResponseCreated(dataProperty(payload, "created", `OpenAI-compatible response for ${safeRole}`), safeRole);
  validateResponseMetaString(dataProperty(payload, "model", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.model`);
  validateResponseUsage(dataProperty(payload, "usage", `OpenAI-compatible response for ${safeRole}`), safeRole);
  validateResponseMetaString(dataProperty(payload, "system_fingerprint", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.system_fingerprint`);
  validateResponseMetaString(dataProperty(payload, "service_tier", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.service_tier`);
  const choices = dataProperty(payload, "choices", `OpenAI-compatible response for ${safeRole}`);
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error(`OpenAI-compatible response for ${safeRole} must include a non-empty choices array.`);
  }
  if (choices.length > MAX_OPENAI_CHOICES) {
    throw new Error(`OpenAI-compatible response for ${safeRole} must include at most ${MAX_OPENAI_CHOICES} choices.`);
  }
  assertOpenAiChoicesArray(choices, `OpenAI-compatible response for ${safeRole}.choices`);
  const firstChoice = arrayItem(choices, 0, `OpenAI-compatible response for ${safeRole}.choices`);
  if (!firstChoice || typeof firstChoice !== "object" || Array.isArray(firstChoice)) {
    throw new Error(`OpenAI-compatible response for ${safeRole} must include an object choice.`);
  }
  assertPlainResponseObject(firstChoice, `OpenAI-compatible response for ${safeRole}.choices[0]`);
  assertKnownResponseFields(firstChoice, `OpenAI-compatible response for ${safeRole}.choices[0]`, ["index", "message", "finish_reason", "logprobs"]);
  validateChoiceIndex(dataProperty(firstChoice, "index", `OpenAI-compatible response for ${safeRole}.choices[0]`), safeRole);
  validateFinishReason(dataProperty(firstChoice, "finish_reason", `OpenAI-compatible response for ${safeRole}.choices[0]`), safeRole);
  validateLogprobs(dataProperty(firstChoice, "logprobs", `OpenAI-compatible response for ${safeRole}.choices[0]`), safeRole);
  const message = dataProperty(firstChoice, "message", `OpenAI-compatible response for ${safeRole}.choices[0]`);
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    throw new Error(`OpenAI-compatible response for ${safeRole} must include choice.message.`);
  }
  assertPlainResponseObject(message, `OpenAI-compatible response for ${safeRole}.choices[0].message`);
  assertKnownResponseFields(message, `OpenAI-compatible response for ${safeRole}.choices[0].message`, ["role", "content", "refusal", "annotations"]);
  validateMessageRole(dataProperty(message, "role", `OpenAI-compatible response for ${safeRole}.choices[0].message`), safeRole);
  validateMessageRefusal(dataProperty(message, "refusal", `OpenAI-compatible response for ${safeRole}.choices[0].message`), safeRole);
  validateMessageAnnotations(dataProperty(message, "annotations", `OpenAI-compatible response for ${safeRole}.choices[0].message`), safeRole);
  const content = dataProperty(message, "content", `OpenAI-compatible response for ${safeRole}.choices[0].message`);
  if (typeof content !== "string") {
    throw new Error(`OpenAI-compatible response for ${safeRole} must include string choice.message.content.`);
  }
  const text = content.trim();
  if (!text) {
    throw new Error(`OpenAI-compatible response for ${safeRole} returned empty choice.message.content.`);
  }
  if (text.length > MAX_OPENAI_CONTENT_CHARS) {
    throw new Error(`OpenAI-compatible response for ${safeRole}.choices[0].message.content must be at most ${MAX_OPENAI_CONTENT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_OPENAI_CONTENT_BYTES) > MAX_OPENAI_CONTENT_BYTES) {
    throw new Error(`OpenAI-compatible response for ${safeRole}.choices[0].message.content must be at most ${MAX_OPENAI_CONTENT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new Error(`OpenAI-compatible response for ${safeRole}.choices[0].message.content must not contain control characters.`);
  }
  return text;
}

function assertPlainResponseObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  const prototype = safeGetPrototypeOf(value, label);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain JSON object.`);
  }
}

function validateMessageRole(value: unknown, role: string): void {
  if (value === undefined) {
    return;
  }
  if (value !== "assistant") {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].message.role must be assistant when provided.`);
  }
}

function validateMessageRefusal(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  throw new Error(`OpenAI-compatible response for ${role}.choices[0].message.refusal must be null when provided.`);
}

function validateResponseMetaString(value: unknown, label: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string when provided.`);
  }
  if (value.length > MAX_OPENAI_RESPONSE_META_CHARS) {
    throw new Error(`${label} must be at most ${MAX_OPENAI_RESPONSE_META_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_OPENAI_RESPONSE_META_BYTES) > MAX_OPENAI_RESPONSE_META_BYTES) {
    throw new Error(`${label} must be at most ${MAX_OPENAI_RESPONSE_META_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
}

function validateResponseObjectType(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  validateResponseMetaString(value, `OpenAI-compatible response for ${role}.object`);
  if (value !== "chat.completion") {
    throw new Error(`OpenAI-compatible response for ${role}.object must be chat.completion when provided.`);
  }
}

function validateResponseCreated(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`OpenAI-compatible response for ${role}.created must be a non-negative safe integer when provided.`);
  }
}

function validateResponseUsage(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  const label = `OpenAI-compatible response for ${role}.usage`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object when provided.`);
  }
  assertPlainResponseObject(value, label);
  assertKnownResponseFields(value, label, [
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "prompt_tokens_details",
    "completion_tokens_details"
  ]);
  const promptTokens = validateUsageTokenCount(dataProperty(value, "prompt_tokens", label), `${label}.prompt_tokens`);
  const completionTokens = validateUsageTokenCount(dataProperty(value, "completion_tokens", label), `${label}.completion_tokens`);
  const totalTokens = validateUsageTokenCount(dataProperty(value, "total_tokens", label), `${label}.total_tokens`);
  if (promptTokens !== undefined && completionTokens !== undefined && totalTokens !== undefined && promptTokens + completionTokens !== totalTokens) {
    throw new Error(`${label}.total_tokens must equal prompt_tokens plus completion_tokens when all three are provided.`);
  }
  validateUsageDetails(dataProperty(value, "prompt_tokens_details", label), `${label}.prompt_tokens_details`, ["cached_tokens", "audio_tokens"]);
  validateUsageDetails(dataProperty(value, "completion_tokens_details", label), `${label}.completion_tokens_details`, [
    "reasoning_tokens",
    "audio_tokens",
    "accepted_prediction_tokens",
    "rejected_prediction_tokens"
  ]);
}

function validateUsageTokenCount(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer when provided.`);
  }
  return value;
}

function validateUsageDetails(value: unknown, label: string, allowedFields: string[]): void {
  if (value === undefined || value === null) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object when provided.`);
  }
  assertPlainResponseObject(value, label);
  assertKnownResponseFields(value, label, allowedFields);
  for (const field of allowedFields) {
    validateUsageTokenCount(dataProperty(value, field, label), `${label}.${field}`);
  }
}

function validateMessageAnnotations(value: unknown, role: string): void {
  if (value === undefined) {
    return;
  }
  const label = `OpenAI-compatible response for ${role}.choices[0].message.annotations`;
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array when provided.`);
  }
  if (value.length > MAX_OPENAI_ANNOTATIONS) {
    throw new Error(`${label} must include at most ${MAX_OPENAI_ANNOTATIONS} annotations.`);
  }
  assertOpenAiChoicesArray(value, label);
  for (let index = 0; index < value.length; index += 1) {
    const annotation = arrayItem(value, index, label);
    if (!annotation || typeof annotation !== "object" || Array.isArray(annotation)) {
      throw new Error(`${label}[${index}] must be a JSON object.`);
    }
    assertPlainResponseObject(annotation, `${label}[${index}]`);
    assertAnnotationFields(annotation, `${label}[${index}]`);
  }
}

function assertAnnotationFields(value: object, label: string): void {
  let fieldCount = 0;
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    fieldCount += 1;
    if (fieldCount > MAX_OPENAI_ANNOTATION_FIELDS) {
      throw new Error(`${label} must contain at most ${MAX_OPENAI_ANNOTATION_FIELDS} fields.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
    validateAnnotationJsonValue(descriptor.value, `${label}.${key}`);
  }
}

function validateAnnotationJsonValue(value: unknown, label: string): void {
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, currentLabel: string, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_OPENAI_ANNOTATION_TOTAL_NODES) {
      throw new Error(`${label} must contain at most ${MAX_OPENAI_ANNOTATION_TOTAL_NODES} JSON values.`);
    }
    if (depth > MAX_OPENAI_ANNOTATION_DEPTH) {
      throw new Error(`${currentLabel} must be nested at most ${MAX_OPENAI_ANNOTATION_DEPTH} levels deep.`);
    }
    if (current === undefined) {
      throw new Error(`${currentLabel} must not be undefined.`);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${currentLabel} must be a finite number.`);
      }
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new Error(`${currentLabel} must be a safe integer.`);
      }
      return;
    }
    if (typeof current === "string") {
      if (current.length > MAX_OPENAI_ANNOTATION_STRING_CHARS) {
        throw new Error(`${currentLabel} must be at most ${MAX_OPENAI_ANNOTATION_STRING_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(current, MAX_OPENAI_ANNOTATION_STRING_BYTES) > MAX_OPENAI_ANNOTATION_STRING_BYTES) {
        throw new Error(`${currentLabel} must be at most ${MAX_OPENAI_ANNOTATION_STRING_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(current)) {
        throw new Error(`${currentLabel} must not contain control characters.`);
      }
      return;
    }
    if (current === null || typeof current === "boolean") {
      return;
    }
    if (typeof current !== "object") {
      throw new Error(`${currentLabel} must contain only JSON-compatible values.`);
    }
    if (stack.has(current)) {
      throw new Error(`${currentLabel} must not contain circular references.`);
    }
    stack.add(current);
    if (Array.isArray(current)) {
      if (safeGetPrototypeOf(current, currentLabel) !== Array.prototype) {
        throw new Error(`${currentLabel} must be a standard array.`);
      }
      if (current.length > MAX_OPENAI_ANNOTATION_ARRAY_ITEMS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_OPENAI_ANNOTATION_ARRAY_ITEMS} array items.`);
      }
      assertOpenAiChoicesArray(current, currentLabel);
      for (let index = 0; index < current.length; index += 1) {
        visit(arrayItem(current, index, currentLabel), `${currentLabel}[${index}]`, depth + 1);
      }
      stack.delete(current);
      return;
    }
    const prototype = safeGetPrototypeOf(current, currentLabel);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${currentLabel} must be a plain JSON object.`);
    }
    let fieldCount = 0;
    for (const key of safeOwnKeys(current, currentLabel)) {
      if (typeof key !== "string") {
        throw new Error(`${currentLabel} must not contain symbol properties.`);
      }
      fieldCount += 1;
      if (fieldCount > MAX_OPENAI_ANNOTATION_FIELDS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_OPENAI_ANNOTATION_FIELDS} fields.`);
      }
      if (key.length > MAX_OPENAI_ANNOTATION_KEY_CHARS) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_OPENAI_ANNOTATION_KEY_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(key, MAX_OPENAI_ANNOTATION_KEY_BYTES) > MAX_OPENAI_ANNOTATION_KEY_BYTES) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_OPENAI_ANNOTATION_KEY_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error(`${currentLabel} object keys must not contain control characters.`);
      }
      const descriptor = safeGetOwnPropertyDescriptor(current, key, currentLabel);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${currentLabel}.${key} must be an enumerable data property.`);
      }
      visit(descriptor.value, `${currentLabel}.${key}`, depth + 1);
    }
    stack.delete(current);
  };
  visit(value, label, 0);
}

function validateChoiceIndex(value: unknown, role: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value !== 0) {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].index must be 0 when provided.`);
  }
}

function validateLogprobs(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  throw new Error(`OpenAI-compatible response for ${role}.choices[0].logprobs must be null when provided.`);
}

function validateFinishReason(value: unknown, role: string): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].finish_reason must be a non-empty string when provided.`);
  }
  if (value.length > MAX_OPENAI_FINISH_REASON_CHARS) {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].finish_reason must be at most ${MAX_OPENAI_FINISH_REASON_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_OPENAI_FINISH_REASON_BYTES) > MAX_OPENAI_FINISH_REASON_BYTES) {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].finish_reason must be at most ${MAX_OPENAI_FINISH_REASON_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].finish_reason must not contain control characters.`);
  }
  if (value !== "stop") {
    throw new Error(`OpenAI-compatible response for ${role}.choices[0].finish_reason must be stop for complete text responses.`);
  }
}

function validateRoleLabel(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  const text = value.trim();
  if (text.length > MAX_OPENAI_ROLE_LABEL_CHARS) {
    throw new Error(`${label} must be at most ${MAX_OPENAI_ROLE_LABEL_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_OPENAI_ROLE_LABEL_BYTES) > MAX_OPENAI_ROLE_LABEL_BYTES) {
    throw new Error(`${label} must be at most ${MAX_OPENAI_ROLE_LABEL_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(text)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  return text;
}

function dataProperty(value: object, key: string, label: string): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`${label}.${key} must be an enumerable data property.`);
  }
  return descriptor.value;
}

function assertKnownResponseFields(value: object, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!allowedFields.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}.${key} must be an enumerable data property.`);
    }
  }
}

function arrayItem(value: unknown[], index: number, label: string): unknown {
  const descriptor = safeGetOwnPropertyDescriptor(value, String(index), label);
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`${label}[${index}] must be an enumerable data item.`);
  }
  return descriptor.value;
}

function assertOpenAiChoicesArray(value: unknown[], label: string): void {
  if (safeGetPrototypeOf(value, label) !== Array.prototype) {
    throw new Error(`${label} must be a standard array.`);
  }
  for (const key of safeOwnKeys(value, label)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`${label}.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${key}] must be an enumerable data item.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!safeGetOwnPropertyDescriptor(value, String(index), label)) {
      throw new Error(`${label}[${index}] must not be a sparse array hole.`);
    }
  }
}

export function parseIssuePrefixedResult(result: AgentResult): AgentResult {
  const textInput = validateIssuePrefixedResultInput(result);
  const lines = textInput.split("\n");
  const rawIssues = lines
    .filter((line) => line.startsWith("ISSUE:"))
    .map((line) => line.slice("ISSUE:".length).trim())
    .filter(Boolean);
  const issues = rawIssues.slice(0, MAX_ISSUE_PREFIXED_ITEMS).map(truncateIssuePrefixedText);
  if (rawIssues.length > MAX_ISSUE_PREFIXED_ITEMS) {
    issues.splice(MAX_ISSUE_PREFIXED_ITEMS - 1, 1, `[truncated ${rawIssues.length - (MAX_ISSUE_PREFIXED_ITEMS - 1)} issue-prefixed issues]`);
  }
  const text = lines.filter((line) => !line.startsWith("ISSUE:")).join("\n").trim();
  return { text: text || textInput, issues };
}

function validateIssuePrefixedResultInput(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Issue-prefixed agent result must be an object.");
  }
  assertIssuePrefixedResultSurface(value);
  const descriptor = safeGetOwnPropertyDescriptor(value, "text", "Issue-prefixed agent result");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
    throw new Error("Issue-prefixed agent result.text must be an enumerable data property.");
  }
  if (typeof descriptor.value !== "string" || descriptor.value.trim().length === 0) {
    throw new Error("Issue-prefixed agent result.text must be a non-empty string.");
  }
  if (descriptor.value.length > MAX_ISSUE_PREFIXED_TEXT_CHARS) {
    throw new Error(`Issue-prefixed agent result.text must be at most ${MAX_ISSUE_PREFIXED_TEXT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(descriptor.value, MAX_ISSUE_PREFIXED_TEXT_BYTES) > MAX_ISSUE_PREFIXED_TEXT_BYTES) {
    throw new Error(`Issue-prefixed agent result.text must be at most ${MAX_ISSUE_PREFIXED_TEXT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(descriptor.value)) {
    throw new Error("Issue-prefixed agent result.text must not contain control characters.");
  }
  return descriptor.value;
}

function assertIssuePrefixedResultSurface(value: object): void {
  const prototype = safeGetPrototypeOf(value, "Issue-prefixed agent result");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Issue-prefixed agent result must be a plain object.");
  }
  for (const key of safeOwnKeys(value, "Issue-prefixed agent result")) {
    if (typeof key !== "string") {
      throw new Error("Issue-prefixed agent result must not contain symbol properties.");
    }
    if (key !== "text" && key !== "issues") {
      throw new Error(`Issue-prefixed agent result.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "Issue-prefixed agent result");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`Issue-prefixed agent result.${key} must be an enumerable data property.`);
    }
    if (key === "issues" && descriptor.value !== undefined) {
      validateIssuePrefixedInputIssues(descriptor.value);
    }
  }
}

function validateIssuePrefixedInputIssues(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("Issue-prefixed agent result.issues must be an array when provided.");
  }
  if (safeGetPrototypeOf(value, "Issue-prefixed agent result.issues") !== Array.prototype) {
    throw new Error("Issue-prefixed agent result.issues must be a standard array.");
  }
  if (value.length > MAX_ISSUE_PREFIXED_ITEMS) {
    throw new Error(`Issue-prefixed agent result.issues must contain at most ${MAX_ISSUE_PREFIXED_ITEMS} items.`);
  }
  assertOpenAiChoicesArray(value, "Issue-prefixed agent result.issues");
  for (let index = 0; index < value.length; index += 1) {
    const issue = arrayItem(value, index, "Issue-prefixed agent result.issues");
    if (typeof issue !== "string" || issue.trim().length === 0) {
      throw new Error(`Issue-prefixed agent result.issues[${index}] must be a non-empty string.`);
    }
    if (issue.length > MAX_ISSUE_PREFIXED_CHARS) {
      throw new Error(`Issue-prefixed agent result.issues[${index}] must be at most ${MAX_ISSUE_PREFIXED_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(issue, MAX_ISSUE_PREFIXED_BYTES) > MAX_ISSUE_PREFIXED_BYTES) {
      throw new Error(`Issue-prefixed agent result.issues[${index}] must be at most ${MAX_ISSUE_PREFIXED_BYTES} UTF-8 bytes.`);
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(issue)) {
      throw new Error(`Issue-prefixed agent result.issues[${index}] must not contain control characters.`);
    }
  }
}

function truncateIssuePrefixedText(value: string): string {
  if (
    value.length <= MAX_ISSUE_PREFIXED_CHARS &&
    utf8ByteLengthUpTo(value, MAX_ISSUE_PREFIXED_BYTES) <= MAX_ISSUE_PREFIXED_BYTES
  ) {
    return value;
  }
  const marker =
    value.length > MAX_ISSUE_PREFIXED_CHARS
      ? `... [truncated ${value.length - MAX_ISSUE_PREFIXED_CHARS} chars]`
      : `... [truncated ${Math.max(0, utf8ByteLength(value) - MAX_ISSUE_PREFIXED_BYTES)} UTF-8 bytes]`;
  return truncateTextByCharsAndBytesWithMarker(value, marker, MAX_ISSUE_PREFIXED_CHARS, MAX_ISSUE_PREFIXED_BYTES);
}

function truncateTextByCharsAndBytesWithMarker(value: string, marker: string, maxChars: number, maxBytes: number): string {
  let output = "";
  for (const char of value) {
    const candidate = `${output}${char}`;
    if (candidate.length > maxChars || utf8ByteLengthUpTo(`${candidate}${marker}`, maxBytes) > maxBytes) {
      break;
    }
    output = candidate;
  }
  return `${output}${marker}`;
}

function system(content: string): ChatMessage {
  return { role: "system", content };
}

function user(content: string): ChatMessage {
  return { role: "user", content };
}

function json(value: unknown): string {
  try {
    return JSON.stringify(normalizePromptJsonValue(value, "OpenAI-compatible prompt context"), null, 2);
  } catch (error) {
    throw new Error(`OpenAI-compatible prompt context must be JSON serializable: ${errorMessage(error)}`);
  }
}

function normalizePromptJsonValue(value: unknown, label: string): unknown {
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, currentLabel: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_PROMPT_CONTEXT_TOTAL_NODES) {
      throw new Error(`${label} must contain at most ${MAX_PROMPT_CONTEXT_TOTAL_NODES} JSON values.`);
    }
    if (depth > MAX_PROMPT_CONTEXT_DEPTH) {
      throw new Error(`${currentLabel} must be nested at most ${MAX_PROMPT_CONTEXT_DEPTH} levels deep.`);
    }
    if (current === undefined) {
      throw new Error(`${currentLabel} must not be undefined.`);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) {
        throw new Error(`${currentLabel} must be a finite number.`);
      }
      if (Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new Error(`${currentLabel} must be a safe integer.`);
      }
    }
    if (typeof current === "string") {
      if (current.length > MAX_PROMPT_CONTEXT_STRING_CHARS) {
        throw new Error(`${currentLabel} must be at most ${MAX_PROMPT_CONTEXT_STRING_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(current, MAX_PROMPT_CONTEXT_STRING_BYTES) > MAX_PROMPT_CONTEXT_STRING_BYTES) {
        throw new Error(`${currentLabel} must be at most ${MAX_PROMPT_CONTEXT_STRING_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(current)) {
        throw new Error(`${currentLabel} must not contain control characters.`);
      }
      return current;
    }
    if (current === null || typeof current === "number" || typeof current === "boolean") {
      return current;
    }
    if (typeof current !== "object") {
      throw new Error(`${currentLabel} must contain only JSON-compatible values.`);
    }
    if (stack.has(current)) {
      throw new Error(`${currentLabel} must not contain circular references.`);
    }
    stack.add(current);
    if (Array.isArray(current)) {
      if (safeGetPrototypeOf(current, currentLabel) !== Array.prototype) {
        throw new Error(`${currentLabel} must be a standard array.`);
      }
      if (current.length > MAX_PROMPT_CONTEXT_ARRAY_ITEMS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_PROMPT_CONTEXT_ARRAY_ITEMS} array items.`);
      }
      assertPromptArrayDataProperties(current, currentLabel);
      const output: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel);
        if (!descriptor) {
          throw new Error(`${currentLabel}[${index}] must not be a sparse array hole.`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${currentLabel}[${index}] must be an enumerable data item.`);
        }
        output.push(visit(descriptor.value, `${currentLabel}[${index}]`, depth + 1));
      }
      stack.delete(current);
      Object.setPrototypeOf(output, null);
      return output;
    }
    const prototype = safeGetPrototypeOf(current, currentLabel);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${currentLabel} must be a plain JSON object.`);
    }
    const keys = safeOwnKeys(current, currentLabel);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error(`${currentLabel} must not contain symbol properties.`);
    }
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      if (typeof key !== "string") {
        throw new Error(`${currentLabel} must not contain symbol properties.`);
      }
      const descriptor = safeGetOwnPropertyDescriptor(current, key, currentLabel);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${currentLabel} must not contain non-enumerable or accessor properties.`);
      }
      entries.push([key, descriptor.value]);
    }
    if (entries.length > MAX_PROMPT_CONTEXT_OBJECT_FIELDS) {
      throw new Error(`${currentLabel} must contain at most ${MAX_PROMPT_CONTEXT_OBJECT_FIELDS} object fields.`);
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of entries) {
      if (key.length > MAX_PROMPT_CONTEXT_OBJECT_KEY_CHARS) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_PROMPT_CONTEXT_OBJECT_KEY_CHARS} characters.`);
      }
      if (utf8ByteLengthUpTo(key, MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES) > MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES) {
        throw new Error(`${currentLabel} object keys must be at most ${MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error(`${currentLabel} object keys must not contain control characters.`);
      }
      Object.defineProperty(output, key, {
        value: visit(item, `${currentLabel}.${key}`, depth + 1),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    stack.delete(current);
    return output;
  };
  return visit(value, label, 0);
}

function assertPromptArrayDataProperties(value: unknown[], label: string): void {
  for (const key of safeOwnKeys(value, label)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`${label}.${key} is not a supported array field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${key}] must be an enumerable data item.`);
    }
  }
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function openAiRequestBody(value: unknown, role: string): string {
  let body: string;
  try {
    body = JSON.stringify(normalizePromptJsonValue(value, `OpenAI-compatible request body for ${role}`));
  } catch (error) {
    throw new Error(`OpenAI-compatible request body for ${role} must be JSON serializable: ${errorMessage(error)}`);
  }
  if (body.length > MAX_REQUEST_BODY_CHARS) {
    throw new Error(`OpenAI-compatible request body for ${role} must be at most ${MAX_REQUEST_BODY_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(body, MAX_REQUEST_BODY_BYTES) > MAX_REQUEST_BODY_BYTES) {
    throw new Error(`OpenAI-compatible request body for ${role} must be at most ${MAX_REQUEST_BODY_BYTES} UTF-8 bytes.`);
  }
  return body;
}

function parseOpenAiJsonBody(body: unknown, role: string): unknown {
  if (typeof body !== "string") {
    throw new Error(`OpenAI-compatible response body for ${role} must be a string.`);
  }
  if (body.length > MAX_RESPONSE_BODY_CHARS) {
    throw new Error(`OpenAI-compatible response body for ${role} must be at most ${MAX_RESPONSE_BODY_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(body, MAX_RESPONSE_BODY_BYTES) > MAX_RESPONSE_BODY_BYTES) {
    throw new Error(`OpenAI-compatible response body for ${role} must be at most ${MAX_RESPONSE_BODY_BYTES} UTF-8 bytes.`);
  }
  try {
    assertNoDuplicateJsonObjectKeys(body, `OpenAI-compatible response body for ${role}`, MAX_RESPONSE_JSON_DEPTH);
    return JSON.parse(body) as unknown;
  } catch (error) {
    throw new Error(`OpenAI-compatible response body for ${role} must be valid JSON: ${errorMessage(error)}`);
  }
}

function isRetryableError(error: Error): boolean {
  return /^Http(408|409|425|429|5\d\d)$/.test(error.name) || error.name === "AbortError" || error.name === "TypeError";
}

function retryDelayMs(config: OpenAiRuntimeConfig, attempt: number): number {
  return Math.min(config.openaiRetryBaseMs * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function requestTimeoutMs(config: OpenAiRuntimeConfig, deadlineAt: number): number {
  return timeoutMsForTimer(Math.min(config.openaiTimeoutMs, remainingOpenAiMs("request", deadlineAt)));
}

function remainingOpenAiMs(role: string, deadlineAt: number): number {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    throw new Error(`OpenAI-compatible request deadline exceeded for ${role}.`);
  }
  return remaining;
}

function assertOpenAiDeadline(role: string, deadlineAt: number): void {
  remainingOpenAiMs(role, deadlineAt);
}

async function readResponseText(response: FetchResponseLike, role: string, deadlineAt: number): Promise<string> {
  const remainingMs = timeoutMsForTimer(remainingOpenAiMs(role, deadlineAt));
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const body = await Promise.race([
      response.text(),
      new Promise<string>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`OpenAI-compatible response body read deadline exceeded for ${role}.`));
        }, remainingMs);
      })
    ]);
    if (typeof body !== "string") {
      throw new Error(`OpenAI-compatible response body for ${role} must be a string.`);
    }
    if (body.length > MAX_RESPONSE_BODY_CHARS) {
      throw new Error(`OpenAI-compatible response body for ${role} must be at most ${MAX_RESPONSE_BODY_CHARS} characters.`);
    }
    if (utf8ByteLengthUpTo(body, MAX_RESPONSE_BODY_BYTES) > MAX_RESPONSE_BODY_BYTES) {
      throw new Error(`OpenAI-compatible response body for ${role} must be at most ${MAX_RESPONSE_BODY_BYTES} UTF-8 bytes.`);
    }
    return body;
  } catch (error) {
    throw new Error(`OpenAI-compatible response body read failed for ${role}: ${errorMessage(error)}`);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}

function utf8ByteLengthUpTo(value: string, maxBytes: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar = first;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        index += 1;
      }
    }
    bytes += utf8ScalarByteLength(scalar);
    if (bytes > maxBytes) {
      return bytes;
    }
  }
  return bytes;
}

function utf8ScalarByteLength(scalar: number): number {
  if (scalar <= 0x7f) {
    return 1;
  }
  if (scalar <= 0x7ff) {
    return 2;
  }
  if (scalar <= 0xffff) {
    return 3;
  }
  return 4;
}

function timeoutMsForTimer(ms: number): number {
  return Math.min(ms, MAX_SET_TIMEOUT_MS);
}

function truncateErrorBody(body: string): string {
  if (body.length <= MAX_ERROR_BODY_CHARS && utf8ByteLengthUpTo(body, MAX_ERROR_BODY_BYTES) <= MAX_ERROR_BODY_BYTES) {
    return body;
  }
  const marker =
    body.length > MAX_ERROR_BODY_CHARS
      ? `... [truncated ${body.length - MAX_ERROR_BODY_CHARS} chars]`
      : `... [truncated ${Math.max(0, utf8ByteLength(body) - MAX_ERROR_BODY_BYTES)} UTF-8 bytes]`;
  return truncateTextByCharsAndBytesWithMarker(body, marker, MAX_ERROR_BODY_CHARS, MAX_ERROR_BODY_BYTES);
}

function redactSecrets(value: string, config: OpenAiRuntimeConfig): string {
  let redacted = redactInlineSecrets(value.replace(OPENAI_ERROR_CONTROL_CHARS_GLOBAL, " "));
  redacted = redacted.split(config.openaiBaseUrl).join("<openai-base-url>");
  if (config.openaiApiKey) {
    redacted = redacted.split(config.openaiApiKey).join("<openai-api-key>");
  }
  return redacted;
}

function normalizeOpenAiError(error: unknown, config: OpenAiRuntimeConfig): Error {
  const normalized = new Error(truncateOpenAiErrorText(redactSecrets(redactErrorMessage(error), config)));
  normalized.name = safeErrorName(error);
  return normalized;
}

function errorMessage(error: unknown): string {
  const message = redactErrorMessage(error).replace(OPENAI_ERROR_CONTROL_CHARS_GLOBAL, " ");
  return truncateOpenAiErrorText(message);
}

function truncateOpenAiErrorText(message: string): string {
  if (
    message.length <= MAX_OPENAI_ERROR_CHARS &&
    utf8ByteLengthUpTo(message, MAX_OPENAI_ERROR_BYTES) <= MAX_OPENAI_ERROR_BYTES
  ) {
    return message;
  }
  const marker =
    message.length > MAX_OPENAI_ERROR_CHARS
      ? `... [truncated ${message.length - MAX_OPENAI_ERROR_CHARS} chars]`
      : `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_OPENAI_ERROR_BYTES)} UTF-8 bytes]`;
  return truncateTextByCharsAndBytesWithMarker(message, marker, MAX_OPENAI_ERROR_CHARS, MAX_OPENAI_ERROR_BYTES);
}

function safeErrorName(error: unknown): string {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return "Error";
  }
  let current: object | null = error;
  while (current) {
    const descriptor = safeErrorNameDescriptor(current);
    if (descriptor === false) {
      return "Error";
    }
    if (descriptor) {
      if ("value" in descriptor && typeof descriptor.value === "string" && isSafeErrorName(descriptor.value)) {
        return descriptor.value;
      }
      return "Error";
    }
    const prototype = safeErrorPrototype(current);
    if (prototype === false) {
      return "Error";
    }
    current = prototype;
  }
  return "Error";
}

function safeErrorNameDescriptor(value: object): PropertyDescriptor | undefined | false {
  try {
    return Object.getOwnPropertyDescriptor(value, "name");
  } catch {
    return false;
  }
}

function safeErrorPrototype(value: object): object | null | false {
  try {
    return Object.getPrototypeOf(value);
  } catch {
    return false;
  }
}

function isSafeErrorName(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_OPENAI_ERROR_NAME_CHARS
    && utf8ByteLengthUpTo(value, MAX_OPENAI_ERROR_NAME_BYTES) <= MAX_OPENAI_ERROR_NAME_BYTES
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}
