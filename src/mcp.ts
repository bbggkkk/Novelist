import { dirname, isAbsolute, resolve } from "node:path";
import { NovelPipeline } from "./pipeline.js";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import { createNovelAgents } from "./agentFactory.js";
import { NovelStorage } from "./storage.js";
import { JobManager } from "./jobs.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import { validateToolResultShape } from "./toolResultValidation.js";
import { assertNoDuplicateJsonObjectKeys } from "./jsonPreflight.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";
import type { ToolResult } from "./types.js";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcHandler {
  handle(request: unknown): Promise<unknown>;
}

interface StdioLineProcessorOptions {
  maxLineLength?: number;
}

const MAX_MCP_ERROR_CHARS = 4000;
const MAX_MCP_ERROR_BYTES = 4000;
const MAX_TOOL_RESPONSE_TEXT_CHARS = 256 * 1024;
const MAX_TOOL_RESPONSE_TEXT_BYTES = 256 * 1024;
const MAX_TOOL_RESULT_MESSAGE_CHARS = 4000;
const MAX_JSON_RPC_ID_STRING_CHARS = 256;
const MAX_JSON_RPC_ID_STRING_BYTES = 256;
const MAX_JSON_RPC_METHOD_CHARS = 128;
const MAX_JSON_RPC_METHOD_BYTES = 128;
const MAX_JSON_RPC_VALUE_DEPTH = 32;
const MAX_JSON_RPC_OBJECT_FIELDS = 100;
const MAX_JSON_RPC_OBJECT_KEY_CHARS = 256;
const MAX_JSON_RPC_OBJECT_KEY_BYTES = 512;
const MAX_JSON_RPC_ARRAY_ITEMS = 1000;
const MAX_JSON_RPC_TOTAL_NODES = 10000;
const MAX_JSON_RPC_STRING_CHARS = 16 * 1024;
const MAX_JSON_RPC_STRING_BYTES = 16 * 1024;
const MAX_MCP_STORAGE_ROOT_CHARS = 4096;
const MAX_MCP_STORAGE_ROOT_BYTES = 4096;
const JSON_RPC_REQUEST_VALUE_LIMITS = {
  maxDepth: MAX_JSON_RPC_VALUE_DEPTH,
  maxObjectFields: MAX_JSON_RPC_OBJECT_FIELDS,
  maxObjectKeyChars: MAX_JSON_RPC_OBJECT_KEY_CHARS,
  maxObjectKeyBytes: MAX_JSON_RPC_OBJECT_KEY_BYTES,
  maxArrayItems: MAX_JSON_RPC_ARRAY_ITEMS,
  maxTotalNodes: MAX_JSON_RPC_TOTAL_NODES,
  maxStringChars: MAX_JSON_RPC_STRING_CHARS,
  maxStringBytes: MAX_JSON_RPC_STRING_BYTES
};
const JSON_RPC_RESPONSE_VALUE_LIMITS = {
  maxDepth: 64,
  maxObjectFields: 1000,
  maxObjectKeyChars: 1024,
  maxObjectKeyBytes: 4096,
  maxArrayItems: 10000,
  maxTotalNodes: 100000,
  maxStringChars: MAX_TOOL_RESPONSE_TEXT_CHARS,
  maxStringBytes: MAX_TOOL_RESPONSE_TEXT_BYTES
};
const MCP_ERROR_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;
const JSON_RPC_NON_PRINTING_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MIN_STDIO_LINE_LENGTH = 256;
const MAX_STDIO_LINE_LENGTH = 16 * 1024 * 1024;
const MAX_STDIO_PENDING_LINES = 1000;
const MAX_TOOL_NAME_CHARS = 128;
const MAX_TOOL_NAME_BYTES = 128;
const MAX_TITLE_INPUT_CHARS = 512;
const MAX_TITLE_INPUT_BYTES = 512;
const MAX_OPTION_INPUT_CHARS = 256;
const MAX_OPTION_INPUT_BYTES = 256;
const MAX_INSTRUCTION_INPUT_CHARS = 16 * 1024;
const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024;
const SINGLE_LINE_PRINTABLE_PATTERN = "^(?=.*\\S)[^\\u0000-\\u001f\\u007f]+$";
const MULTILINE_PRINTABLE_PATTERN = "^(?=.*\\S)[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]+$";
const encoder = new TextEncoder();
const titleStringSchema = { type: "string", minLength: 1, maxLength: MAX_TITLE_INPUT_CHARS, "x-maxUtf8Bytes": MAX_TITLE_INPUT_BYTES, pattern: SINGLE_LINE_PRINTABLE_PATTERN };
const optionStringSchema = { type: "string", minLength: 1, maxLength: MAX_OPTION_INPUT_CHARS, "x-maxUtf8Bytes": MAX_OPTION_INPUT_BYTES, pattern: SINGLE_LINE_PRINTABLE_PATTERN };
const instructionStringSchema = { type: "string", minLength: 1, maxLength: MAX_INSTRUCTION_INPUT_CHARS, "x-maxUtf8Bytes": MAX_INSTRUCTION_INPUT_BYTES, pattern: MULTILINE_PRINTABLE_PATTERN };
const revisionTargetStringSchema = {
  type: "string",
  minLength: 1,
  maxLength: MAX_OPTION_INPUT_CHARS,
  "x-maxUtf8Bytes": MAX_OPTION_INPUT_BYTES,
  pattern: "^(?:[Cc][Hh][Aa][Pp][Tt][Ee][Rr]:[1-9]\\d*,? *[Bb][Ee][Aa][Tt]:[1-9]\\d*|[1-9]\\d*[-/][1-9]\\d*)$",
  description: "Revision selector: chapter:<n>,beat:<n>, chapter:<n> beat:<n>, <chapter>-<beat>, or <chapter>/<beat>."
};
const safeIdStringSchema = {
  type: "string",
  minLength: 1,
  maxLength: 120,
  "x-maxUtf8Bytes": 120,
  pattern: "^(?!.*\\.\\.)[a-z0-9가-힣][a-z0-9가-힣._-]*$",
  description: "Safe path ID segment. Runtime validation also caps this at 120 UTF-8 bytes."
};
const newProjectInputSchema = {
  type: "object",
  required: ["franchiseName", "workRequest"],
  properties: {
    franchiseName: titleStringSchema,
    workRequest: titleStringSchema,
    volumeRequest: titleStringSchema,
    genre: optionStringSchema,
    tone: optionStringSchema,
    targetLength: optionStringSchema
  },
  additionalProperties: false
};
const confirmInputSchema = {
  type: "object",
  required: ["confirmationId", "approved"],
  properties: {
    confirmationId: safeIdStringSchema,
    approved: { type: "boolean" },
    revisionInstruction: instructionStringSchema
  },
  oneOf: [
    {
      properties: {
        approved: { enum: [true] }
      }
    },
    {
      required: ["revisionInstruction"],
      properties: {
        approved: { enum: [false] }
      }
    }
  ],
  additionalProperties: false
};
const continueInputSchema = {
  type: "object",
  properties: {
    franchiseId: safeIdStringSchema,
    workId: safeIdStringSchema,
    volumeId: safeIdStringSchema,
    current: { type: "boolean" }
  },
  anyOf: [
    {
      not: {
        anyOf: [
          { required: ["franchiseId"] },
          { required: ["workId"] },
          { required: ["volumeId"] },
          { required: ["current"] }
        ]
      }
    },
    {
      required: ["current"],
      not: {
        anyOf: [
          { required: ["franchiseId"] },
          { required: ["workId"] },
          { required: ["volumeId"] }
        ]
      },
      properties: {
        current: { enum: [true] }
      }
    },
    {
      required: ["franchiseId", "workId", "volumeId"],
      properties: {
        current: { enum: [false] }
      }
    }
  ],
  additionalProperties: false
};
const reviseInputSchema = {
  type: "object",
  required: ["franchiseId", "workId", "volumeId", "target", "instruction"],
  properties: {
    franchiseId: safeIdStringSchema,
    workId: safeIdStringSchema,
    volumeId: safeIdStringSchema,
    target: revisionTargetStringSchema,
    instruction: instructionStringSchema
  },
  additionalProperties: false
};
const buildEpubInputSchema = {
  type: "object",
  required: ["franchiseId", "workId", "volumeId"],
  properties: {
    franchiseId: safeIdStringSchema,
    workId: safeIdStringSchema,
    volumeId: safeIdStringSchema
  },
  additionalProperties: false
};
const asyncJobToolSchemas = [
  { toolName: "novel_new_project", argsSchema: newProjectInputSchema, argsRequired: true },
  { toolName: "novel_confirm", argsSchema: confirmInputSchema, argsRequired: true },
  { toolName: "novel_continue", argsSchema: continueInputSchema, argsRequired: false },
  { toolName: "novel_revise", argsSchema: reviseInputSchema, argsRequired: true },
  { toolName: "novel_build_epub", argsSchema: buildEpubInputSchema, argsRequired: true }
].map(({ toolName, argsSchema, argsRequired }) => ({
  type: "object",
  required: argsRequired ? ["toolName", "args"] : ["toolName"],
  properties: {
    toolName: { type: "string", enum: [toolName] },
    args: argsSchema
  },
  additionalProperties: false
}));

const tools = [
  {
    name: "novel_health",
    description: "Return operational health information for the Novelist MCP server.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "novel_job_start",
    description: "Run a long novel operation in the background and return a job id.",
    inputSchema: {
      type: "object",
      oneOf: asyncJobToolSchemas
    }
  },
  {
    name: "novel_job_status",
    description: "Return status, result, or error for a background novel job.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: safeIdStringSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "novel_job_list",
    description: "List background novel jobs, optionally filtered by status.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", minLength: 1, enum: ["queued", "running", "succeeded", "failed", "cancelled"] },
        limit: { type: "integer", minimum: 1, maximum: 1000 },
        offset: { type: "integer", minimum: 0, maximum: 100000 }
      },
      additionalProperties: false
    }
  },
  {
    name: "novel_job_cleanup",
    description: "Delete finished background job snapshots older than the configured retention period.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false
    }
  },
  {
    name: "novel_job_cancel",
    description: "Request cancellation for a background novel job.",
    inputSchema: {
      type: "object",
      required: ["jobId"],
      properties: {
        jobId: safeIdStringSchema
      },
      additionalProperties: false
    }
  },
  {
    name: "novel_new_project",
    description: "Create a new franchise/work/volume pipeline and return an initial outline for user confirmation.",
    inputSchema: newProjectInputSchema
  },
  {
    name: "novel_confirm",
    description: "Resolve a pending confirmation and resume the novel pipeline.",
    inputSchema: confirmInputSchema
  },
  {
    name: "novel_continue",
    description: "Continue drafting and reviewing the current or specified volume pipeline.",
    inputSchema: continueInputSchema
  },
  {
    name: "novel_status",
    description: "Return status for the current or specified novel pipeline.",
    inputSchema: continueInputSchema
  },
  {
    name: "novel_revise",
    description: "Revise a target beat through the same write/edit/proofread/continuity pipeline.",
    inputSchema: reviseInputSchema
  },
  {
    name: "novel_build_epub",
    description: "Build a valid EPUB 3 archive for a completed volume.",
    inputSchema: buildEpubInputSchema
  }
];

export class McpServer {
  private readonly pipeline: NovelPipeline;
  private readonly logger: Logger;
  private readonly jobs: JobManager;
  private readonly ready: Promise<void>;
  private readonly redactionRoot?: string;
  private startupError?: string;

  constructor(
    pipeline?: NovelPipeline,
    logger?: Logger,
    storage?: NovelStorage
  ) {
    const config = loadConfig();
    const hasPipeline = pipeline !== undefined;
    const hasStorage = storage !== undefined;
    const defaults = hasPipeline ? undefined : createDefaultPipeline(config, hasStorage ? storage : undefined);
    this.pipeline = validateMcpPipeline(hasPipeline ? pipeline : defaults!.pipeline);
    this.logger = validateMcpLogger(logger ?? new Logger(config.logLevel));
    const jobStorage = hasStorage ? storage : defaults?.storage;
    this.redactionRoot = validateMcpStorage(jobStorage);
    this.jobs = new JobManager(this.pipeline, jobStorage, config.jobRetentionMs, config.maxConcurrentJobs, config.maxJobs);
    this.ready = this.jobs.loadPersistedJobs().then((result) => {
      this.logger.info("mcp_jobs_loaded", {
        loaded: result.loaded,
        recovered: result.recovered,
        failed: result.failed,
        quarantined: result.quarantined,
        skipped: result.skipped
      });
    }).catch((error: unknown) => {
      const message = redactRootInMessage(errorMessage(error), this.redactionRoot);
      this.startupError = message;
      this.logger.error("mcp_jobs_load_failed", { error: message });
    });
  }

  async handle(request: unknown): Promise<unknown> {
    try {
      const requestFields = validateJsonRpcRequest(request);
      if (requestFields.method === "initialize") {
        return maybeResponse(requestFields.id, {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: PACKAGE_NAME, version: PACKAGE_VERSION }
        });
      }
      if (requestFields.method === "tools/list") {
        return maybeResponse(requestFields.id, { tools: cloneJson(tools) });
      }
      if (requestFields.method === "tools/call") {
        const params = toolCallParams(requestFields.params);
        const toolName = parseToolName(params.name);
        await this.ready;
        if (this.startupError && toolName !== "novel_health") {
          throw new Error(`Server startup failed: ${this.startupError}`);
        }
        const baseResult = validateToolResultShape(
          await this.callTool(toolName, toolArguments(params.arguments)),
          `Tool result from ${toolName}`,
          MAX_TOOL_RESULT_MESSAGE_CHARS
        );
        const result = this.startupError && toolName === "novel_health"
          ? withStartupHealth(baseResult, this.startupError)
          : baseResult;
        const text = toolResultText(sanitizeToolResultForClient(
          validateToolResultShape(result, `Tool result from ${toolName}`, MAX_TOOL_RESULT_MESSAGE_CHARS),
          this.redactionRoot
        ));
        return maybeResponse(requestFields.id, {
          content: [{ type: "text", text }]
        });
      }
      await this.ready;
      if (this.startupError) {
        throw new Error(`Server startup failed: ${this.startupError}`);
      }
      if (requestFields.id === undefined) {
        return undefined;
      }
      return directErrorResponse(requestFields.id, -32601, `Method not found: ${requestFields.method}`);
    } catch (error) {
      const message = errorMessage(error);
      const clientMessage = redactRootInMessage(message, this.redactionRoot);
      const requestFields = safeRequestFields(request);
      this.logger.warn("mcp_request_failed", { method: requestFields.method, error: clientMessage });
      if (isTopLevelInvalidRequest(request)) {
        return directErrorResponse(null, -32000, clientMessage);
      }
      if (!requestFields.hasId) {
        return undefined;
      }
      return directErrorResponse(isJsonRpcId(requestFields.id) ? requestFields.id : null, -32000, clientMessage);
    }
  }

  private async callTool(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case "novel_new_project":
        return this.pipeline.newProject(args as never);
      case "novel_health":
        return this.pipeline.health(args as never);
      case "novel_job_start":
        return this.jobs.start(args);
      case "novel_job_status":
        return this.jobs.status(args);
      case "novel_job_list":
        return this.jobs.list(args);
      case "novel_job_cleanup":
        return this.jobs.cleanup(args);
      case "novel_job_cancel":
        return this.jobs.cancel(args);
      case "novel_confirm":
        return this.pipeline.confirm(args as never);
      case "novel_continue":
        return this.pipeline.continue(args as never);
      case "novel_status":
        return this.pipeline.status(args as never);
      case "novel_revise":
        return this.pipeline.revise(args as never);
      case "novel_build_epub":
        return this.pipeline.buildEpub(args as never);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async shutdown(): Promise<void> {
    await this.ready;
    const result = await this.jobs.shutdown();
    this.logger.info("mcp_shutdown_jobs", { ...result });
  }
}

function createDefaultPipeline(config: ReturnType<typeof loadConfig>, storage = new NovelStorage(config)): { pipeline: NovelPipeline; storage: NovelStorage } {
  return { pipeline: new NovelPipeline(storage, createNovelAgents(config), config), storage };
}

function toolArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tools/call params.arguments must be an object when provided.");
  }
  return value as Record<string, unknown>;
}

function toolCallParams(value: unknown): { name?: unknown; arguments?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tools/call params must be an object.");
  }
  assertKnownFields(value as Record<string, unknown>, "tools/call params", ["name", "arguments"]);
  return {
    name: optionalOwnDataProperty(value, "name", "tools/call params").value,
    arguments: optionalOwnDataProperty(value, "arguments", "tools/call params").value
  };
}

function parseToolName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("tools/call requires params.name");
  }
  if (value.length > MAX_TOOL_NAME_CHARS) {
    throw new Error(`tools/call params.name must be at most ${MAX_TOOL_NAME_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_TOOL_NAME_BYTES) > MAX_TOOL_NAME_BYTES) {
    throw new Error(`tools/call params.name must be at most ${MAX_TOOL_NAME_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("tools/call params.name must not contain control characters.");
  }
  if (value.trim() !== value) {
    throw new Error("tools/call params.name must not have leading or trailing whitespace.");
  }
  return value;
}

function toolResultText(result: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(snapshotJsonValueShape(result, "Tool result JSON", JSON_RPC_RESPONSE_VALUE_LIMITS), null, 2);
  } catch (error) {
    throw new Error(`Tool result must be JSON serializable: ${errorMessage(error)}`);
  }
  if (text.length > MAX_TOOL_RESPONSE_TEXT_CHARS) {
    throw new Error(`Tool result JSON size must be less than or equal to ${MAX_TOOL_RESPONSE_TEXT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(text, MAX_TOOL_RESPONSE_TEXT_BYTES) > MAX_TOOL_RESPONSE_TEXT_BYTES) {
    throw new Error(`Tool result JSON size must be less than or equal to ${MAX_TOOL_RESPONSE_TEXT_BYTES} UTF-8 bytes.`);
  }
  return text;
}

function sanitizeToolResultForClient(result: ToolResult, root: string | undefined): ToolResult {
  const output: ToolResult = {
    status: result.status,
    message: redactRootInMessage(redactInlineSecrets(result.message), root)
  };
  if (Object.prototype.hasOwnProperty.call(result, "data")) {
    output.data = sanitizeToolResultJson(snapshotJsonValueShape(result.data, "Tool result client data", JSON_RPC_RESPONSE_VALUE_LIMITS), root);
  }
  return output;
}

function sanitizeToolResultJson(value: unknown, root: string | undefined): unknown {
  if (typeof value === "string") {
    return redactRootInMessage(redactInlineSecrets(value), root);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    const prototype = safeGetPrototypeOf(value, "Tool result client data array");
    if (prototype !== Array.prototype && prototype !== null) {
      throw new Error("Tool result client data array must be a standard or snapshotted array.");
    }
    assertJsonRpcArrayDataProperties(value, "Tool result client data array");
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = safeGetOwnPropertyDescriptor(value, String(index), "Tool result client data array");
      if (!descriptor) {
        throw new Error(`Tool result client data array[${index}] must not be a sparse array hole.`);
      }
      if (!descriptor.enumerable || !("value" in descriptor)) {
        throw new Error(`Tool result client data array[${index}] must not contain non-enumerable or accessor properties.`);
      }
      output.push(sanitizeToolResultJson(descriptor.value, root));
    }
    return output;
  }
  if (value && typeof value === "object") {
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of safeOwnKeys(value, "Tool result client data object")) {
      if (typeof key !== "string") {
        throw new Error("Tool result client data object must not contain symbol properties.");
      }
      const descriptor = safeGetOwnPropertyDescriptor(value, key, "Tool result client data object");
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`Tool result client data object.${key} must not contain non-enumerable or accessor properties.`);
      }
      const redactedKey = uniqueSanitizedObjectKey(output, redactRootInMessage(redactInlineSecrets(key), root));
      Object.defineProperty(output, redactedKey, {
        value: sanitizeToolResultJson(descriptor.value, root),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return output;
  }
  return value;
}

function uniqueSanitizedObjectKey(output: Record<string, unknown>, key: string): string {
  if (!Object.prototype.hasOwnProperty.call(output, key)) {
    return key;
  }
  let index = 2;
  while (Object.prototype.hasOwnProperty.call(output, `${key} (${index})`)) {
    index += 1;
  }
  return `${key} (${index})`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(snapshotJsonValueShape(value, "JSON clone", JSON_RPC_RESPONSE_VALUE_LIMITS))) as T;
}

function withStartupHealth(result: ToolResult, startupError: string): ToolResult {
  const data = startupHealthData(result.data, startupError);
  return {
    status: "blocked",
    message: `${result.message} Startup recovery failed.`,
    data
  };
}

function startupHealthData(value: unknown, startupError: string): Record<string, unknown> {
  const data = Object.create(null) as Record<string, unknown>;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const snapshot = snapshotJsonValueShape(value, "Tool result startup health data", JSON_RPC_RESPONSE_VALUE_LIMITS);
    if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
      for (const key of safeOwnKeys(snapshot, "Tool result startup health data snapshot")) {
        if (typeof key !== "string") {
          throw new Error("Tool result startup health data snapshot must not contain symbol properties.");
        }
        const descriptor = safeGetOwnPropertyDescriptor(snapshot, key, "Tool result startup health data snapshot");
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error(`Tool result startup health data snapshot.${key} must not contain non-enumerable or accessor properties.`);
        }
        const safeKey = uniqueSanitizedObjectKey(data, key);
        Object.defineProperty(data, safeKey, {
          value: descriptor.value,
          enumerable: true,
          configurable: true,
          writable: true
        });
      }
    }
  }
  const startupKey = uniqueSanitizedObjectKey(data, "startup");
  Object.defineProperty(data, startupKey, {
    value: {
      recovered: false,
      error: startupError
    },
    enumerable: true,
    configurable: true,
    writable: true
  });
  return data;
}

export function createStdioServer(server = new McpServer()): void {
  const config = loadConfig();
  const processor = new StdioLineProcessor(server, (line) => {
    process.stdout.write(line);
  }, { maxLineLength: config.stdioMaxLineLength });
  const keepAlive = setInterval(() => undefined, 2147483647);
  let onData!: (chunk: string) => void;
  let onEnd!: () => void;
  let onSigint!: () => void;
  let onSigterm!: () => void;
  const shutdownOnce = createShutdownOnce(server, async () => {
    try {
      await processor.drain();
    } finally {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
      clearInterval(keepAlive);
    }
  });
  process.stdin.setEncoding("utf8");
  onData = (chunk) => {
    processor.push(chunk);
  };
  onEnd = () => {
    processor.end();
    void shutdownOnce();
  };
  onSigint = () => {
    void shutdownOnce().finally(() => {
      process.exitCode = 130;
    });
  };
  onSigterm = () => {
    void shutdownOnce().finally(() => {
      process.exitCode = 143;
    });
  };
  process.stdin.on("data", onData);
  process.stdin.on("end", onEnd);
  process.stdin.resume();
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

export function createShutdownOnce(server: { shutdown(): Promise<void> }, beforeShutdown: () => Promise<void> = async () => undefined): () => Promise<void> {
  const safeServer = validateMethodObject(server, "shutdown", "shutdown server") as { shutdown(): Promise<void> };
  const safeBeforeShutdown = validateFunction(beforeShutdown, "beforeShutdown") as () => Promise<void>;
  let shutdown: Promise<void> | undefined;
  return () => {
    shutdown ??= (async () => {
      try {
        await safeBeforeShutdown();
      } catch {
        // Continue to server shutdown even if draining or pre-shutdown cleanup fails.
      }
      try {
        await safeServer.shutdown();
      } catch {
        // Shutdown is best-effort during process teardown.
      }
    })();
    return shutdown;
  };
}

export class StdioLineProcessor {
  private buffer = "";
  private queue: Promise<void> = Promise.resolve();
  private pendingLines = 0;
  private discardingOverlongLine = false;
  private readonly maxLineLength: number;
  private readonly server: JsonRpcHandler;
  private readonly write: (line: string) => void;

  constructor(
    server: JsonRpcHandler,
    write: (line: string) => void,
    options: StdioLineProcessorOptions = {}
  ) {
    this.server = validateMethodObject(server, "handle", "StdioLineProcessor.server") as JsonRpcHandler;
    this.write = validateFunction(write, "StdioLineProcessor.write") as (line: string) => void;
    const safeOptions = validateStdioOptions(options);
    this.maxLineLength = validateStdioMaxLineLength(safeOptions.maxLineLength ?? loadConfig().stdioMaxLineLength);
  }

  push(chunk: string): void {
    const safeChunk = validateStdioChunk(chunk);
    let remaining = safeChunk;
    while (remaining.length > 0) {
      if (this.discardingOverlongLine) {
        const newlineIndex = remaining.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        remaining = remaining.slice(newlineIndex + 1);
        this.discardingOverlongLine = false;
      }

      const newlineIndex = remaining.indexOf("\n");
      const segment = newlineIndex >= 0 ? remaining.slice(0, newlineIndex) : remaining;
      remaining = newlineIndex >= 0 ? remaining.slice(newlineIndex + 1) : "";
      const currentBytes = utf8ByteLengthUpTo(this.buffer, this.maxLineLength);
      const segmentBytes = utf8ByteLengthUpTo(segment, this.maxLineLength);
      if (this.buffer.length + segment.length > this.maxLineLength || currentBytes + segmentBytes > this.maxLineLength) {
        this.buffer = "";
        this.discardingOverlongLine = newlineIndex < 0;
        this.writeLineTooLongError();
        continue;
      }
      this.buffer += segment;
      if (newlineIndex >= 0) {
        const line = this.buffer.trim();
        this.buffer = "";
        this.enqueue(line);
      }
    }
  }

  end(): void {
    if (this.discardingOverlongLine) {
      this.discardingOverlongLine = false;
      this.buffer = "";
      return;
    }
    const line = this.buffer.trim();
    this.buffer = "";
    this.enqueue(line);
  }

  drain(): Promise<void> {
    return this.queue;
  }

  private enqueue(line: string): void {
    if (!line) {
      return;
    }
    if (this.pendingLines >= MAX_STDIO_PENDING_LINES) {
      safeWrite(this.write, `${boundedErrorResponse(null, -32000, `JSON-RPC request queue exceeds ${MAX_STDIO_PENDING_LINES} pending lines.`, this.maxLineLength)}\n`);
      return;
    }
    this.pendingLines += 1;
    this.queue = this.queue
      .catch(() => undefined)
      .then(async () => {
        try {
          await dispatchLine(this.server, line, this.write, this.maxLineLength);
        } finally {
          this.pendingLines -= 1;
        }
      });
  }

  private writeLineTooLongError(): void {
    safeWrite(this.write, `${boundedErrorResponse(null, -32700, `Parse error: JSON-RPC line exceeds ${this.maxLineLength} characters or UTF-8 bytes.`, this.maxLineLength)}\n`);
  }
}

function validateStdioMaxLineLength(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("StdioLineProcessor.maxLineLength must be an integer.");
  }
  if (value < MIN_STDIO_LINE_LENGTH || value > MAX_STDIO_LINE_LENGTH) {
    throw new Error(`StdioLineProcessor.maxLineLength must be between ${MIN_STDIO_LINE_LENGTH} and ${MAX_STDIO_LINE_LENGTH}.`);
  }
  return value;
}

function validateStdioChunk(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("StdioLineProcessor.push chunk must be a string.");
  }
  return value;
}

function validateMcpPipeline(value: unknown): NovelPipeline {
  validateObjectForSymbolInjection(value, "McpServer.pipeline");
  if (!safeInstanceOf(value, NovelPipeline, "McpServer.pipeline")) {
    throw new Error("McpServer.pipeline must be a NovelPipeline instance.");
  }
  validateMethodObject(value, "newProject", "McpServer.pipeline");
  validateMethodObject(value, "health", "McpServer.pipeline");
  validateMethodObject(value, "confirm", "McpServer.pipeline");
  validateMethodObject(value, "continue", "McpServer.pipeline");
  validateMethodObject(value, "status", "McpServer.pipeline");
  validateMethodObject(value, "revise", "McpServer.pipeline");
  validateMethodObject(value, "buildEpub", "McpServer.pipeline");
  return value as NovelPipeline;
}

function validateMcpLogger(value: unknown): Logger {
  validateObjectForSymbolInjection(value, "McpServer.logger");
  if (!safeInstanceOf(value, Logger, "McpServer.logger")) {
    throw new Error("McpServer.logger must be a Logger instance.");
  }
  validateMethodObject(value, "info", "McpServer.logger");
  validateMethodObject(value, "warn", "McpServer.logger");
  validateMethodObject(value, "error", "McpServer.logger");
  return value as Logger;
}

function validateMcpStorage(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("McpServer.storage must be an object.");
  }
  assertNoSymbolInjectionProperties(value, "McpServer.storage");
  if (!safeInstanceOf(value, NovelStorage, "McpServer.storage")) {
    throw new Error("McpServer.storage must be a NovelStorage instance.");
  }
  const descriptor = safeGetOwnPropertyDescriptor(value, "root", "McpServer.storage");
  if (!descriptor || !descriptor.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") {
    throw new Error("McpServer.storage.root must be an enumerable data string.");
  }
  validateInjectedStorageRoot(descriptor.value, "McpServer.storage.root");
  return descriptor.value;
}

function validateObjectForSymbolInjection(value: unknown, label: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertNoSymbolInjectionProperties(value, label);
  return value;
}

function assertNoSymbolInjectionProperties(value: object, label: string): void {
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
  }
}

function safeInstanceOf(value: unknown, constructor: Function, label: string): boolean {
  try {
    return value instanceof (constructor as any);
  } catch {
    throw new Error(`${label} prototype must be readable.`);
  }
}

function validateInjectedStorageRoot(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty absolute path.`);
  }
  if (value.length > MAX_MCP_STORAGE_ROOT_CHARS) {
    throw new Error(`${label} must be at most ${MAX_MCP_STORAGE_ROOT_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(value, MAX_MCP_STORAGE_ROOT_BYTES) > MAX_MCP_STORAGE_ROOT_BYTES) {
    throw new Error(`${label} must be at most ${MAX_MCP_STORAGE_ROOT_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must not contain control characters.`);
  }
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  const root = resolve(value);
  if (dirname(root) === root) {
    throw new Error(`${label} must not be the filesystem root.`);
  }
}

function validateStdioOptions(value: unknown): StdioLineProcessorOptions {
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("StdioLineProcessor.options must be an object.");
  }
  const prototype = safeGetPrototypeOf(value, "StdioLineProcessor.options");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("StdioLineProcessor.options must be a plain object.");
  }
  const output: StdioLineProcessorOptions = {};
  for (const key of safeOwnKeys(value, "StdioLineProcessor.options")) {
    if (typeof key !== "string") {
      throw new Error("StdioLineProcessor.options must not contain symbol properties.");
    }
    if (key !== "maxLineLength") {
      throw new Error(`StdioLineProcessor.options.${key} is not a supported field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, "StdioLineProcessor.options");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error("StdioLineProcessor.options must not contain non-enumerable or accessor properties.");
    }
    output.maxLineLength = descriptor.value as number;
  }
  return output;
}

function validateMethodObject(value: unknown, methodName: string, label: string): object {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  let current: object | null = value;
  while (current !== null) {
    const descriptor = safeGetOwnPropertyDescriptor(current, methodName, label);
    if (descriptor) {
      if ("value" in descriptor && typeof descriptor.value === "function") {
        return value;
      }
      throw new Error(`${label}.${methodName} must be a data function.`);
    }
    current = safeGetPrototypeOf(current, label);
  }
  throw new Error(`${label}.${methodName} must be a data function.`);
}

function validateFunction(value: unknown, label: string): Function {
  if (typeof value !== "function") {
    throw new Error(`${label} must be a function.`);
  }
  return value;
}

async function dispatchLine(server: JsonRpcHandler, line: string, write: (line: string) => void, maxLineLength: number): Promise<void> {
  let parsed: unknown;
  try {
    assertNoDuplicateJsonObjectKeys(line, "JSON-RPC request", MAX_JSON_RPC_VALUE_DEPTH);
    parsed = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    const message = errorMessage(error);
    safeWrite(write, `${boundedErrorResponse(null, -32700, `Parse error: ${message}`, maxLineLength)}\n`);
    return;
  }

  try {
    const result = await server.handle(parsed);
    if (result !== undefined) {
      const serialized = serializeJsonRpcResponse(result);
      if (!fitsMaxLine(serialized, maxLineLength)) {
        const parsedObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { id?: unknown }) : undefined;
        const id = isJsonRpcId(parsedObject?.id) ? parsedObject.id : null;
        safeWrite(write, `${boundedErrorResponse(id, -32000, `Response exceeds ${maxLineLength} characters or UTF-8 bytes.`, maxLineLength)}\n`);
        return;
      }
      safeWrite(write, `${serialized}\n`);
    }
  } catch (error) {
    const message = errorMessage(error);
    const parsedObject = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as { id?: unknown }) : undefined;
    if (parsedObject?.id === undefined) {
      return;
    }
    safeWrite(write, `${boundedErrorResponse(isJsonRpcId(parsedObject.id) ? parsedObject.id : null, -32000, message, maxLineLength)}\n`);
  }
}

function serializeJsonRpcResponse(result: unknown): string {
  let serialized: string | undefined;
  try {
    const stableResult = snapshotJsonValueShape(result, "JSON-RPC response", JSON_RPC_RESPONSE_VALUE_LIMITS);
    validateJsonRpcResponseEnvelope(stableResult);
    serialized = JSON.stringify(stableResult);
  } catch (error) {
    throw new Error(`JSON-RPC response must be JSON serializable: ${errorMessage(error)}`);
  }
  if (typeof serialized !== "string") {
    throw new Error("JSON-RPC response must be JSON serializable.");
  }
  return serialized;
}

function validateJsonRpcResponseEnvelope(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON-RPC response must be an object.");
  }
  const responseObject = value as Record<string, unknown>;
  assertKnownFields(responseObject, "JSON-RPC response", ["jsonrpc", "id", "result", "error"]);
  const jsonrpc = requiredOwnDataProperty(responseObject, "jsonrpc", "JSON-RPC response");
  const id = requiredOwnDataProperty(responseObject, "id", "JSON-RPC response");
  const result = optionalOwnDataProperty(responseObject, "result", "JSON-RPC response");
  const error = optionalOwnDataProperty(responseObject, "error", "JSON-RPC response");
  if (jsonrpc !== "2.0") {
    throw new Error("JSON-RPC response.jsonrpc must be \"2.0\".");
  }
  if (!isJsonRpcId(id)) {
    throw new Error(`JSON-RPC response.id must be a string up to ${MAX_JSON_RPC_ID_STRING_CHARS} characters and ${MAX_JSON_RPC_ID_STRING_BYTES} UTF-8 bytes, a safe integer, or null.`);
  }
  if (result.present === error.present) {
    throw new Error("JSON-RPC response must contain exactly one of result or error.");
  }
  if (error.present) {
    validateJsonRpcErrorObject(error.value);
  }
}

function validateJsonRpcErrorObject(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("JSON-RPC response.error must be an object.");
  }
  const errorObject = value as Record<string, unknown>;
  assertKnownFields(errorObject, "JSON-RPC response.error", ["code", "message", "data"]);
  const code = requiredOwnDataProperty(errorObject, "code", "JSON-RPC response.error");
  const message = requiredOwnDataProperty(errorObject, "message", "JSON-RPC response.error");
  const data = optionalOwnDataProperty(errorObject, "data", "JSON-RPC response.error");
  if (typeof code !== "number" || !Number.isSafeInteger(code)) {
    throw new Error("JSON-RPC response.error.code must be a safe integer.");
  }
  if (typeof message !== "string" || message.trim().length === 0) {
    throw new Error("JSON-RPC response.error.message must be a non-empty string.");
  }
  if (message.length > MAX_MCP_ERROR_CHARS) {
    throw new Error(`JSON-RPC response.error.message must be at most ${MAX_MCP_ERROR_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(message, MAX_MCP_ERROR_BYTES) > MAX_MCP_ERROR_BYTES) {
    throw new Error(`JSON-RPC response.error.message must be at most ${MAX_MCP_ERROR_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(message)) {
    throw new Error("JSON-RPC response.error.message must not contain control characters.");
  }
  if (data.present) {
    throw new Error("JSON-RPC response.error.data is not supported.");
  }
}

function safeWrite(write: (line: string) => void, line: string): void {
  try {
    write(line);
  } catch {
    // Keep the request processor alive if the output stream has a transient failure.
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

function utf8PrefixLength(value: string, maxBytes: number): number {
  let chars = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const first = value.charCodeAt(index);
    let scalar = first;
    let charLength = 1;
    if (first >= 0xd800 && first <= 0xdbff && index + 1 < value.length) {
      const second = value.charCodeAt(index + 1);
      if (second >= 0xdc00 && second <= 0xdfff) {
        scalar = 0x10000 + ((first - 0xd800) << 10) + (second - 0xdc00);
        charLength = 2;
      }
    }
    const nextBytes = bytes + utf8ScalarByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    chars += charLength;
    bytes = nextBytes;
    if (charLength === 2) {
      index += 1;
    }
  }
  return chars;
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

function fitsMaxLine(value: string, maxLineLength: number): boolean {
  return value.length <= maxLineLength && utf8ByteLengthUpTo(value, maxLineLength) <= maxLineLength;
}

function isTopLevelInvalidRequest(value: unknown): boolean {
  return value === null || typeof value !== "object" || Array.isArray(value);
}

function safeRequestFields(value: unknown): { hasId: boolean; id?: unknown; method?: unknown } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { hasId: false };
  }
  const id = safeDataProperty(value, "id");
  const method = safeDataProperty(value, "method");
  return {
    hasId: id.present,
    id: id.value,
    method: method.value
  };
}

function safeDataProperty(value: object, key: string): { present: boolean; value?: unknown } {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = safeGetOwnPropertyDescriptor(value, key, "JSON-RPC request fallback");
  } catch {
    return { present: false };
  }
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    return { present: descriptor !== undefined };
  }
  return { present: true, value: descriptor.value };
}

function optionalOwnDataProperty(value: object, key: string, label: string): { present: boolean; value?: unknown } {
  const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
  if (descriptor === undefined) {
    return { present: false };
  }
  if (!descriptor.enumerable || !("value" in descriptor)) {
    throw new Error(`${label}.${key} must be an enumerable data property.`);
  }
  return { present: true, value: descriptor.value };
}

function requiredOwnDataProperty(value: object, key: string, label: string): unknown {
  const property = optionalOwnDataProperty(value, key, label);
  if (!property.present) {
    throw new Error(`${label}.${key} is required.`);
  }
  return property.value;
}

function validateJsonRpcRequest(request: unknown): JsonRpcRequest {
  const snapshot = snapshotJsonValueShape(request, "JSON-RPC request", JSON_RPC_REQUEST_VALUE_LIMITS);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Request must be an object.");
  }
  assertKnownFields(snapshot as Record<string, unknown>, "JSON-RPC request", ["jsonrpc", "id", "method", "params"]);
  const candidate = jsonRpcRequestFields(snapshot);
  if (candidate.jsonrpc !== "2.0") {
    throw new Error("jsonrpc must be \"2.0\".");
  }
  if (candidate.id !== undefined && !isJsonRpcId(candidate.id)) {
    throw new Error(`id must be a string up to ${MAX_JSON_RPC_ID_STRING_CHARS} characters and ${MAX_JSON_RPC_ID_STRING_BYTES} UTF-8 bytes, a safe integer, null, or omitted.`);
  }
  if (typeof candidate.method !== "string" || !candidate.method.trim()) {
    throw new Error("method must be a non-empty string.");
  }
  if (candidate.method.length > MAX_JSON_RPC_METHOD_CHARS) {
    throw new Error(`method must be at most ${MAX_JSON_RPC_METHOD_CHARS} characters.`);
  }
  if (utf8ByteLengthUpTo(candidate.method, MAX_JSON_RPC_METHOD_BYTES) > MAX_JSON_RPC_METHOD_BYTES) {
    throw new Error(`method must be at most ${MAX_JSON_RPC_METHOD_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(candidate.method)) {
    throw new Error("method must not contain control characters.");
  }
  if (candidate.method.trim() !== candidate.method) {
    throw new Error("method must not have leading or trailing whitespace.");
  }
  return candidate;
}

function jsonRpcRequestFields(request: object): JsonRpcRequest {
  return {
    jsonrpc: requiredOwnDataProperty(request, "jsonrpc", "JSON-RPC request") as JsonRpcRequest["jsonrpc"],
    id: optionalOwnDataProperty(request, "id", "JSON-RPC request").value as JsonRpcRequest["id"],
    method: requiredOwnDataProperty(request, "method", "JSON-RPC request") as string,
    params: optionalOwnDataProperty(request, "params", "JSON-RPC request").value
  };
}

function validateJsonValueShape(value: unknown, label: string, limits: typeof JSON_RPC_REQUEST_VALUE_LIMITS): void {
  snapshotJsonValueShape(value, label, limits);
}

function snapshotJsonValueShape(value: unknown, label: string, limits: typeof JSON_RPC_REQUEST_VALUE_LIMITS): unknown {
  const stack = new WeakSet<object>();
  let nodes = 0;
  const visit = (current: unknown, currentLabel: string, depth: number): unknown => {
    nodes += 1;
    if (nodes > limits.maxTotalNodes) {
      throw new Error(`${label} must contain at most ${limits.maxTotalNodes} JSON values.`);
    }
    if (depth > limits.maxDepth) {
      throw new Error(`${currentLabel} must be nested at most ${limits.maxDepth} levels deep.`);
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
      if (current.length > limits.maxStringChars) {
        throw new Error(`${currentLabel} must be at most ${limits.maxStringChars} characters.`);
      }
      if (utf8ByteLengthUpTo(current, limits.maxStringBytes) > limits.maxStringBytes) {
        throw new Error(`${currentLabel} must be at most ${limits.maxStringBytes} UTF-8 bytes.`);
      }
      if (JSON_RPC_NON_PRINTING_CONTROL_CHARS.test(current)) {
        throw new Error(`${currentLabel} must not contain non-printing control characters.`);
      }
    }
    if (current === null || typeof current === "string" || typeof current === "number" || typeof current === "boolean") {
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
      if (current.length > limits.maxArrayItems) {
        throw new Error(`${currentLabel} must contain at most ${limits.maxArrayItems} array items.`);
      }
      assertJsonRpcArrayDataProperties(current, currentLabel);
      const output: unknown[] = [];
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel);
        if (!descriptor) {
          throw new Error(`${currentLabel}[${index}] must not be a sparse array hole.`);
        }
        if (!descriptor.enumerable || !("value" in descriptor)) {
          throw new Error(`${currentLabel}[${index}] must not contain non-enumerable or accessor properties.`);
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
    let fieldCount = 0;
    const output = Object.create(null) as Record<string, unknown>;
    for (const key of safeOwnKeys(current, currentLabel)) {
      if (typeof key !== "string") {
        throw new Error(`${currentLabel} must not contain symbol properties.`);
      }
      fieldCount += 1;
      if (fieldCount > limits.maxObjectFields) {
        throw new Error(`${currentLabel} must contain at most ${limits.maxObjectFields} object fields.`);
      }
      if (key.length > limits.maxObjectKeyChars) {
        throw new Error(`${currentLabel} object keys must be at most ${limits.maxObjectKeyChars} characters.`);
      }
      if (utf8ByteLengthUpTo(key, limits.maxObjectKeyBytes) > limits.maxObjectKeyBytes) {
        throw new Error(`${currentLabel} object keys must be at most ${limits.maxObjectKeyBytes} UTF-8 bytes.`);
      }
      if (/[\u0000-\u001f\u007f]/u.test(key)) {
        throw new Error(`${currentLabel} object keys must not contain control characters.`);
      }
      const descriptor = safeGetOwnPropertyDescriptor(current, key, currentLabel);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error(`${currentLabel} must not contain non-enumerable or accessor properties.`);
      }
      Object.defineProperty(output, key, {
        value: visit(descriptor.value, `${currentLabel}.${key}`, depth + 1),
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

function assertJsonRpcArrayDataProperties(value: unknown[], label: string): void {
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
      throw new Error(`${label}[${key}] must not contain non-enumerable or accessor properties.`);
    }
  }
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

function safeGetOwnPropertyDescriptor(value: object, key: PropertyKey, label: string): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw new Error(`${label} property descriptors must be readable.`);
  }
}

function isArrayIndexKey(value: string, length: number): boolean {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function assertKnownFields(value: Record<string, unknown>, label: string, allowed: string[]): void {
  const allowedFields = new Set(allowed);
  for (const key of safeOwnKeys(value, label)) {
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(value, key, label);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label} must not contain non-enumerable or accessor properties.`);
    }
    if (!allowedFields.has(key)) {
      throw new Error(`${label}.${key} is not a supported field.`);
    }
  }
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  if (value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.length <= MAX_JSON_RPC_ID_STRING_CHARS && utf8ByteLengthUpTo(value, MAX_JSON_RPC_ID_STRING_BYTES) <= MAX_JSON_RPC_ID_STRING_BYTES && !/[\u0000-\u001f\u007f]/u.test(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value);
}

function response(id: JsonRpcId, result: unknown) {
  return validatedJsonRpcResponse({ jsonrpc: "2.0", id, result });
}

function maybeResponse(id: JsonRpcId | undefined, result: unknown) {
  return id === undefined ? undefined : response(id, result);
}

function errorResponse(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function directErrorResponse(id: JsonRpcId, code: number, message: string) {
  return validatedJsonRpcResponse(errorResponse(id, code, message));
}

function validatedJsonRpcResponse(value: unknown): unknown {
  const snapshot = snapshotJsonValueShape(value, "JSON-RPC response", JSON_RPC_RESPONSE_VALUE_LIMITS);
  validateJsonRpcResponseEnvelope(snapshot);
  return snapshot;
}

function errorMessage(error: unknown): string {
  return truncateErrorMessage(
    redactErrorMessage(error).replace(MCP_ERROR_CONTROL_CHARS_GLOBAL, " ")
  );
}

function truncateErrorMessage(message: string): string {
  if (
    message.length <= MAX_MCP_ERROR_CHARS &&
    utf8ByteLengthUpTo(message, MAX_MCP_ERROR_BYTES) <= MAX_MCP_ERROR_BYTES
  ) {
    return message;
  }
  if (message.length > MAX_MCP_ERROR_CHARS) {
    const candidate = `${message.slice(0, MAX_MCP_ERROR_CHARS)}... [truncated ${message.length - MAX_MCP_ERROR_CHARS} chars]`;
    if (utf8ByteLengthUpTo(candidate, MAX_MCP_ERROR_BYTES) <= MAX_MCP_ERROR_BYTES) {
      return candidate;
    }
  }
  return truncateErrorMessageByBytes(message);
}

function truncateErrorMessageByBytes(message: string): string {
  const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_MCP_ERROR_BYTES)} UTF-8 bytes]`;
  const markerBytes = utf8ByteLength(marker);
  if (markerBytes > MAX_MCP_ERROR_BYTES) {
    return marker;
  }
  return `${message.slice(0, utf8PrefixLength(message, MAX_MCP_ERROR_BYTES - markerBytes))}${marker}`;
}

function redactRootInMessage(message: string, root: string | undefined): string {
  if (!root) {
    return message;
  }
  return message.split(root).join("<data-root>");
}

function boundedErrorResponse(id: JsonRpcId, code: number, message: string, maxLineLength: number): string {
  const serialized = JSON.stringify(errorResponse(id, code, message));
  if (fitsMaxLine(serialized, maxLineLength)) {
    return serialized;
  }
  const safeId = fitsMaxLine(JSON.stringify(errorResponse(id, code, "")), maxLineLength) ? id : null;
  const marker = "... [truncated]";
  let low = 0;
  let high = message.length;
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${message.slice(0, middle)}${marker}`;
    const bounded = JSON.stringify(errorResponse(safeId, code, candidate));
    if (fitsMaxLine(bounded, maxLineLength)) {
      best = bounded;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (best !== undefined) {
    return best;
  }
  const truncated = JSON.stringify(errorResponse(safeId, code, "truncated"));
  if (fitsMaxLine(truncated, maxLineLength)) {
    return truncated;
  }
  return JSON.stringify(errorResponse(null, code, ""));
}
