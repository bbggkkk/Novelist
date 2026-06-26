/**
 * Centralized constants for the novelist MCP server.
 * Prefer importing from this module over hard-coding values.
 */

import { join, resolve } from "node:path";

// ── Protocol / Schema ────────────────────────────────────────────────────────

export const MCP_PROTOCOL_VERSION = "2024-11-05";
export const JSON_RPC_VERSION = "2.0";
export const CURRENT_STATE_SCHEMA_VERSION = 1;
export const HEALTH_STORAGE_ROOT_HASH = "project-.novelist";
export const HEALTH_AGENT_PROVIDER = "mcp-caller";
export const STARTUP_FAILED_EVENT = "novelist_startup_failed";

// ── Validation limits ───────────────────────────────────────────────────────

export const MAX_CHAPTERS = 200;
export const MAX_BEATS_PER_CHAPTER = 200;
export const MAX_TOTAL_BEATS = 5000;
export const MAX_TITLE_CHARS = 512;
export const MAX_TITLE_BYTES = 512;
export const MAX_TEXT_CHARS = 256 * 1024;
export const MAX_TEXT_BYTES = 256 * 1024;
export const MAX_TIMESTAMP_CHARS = 64;
export const MAX_TIMESTAMP_BYTES = 64;
export const MAX_BEAT_TARGET_WORDS = 1_000_000;
export const MAX_OBJECT_FIELDS = 1000;
export const MAX_OBJECT_KEY_CHARS = 1024;
export const MAX_OBJECT_KEY_BYTES = 2048;

// ── Storage limits ───────────────────────────────────────────────────────────

export const MAX_JSON_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_MARKDOWN_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_WORLD_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_COLLECTED_VOLUME_MARKDOWN_CHARS = 16 * 1024 * 1024;
export const MAX_COLLECTED_VOLUME_MARKDOWN_BYTES = 16 * 1024 * 1024;
export const MAX_ATOMIC_WRITE_BYTES = 64 * 1024 * 1024;
export const MAX_LOCK_OWNER_FILE_BYTES = 64 * 1024;
export const MAX_LOCK_OWNER_TOKEN_CHARS = 256;
export const MAX_SAFE_ID_BYTES = 120;
export const MAX_STORAGE_ROOT_CHARS = 4096;
export const MAX_STORAGE_ROOT_BYTES = 4096;
export const MAX_QUARANTINE_CLEANUP_FAILURE_ITEMS = 100;
export const MAX_MARKDOWN_FRONTMATTER_CHARS = 64 * 1024;
export const MAX_MARKDOWN_FRONTMATTER_BYTES = 64 * 1024;
export const MAX_MARKDOWN_FRONTMATTER_FIELDS = 20;
export const MAX_MARKDOWN_FRONTMATTER_KEY_CHARS = 256;
export const MAX_MARKDOWN_FRONTMATTER_KEY_BYTES = 512;
export const MAX_JSON_VALUE_DEPTH = 64;
export const MAX_JSON_OBJECT_FIELDS = 1000;
export const MAX_JSON_OBJECT_KEY_CHARS = 1024;
export const MAX_JSON_OBJECT_KEY_BYTES = 2048;
export const MAX_JSON_STRING_CHARS = 1024 * 1024;
export const MAX_JSON_STRING_BYTES = 1024 * 1024;
export const MAX_JSON_ARRAY_ITEMS = 10000;
export const MAX_JSON_TOTAL_NODES = 100000;
export const MAX_DIRECTORY_SCAN_ENTRIES = 10000;
export const MAX_DIRECTORY_ENTRY_NAME_CHARS = 1024;
export const MAX_DIRECTORY_ENTRY_NAME_BYTES = 1024;
export const MAX_SAFE_CHILD_DIRECTORIES = 1000;
export const MAX_STORAGE_ERROR_CHARS = 4000;
export const MAX_STORAGE_ERROR_BYTES = 4000;
export const MAX_BEAT_PATH_INDEX = 5000;
export const MAX_SET_TIMEOUT_MS = 2_147_483_647;
export const MAX_STORAGE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_STORAGE_JOB_SNAPSHOTS = 100000;
export const MAX_STORAGE_PATH_CHARS = 8192;
export const MAX_STORAGE_PATH_BYTES = 8192;
export const MAX_SLUG_INPUT_CHARS = 16 * 1024;
export const MAX_TITLE_INPUT_CHARS = 512;
export const MAX_OPTION_INPUT_CHARS = 256;
export const MAX_INSTRUCTION_INPUT_CHARS = 16 * 1024;

// ── EPUB limits ───────────────────────────────────────────────────────────────

export const MAX_EPUB_MARKDOWN_CHARS = 16 * 1024 * 1024;
export const MAX_EPUB_MARKDOWN_BYTES = 16 * 1024 * 1024;
export const MAX_EPUB_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_EPUB_ENTRIES = 256;
export const MAX_EPUB_PARSED_ZIP_ENTRIES = 4096;
export const MAX_EPUB_ENTRY_NAME_BYTES = 1024;
export const MAX_EPUB_REPORTED_ISSUES = 50;
export const MAX_EPUB_REPORTED_ENTRIES = 256;
export const MAX_EPUB_ISSUE_CHARS = 300;
export const MAX_EPUB_ISSUE_BYTES = 300;
export const MAX_EPUB_REPORTED_ENTRY_CHARS = 200;
export const MAX_EPUB_REPORTED_ENTRY_BYTES = 200;
export const MAX_EPUB_METADATA_CHARS = 512;
export const ZIP_UTF8_NAME_FLAG = 0x0800;
export const ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS = ZIP_UTF8_NAME_FLAG;

// ── JSON-RPC limits ──────────────────────────────────────────────────────────

export const MAX_JSON_RPC_ID_STRING_CHARS = 256;
export const MAX_JSON_RPC_ID_STRING_BYTES = 256;
export const MAX_JSON_RPC_METHOD_CHARS = 128;
export const MAX_JSON_RPC_METHOD_BYTES = 128;
export const MAX_JSON_RPC_VALUE_DEPTH = 32;
export const MAX_JSON_RPC_OBJECT_FIELDS = 100;
export const MAX_JSON_RPC_OBJECT_KEY_CHARS = 256;
export const MAX_JSON_RPC_OBJECT_KEY_BYTES = 512;
export const MAX_JSON_RPC_ARRAY_ITEMS = 1000;
export const MAX_JSON_RPC_TOTAL_NODES = 10000;
export const MAX_JSON_RPC_STRING_CHARS = 16 * 1024;
export const MAX_JSON_RPC_STRING_BYTES = 16 * 1024;

// ── External validator ───────────────────────────────────────────────────────

export const DEFAULT_VALIDATOR_PATH = "/usr/local/bin:/usr/bin:/bin";
export const DEFAULT_VALIDATOR_CWD = "/";
export const MAX_CAPTURED_OUTPUT_CHARS = 16 * 1024;
export const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024;
export const MAX_PROCESS_BUFFER_BYTES = 1024 * 1024;
export const MAX_REPORTED_COMMAND_CHARS = 1024;
export const MAX_REPORTED_COMMAND_BYTES = 1024;
export const MAX_REPORTED_ARG_CHARS = 1024;
export const MAX_REPORTED_ARG_BYTES = 1024;
export const MAX_REPORTED_ARGS = 64;
export const MAX_REPORTED_ERROR_CHARS = 4000;
export const MAX_REPORTED_ERROR_BYTES = 4000;
export const MAX_EPUB_PATH_CHARS = 4096;
export const MAX_EPUB_PATH_BYTES = 4096;
export const MAX_EXEC_ARGS = 64;
export const MAX_EXEC_ARG_TEMPLATE_CHARS = 4096;
export const MAX_EXEC_ARG_TEMPLATE_BYTES = 4096;
export const MAX_EXEC_ARG_CHARS = 8192;
export const MAX_EXEC_ARGV_BYTES = 256 * 1024;
export const MAX_VALIDATOR_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;

// ── Config parsing ───────────────────────────────────────────────────────────

export const MAX_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_OPERATION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CONCURRENT_JOBS = 64;
export const MAX_TOTAL_JOBS = 100000;
export const MIN_STDIO_LINE_LENGTH = 256;
export const MAX_STDIO_LINE_LENGTH = 16 * 1024 * 1024;
export const MAX_EPUBCHECK_ARGS = 64;
export const MAX_EPUBCHECK_ARG_LENGTH = 4096;
export const MAX_EPUBCHECK_ARG_BYTES = 4096;
export const MAX_EPUBCHECK_ARGS_RAW_LENGTH = 300 * 1024;
export const MAX_EPUBCHECK_ARGS_JSON_DEPTH = 64;
export const MAX_NUMERIC_ENV_LENGTH = 32;
export const MAX_NUMERIC_ENV_RAW_LENGTH = 1024;
export const MAX_ENUM_ENV_RAW_LENGTH = 1024;
export const MAX_ENV_NAME_LENGTH = 256;
export const MAX_ENV_NAME_BYTES = 512;
export const MAX_ENV_FIELDS = 10000;
export const RAW_TRIM_PADDING_LENGTH = 1024;
export const MAX_CONFIG_ERROR_CHARS = 1000;
export const MAX_CONFIG_ERROR_BYTES = 1000;

// ── Logger limits ────────────────────────────────────────────────────────────

export const MAX_LOG_STRING_CHARS = 4000;
export const MAX_LOG_STRING_BYTES = 16 * 1024;
export const MAX_LOG_KEY_CHARS = 256;
export const MAX_LOG_KEY_BYTES = 1024;
export const MAX_LOG_ARRAY_ITEMS = 50;
export const MAX_LOG_OBJECT_FIELDS = 100;
export const MAX_LOG_DEPTH = 8;
export const LOG_LEVEL_DEBUG_ORDER = 10;
export const LOG_LEVEL_INFO_ORDER = 20;
export const LOG_LEVEL_WARN_ORDER = 30;
export const LOG_LEVEL_ERROR_ORDER = 40;
export const LOG_LEVEL_SILENT_ORDER = 100;

// ── Language / Defaults ─────────────────────────────────────────────────────

export const EPUB_LANGUAGE = "ko";
export function defaultStorageRoot(): string {
  return resolve(join(process.cwd(), ".novelist"));
}
