import { createRequire } from "node:module";

const requirePackageJson = createRequire(import.meta.url);
const packageJsonCandidates = ["../../package.json", "../package.json"];

let cachedName: string | undefined;
let cachedVersion: string | undefined;

function readPackageJson(): { name: string; version: string } {
  try {
    for (const packageJsonPath of packageJsonCandidates) {
      try {
        const parsed = requirePackageJson(packageJsonPath) as { name: string; version: string };
        return { name: parsed.name, version: parsed.version };
      } catch {
        // Try the next candidate path. The source and built layouts differ.
      }
    }
  } catch {
    // Fall through to the safe fallback below.
  }
  return { name: "novelist-mcp", version: "0.0.0" };
}

export function getPackageName(): string {
  if (!cachedName) {
    cachedName = readPackageJson().name;
  }
  return cachedName;
}

export function getPackageVersion(): string {
  if (!cachedVersion) {
    cachedVersion = readPackageJson().version;
  }
  return cachedVersion;
}

export const PACKAGE_NAME = getPackageName();
export const PACKAGE_VERSION = getPackageVersion();
