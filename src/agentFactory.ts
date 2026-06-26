import type { AppConfig } from "./config.js";
import { StubNovelAgents } from "./agents.js";
import { OpenAiNovelAgents } from "./openaiAgents.js";
import type { NovelAgents } from "./types.js";

const AGENT_FACTORY_CONFIG_FIELDS = new Set<keyof AppConfig>([
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

export function createNovelAgents(config: AppConfig): NovelAgents {
  const agentProvider = validateAgentFactoryConfig(config);
  if (agentProvider === "openai") {
    return new OpenAiNovelAgents(config);
  }
  return new StubNovelAgents();
}

function validateAgentFactoryConfig(config: AppConfig): AppConfig["agentProvider"] {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("createNovelAgents.config must be an object.");
  }
  const prototype = safeGetPrototypeOf(config, "createNovelAgents.config");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("createNovelAgents.config must be a plain object.");
  }
  for (const key of safeOwnKeys(config, "createNovelAgents.config")) {
    if (typeof key !== "string") {
      throw new Error("createNovelAgents.config must not contain symbol properties.");
    }
    if (!AGENT_FACTORY_CONFIG_FIELDS.has(key as keyof AppConfig)) {
      throw new Error(`createNovelAgents.${key} is not a supported config field.`);
    }
    const descriptor = safeGetOwnPropertyDescriptor(config, key, "createNovelAgents.config");
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`createNovelAgents.${key} must be an enumerable data property.`);
    }
  }
  const descriptor = safeGetOwnPropertyDescriptor(config, "agentProvider", "createNovelAgents.config");
  if (!descriptor?.enumerable || !("value" in descriptor)) {
    throw new Error("createNovelAgents.agentProvider must be an enumerable data property.");
  }
  if (descriptor.value !== "stub" && descriptor.value !== "openai") {
    throw new Error("createNovelAgents.agentProvider must be stub or openai.");
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
