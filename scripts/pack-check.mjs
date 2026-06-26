import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { assertNoDuplicateJsonObjectKeys } from "../dist/src/jsonPreflight.js";

const expectedFiles = ["dist/src", "README.md", "package.json"];
const expectedExports = {
  ".": {
    types: "./dist/src/index.d.ts",
    import: "./dist/src/index.js"
  }
};
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const MAX_PACKAGE_DESCRIPTION_CHARS = 256;
const MAX_PACKAGE_DESCRIPTION_BYTES = 256;
const MAX_PACKAGE_VERSION_CHARS = 128;
const MAX_PACKAGE_VERSION_BYTES = 128;
const MAX_PACK_JSON_BYTES = 2 * 1024 * 1024;
const MAX_PACK_JSON_PATH_CHARS = 4096;
const MAX_PACK_JSON_PATH_BYTES = 4096;
const STDIN_READ_CHUNK_BYTES = 64 * 1024;
const MAX_PACK_FILE_COUNT = 200;
const MAX_PACK_FILE_PATH_CHARS = 4096;
const MAX_PACK_FILE_PATH_BYTES = 4096;
const MAX_PACK_FILE_SIZE_BYTES = 1024 * 1024;
const MAX_PACK_TARBALL_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PACK_UNPACKED_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_PACK_FILE_MODE = 0o177777;
const MAX_JSON_VALUE_DEPTH = 64;
const MAX_JSON_TOTAL_NODES = 100000;
const MAX_JSON_OBJECT_FIELDS = 1000;
const MAX_JSON_OBJECT_KEY_CHARS = 1024;
const MAX_JSON_OBJECT_KEY_BYTES = 2048;
const MAX_JSON_ARRAY_ITEMS = 10000;
const MAX_JSON_STRING_CHARS = 1024 * 1024;
const MAX_JSON_STRING_BYTES = 1024 * 1024;
const MAX_ERROR_MESSAGE_CHARS = 1000;
const MAX_ERROR_MESSAGE_BYTES = 1000;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_REGULAR_FILE_TYPE = 0o100000;
const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly"
];
const expectedScripts = {
  build: "node -e \"require('node:fs').rmSync('dist', { recursive: true, force: true })\" && tsc -p tsconfig.json && node -e \"require('node:fs').chmodSync('dist/src/cli.js', 0o755)\"",
  test: "npm run build && node dist/tests/pipeline.test.js",
  "pack:check": "npm run build && npm pack --dry-run --json --cache /tmp/novelist-npm-cache | node scripts/pack-check.mjs -",
  verify: "npm test && npm run pack:check",
  prepare: "npm run build",
  start: "node dist/src/cli.js"
};
const forbiddenRuntimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundleDependencies",
  "bundledDependencies"
];
const allowedPackageFields = [
  "name",
  "version",
  "description",
  "license",
  "type",
  "engines",
  "main",
  "types",
  "exports",
  "files",
  "bin",
  "scripts",
  "devDependencies",
  "publishConfig"
];
const allowedDevDependencies = {
  typescript: "^6.0.3"
};
const allowedPublishConfigFields = ["access", "provenance"];
const allowedPackFields = ["id", "name", "version", "filename", "files", "entryCount", "size", "unpackedSize", "shasum", "integrity", "bundled"];
const allowedPackFileFields = ["path", "size", "mode"];
const allowedBinFields = ["novelist-mcp"];
const allowedEnginesFields = ["node"];
const allowedPackageLockFields = ["name", "version", "lockfileVersion", "requires", "packages"];
const allowedPackageLockRootFields = ["name", "version", "license", "bin", "devDependencies", "engines"];
const allowedPackageLockPackagePaths = ["", "node_modules/typescript"];
const allowedPackageLockTypescriptFields = ["version", "resolved", "integrity", "dev", "license", "bin", "engines"];
const reviewedSourceFiles = [
  "agentFactory.ts",
  "agents.ts",
  "cli.ts",
  "cliArgs.ts",
  "cliIo.ts",
  "config.ts",
  "epub.ts",
  "execution.ts",
  "externalEpubCheck.ts",
  "index.ts",
  "jobs.ts",
  "jsonPreflight.ts",
  "logger.ts",
  "mcp.ts",
  "node.d.ts",
  "openaiAgents.ts",
  "pipeline.ts",
  "redaction.ts",
  "startup.ts",
  "stateValidation.ts",
  "storage.ts",
  "toolResultValidation.ts",
  "types.ts",
  "validation.ts",
  "version.ts"
];
const expectedPackageLockTypescript = {
  version: "6.0.3",
  resolved: "https://registry.npmjs.org/typescript/-/typescript-6.0.3.tgz",
  dev: true,
  license: "Apache-2.0",
  bin: {
    tsc: "bin/tsc",
    tsserver: "bin/tsserver"
  },
  engines: {
    node: ">=14.17"
  }
};
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

const packJsonPath = parsePackJsonPath(process.argv.slice(2));

function parsePackJsonPath(args) {
  if (args.length !== 1) {
    throw new Error("Usage: node scripts/pack-check.mjs <npm-pack-json|->");
  }
  const [path] = args;
  if (typeof path !== "string" || path.trim().length === 0) {
    throw new Error("npm pack JSON metadata path must be a non-empty string.");
  }
  if (path.length > MAX_PACK_JSON_PATH_CHARS) {
    throw new Error(`npm pack JSON metadata path must be at most ${MAX_PACK_JSON_PATH_CHARS} characters.`);
  }
  if (utf8ByteLength(path) > MAX_PACK_JSON_PATH_BYTES) {
    throw new Error(`npm pack JSON metadata path must be at most ${MAX_PACK_JSON_PATH_BYTES} UTF-8 bytes.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error("npm pack JSON metadata path must not contain control characters.");
  }
  return path;
}

function readJsonFile(path, label, maxBytes) {
  const text = readTextFile(path, label, maxBytes);
  return parseJsonText(text, label);
}

function readTextFile(path, label, maxBytes) {
  return readTextFileRecord(path, label, maxBytes).text;
}

function readTextFileRecord(path, label, maxBytes) {
  const linkStats = lstatSync(path);
  if (!linkStats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }
  const size = linkStats.size;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`${label} size must be a non-negative safe integer.`);
  }
  if (size > maxBytes) {
    throw new Error(`${label} must be at most ${maxBytes} bytes.`);
  }
  const fd = openSync(path, "r");
  try {
    const stats = fstatSync(fd);
    if (stats.dev !== linkStats.dev || stats.ino !== linkStats.ino) {
      throw new Error(`${label} path changed while being opened.`);
    }
    if (!stats.isFile()) {
      throw new Error(`${label} must be a regular file.`);
    }
    const text = readBoundedFileDescriptor(fd, label, maxBytes);
    assertFileUnchanged(fd, stats, label);
    return { text, stats };
  } finally {
    closeSync(fd);
  }
}

function assertFileUnchanged(fd, expected, label) {
  const actual = fstatSync(fd);
  if (
    actual.dev !== expected.dev ||
    actual.ino !== expected.ino ||
    actual.size !== expected.size ||
    actual.mtimeMs !== expected.mtimeMs
  ) {
    throw new Error(`${label} changed while being read.`);
  }
}

function readJsonInput(path, label, maxBytes) {
  if (path !== "-") {
    return readJsonFile(path, label, maxBytes);
  }
  return parseJsonText(readBoundedStdin(label, maxBytes), label);
}

function readBoundedStdin(label, maxBytes) {
  const chunks = [];
  let total = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new Error(`${label} must be at most ${maxBytes} bytes.`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(STDIN_READ_CHUNK_BYTES, remaining));
    const bytesRead = readSync(0, buffer, 0, buffer.length, null);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    if (total > maxBytes) {
      throw new Error(`${label} must be at most ${maxBytes} bytes.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return decodeStrictUtf8(Buffer.concat(chunks, total), label);
}

function readBoundedFileDescriptor(fd, label, maxBytes) {
  const chunks = [];
  let total = 0;
  let position = 0;
  while (true) {
    const remaining = maxBytes + 1 - total;
    if (remaining <= 0) {
      throw new Error(`${label} must be at most ${maxBytes} bytes.`);
    }
    const buffer = Buffer.allocUnsafe(Math.min(STDIN_READ_CHUNK_BYTES, remaining));
    const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    position += bytesRead;
    if (total > maxBytes) {
      throw new Error(`${label} must be at most ${maxBytes} bytes.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  return decodeStrictUtf8(Buffer.concat(chunks, total), label);
}

function decodeStrictUtf8(buffer, label) {
  try {
    return strictUtf8Decoder.decode(buffer);
  } catch {
    throw new Error(`${label} must be valid UTF-8.`);
  }
}

function parseJsonText(text, label) {
  let parsed;
  try {
    assertNoDuplicateJsonObjectKeys(text, label, MAX_JSON_VALUE_DEPTH);
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${boundedErrorMessage(error)}`);
  }
  validateParsedJsonMetadata(parsed, label);
  return parsed;
}

function validateParsedJsonMetadata(value, label) {
  const stack = new WeakSet();
  let nodes = 0;
  const visit = (current, currentLabel, depth) => {
    nodes += 1;
    if (nodes > MAX_JSON_TOTAL_NODES) {
      throw new Error(`${label} must contain at most ${MAX_JSON_TOTAL_NODES} JSON values.`);
    }
    if (depth > MAX_JSON_VALUE_DEPTH) {
      throw new Error(`${currentLabel} must be nested at most ${MAX_JSON_VALUE_DEPTH} levels deep.`);
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
      if (current.length > MAX_JSON_STRING_CHARS) {
        throw new Error(`${currentLabel} must be at most ${MAX_JSON_STRING_CHARS} characters.`);
      }
      if (utf8ByteLength(current) > MAX_JSON_STRING_BYTES) {
        throw new Error(`${currentLabel} must be at most ${MAX_JSON_STRING_BYTES} UTF-8 bytes.`);
      }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(current)) {
        throw new Error(`${currentLabel} must not contain control characters.`);
      }
      return;
    }
    if (current === null || typeof current === "boolean") {
      return;
    }
    if (!current || typeof current !== "object") {
      throw new Error(`${currentLabel} must contain only JSON-compatible values.`);
    }
    if (stack.has(current)) {
      throw new Error(`${currentLabel} must not contain circular references.`);
    }
    stack.add(current);
    try {
      if (Array.isArray(current)) {
        if (Object.getPrototypeOf(current) !== Array.prototype) {
          throw new Error(`${currentLabel} must be a standard array.`);
        }
        if (current.length > MAX_JSON_ARRAY_ITEMS) {
          throw new Error(`${currentLabel} must contain at most ${MAX_JSON_ARRAY_ITEMS} array items.`);
        }
        assertPlainJsonArray(current, currentLabel);
        for (let index = 0; index < current.length; index += 1) {
          visit(current[index], `${currentLabel}[${index}]`, depth + 1);
        }
        return;
      }
      if (!isPlainJsonObject(current)) {
        throw new Error(`${currentLabel} must be a JSON object.`);
      }
      const keys = Object.keys(current);
      if (keys.length > MAX_JSON_OBJECT_FIELDS) {
        throw new Error(`${currentLabel} must contain at most ${MAX_JSON_OBJECT_FIELDS} object fields.`);
      }
      for (const key of keys) {
        if (key.length > MAX_JSON_OBJECT_KEY_CHARS) {
          throw new Error(`${currentLabel} object keys must be at most ${MAX_JSON_OBJECT_KEY_CHARS} characters.`);
        }
        if (utf8ByteLength(key) > MAX_JSON_OBJECT_KEY_BYTES) {
          throw new Error(`${currentLabel} object keys must be at most ${MAX_JSON_OBJECT_KEY_BYTES} UTF-8 bytes.`);
        }
        if (/[\u0000-\u001f\u007f]/u.test(key)) {
          throw new Error(`${currentLabel} object keys must not contain control characters.`);
        }
        visit(current[key], `${currentLabel}.${key}`, depth + 1);
      }
    } finally {
      stack.delete(current);
    }
  };
  visit(value, label, 0);
}

function utf8ByteLength(value) {
  return encoder.encode(value).length;
}

function validatePackageFilesMetadata(value) {
  if (!Array.isArray(value)) {
    throw new Error("package.json files must be an array.");
  }
  for (const [index, file] of value.entries()) {
    if (typeof file !== "string" || file.length === 0) {
      throw new Error(`package.json files[${index}] must be a non-empty string.`);
    }
    if (file.length > MAX_PACK_FILE_PATH_CHARS) {
      throw new Error(`package.json files[${index}] must be at most ${MAX_PACK_FILE_PATH_CHARS} characters.`);
    }
    if (utf8ByteLength(file) > MAX_PACK_FILE_PATH_BYTES) {
      throw new Error(`package.json files[${index}] must be at most ${MAX_PACK_FILE_PATH_BYTES} UTF-8 bytes.`);
    }
    if (file.startsWith("/") || file.startsWith("\\") || file.includes("\\") || file.split("/").includes("..") || /[\u0000-\u001f\u007f]/u.test(file)) {
      throw new Error(`package.json files[${index}] must be a safe package-relative path.`);
    }
  }
}

function validateTsconfigSourcePolicy(value) {
  assertPlainJsonObject(value, "tsconfig.json");
  const compilerOptions = requiredPlainJsonObject(value.compilerOptions, "tsconfig.json compilerOptions");
  const expectedCompilerOptions = {
    target: "ES2022",
    lib: ["ES2022"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    rootDir: ".",
    outDir: "dist",
    strict: true,
    skipLibCheck: false,
    noEmitOnError: true,
    declaration: true
  };
  for (const fieldName of Object.keys(compilerOptions)) {
    if (!Object.prototype.hasOwnProperty.call(expectedCompilerOptions, fieldName)) {
      throw new Error(`tsconfig.json compilerOptions.${fieldName} must not be present; TypeScript compiler policy changes require an explicit review.`);
    }
  }
  for (const [fieldName, expectedValue] of Object.entries(expectedCompilerOptions)) {
    if (!jsonMetadataEqual(compilerOptions[fieldName], expectedValue)) {
      throw new Error(`tsconfig.json compilerOptions.${fieldName} must match the reviewed TypeScript compiler policy.`);
    }
  }
  if (!jsonMetadataEqual(value.include, ["src/**/*.ts", "tests/**/*.ts"])) {
    throw new Error("tsconfig.json include must match the reviewed TypeScript source set.");
  }
  for (const fieldName of Object.keys(value)) {
    if (fieldName !== "compilerOptions" && fieldName !== "include") {
      throw new Error(`tsconfig.json ${fieldName} must not be present; TypeScript project policy changes require an explicit review.`);
    }
  }
}

const packageJson = readJsonFile("package.json", "package.json", MAX_PACKAGE_JSON_BYTES);
assertPlainJsonObject(packageJson, "package.json");
if (existsSync("tsconfig.json")) {
  validateTsconfigSourcePolicy(readJsonFile("tsconfig.json", "tsconfig.json", MAX_PACKAGE_JSON_BYTES));
}
for (const fieldName of Object.keys(packageJson)) {
  if (!allowedPackageFields.includes(fieldName)) {
    throw new Error(`package.json ${fieldName} must not be present; package metadata changes require an explicit packaging review.`);
  }
}
const binConfig = optionalPlainJsonObject(packageJson, "bin", "package.json bin");
const enginesConfig = optionalPlainJsonObject(packageJson, "engines", "package.json engines");
const scriptsConfig = optionalPlainJsonObject(packageJson, "scripts", "package.json scripts");
const binPath = binConfig?.["novelist-mcp"];
const packageLock = existsSync("package-lock.json") ? readJsonFile("package-lock.json", "package-lock.json", MAX_PACKAGE_JSON_BYTES) : undefined;
let packageLockPackages;
let packageLockRoot;
if (packageLock !== undefined) {
  assertPlainJsonObject(packageLock, "package-lock.json");
  for (const fieldName of Object.keys(packageLock)) {
    if (!allowedPackageLockFields.includes(fieldName)) {
      throw new Error(`package-lock.json ${fieldName} must not be present; lockfile metadata changes require an explicit packaging review.`);
    }
  }
  packageLockPackages = requiredPlainJsonObject(packageLock.packages, "package-lock.json packages");
  packageLockRoot = requiredPlainJsonObject(packageLockPackages[""], "package-lock.json root package");
  for (const fieldName of Object.keys(packageLockRoot)) {
    if (!allowedPackageLockRootFields.includes(fieldName)) {
      throw new Error(`package-lock.json root package ${fieldName} must not be present; lockfile root metadata changes require an explicit packaging review.`);
    }
  }
}

if (packageJson.name !== "novelist-mcp") {
  throw new Error("package.json name must be novelist-mcp.");
}

if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  throw new Error("package.json version must be a valid semver-like version.");
}
if (packageJson.version.length > MAX_PACKAGE_VERSION_CHARS) {
  throw new Error(`package.json version must be at most ${MAX_PACKAGE_VERSION_CHARS} characters.`);
}
if (utf8ByteLength(packageJson.version) > MAX_PACKAGE_VERSION_BYTES) {
  throw new Error(`package.json version must be at most ${MAX_PACKAGE_VERSION_BYTES} UTF-8 bytes.`);
}

if (typeof packageJson.description !== "string" || packageJson.description.trim().length === 0) {
  throw new Error("package.json description must be a non-empty string.");
}
if (packageJson.description.length > MAX_PACKAGE_DESCRIPTION_CHARS) {
  throw new Error(`package.json description must be at most ${MAX_PACKAGE_DESCRIPTION_CHARS} characters.`);
}
if (utf8ByteLength(packageJson.description) > MAX_PACKAGE_DESCRIPTION_BYTES) {
  throw new Error(`package.json description must be at most ${MAX_PACKAGE_DESCRIPTION_BYTES} UTF-8 bytes.`);
}
if (/[\u0000-\u001f\u007f]/u.test(packageJson.description)) {
  throw new Error("package.json description must not contain control characters.");
}

if (packageJson.license !== "MIT") {
  throw new Error("package.json license must be MIT.");
}

if (packageJson.private === true) {
  throw new Error("package.json private must not be true for a publishable package.");
}

if (packageJson.type !== "module") {
  throw new Error("package.json type must be module.");
}

if (enginesConfig?.node !== ">=22.0.0") {
  throw new Error("package.json engines.node must be >=22.0.0.");
}
if (enginesConfig) {
  for (const fieldName of Object.keys(enginesConfig)) {
    if (!allowedEnginesFields.includes(fieldName)) {
      throw new Error(`package.json engines.${fieldName} must not be present; runtime engine policy changes require an explicit packaging review.`);
    }
  }
}

for (const fieldName of forbiddenRuntimeDependencyFields) {
  if (Object.prototype.hasOwnProperty.call(packageJson, fieldName)) {
    throw new Error(`package.json ${fieldName} must not be present; runtime dependencies require an explicit packaging review.`);
  }
}

if (Object.prototype.hasOwnProperty.call(packageJson, "devDependencies")) {
  const devDependencies = packageJson.devDependencies;
  if (!isPlainJsonObject(devDependencies)) {
    throw new Error("package.json devDependencies must be an object when present.");
  }
  const allowedNames = Object.keys(allowedDevDependencies);
  for (const [name, version] of Object.entries(devDependencies)) {
    if (!Object.prototype.hasOwnProperty.call(allowedDevDependencies, name)) {
      throw new Error(`package.json devDependencies.${name} must not be present; development dependency changes require an explicit packaging review.`);
    }
    if (version !== allowedDevDependencies[name]) {
      throw new Error(`package.json devDependencies.${name} must be exactly ${allowedDevDependencies[name]}.`);
    }
  }
  for (const name of allowedNames) {
    if (!Object.prototype.hasOwnProperty.call(devDependencies, name)) {
      throw new Error(`package.json devDependencies.${name} must be present.`);
    }
  }
}

if (Object.prototype.hasOwnProperty.call(packageJson, "publishConfig")) {
  const publishConfig = packageJson.publishConfig;
  if (!isPlainJsonObject(publishConfig)) {
    throw new Error("package.json publishConfig must be an object when present.");
  }
  for (const fieldName of Object.keys(publishConfig)) {
    if (!allowedPublishConfigFields.includes(fieldName)) {
      throw new Error(`package.json publishConfig.${fieldName} must not be present; publish target changes require an explicit packaging review.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(publishConfig, "access") && publishConfig.access !== "public") {
    throw new Error("package.json publishConfig.access must be public when present.");
  }
  if (Object.prototype.hasOwnProperty.call(publishConfig, "provenance") && publishConfig.provenance !== true) {
    throw new Error("package.json publishConfig.provenance must be true when present.");
  }
}

if (packageJson.main !== "dist/src/index.js") {
  throw new Error("package.json main must point at dist/src/index.js.");
}

if (packageJson.types !== "dist/src/index.d.ts") {
  throw new Error("package.json types must point at dist/src/index.d.ts.");
}

if (!jsonMetadataEqual(packageJson.exports, expectedExports)) {
  throw new Error("package.json exports must expose only ./dist/src/index.js with ./dist/src/index.d.ts types.");
}

validatePackageFilesMetadata(packageJson.files);
if (!jsonMetadataEqual(packageJson.files, expectedFiles)) {
  throw new Error(`package.json files must be exactly ${expectedFiles.join(", ")}.`);
}

if (binPath !== "dist/src/cli.js") {
  throw new Error("package.json bin.novelist-mcp must point at dist/src/cli.js.");
}
if (binConfig) {
  for (const fieldName of Object.keys(binConfig)) {
    if (!allowedBinFields.includes(fieldName)) {
      throw new Error(`package.json bin.${fieldName} must not be present; package executable changes require an explicit packaging review.`);
    }
  }
}

if (packageLock !== undefined && packageLockRoot !== undefined) {
  if (packageLock.name !== packageJson.name || packageLockRoot.name !== packageJson.name) {
    throw new Error("package-lock.json package names must match package.json name.");
  }
  if (packageLock.version !== packageJson.version || packageLockRoot.version !== packageJson.version) {
    throw new Error("package-lock.json package versions must match package.json version.");
  }
  if (packageLockRoot.license !== packageJson.license) {
    throw new Error("package-lock.json root package license must match package.json license.");
  }
  if (packageLock.lockfileVersion !== 3) {
    throw new Error("package-lock.json lockfileVersion must be 3.");
  }
  if (packageLock.requires !== true) {
    throw new Error("package-lock.json requires must be true.");
  }
  if (!jsonMetadataEqual(packageLockRoot.bin, packageJson.bin)) {
    throw new Error("package-lock.json root package bin must match package.json bin.");
  }
  if (!jsonMetadataEqual(packageLockRoot.engines, packageJson.engines)) {
    throw new Error("package-lock.json root package engines must match package.json engines.");
  }
  if (!jsonMetadataEqual(packageLockRoot.devDependencies, packageJson.devDependencies)) {
    throw new Error("package-lock.json root package devDependencies must match package.json devDependencies.");
  }
  validatePackageLockPackages(packageLockPackages);
}

for (const scriptName of forbiddenLifecycleScripts) {
  if (Object.prototype.hasOwnProperty.call(scriptsConfig ?? {}, scriptName)) {
    throw new Error(`package.json scripts.${scriptName} must not be present in the publishable package.`);
  }
}
if (scriptsConfig) {
  for (const [scriptName, scriptValue] of Object.entries(scriptsConfig)) {
    if (!Object.prototype.hasOwnProperty.call(expectedScripts, scriptName)) {
      throw new Error(`package.json scripts.${scriptName} must not be present; package scripts changes require an explicit packaging review.`);
    }
    if (scriptValue !== expectedScripts[scriptName]) {
      throw new Error(`package.json scripts.${scriptName} must be exactly the reviewed command.`);
    }
  }
  for (const scriptName of Object.keys(expectedScripts)) {
    if (!Object.prototype.hasOwnProperty.call(scriptsConfig, scriptName)) {
      throw new Error(`package.json scripts.${scriptName} must be present.`);
    }
  }
}

const binStats = lstatSync(binPath);
if (!binStats.isFile()) {
  throw new Error("dist/src/cli.js must be a regular file for the package bin.");
}
const binRecord = readTextFileRecord(binPath, "dist/src/cli.js", MAX_PACK_FILE_SIZE_BYTES);
const bin = binRecord.text;
if (!bin.startsWith("#!/usr/bin/env node\n")) {
  throw new Error("dist/src/cli.js must start with a Node shebang.");
}

const mode = binRecord.stats.mode & 0o777;
if ((mode & 0o111) === 0) {
  throw new Error("dist/src/cli.js must be executable for the package bin.");
}

const libraryEntry = readTextFile(packageJson.main, "dist/src/index.js", MAX_PACK_FILE_SIZE_BYTES);
if (libraryEntry.startsWith("#!")) {
  throw new Error("dist/src/index.js library entrypoint must not start with a shebang.");
}
if (!/\bexport\b/u.test(libraryEntry)) {
  throw new Error("dist/src/index.js library entrypoint must contain JavaScript exports.");
}

const typeEntry = readTextFile(packageJson.types, "dist/src/index.d.ts", MAX_PACK_FILE_SIZE_BYTES);
if (typeEntry.startsWith("#!")) {
  throw new Error("dist/src/index.d.ts type declaration entrypoint must not start with a shebang.");
}
if (!/\bexport\b/u.test(typeEntry)) {
  throw new Error("dist/src/index.d.ts type declaration entrypoint must contain TypeScript exports.");
}

const packs = readJsonInput(packJsonPath, "npm pack JSON metadata", MAX_PACK_JSON_BYTES);
if (!Array.isArray(packs) || packs.length !== 1) {
  throw new Error("npm pack --dry-run --json must return exactly one package metadata object.");
}
const pack = packs?.[0];
if (!isPlainJsonObject(pack)) {
  throw new Error("npm pack --dry-run --json package metadata must be an object.");
}
for (const fieldName of Object.keys(pack)) {
  if (!allowedPackFields.includes(fieldName)) {
    throw new Error(`npm pack metadata.${fieldName} must not be present; pack metadata changes require an explicit packaging review.`);
  }
}
const files = pack?.files;
if (!Array.isArray(files)) {
  throw new Error("npm pack --dry-run --json did not return a file list.");
}
assertPlainJsonArray(files, "npm pack files");
if (files.length > MAX_PACK_FILE_COUNT) {
  throw new Error(`npm pack file list must contain at most ${MAX_PACK_FILE_COUNT} files.`);
}

const paths = files.map((file, index) => {
  if (!isPlainJsonObject(file)) {
    throw new Error(`npm pack file entry ${index} must be an object.`);
  }
  for (const fieldName of Object.keys(file)) {
    if (!allowedPackFileFields.includes(fieldName)) {
      throw new Error(`npm pack file entry ${index}.${fieldName} must not be present; pack file metadata changes require an explicit packaging review.`);
    }
  }
  const path = file.path;
  if (typeof path !== "string" || path.length === 0) {
    throw new Error(`npm pack file entry ${index}.path must be a non-empty string.`);
  }
  if (path.length > MAX_PACK_FILE_PATH_CHARS) {
    throw new Error(`npm pack file entry ${index}.path must be at most ${MAX_PACK_FILE_PATH_CHARS} characters.`);
  }
  if (utf8ByteLength(path) > MAX_PACK_FILE_PATH_BYTES) {
    throw new Error(`npm pack file entry ${index}.path must be at most ${MAX_PACK_FILE_PATH_BYTES} UTF-8 bytes.`);
  }
  if (path.startsWith("/") || path.startsWith("\\") || path.includes("\\") || path.split("/").includes("..") || /[\u0000-\u001f\u007f]/u.test(path)) {
    throw new Error(`npm pack file entry ${index}.path is not a safe package-relative path.`);
  }
  const localStats = lstatSync(path);
  if (!localStats.isFile()) {
    throw new Error(`npm pack file entry ${index}.path must refer to a regular file.`);
  }
  const metadataSize = file.size;
  if (metadataSize !== undefined && (typeof metadataSize !== "number" || !Number.isSafeInteger(metadataSize) || metadataSize < 0)) {
    throw new Error(`npm pack file entry ${index}.size must be a non-negative safe integer when provided.`);
  }
  const size = Math.max(metadataSize ?? 0, localStats.size);
  if (size > MAX_PACK_FILE_SIZE_BYTES) {
    throw new Error(`npm pack file entry ${index}.size must be at most ${MAX_PACK_FILE_SIZE_BYTES} bytes.`);
  }
  if (Object.prototype.hasOwnProperty.call(file, "mode")) {
    if (typeof file.mode !== "number" || !Number.isSafeInteger(file.mode) || file.mode < 0 || file.mode > MAX_PACK_FILE_MODE) {
      throw new Error(`npm pack file entry ${index}.mode must be a non-negative Unix file mode number when provided.`);
    }
    const fileType = file.mode & UNIX_FILE_TYPE_MASK;
    if (fileType !== 0 && fileType !== UNIX_REGULAR_FILE_TYPE) {
      throw new Error(`npm pack file entry ${index}.mode must describe a regular file when Unix file type bits are present.`);
    }
  }
  return path;
}).sort();

const duplicatePaths = paths.filter((path, index) => index > 0 && path === paths[index - 1]);
if (duplicatePaths.length > 0) {
  throw new Error(`npm pack file list contains duplicate paths: ${[...new Set(duplicatePaths)].join(", ")}`);
}

const forbidden = paths.filter((path) => path.startsWith("src/") || path.startsWith("tests/") || path.startsWith("scripts/") || path.startsWith(".github/"));
if (forbidden.length > 0) {
  throw new Error(`Package includes non-runtime project files: ${forbidden.join(", ")}`);
}

const sourceFiles = new Set(readdirSync("src").filter((path) => path.endsWith(".ts")));
if (hasReviewedPublicApiSourceSet(sourceFiles)) {
  validateReviewedSourceFiles(sourceFiles);
}
const requiredRuntimeFiles = ["README.md", "package.json", "dist/src/cli.js", "dist/src/index.js", "dist/src/mcp.js", "dist/src/pipeline.js"];
if (sourceFiles.has("jsonPreflight.ts")) {
  requiredRuntimeFiles.push("dist/src/jsonPreflight.js");
}
for (const required of requiredRuntimeFiles) {
  if (!paths.includes(required)) {
    throw new Error(`Package is missing required file: ${required}`);
  }
}

for (const path of paths) {
  if (path !== "README.md" && path !== "package.json" && !path.startsWith("dist/src/")) {
    throw new Error(`Package includes unexpected file: ${path}`);
  }
}

const packedPathSet = new Set(paths);
for (const sourceFile of sourceFiles) {
  if (sourceFile.endsWith(".d.ts")) {
    continue;
  }
  const stem = basename(sourceFile).replace(/\.ts$/u, "");
  const jsPath = `dist/src/${stem}.js`;
  const declarationPath = `dist/src/${stem}.d.ts`;
  if (!packedPathSet.has(jsPath)) {
    throw new Error(`Package is missing compiled JavaScript artifact for source: src/${sourceFile}`);
  }
  if (!packedPathSet.has(declarationPath)) {
    throw new Error(`Package is missing declaration artifact for source: src/${sourceFile}`);
  }
}
for (const path of paths) {
  if (!path.startsWith("dist/src/")) {
    continue;
  }
  if (path === "dist/src/node.d.ts") {
    throw new Error("Package must not include local Node type shim: dist/src/node.d.ts");
  }
  if (!path.endsWith(".js") && !path.endsWith(".d.ts")) {
    throw new Error(`Package includes unexpected dist artifact type: ${path}`);
  }
  const stem = basename(path).replace(/\.d\.ts$/u, "").replace(/\.js$/u, "");
  if (path.endsWith(".js") && !sourceFiles.has(`${stem}.ts`)) {
    throw new Error(`Package includes stale compiled JavaScript without source: ${path}`);
  }
  if (path.endsWith(".js") && !packedPathSet.has(path.replace(/\.js$/u, ".d.ts"))) {
    throw new Error(`Package is missing declaration file for JavaScript artifact: ${path}`);
  }
  if (path.endsWith(".d.ts") && !sourceFiles.has(`${stem}.ts`) && !sourceFiles.has(`${stem}.d.ts`)) {
    throw new Error(`Package includes stale declaration file without source: ${path}`);
  }
  if (path.endsWith(".d.ts") && sourceFiles.has(`${stem}.ts`) && !packedPathSet.has(path.replace(/\.d\.ts$/u, ".js"))) {
    throw new Error(`Package is missing JavaScript artifact for declaration file: ${path}`);
  }
}

if (sourceFiles.has("version.ts")) {
  const versionArtifact = readTextFile("dist/src/version.js", "dist/src/version.js", MAX_PACK_FILE_SIZE_BYTES);
  const versionMatch = versionArtifact.match(/\bPACKAGE_VERSION\s*=\s*["']([^"']+)["']/u);
  if (!versionMatch) {
    throw new Error("dist/src/version.js must export a concrete PACKAGE_VERSION string.");
  }
  if (versionMatch[1] !== packageJson.version) {
    throw new Error("dist/src/version.js PACKAGE_VERSION must match package.json version.");
  }
}

if (hasReviewedPublicApiSourceSet(sourceFiles)) {
  validateIndexRuntime(libraryEntry);
  validateIndexTypes(typeEntry);
}

if (sourceFiles.has("jsonPreflight.ts")) {
  validateJsonPreflightRuntime(readTextFile("dist/src/jsonPreflight.js", "dist/src/jsonPreflight.js", MAX_PACK_FILE_SIZE_BYTES));
  validateJsonPreflightTypes(readTextFile("dist/src/jsonPreflight.d.ts", "dist/src/jsonPreflight.d.ts", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("externalEpubCheck.ts")) {
  validateExternalEpubCheckRuntime(readTextFile("dist/src/externalEpubCheck.js", "dist/src/externalEpubCheck.js", MAX_PACK_FILE_SIZE_BYTES));
  validateExternalEpubCheckTypes(readTextFile("dist/src/externalEpubCheck.d.ts", "dist/src/externalEpubCheck.d.ts", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("mcp.ts")) {
  validateMcpRuntime(readTextFile("dist/src/mcp.js", "dist/src/mcp.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("openaiAgents.ts")) {
  validateOpenAiAgentsRuntime(readTextFile("dist/src/openaiAgents.js", "dist/src/openaiAgents.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("agents.ts")) {
  validateAgentsRuntime(readTextFile("dist/src/agents.js", "dist/src/agents.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("storage.ts")) {
  validateStorageRuntime(readTextFile("dist/src/storage.js", "dist/src/storage.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("pipeline.ts")) {
  validatePipelineRuntime(readTextFile("dist/src/pipeline.js", "dist/src/pipeline.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("jobs.ts")) {
  validateJobsRuntime(readTextFile("dist/src/jobs.js", "dist/src/jobs.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("logger.ts")) {
  validateLoggerRuntime(readTextFile("dist/src/logger.js", "dist/src/logger.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("config.ts")) {
  validateConfigRuntime(readTextFile("dist/src/config.js", "dist/src/config.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("agentFactory.ts")) {
  validateAgentFactoryRuntime(readTextFile("dist/src/agentFactory.js", "dist/src/agentFactory.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("redaction.ts")) {
  validateRedactionRuntime(readTextFile("dist/src/redaction.js", "dist/src/redaction.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("startup.ts")) {
  validateStartupRuntime(readTextFile("dist/src/startup.js", "dist/src/startup.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("cliArgs.ts")) {
  validateCliArgsRuntime(readTextFile("dist/src/cliArgs.js", "dist/src/cliArgs.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("cliIo.ts")) {
  validateCliIoRuntime(readTextFile("dist/src/cliIo.js", "dist/src/cliIo.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("execution.ts")) {
  validateExecutionRuntime(readTextFile("dist/src/execution.js", "dist/src/execution.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("toolResultValidation.ts")) {
  validateToolResultValidationRuntime(readTextFile("dist/src/toolResultValidation.js", "dist/src/toolResultValidation.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("stateValidation.ts")) {
  validateStateValidationRuntime(readTextFile("dist/src/stateValidation.js", "dist/src/stateValidation.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("epub.ts")) {
  validateEpubRuntime(readTextFile("dist/src/epub.js", "dist/src/epub.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (sourceFiles.has("validation.ts")) {
  validateValidationRuntime(readTextFile("dist/src/validation.js", "dist/src/validation.js", MAX_PACK_FILE_SIZE_BYTES));
}

if (pack.name !== packageJson.name) {
  throw new Error("npm pack package name must match package.json name.");
}
if (pack.version !== packageJson.version) {
  throw new Error("npm pack package version must match package.json version.");
}
if (Object.prototype.hasOwnProperty.call(pack, "id") && pack.id !== `${packageJson.name}@${packageJson.version}`) {
  throw new Error("npm pack package id must match package.json name and version.");
}
if (Object.prototype.hasOwnProperty.call(pack, "filename") && pack.filename !== `${packageJson.name}-${packageJson.version}.tgz`) {
  throw new Error("npm pack filename must match package.json name and version.");
}
if (Object.prototype.hasOwnProperty.call(pack, "size")) {
  if (typeof pack.size !== "number" || !Number.isSafeInteger(pack.size) || pack.size < 0) {
    throw new Error("npm pack size must be a non-negative safe integer.");
  }
  if (pack.size > MAX_PACK_TARBALL_SIZE_BYTES) {
    throw new Error(`npm pack size must be at most ${MAX_PACK_TARBALL_SIZE_BYTES} bytes.`);
  }
}
if (Object.prototype.hasOwnProperty.call(pack, "shasum") && (typeof pack.shasum !== "string" || !/^[a-f0-9]{40}$/u.test(pack.shasum))) {
  throw new Error("npm pack shasum must be a 40-character lowercase hex SHA-1 digest.");
}
if (
  Object.prototype.hasOwnProperty.call(pack, "integrity") &&
  (typeof pack.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(pack.integrity) || pack.integrity.length > 256)
) {
  throw new Error("npm pack integrity must be a bounded sha512 digest.");
}
if (typeof pack.entryCount !== "number" || !Number.isSafeInteger(pack.entryCount) || pack.entryCount !== files.length) {
  throw new Error("npm pack entryCount must match the returned file list length.");
}
if (typeof pack.unpackedSize !== "number" || !Number.isSafeInteger(pack.unpackedSize) || pack.unpackedSize < 0) {
  throw new Error("npm pack unpackedSize must be a non-negative safe integer.");
}
if (pack.unpackedSize > MAX_PACK_UNPACKED_SIZE_BYTES) {
  throw new Error(`npm pack unpackedSize must be at most ${MAX_PACK_UNPACKED_SIZE_BYTES} bytes.`);
}
if (!Array.isArray(pack.bundled)) {
  throw new Error("npm pack bundled metadata must be an array.");
}
assertPlainJsonArray(pack.bundled, "npm pack bundled metadata");
if (pack.bundled.length > 0) {
  throw new Error("npm pack must not include bundled dependencies.");
}

const packedBin = files.find((file) => isPlainJsonObject(file) && file.path === "dist/src/cli.js");
if (
  !packedBin ||
  typeof packedBin.mode !== "number" ||
  !Number.isSafeInteger(packedBin.mode) ||
  packedBin.mode < 0 ||
  packedBin.mode > MAX_PACK_FILE_MODE ||
  ((packedBin.mode & 0o777) & 0o111) === 0
) {
  throw new Error("Packed dist/src/cli.js must remain executable.");
}
validateCliEntrypoint(bin);

function isPlainJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainJsonObject(value, label) {
  if (!isPlainJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
}

function assertPlainJsonArray(value, label) {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be a standard array.`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string") {
      throw new Error(`${label} must not contain symbol properties.`);
    }
    if (!isArrayIndexKey(key, value.length)) {
      throw new Error(`${label}.${key} is not a supported array field.`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw new Error(`${label}[${key}] must be an enumerable data item.`);
    }
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.getOwnPropertyDescriptor(value, String(index))) {
      throw new Error(`${label}[${index}] must not be a sparse array hole.`);
    }
  }
}

function isArrayIndexKey(value, length) {
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    return false;
  }
  const index = Number(value);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value;
}

function requiredPlainJsonObject(value, label) {
  if (!isPlainJsonObject(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function optionalPlainJsonObject(object, fieldName, label) {
  if (!Object.prototype.hasOwnProperty.call(object, fieldName)) {
    return undefined;
  }
  const value = object[fieldName];
  if (!isPlainJsonObject(value)) {
    throw new Error(`${label} must be an object when present.`);
  }
  return value;
}

function jsonMetadataEqual(left, right) {
  if (left === right) {
    return true;
  }
  if (left === null || right === null || typeof left !== typeof right) {
    return false;
  }
  if (typeof left !== "object") {
    return false;
  }
  const leftIsArray = Array.isArray(left);
  const rightIsArray = Array.isArray(right);
  if (leftIsArray || rightIsArray) {
    if (!leftIsArray || !rightIsArray || left.length !== right.length) {
      return false;
    }
    for (let index = 0; index < left.length; index += 1) {
      const leftDescriptor = Object.getOwnPropertyDescriptor(left, String(index));
      const rightDescriptor = Object.getOwnPropertyDescriptor(right, String(index));
      if (!isEnumerableDataDescriptor(leftDescriptor) || !isEnumerableDataDescriptor(rightDescriptor)) {
        return false;
      }
      if (!jsonMetadataEqual(leftDescriptor.value, rightDescriptor.value)) {
        return false;
      }
    }
    return true;
  }
  if (!isPlainJsonObject(left) || !isPlainJsonObject(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index]) {
      return false;
    }
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, key);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, key);
    if (!isEnumerableDataDescriptor(leftDescriptor) || !isEnumerableDataDescriptor(rightDescriptor)) {
      return false;
    }
    if (!jsonMetadataEqual(leftDescriptor.value, rightDescriptor.value)) {
      return false;
    }
  }
  return true;
}

function isEnumerableDataDescriptor(descriptor) {
  return Boolean(descriptor?.enumerable && "value" in descriptor);
}

function validatePackageLockPackages(packages) {
  for (const path of Object.keys(packages)) {
    if (!allowedPackageLockPackagePaths.includes(path)) {
      throw new Error(`package-lock.json packages.${path} must not be present; lockfile dependency changes require an explicit packaging review.`);
    }
  }
  for (const path of allowedPackageLockPackagePaths) {
    if (!Object.prototype.hasOwnProperty.call(packages, path)) {
      throw new Error(`package-lock.json packages.${path || "<root>"} must be present.`);
    }
  }
  const typescript = requiredPlainJsonObject(packages["node_modules/typescript"], "package-lock.json packages.node_modules/typescript");
  for (const fieldName of Object.keys(typescript)) {
    if (!allowedPackageLockTypescriptFields.includes(fieldName)) {
      throw new Error(`package-lock.json packages.node_modules/typescript.${fieldName} must not be present; TypeScript lock metadata changes require an explicit packaging review.`);
    }
  }
  for (const [fieldName, expectedValue] of Object.entries(expectedPackageLockTypescript)) {
    if (!jsonMetadataEqual(typescript[fieldName], expectedValue)) {
      throw new Error(`package-lock.json packages.node_modules/typescript.${fieldName} must match the reviewed TypeScript lock metadata.`);
    }
  }
  if (typeof typescript.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(typescript.integrity) || typescript.integrity.length > 256) {
    throw new Error("package-lock.json packages.node_modules/typescript.integrity must be a bounded sha512 digest.");
  }
}

function hasReviewedPublicApiSourceSet(sourceFiles) {
  const reviewedPublicApiSources = [
    "agentFactory.ts",
    "agents.ts",
    "config.ts",
    "epub.ts",
    "execution.ts",
    "externalEpubCheck.ts",
    "jobs.ts",
    "logger.ts",
    "mcp.ts",
    "openaiAgents.ts",
    "pipeline.ts",
    "redaction.ts",
    "stateValidation.ts",
    "storage.ts",
    "startup.ts",
    "types.ts",
    "validation.ts",
    "version.ts"
  ];
  return reviewedPublicApiSources.every((sourceFile) => sourceFiles.has(sourceFile));
}

function validateReviewedSourceFiles(sourceFiles) {
  const reviewed = new Set(reviewedSourceFiles);
  for (const sourceFile of sourceFiles) {
    if (!reviewed.has(sourceFile)) {
      throw new Error(`src/${sourceFile} is not in the reviewed source file set; update pack-check before publishing new runtime modules.`);
    }
  }
  for (const sourceFile of reviewed) {
    if (!sourceFiles.has(sourceFile)) {
      throw new Error(`src/${sourceFile} is missing from the reviewed source file set.`);
    }
  }
}

function validateIndexRuntime(source) {
  const expectedRuntimeExports = [
    "CURRENT_STATE_SCHEMA_VERSION",
    "ExecutionDeadline",
    "JobManager",
    "Logger",
    "McpServer",
    "NovelPipeline",
    "NovelStorage",
    "OpenAiNovelAgents",
    "OperationCancelledError",
    "OperationTimeoutError",
    "PACKAGE_NAME",
    "PACKAGE_VERSION",
    "StdioLineProcessor",
    "StubNovelAgents",
    "ValidationError",
    "assertBoundedNonEmptySingleLineString",
    "assertBoundedNonEmptyString",
    "assertNonEmptyString",
    "assertObject",
    "assertRevisionTargetString",
    "assertSafeId",
    "assertShape",
    "asOptionalBoundedSingleLineString",
    "asOptionalBoundedString",
    "asOptionalString",
    "buildEpubArchive",
    "createNovelAgents",
    "createShutdownOnce",
    "createStdioServer",
    "exists",
    "loadConfig",
    "parseIssuePrefixedResult",
    "parseOpenAiTextResponse",
    "redactErrorMessage",
    "redactInlineSecrets",
    "runExternalEpubCheck",
    "slugify",
    "startupErrorMessage",
    "validateEpubArchive",
    "validateVolumeState"
  ].sort();
  const requiredSnippets = [
    "export { createNovelAgents } from \"./agentFactory.js\"",
    "export { StubNovelAgents } from \"./agents.js\"",
    "export { loadConfig } from \"./config.js\"",
    "export { buildEpubArchive, validateEpubArchive } from \"./epub.js\"",
    "export { ExecutionDeadline, OperationCancelledError, OperationTimeoutError } from \"./execution.js\"",
    "export { runExternalEpubCheck } from \"./externalEpubCheck.js\"",
    "export { JobManager } from \"./jobs.js\"",
    "export { Logger } from \"./logger.js\"",
    "export { createShutdownOnce, createStdioServer, McpServer, StdioLineProcessor } from \"./mcp.js\"",
    "export { OpenAiNovelAgents, parseIssuePrefixedResult, parseOpenAiTextResponse } from \"./openaiAgents.js\"",
    "export { NovelPipeline } from \"./pipeline.js\"",
    "export { redactErrorMessage, redactInlineSecrets } from \"./redaction.js\"",
    "export { validateVolumeState } from \"./stateValidation.js\"",
    "export { NovelStorage, exists, slugify } from \"./storage.js\"",
    "export { startupErrorMessage } from \"./startup.js\"",
    "export { CURRENT_STATE_SCHEMA_VERSION } from \"./types.js\"",
    "export { PACKAGE_NAME, PACKAGE_VERSION } from \"./version.js\"",
    "export { ValidationError, assertBoundedNonEmptySingleLineString, assertBoundedNonEmptyString, assertNonEmptyString, assertObject, assertRevisionTargetString, assertSafeId, assertShape, asOptionalBoundedSingleLineString, asOptionalBoundedString, asOptionalString } from \"./validation.js\""
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/index.js must expose the reviewed public runtime API: missing ${snippet}.`);
    }
  }
  const actualRuntimeExports = collectNamedRuntimeExports(source).sort();
  if (!jsonMetadataEqual(actualRuntimeExports, expectedRuntimeExports)) {
    throw new Error(
      `dist/src/index.js must expose exactly the reviewed public runtime API: expected ${expectedRuntimeExports.join(", ")}, actual ${actualRuntimeExports.join(", ")}.`
    );
  }
}

function collectNamedRuntimeExports(source) {
  if (/export\s+(?!\{)/u.test(source)) {
    throw new Error("dist/src/index.js must expose public runtime values through named re-export declarations only.");
  }
  const names = [];
  for (const match of source.matchAll(/export\s+\{([^}]*)\}\s+from\s+"[^"]+";/gu)) {
    for (const rawName of match[1].split(",")) {
      const name = rawName.trim();
      if (name.length > 0) {
        names.push(name.split(/\s+as\s+/u).pop().trim());
      }
    }
  }
  return names;
}

function validateIndexTypes(source) {
  const expectedTypeExports = [
    "AgentContext",
    "AgentProvider",
    "AgentResult",
    "AgentRole",
    "AppConfig",
    "AsyncToolName",
    "BeatState",
    "BuildEpubInput",
    "ChapterState",
    "ConflictRecord",
    "Confirmation",
    "ConfirmInput",
    "ContinueInput",
    "EpubValidationResult",
    "ExecutionSignal",
    "ExternalEpubCheckResult",
    "JobListSnapshot",
    "JobLoadResult",
    "JobQuarantineCleanupResult",
    "JobShutdownResult",
    "JobSnapshot",
    "JobStatus",
    "JobStatusSnapshot",
    "LogLevel",
    "NewProjectInput",
    "NovelAgents",
    "ObjectShape",
    "PipelineStatus",
    "ReviseInput",
    "StorageHealthCheck",
    "ToolResult",
    "VolumeState"
  ].sort();
  const requiredSnippets = [
    "export type { AppConfig, AgentProvider, LogLevel } from \"./config.js\"",
    "export type { EpubValidationResult } from \"./epub.js\"",
    "export type { ExecutionSignal } from \"./execution.js\"",
    "export type { ExternalEpubCheckResult } from \"./externalEpubCheck.js\"",
    "export type { AsyncToolName, JobListSnapshot, JobLoadResult, JobShutdownResult, JobSnapshot, JobStatus, JobStatusSnapshot } from \"./jobs.js\"",
    "export type { JobQuarantineCleanupResult, StorageHealthCheck } from \"./storage.js\"",
    "export type { AgentContext, AgentResult, AgentRole, BeatState, BuildEpubInput, ChapterState, ConflictRecord, Confirmation, ConfirmInput, ContinueInput, NewProjectInput, NovelAgents, PipelineStatus, ReviseInput, ToolResult, VolumeState } from \"./types.js\"",
    "export type { ObjectShape } from \"./validation.js\""
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/index.d.ts must expose the reviewed public type API: missing ${snippet}.`);
    }
  }
  const actualTypeExports = collectNamedTypeExports(source).sort();
  if (!jsonMetadataEqual(actualTypeExports, expectedTypeExports)) {
    throw new Error(
      `dist/src/index.d.ts must expose exactly the reviewed public type API: expected ${expectedTypeExports.join(", ")}, actual ${actualTypeExports.join(", ")}.`
    );
  }
}

function collectNamedTypeExports(source) {
  if (/export\s+type\s+(?!\{)/u.test(source)) {
    throw new Error("dist/src/index.d.ts must expose public types through named re-export declarations only.");
  }
  const names = [];
  for (const match of source.matchAll(/export\s+type\s+\{([^}]*)\}\s+from\s+"[^"]+";/gu)) {
    for (const rawName of match[1].split(",")) {
      const name = rawName.trim();
      if (name.length > 0) {
        names.push(name.split(/\s+as\s+/u).pop().trim());
      }
    }
  }
  return names;
}

function validateJsonPreflightRuntime(source) {
  const requiredSnippets = [
    "export function assertNoDuplicateJsonObjectKeys",
    "validateJsonPreflightText(text)",
    "validateJsonPreflightLabel(label)",
    "validateJsonPreflightMaxDepth(maxDepth)",
    "const MAX_JSON_PREFLIGHT_TEXT_BYTES = 16 * 1024 * 1024",
    "const MAX_JSON_PREFLIGHT_LABEL_BYTES = 512",
    "const MAX_JSON_PREFLIGHT_OBJECT_KEYS = 10000",
    "utf8ByteLengthUpTo(value, MAX_JSON_PREFLIGHT_TEXT_BYTES) > MAX_JSON_PREFLIGHT_TEXT_BYTES",
    "utf8ByteLengthUpTo(value, MAX_JSON_PREFLIGHT_LABEL_BYTES) > MAX_JSON_PREFLIGHT_LABEL_BYTES",
    "JSON.parse(safeText.slice(start, index))",
    "keys.has(key)",
    "keys.size > MAX_JSON_PREFLIGHT_OBJECT_KEYS",
    "must not contain duplicate object keys",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "objects must contain at most ${MAX_JSON_PREFLIGHT_OBJECT_KEYS} keys",
    "must be nested at most"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/jsonPreflight.js must contain reviewed JSON preflight runtime code: missing ${snippet}.`);
    }
  }
}

function validateJsonPreflightTypes(source) {
  const expected = "export declare function assertNoDuplicateJsonObjectKeys(text: string, label: string, maxDepth: number): void;";
  if (!source.includes(expected)) {
    throw new Error("dist/src/jsonPreflight.d.ts must expose the reviewed JSON preflight function signature.");
  }
}

function validateExternalEpubCheckRuntime(source) {
  const requiredSnippets = [
    "export async function runExternalEpubCheck",
    "const MAX_SET_TIMEOUT_MS = 2_147_483_647",
    "resolvedCommand",
    "await realpath(command)",
    "execFile(",
    "timeoutMsForTimer(Math.max(1, Math.min(operationTimeoutMs, remainingTimeoutMs)))",
    "maxBuffer: MAX_PROCESS_BUFFER_BYTES",
    "const MAX_CAPTURED_OUTPUT_BYTES = 16 * 1024",
    "const MAX_REPORTED_COMMAND_BYTES = 1024",
    "const MAX_REPORTED_ARG_BYTES = 1024",
    "const MAX_REPORTED_ERROR_BYTES = 4000",
    "const MAX_EPUB_PATH_BYTES = 4096",
    "const MAX_EXEC_ARG_TEMPLATE_BYTES = 4096",
    "cwd: DEFAULT_VALIDATOR_CWD",
    "env: externalValidatorEnv()",
    "validateRuntimeArgs(args)",
    "countEpubPlaceholders(argTemplates) !== 1",
    "External EPUB validator arguments must include exactly one {epub}.",
    "function countEpubPlaceholders(args)",
    "const prototype = safeGetPrototypeOf(config, \"External EPUB validator config\")",
    "for (const key of safeOwnKeys(config, \"External EPUB validator config\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(config, key, \"External EPUB validator config\")",
    "safeGetOwnPropertyDescriptor(config, key, \"External EPUB validator config\")",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "safeGetPrototypeOf(value, \"External EPUB validator arguments\") !== Array.prototype",
    "for (const key of safeOwnKeys(value, \"External EPUB validator arguments\"))",
    "safeGetOwnPropertyDescriptor(value, key, \"External EPUB validator arguments\")",
    "const descriptor = safeGetOwnPropertyDescriptor(value, String(index), \"External EPUB validator arguments\")",
    "utf8ByteLengthUpTo(descriptor.value, MAX_EXEC_ARG_TEMPLATE_BYTES) > MAX_EXEC_ARG_TEMPLATE_BYTES",
    "utf8ByteLengthUpTo(command, MAX_REPORTED_COMMAND_BYTES) > MAX_REPORTED_COMMAND_BYTES",
    "utf8ByteLengthUpTo(resolvedCommand, MAX_REPORTED_COMMAND_BYTES) > MAX_REPORTED_COMMAND_BYTES",
    "utf8ByteLengthUpTo(epubPath, MAX_EPUB_PATH_BYTES) > MAX_EPUB_PATH_BYTES",
    "access(resolvedCommand, constants.X_OK)",
    "access(epubPath, constants.R_OK)",
    "assertReadableRegularEpubFile(epubPath)",
    "redactInlineSecrets",
    "utf8ByteLengthUpTo(redacted, MAX_CAPTURED_OUTPUT_BYTES) <= MAX_CAPTURED_OUTPUT_BYTES",
    "function truncateTextByCharsAndBytes(value, maxChars, maxBytes)",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function truncateTextByCharsAndBytesWithMarker(value, marker, maxChars, maxBytes)",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function utf8PrefixLength(value, maxChars, maxBytes)",
    "stableJsonStringArray",
    "function timeoutMsForTimer(ms)",
    "return Math.min(ms, MAX_SET_TIMEOUT_MS)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/externalEpubCheck.js must contain reviewed external validator runtime code: missing ${snippet}.`);
    }
  }
}

function validateExternalEpubCheckTypes(source) {
  const requiredSnippets = [
    "export interface ExternalEpubCheckResult",
    "configured: boolean;",
    "valid: boolean;",
    "command?: string;",
    "resolvedCommand?: string;",
    "args?: string[];",
    "export declare function runExternalEpubCheck"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/externalEpubCheck.d.ts must expose the reviewed external validator API: missing ${snippet}.`);
    }
  }
}

function validateMcpRuntime(source) {
  const requiredSnippets = [
    "export class McpServer",
    "const MAX_MCP_ERROR_BYTES = 4000",
    "const MAX_JSON_RPC_ID_STRING_BYTES = 256",
    "const MAX_JSON_RPC_METHOD_BYTES = 128",
    "const MAX_JSON_RPC_OBJECT_KEY_BYTES = 512",
    "const MAX_JSON_RPC_STRING_BYTES = 16 * 1024",
    "const MAX_MCP_STORAGE_ROOT_BYTES = 4096",
    "const MAX_TOOL_NAME_BYTES = 128",
    "const MAX_TITLE_INPUT_BYTES = 512",
    "const MAX_OPTION_INPUT_BYTES = 256",
    "const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024",
    "\"x-maxUtf8Bytes\": MAX_TITLE_INPUT_BYTES",
    "\"x-maxUtf8Bytes\": MAX_OPTION_INPUT_BYTES",
    "\"x-maxUtf8Bytes\": MAX_INSTRUCTION_INPUT_BYTES",
    "\"x-maxUtf8Bytes\": 120",
    "name: \"novel_health\"",
    "name: \"novel_job_start\"",
    "name: \"novel_job_status\"",
    "name: \"novel_job_list\"",
    "name: \"novel_job_cleanup\"",
    "name: \"novel_job_cancel\"",
    "name: \"novel_new_project\"",
    "name: \"novel_confirm\"",
    "name: \"novel_continue\"",
    "name: \"novel_status\"",
    "name: \"novel_revise\"",
    "name: \"novel_build_epub\"",
    "toolName: \"novel_new_project\"",
    "toolName: \"novel_confirm\"",
    "toolName: \"novel_continue\"",
    "toolName: \"novel_revise\"",
    "toolName: \"novel_build_epub\"",
    "const MAX_TOOL_RESPONSE_TEXT_BYTES = 256 * 1024",
    "const encoder = new TextEncoder()",
    "const requestFields = validateJsonRpcRequest(request)",
    "sanitizeToolResultForClient(validateToolResultShape(result",
    "this.redactionRoot",
    "function toolResultText(result)",
    "MAX_TOOL_RESPONSE_TEXT_CHARS",
    "utf8ByteLengthUpTo(text, MAX_TOOL_RESPONSE_TEXT_BYTES) > MAX_TOOL_RESPONSE_TEXT_BYTES",
    "function sanitizeToolResultForClient(result, root)",
    "message: redactRootInMessage(redactInlineSecrets(result.message), root)",
    "function sanitizeToolResultJson(value, root)",
    "return redactRootInMessage(redactInlineSecrets(value), root)",
    "safeGetPrototypeOf(value, \"Tool result client data array\")",
    "Tool result client data array must be a standard or snapshotted array",
    "assertJsonRpcArrayDataProperties(value, \"Tool result client data array\")",
    "safeGetOwnPropertyDescriptor(value, String(index), \"Tool result client data array\")",
    "Tool result client data array[${index}] must not be a sparse array hole",
    "for (const key of safeOwnKeys(value, \"Tool result client data object\"))",
    "safeGetOwnPropertyDescriptor(value, key, \"Tool result client data object\")",
    "const redactedKey = uniqueSanitizedObjectKey(output, redactRootInMessage(redactInlineSecrets(key), root))",
    "value: sanitizeToolResultJson(descriptor.value, root)",
    "function startupHealthData(value, startupError)",
    "Tool result startup health data",
    "for (const key of safeOwnKeys(snapshot, \"Tool result startup health data snapshot\"))",
    "safeGetOwnPropertyDescriptor(snapshot, key, \"Tool result startup health data snapshot\")",
    "Tool result startup health data snapshot must not contain symbol properties",
    "Tool result startup health data snapshot.${key} must not contain non-enumerable or accessor properties",
    "value: descriptor.value",
    "const startupKey = uniqueSanitizedObjectKey(data, \"startup\")",
    "export function createStdioServer(server = new McpServer())",
    "let onData",
    "let onSigint",
    "const shutdownOnce = createShutdownOnce(server, async () =>",
    "process.stdin.off(\"data\", onData)",
    "process.stdin.off(\"end\", onEnd)",
    "process.off(\"SIGINT\", onSigint)",
    "process.off(\"SIGTERM\", onSigterm)",
    "clearInterval(keepAlive)",
    "process.stdin.on(\"data\", onData)",
    "process.on(\"SIGINT\", onSigint)",
    "const MAX_STDIO_PENDING_LINES = 1000",
    "pendingLines = 0",
    "this.pendingLines >= MAX_STDIO_PENDING_LINES",
    "JSON-RPC request queue exceeds ${MAX_STDIO_PENDING_LINES} pending lines.",
    "this.pendingLines -= 1",
    "currentBytes + segmentBytes > this.maxLineLength",
    "function validateStdioOptions(value)",
    "const prototype = safeGetPrototypeOf(value, \"StdioLineProcessor.options\")",
    "for (const key of safeOwnKeys(value, \"StdioLineProcessor.options\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, \"StdioLineProcessor.options\")",
    "assertNoDuplicateJsonObjectKeys(line, \"JSON-RPC request\", MAX_JSON_RPC_VALUE_DEPTH)",
    "const message = errorMessage(error)",
    "utf8ByteLengthUpTo(message, MAX_MCP_ERROR_BYTES) > MAX_MCP_ERROR_BYTES",
    "function truncateErrorMessage(message)",
    "utf8ByteLengthUpTo(message, MAX_MCP_ERROR_BYTES) <= MAX_MCP_ERROR_BYTES",
    "function truncateErrorMessageByBytes(message)",
    "const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_MCP_ERROR_BYTES)} UTF-8 bytes]`",
    "utf8PrefixLength(message, MAX_MCP_ERROR_BYTES - markerBytes)",
    "function utf8PrefixLength(value, maxBytes)",
    "boundedErrorResponse(null, -32700, `Parse error: ${message}`, maxLineLength)",
    "validateObjectForSymbolInjection(value, \"McpServer.pipeline\")",
    "safeInstanceOf(value, NovelPipeline, \"McpServer.pipeline\")",
    "validateObjectForSymbolInjection(value, \"McpServer.logger\")",
    "safeInstanceOf(value, Logger, \"McpServer.logger\")",
    "function validateObjectForSymbolInjection(value, label)",
    "assertNoSymbolInjectionProperties(value, \"McpServer.storage\")",
    "safeInstanceOf(value, NovelStorage, \"McpServer.storage\")",
    "safeGetOwnPropertyDescriptor(value, \"root\", \"McpServer.storage\")",
    "function assertNoSymbolInjectionProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "function safeInstanceOf(value, constructor, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function validateJsonRpcRequest(request)",
    "const snapshot = snapshotJsonValueShape(request, \"JSON-RPC request\", JSON_RPC_REQUEST_VALUE_LIMITS)",
    "function safeDataProperty(value, key)",
    "safeGetOwnPropertyDescriptor(value, key, \"JSON-RPC request fallback\")",
    "return { present: false }",
    "function optionalOwnDataProperty(value, key, label)",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, label)",
    "function validatedJsonRpcResponse(value)",
    "const snapshot = snapshotJsonValueShape(value, \"JSON-RPC response\", JSON_RPC_RESPONSE_VALUE_LIMITS)",
    "validateJsonRpcResponseEnvelope(snapshot)",
    "return snapshot",
    "function assertKnownFields(value, label, allowed)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} must not contain symbol properties.`)",
    "throw new Error(`${label} must not contain non-enumerable or accessor properties.`)",
    "function directErrorResponse(id, code, message)",
    "utf8ByteLengthUpTo(value, MAX_TOOL_NAME_BYTES) > MAX_TOOL_NAME_BYTES",
    "utf8ByteLengthUpTo(value, MAX_MCP_STORAGE_ROOT_BYTES) > MAX_MCP_STORAGE_ROOT_BYTES",
    "utf8ByteLengthUpTo(candidate.method, MAX_JSON_RPC_METHOD_BYTES) > MAX_JSON_RPC_METHOD_BYTES",
    "utf8ByteLengthUpTo(value, MAX_JSON_RPC_ID_STRING_BYTES) <= MAX_JSON_RPC_ID_STRING_BYTES",
    "maxObjectKeyBytes: MAX_JSON_RPC_OBJECT_KEY_BYTES",
    "maxStringBytes: MAX_JSON_RPC_STRING_BYTES",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "safeGetOwnPropertyDescriptor(current, String(index), currentLabel)",
    "const prototype = safeGetPrototypeOf(current, currentLabel)",
    "for (const key of safeOwnKeys(current, currentLabel))",
    "const descriptor = safeGetOwnPropertyDescriptor(current, key, currentLabel)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "utf8ByteLengthUpTo(key, limits.maxObjectKeyBytes) > limits.maxObjectKeyBytes",
    "utf8ByteLengthUpTo(current, limits.maxStringBytes) > limits.maxStringBytes",
    "const candidate = jsonRpcRequestFields(snapshot)",
    "return candidate",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function fitsMaxLine(value, maxLineLength)",
    "!fitsMaxLine(serialized, maxLineLength)",
    "Response exceeds ${maxLineLength} characters or UTF-8 bytes.",
    "fitsMaxLine(serialized, maxLineLength)",
    "fitsMaxLine(JSON.stringify(errorResponse(id, code, \"\")), maxLineLength)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/mcp.js must contain reviewed MCP runtime code: missing ${snippet}.`);
    }
  }
}

function validateOpenAiAgentsRuntime(source) {
  const requiredSnippets = [
    "import { redactErrorMessage, redactInlineSecrets } from \"./redaction.js\"",
    "import { assertNoDuplicateJsonObjectKeys } from \"./jsonPreflight.js\"",
    "export class OpenAiNovelAgents",
    "const MAX_SET_TIMEOUT_MS = 2_147_483_647",
    "const MAX_ERROR_BODY_BYTES = 4000",
    "const MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024",
    "const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024",
    "const MAX_OPENAI_CONTENT_BYTES = 16 * 1024 * 1024",
    "const MAX_RESPONSE_HEADERS = 100",
    "const MAX_RESPONSE_HEADER_NAME_CHARS = 256",
    "const MAX_RESPONSE_HEADER_NAME_BYTES = 256",
    "const MAX_RESPONSE_CONTENT_TYPE_CHARS = 512",
    "const MAX_RESPONSE_CONTENT_TYPE_BYTES = 512",
    "const MAX_ISSUE_PREFIXED_BYTES = 4000",
    "const MAX_ISSUE_PREFIXED_TEXT_BYTES = 2 * 1024 * 1024",
    "const MAX_OPENAI_ERROR_BYTES = 4000",
    "const MAX_OPENAI_ERROR_NAME_BYTES = 128",
    "const MAX_OPENAI_ROLE_LABEL_BYTES = 128",
    "const MAX_OPENAI_RESPONSE_META_BYTES = 1024",
    "const MAX_OPENAI_FINISH_REASON_BYTES = 64",
    "const MAX_OPENAI_API_KEY_BYTES = 4096",
    "const MAX_OPENAI_MODEL_BYTES = 200",
    "const MAX_OPENAI_BASE_URL_BYTES = 2048",
    "const MAX_OPENAI_ANNOTATIONS = 16",
    "const MAX_OPENAI_ANNOTATION_FIELDS = 50",
    "const MAX_OPENAI_ANNOTATION_DEPTH = 16",
    "const MAX_OPENAI_ANNOTATION_ARRAY_ITEMS = 1000",
    "const MAX_OPENAI_ANNOTATION_TOTAL_NODES = 10000",
    "const MAX_OPENAI_ANNOTATION_STRING_BYTES = 64 * 1024",
    "const MAX_OPENAI_ANNOTATION_KEY_BYTES = 512",
    "const MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES = 2048",
    "const MAX_PROMPT_CONTEXT_STRING_BYTES = 2 * 1024 * 1024",
    "const controller = new AbortController()",
    "requestTimeoutMs(this.openAiConfig, deadlineAt)",
    "authorization: `Bearer ${this.openAiConfig.openaiApiKey ?? \"\"}`",
    "validateSuccessfulResponseContentType(response.headers, role)",
    "parseOpenAiTextResponse(parseOpenAiJsonBody(responseBody, role), role)",
    "assertCustomFetchResponseSurface(value, `OpenAI-compatible response for ${safeRole}`)",
    "function assertCustomFetchResponseSurface(value, label)",
    "prototype !== Object.prototype && prototype !== null",
    "must be a native Response or plain response object",
    "assertKnownFetchResponseFields(value, label, [\"ok\", \"status\", \"headers\", \"text\"])",
    "validateResponseOkStatus(value.ok, value.status, `OpenAI-compatible response for ${safeRole}`)",
    "validateResponseOkStatus(ok, status, `OpenAI-compatible response for ${safeRole}`)",
    "function validateResponseOkStatus(ok, status, label)",
    "ok must match whether status is a 2xx HTTP status",
    "function assertKnownFetchResponseFields(value, label, allowedFields)",
    "must not contain symbol properties",
    "is not a supported field",
    "lowerKeys.size >= MAX_RESPONSE_HEADERS",
    "header names must be at most ${MAX_RESPONSE_HEADER_NAME_CHARS} characters",
    "utf8ByteLengthUpTo(key, MAX_RESPONSE_HEADER_NAME_BYTES) > MAX_RESPONSE_HEADER_NAME_BYTES",
    "value.length > MAX_RESPONSE_CONTENT_TYPE_CHARS",
    "utf8ByteLengthUpTo(value, MAX_RESPONSE_CONTENT_TYPE_BYTES) > MAX_RESPONSE_CONTENT_TYPE_BYTES",
    "utf8ByteLengthUpTo(descriptor.value, MAX_ISSUE_PREFIXED_TEXT_BYTES) > MAX_ISSUE_PREFIXED_TEXT_BYTES",
    "function assertIssuePrefixedResultSurface(value)",
    "safeGetOwnPropertyDescriptor(value, \"text\", \"Issue-prefixed agent result\")",
    "const prototype = safeGetPrototypeOf(value, \"Issue-prefixed agent result\")",
    "for (const key of safeOwnKeys(value, \"Issue-prefixed agent result\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, \"Issue-prefixed agent result\")",
    "Issue-prefixed agent result must be a plain object.",
    "function validateIssuePrefixedInputIssues(value)",
    "safeGetPrototypeOf(value, \"Issue-prefixed agent result.issues\") !== Array.prototype",
    "Issue-prefixed agent result.issues must contain at most",
    "utf8ByteLengthUpTo(value, MAX_ISSUE_PREFIXED_BYTES) <= MAX_ISSUE_PREFIXED_BYTES",
    "function truncateTextByCharsAndBytesWithMarker(value, marker, maxChars, maxBytes)",
    "utf8ByteLengthUpTo(value, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES",
    "utf8ByteLengthUpTo(normalized, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES",
    "utf8ByteLengthUpTo(value, MAX_OPENAI_API_KEY_BYTES) > MAX_OPENAI_API_KEY_BYTES",
    "utf8ByteLengthUpTo(value, MAX_OPENAI_MODEL_BYTES) > MAX_OPENAI_MODEL_BYTES",
    "const prototype = safeGetPrototypeOf(config, \"OpenAiNovelAgents.config\")",
    "for (const key of safeOwnKeys(config, \"OpenAiNovelAgents.config\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(config, key, \"OpenAiNovelAgents.config\")",
    "safeGetOwnPropertyDescriptor(config, key, \"OpenAiNovelAgents.config\")",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "assertPlainResponseObject(payload, `OpenAI-compatible response for ${safeRole}`)",
    "const prototype = safeGetPrototypeOf(value, label)",
    "safeGetPrototypeOf(value, label) !== Response.prototype",
    "safeGetOwnPropertyDescriptor(value, key, label) !== undefined",
    "for (const key of safeOwnKeys(value, label))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, label)",
    "function isNativeHeaders(value)",
    "return value instanceof Headers",
    "throw new Error(`${label}.content-type must be readable.`)",
    "const prototype = safeGetPrototypeOf(headers, label)",
    "for (const key of safeOwnKeys(headers, label))",
    "const descriptor = safeGetOwnPropertyDescriptor(headers, key, label)",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, label)",
    "validateResponseMetaString(dataProperty(payload, \"id\", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.id`)",
    "validateResponseObjectType(dataProperty(payload, \"object\", `OpenAI-compatible response for ${safeRole}`), safeRole)",
    "validateResponseCreated(dataProperty(payload, \"created\", `OpenAI-compatible response for ${safeRole}`), safeRole)",
    "validateResponseMetaString(dataProperty(payload, \"model\", `OpenAI-compatible response for ${safeRole}`), `OpenAI-compatible response for ${safeRole}.model`)",
    "validateResponseUsage(dataProperty(payload, \"usage\", `OpenAI-compatible response for ${safeRole}`), safeRole)",
    "function validateResponseMetaString(value, label)",
    "function validateResponseObjectType(value, role)",
    "function validateResponseCreated(value, role)",
    "function validateResponseUsage(value, role)",
    "function validateUsageTokenCount(value, label)",
    "function validateUsageDetails(value, label, allowedFields)",
    "const label = `OpenAI-compatible response for ${role}.usage`",
    "prompt_tokens_details",
    "completion_tokens_details",
    "validateUsageTokenCount(dataProperty(value, \"total_tokens\", label), `${label}.total_tokens`)",
    "promptTokens + completionTokens !== totalTokens",
    "total_tokens must equal prompt_tokens plus completion_tokens",
    "validateUsageDetails(dataProperty(value, \"prompt_tokens_details\", label), `${label}.prompt_tokens_details`, [\"cached_tokens\", \"audio_tokens\"])",
    "accepted_prediction_tokens",
    "prompt_tokens",
    "object must be chat.completion when provided",
    "created must be a non-negative safe integer when provided",
    "assertPlainResponseObject(firstChoice, `OpenAI-compatible response for ${safeRole}.choices[0]`)",
    "validateChoiceIndex(dataProperty(firstChoice, \"index\", `OpenAI-compatible response for ${safeRole}.choices[0]`), safeRole)",
    "function validateChoiceIndex(value, role)",
    "choices[0].index must be 0 when provided",
    "validateLogprobs(dataProperty(firstChoice, \"logprobs\", `OpenAI-compatible response for ${safeRole}.choices[0]`), safeRole)",
    "function validateLogprobs(value, role)",
    "choices[0].logprobs must be null when provided",
    "function validateFinishReason(value, role)",
    "utf8ByteLengthUpTo(value, MAX_OPENAI_FINISH_REASON_BYTES) > MAX_OPENAI_FINISH_REASON_BYTES",
    "validateMessageAnnotations(dataProperty(message, \"annotations\", `OpenAI-compatible response for ${safeRole}.choices[0].message`), safeRole)",
    "function validateMessageAnnotations(value, role)",
    "must include at most ${MAX_OPENAI_ANNOTATIONS} annotations",
    "function assertAnnotationFields(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "MAX_OPENAI_ANNOTATION_FIELDS",
    "validateAnnotationJsonValue(descriptor.value, `${label}.${key}`)",
    "function validateAnnotationJsonValue(value, label)",
    "MAX_OPENAI_ANNOTATION_TOTAL_NODES",
    "MAX_OPENAI_ANNOTATION_ARRAY_ITEMS",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "const prototype = safeGetPrototypeOf(current, currentLabel)",
    "for (const key of safeOwnKeys(current, currentLabel))",
    "safeGetOwnPropertyDescriptor(current, key, currentLabel)",
    "function arrayItem(value, index, label)",
    "safeGetOwnPropertyDescriptor(value, String(index), label)",
    "function assertOpenAiChoicesArray(value, label)",
    "safeGetPrototypeOf(value, label) !== Array.prototype",
    "if (!safeGetOwnPropertyDescriptor(value, String(index), label))",
    "MAX_OPENAI_ANNOTATION_STRING_BYTES",
    "MAX_OPENAI_ANNOTATION_KEY_BYTES",
    "must not contain circular references",
    "assertPlainResponseObject(message, `OpenAI-compatible response for ${safeRole}.choices[0].message`)",
    "function assertPlainResponseObject(value, label)",
    "throw new Error(`${label} must be a plain JSON object.`)",
    "function openAiRequestBody(value, role)",
    "normalizePromptJsonValue(value, `OpenAI-compatible request body for ${role}`)",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel)",
    "const prototype = safeGetPrototypeOf(current, currentLabel)",
    "const keys = safeOwnKeys(current, currentLabel)",
    "safeGetOwnPropertyDescriptor(current, key, currentLabel)",
    "entries.push([key, descriptor.value])",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "utf8ByteLengthUpTo(current, MAX_PROMPT_CONTEXT_STRING_BYTES) > MAX_PROMPT_CONTEXT_STRING_BYTES",
    "utf8ByteLengthUpTo(key, MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES) > MAX_PROMPT_CONTEXT_OBJECT_KEY_BYTES",
    "utf8ByteLengthUpTo(body, MAX_REQUEST_BODY_BYTES) > MAX_REQUEST_BODY_BYTES",
    "function parseOpenAiJsonBody(body, role)",
    "utf8ByteLengthUpTo(body, MAX_RESPONSE_BODY_BYTES) > MAX_RESPONSE_BODY_BYTES",
    "utf8ByteLengthUpTo(text, MAX_OPENAI_CONTENT_BYTES) > MAX_OPENAI_CONTENT_BYTES",
    "utf8ByteLengthUpTo(text, MAX_OPENAI_ROLE_LABEL_BYTES) > MAX_OPENAI_ROLE_LABEL_BYTES",
    "assertNoDuplicateJsonObjectKeys(body, `OpenAI-compatible response body for ${role}`, MAX_RESPONSE_JSON_DEPTH)",
    "function redactSecrets(value, config)",
    "redactInlineSecrets(value.replace(OPENAI_ERROR_CONTROL_CHARS_GLOBAL, \" \"))",
    "redacted.split(config.openaiBaseUrl).join(\"<openai-base-url>\")",
    "redacted.split(config.openaiApiKey).join(\"<openai-api-key>\")",
    "function normalizeOpenAiError(error, config)",
    "new Error(truncateOpenAiErrorText(redactSecrets(redactErrorMessage(error), config)))",
    "function truncateErrorBody(body)",
    "utf8ByteLengthUpTo(body, MAX_ERROR_BODY_BYTES) <= MAX_ERROR_BODY_BYTES",
    "function truncateOpenAiErrorText(message)",
    "utf8ByteLengthUpTo(message, MAX_OPENAI_ERROR_BYTES) <= MAX_OPENAI_ERROR_BYTES",
    "function safeErrorName(error)",
    "const descriptor = safeErrorNameDescriptor(current)",
    "const prototype = safeErrorPrototype(current)",
    "current = prototype",
    "function safeErrorNameDescriptor(value)",
    "function safeErrorPrototype(value)",
    "utf8ByteLengthUpTo(value, MAX_OPENAI_ERROR_NAME_BYTES) <= MAX_OPENAI_ERROR_NAME_BYTES",
    "function timeoutMsForTimer(ms)",
    "return Math.min(ms, MAX_SET_TIMEOUT_MS)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/openaiAgents.js must contain reviewed OpenAI adapter runtime code: missing ${snippet}.`);
    }
  }
}

function validateAgentsRuntime(source) {
  const requiredSnippets = [
    "export class StubNovelAgents",
    "async planInitial(input)",
    "const title = input.workRequest.trim()",
    "`# 대략 전개안: ${title}`",
    "`- 프랜차이즈: ${input.franchiseName}`",
    "`- 장르: ${input.genre ?? \"미정\"}`",
    "`- 톤: ${input.tone ?? \"미정\"}`",
    "`- 목표 분량: ${input.targetLength ?? \"중편 1권\"}`",
    "async buildWorld(input, approvedOutline)",
    "`# ${input.franchiseName} 세계관`",
    "approvedOutline",
    "async planSkeleton(contextState, input)",
    "const title = contextState.workTitle",
    "`# ${title} 스켈레톤`",
    "`요청 메모: ${input.workRequest}`",
    "async writeBeat(context)",
    "const beat = requireBeat(context)",
    "`### ${beat.title}`",
    "async editBeat(_context, draft)",
    "편집 메모를 반영해 문장의 리듬과 장면 전환을 다듬었다.",
    "async proofreadBeat(_context, edited)",
    "edited.includes(\"깨진문장\")",
    "async checkContinuity(context, text)",
    "const issueText = [...(context.feedback ?? []), text].join(\"\\n\")",
    "issueText.includes(\"[CONFLICT]\")",
    "scope: \"continuity\"",
    "severity: \"blocking\"",
    "resolved: false",
    "async editJoinedBeats(_context, text)",
    "연결 검수: 이전 비트와 현재 비트의 장면 흐름을 확인했다.",
    "async buildEpub(context, markdown)",
    "function requireBeat(context)",
    "if (!context.currentBeat)",
    "throw new Error(\"currentBeat is required\")"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/agents.js must contain reviewed stub agents runtime code: missing ${snippet}.`);
    }
  }
}

function validateStorageRuntime(source) {
  const requiredSnippets = [
    "import { assertNoDuplicateJsonObjectKeys } from \"./jsonPreflight.js\"",
    "export class NovelStorage",
    "const MAX_SET_TIMEOUT_MS = 2_147_483_647",
    "const MAX_MARKDOWN_FRONTMATTER_BYTES = 64 * 1024",
    "const MAX_COLLECTED_VOLUME_MARKDOWN_CHARS = 16 * 1024 * 1024",
    "const MAX_COLLECTED_VOLUME_MARKDOWN_BYTES = 16 * 1024 * 1024",
    "const MAX_STORAGE_ERROR_BYTES = 4000",
    "const MAX_STORAGE_ROOT_BYTES = 4096",
    "const MAX_STORAGE_PATH_BYTES = 8192",
    "const MAX_DIRECTORY_SCAN_ENTRIES = 10000",
    "const MAX_DIRECTORY_ENTRY_NAME_BYTES = 1024",
    "const MAX_MARKDOWN_FRONTMATTER_KEY_BYTES = 512",
    "const MAX_JSON_OBJECT_KEY_BYTES = 2048",
    "const MAX_JSON_STRING_BYTES = 1024 * 1024",
    "const prototype = safeGetPrototypeOf(value, \"NovelStorage config\")",
    "for (const key of safeOwnKeys(value, \"NovelStorage config\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, \"NovelStorage config\")",
    "safeGetOwnPropertyDescriptor(value, key, \"NovelStorage config\")",
    "const prototype = safeGetPrototypeOf(value, \"Storage state\")",
    "for (const key of safeOwnKeys(value, \"Storage state\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, \"Storage state\")",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "function isErrno(error, code)",
    "safeGetOwnPropertyDescriptor(current, \"code\", \"Storage errno\")",
    "safeGetPrototypeOf(current, \"Storage errno\")",
    "import { access, lstat, mkdir, open, opendir",
    "const stableValue = snapshotJsonMetadataValue(value, \"JSON metadata file\")",
    "utf8ByteLengthUpTo(trimmed, MAX_STORAGE_ROOT_BYTES) > MAX_STORAGE_ROOT_BYTES",
    "await this.writeFileAtomic(path, content)",
    "async writeFileAtomic(path, content)",
    "const contentLabel = `Atomic write content for ${path}`",
    "assertWritableContent(content, contentLabel)",
    "const stableContent = snapshotWritableContent(content, contentLabel)",
    "function isWritableUint8Array(value, label)",
    "return value instanceof Uint8Array",
    "throw new Error(`${label} Uint8Array prototype must be readable.`)",
    "function writableUint8ArrayByteLength(value, label)",
    "throw new Error(`${label} Uint8Array byteLength must be readable.`)",
    "function snapshotWritableContent(value, label)",
    "throw new Error(`${label} must be snapshot-readable.`)",
    "await this.assertRealPathInsideRoot(parent, `parent directory for ${path}`)",
    "const tempIdentity = await this.writeTempFileExclusive(tempPath, stableContent)",
    "await this.assertSameFileIdentity(tempPath, tempIdentity, `temporary file for ${path}`)",
    "await rename(tempPath, path)",
    "await this.syncDirectory(parent, `parent directory for ${path}`)",
    "utf8ByteLengthUpTo(value, MAX_STORAGE_PATH_BYTES) > MAX_STORAGE_PATH_BYTES",
    "async quarantineJob(jobId)",
    "await this.beforeQuarantineJobRename(source, destination)",
    "await this.assertSameFileIdentity(source, sourceStats, `job snapshot ${source}`)",
    "async beforeQuarantineJobRename(_source, _destination)",
    "identity: {",
    "dev: stats.dev",
    "await this.assertSameFileIdentity(path, identity, `job quarantine snapshot ${path}`)",
    "const handle = await open(path, \"wx\")",
    "throw new Error(`${label} path must not be a symbolic link: ${path}`)",
    "async assertRealPathInsideRoot(path, label)",
    "throw new Error(`${label} resolves outside storage root: ${path}`)",
    "function parseJsonMetadataText(text, path)",
    "assertNoDuplicateJsonObjectKeys(text, \"JSON metadata file\", MAX_JSON_VALUE_DEPTH)",
    "function parseLockOwnerToken(text)",
    "assertNoDuplicateJsonObjectKeys(text, \"Lock owner file\", MAX_JSON_VALUE_DEPTH)",
    "safeGetPrototypeOf(owner, \"Lock owner file\")",
    "for (const key of safeOwnKeys(owner, \"Lock owner file\"))",
    "safeGetOwnPropertyDescriptor(owner, key, \"Lock owner file\")",
    "safeGetOwnPropertyDescriptor(owner, \"updatedAt\", \"Lock owner file\")",
    "safeGetOwnPropertyDescriptor(owner, \"token\", \"Lock owner file\")",
    "function errorMessage(error)",
    "utf8ByteLengthUpTo(redacted, MAX_STORAGE_ERROR_BYTES) <= MAX_STORAGE_ERROR_BYTES",
    "function truncateStorageErrorByBytes(value)",
    "const marker = `... [truncated ${Math.max(0, utf8ByteLength(value) - MAX_STORAGE_ERROR_BYTES)} UTF-8 bytes]`",
    "validateJsonMetadataValue(parsed, \"JSON metadata file\")",
    "key.length > MAX_MARKDOWN_FRONTMATTER_KEY_CHARS",
    "utf8ByteLengthUpTo(key, MAX_MARKDOWN_FRONTMATTER_KEY_BYTES) > MAX_MARKDOWN_FRONTMATTER_KEY_BYTES",
    "function markdownFrontmatterEntries(frontmatter, label)",
    "const prototype = safeGetPrototypeOf(frontmatter, label)",
    "for (const key of safeOwnKeys(frontmatter, label))",
    "const descriptor = safeGetOwnPropertyDescriptor(frontmatter, key, label)",
    "function snapshotJsonMetadataValue(value, label, options = {})",
    "throw new Error(`${currentLabel} must not be undefined.`)",
    "throw new Error(`${currentLabel} must not contain circular references.`)",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "const descriptor = safeGetOwnPropertyDescriptor(current, String(index), currentLabel)",
    "const prototype = safeGetPrototypeOf(current, currentLabel)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "function assertKnownFields(value, label, allowed)",
    "for (const key of safeOwnKeys(value, label))",
    "throw new Error(`${label} must not contain symbol properties.`)",
    "throw new Error(`${label} must not contain non-enumerable or accessor properties.`)",
    "utf8ByteLengthUpTo(current, MAX_JSON_STRING_BYTES) > MAX_JSON_STRING_BYTES",
    "utf8ByteLengthUpTo(key, MAX_JSON_OBJECT_KEY_BYTES) > MAX_JSON_OBJECT_KEY_BYTES",
    "for await (const name of this.readDirectoryNames(dir))",
    "async *readDirectoryNames(dir)",
    "const directory = await opendir(dir)",
    "if (scanned > MAX_DIRECTORY_SCAN_ENTRIES)",
    "if (!isSupportedDirectoryEntryName(entry.name))",
    "for await (const entry of directory)",
    "function isSupportedDirectoryEntryName(value)",
    "utf8ByteLengthUpTo(value, MAX_DIRECTORY_ENTRY_NAME_BYTES) <= MAX_DIRECTORY_ENTRY_NAME_BYTES",
    "async collectVolumeMarkdown(state)",
    "candidate-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\\\.epub",
    "function escapeRegExp(value)",
    "beatPath(state, chapterNo, beatNo)",
    "assertDeclaredBeat(validated, chapterNo, beatNo)",
    "assertDeclaredBeat(validated, safeChapterNo, safeBeatNo)",
    "function assertDeclaredBeat(state, chapterNo, beatNo)",
    "Beat is not declared in volume state",
    "utf8ByteLengthUpTo(header, MAX_MARKDOWN_FRONTMATTER_BYTES) > MAX_MARKDOWN_FRONTMATTER_BYTES",
    "Beat markdown frontmatter field must not contain control characters",
    "let collectedBytes = 0",
    "utf8ByteLengthUpTo(part, MAX_COLLECTED_VOLUME_MARKDOWN_BYTES)",
    "MAX_COLLECTED_VOLUME_MARKDOWN_BYTES",
    "must be non-empty after trimming",
    "async loadCurrentState()",
    "async writeCurrentPointer(state)",
    "this.validateCurrentPointer(await this.readJson",
    "validateCurrentPointer(value)",
    "const pointer = assertObject(value, \"current pointer\")",
    "assertKnownFields(pointer, \"current pointer\", [\"franchiseId\", \"workId\", \"volumeId\"])",
    "franchiseId: assertSafeId(pointer.franchiseId, \"current.franchiseId\")",
    "workId: assertSafeId(pointer.workId, \"current.workId\")",
    "volumeId: assertSafeId(pointer.volumeId, \"current.volumeId\")",
    "readCurrentPointerWithBackup(path)",
    "function boundedUtf8ByteLength(value, label)",
    "return utf8ByteLengthUpTo(value, MAX_ATOMIC_WRITE_BYTES)",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "setTimeout(resolveSleep, timeoutMsForTimer(ms))",
    "function timeoutMsForTimer(ms)",
    "return Math.min(ms, MAX_SET_TIMEOUT_MS)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/storage.js must contain reviewed storage runtime code: missing ${snippet}.`);
    }
  }
}

function validatePipelineRuntime(source) {
  const requiredSnippets = [
    "import { ExecutionDeadline } from \"./execution.js\"",
    "import { validateVolumeState } from \"./stateValidation.js\"",
    "export class NovelPipeline",
    "this.storage = validatePipelineStorage(storage)",
    "this.agents = validatePipelineAgents(agents)",
    "this.config = validatePipelineConfig(config)",
    "const MAX_AGENT_TEXT_BYTES = 16 * 1024 * 1024",
    "const MAX_PIPELINE_ERROR_BYTES = 16 * 1024",
    "const MAX_PIPELINE_OPENAI_BASE_URL_BYTES = 2048",
    "const MAX_PIPELINE_OPENAI_MODEL_BYTES = 200",
    "const MAX_PIPELINE_OPENAI_API_KEY_BYTES = 4096",
    "const MAX_PIPELINE_STORAGE_ROOT_BYTES = 4096",
    "const MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES = 1024",
    "const MAX_PIPELINE_EPUBCHECK_ARG_BYTES = 4096",
    "const MAX_TITLE_INPUT_BYTES = 512",
    "const MAX_OPTION_INPUT_BYTES = 256",
    "const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024",
    "const MAX_AGENT_ISSUE_BYTES = 4000",
    "return this.withRootRedaction(async () =>",
    "new ExecutionDeadline(this.config.operationTimeoutMs, signal)",
    "state.status = \"pending_user_confirmation\"",
    "validateAgentResult(await this.agents.writeBeat",
    "result.conflict === undefined || result.conflict === null",
    "validateAgentResult(await this.agents.editBeat",
    "validateAgentResult(await this.agents.proofreadBeat",
    "validateAgentResult(await this.agents.checkContinuity",
    "appendConflict(state, continuity.conflict)",
    "incrementBeatRetryCount(beat)",
    "beat.retryCount > this.config.reviewMaxRetries",
    "appendConfirmation(state, {",
    "kind: \"conflict_resolution\"",
    "assertNoSymbolInjectionProperties(value, \"NovelPipeline.storage\")",
    "assertNoSymbolInjectionProperties(value, \"NovelPipeline.agents\")",
    "function assertNoSymbolInjectionProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, \"root\", \"NovelPipeline.storage\")",
    "function validateMethodObject(value, methodName, label)",
    "safeGetOwnPropertyDescriptor(current, methodName, label)",
    "safeGetPrototypeOf(current, label)",
    "const prototype = safeGetPrototypeOf(config, \"NovelPipeline.config\")",
    "for (const key of safeOwnKeys(config, \"NovelPipeline.config\"))",
    "const descriptor = safeGetOwnPropertyDescriptor(config, key, \"NovelPipeline.config\")",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "assertRequiredStorageHealthFields(object)",
    "const prototype = safeGetPrototypeOf(value, \"Storage health check\")",
    "for (const key of safeOwnKeys(value, \"Storage health check\"))",
    "safeGetOwnPropertyDescriptor(value, key, \"Storage health check\")",
    "safeGetOwnPropertyDescriptor(value, \"root\", \"Storage health check\")",
    "function assertRequiredStorageHealthFields(value)",
    "Storage health check.${key} is required",
    "validateStorageHealthRoot(object)",
    "function validateStorageHealthRoot(value)",
    "Storage health check.root must be a non-empty string when provided",
    "Storage health check.${key} must be a non-empty string when provided",
    "validateAgentResult(await this.agents.editJoinedBeats",
    "const previousState = cloneVolumeState(state)",
    "const previousBeatFile = await this.storage.readBeatFile",
    "await this.storage.writeBeatFile(previousState, beat.chapterNo, beat.beatNo, previousBeatFile)",
    "advanceCursor(state)",
    "return validateVolumeState(state)",
    "function summarizeState(state)",
    "pendingConfirmationHasMore: pendingConfirmations.length > MAX_SUMMARY_ITEMS",
    "unresolvedConflictHasMore: unresolvedConflicts.length > MAX_SUMMARY_ITEMS",
    "pendingConfirmations: pendingConfirmations.slice(0, MAX_SUMMARY_ITEMS).map(summaryConfirmation)",
    "unresolvedConflicts: unresolvedConflicts.slice(0, MAX_SUMMARY_ITEMS).map(summaryConflict)",
    "function assertOnlyFields(value, label, allowed)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "`${label} must contain at most ${allowed.length} supported fields.`",
    "`${label}.${key} must be an enumerable data property.`",
    "function boundedNonEmptyString(value, label, maxChars, maxBytes",
    "MAX_AGENT_ISSUE_CHARS, MAX_AGENT_ISSUE_BYTES",
    "safeGetPrototypeOf(value, label) !== Array.prototype",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "safeGetOwnPropertyDescriptor(value, String(index), label)",
    "utf8ByteLengthUpTo(text, maxBytes) > maxBytes",
    "utf8ByteLengthUpTo(value, MAX_PIPELINE_STORAGE_ROOT_BYTES) > MAX_PIPELINE_STORAGE_ROOT_BYTES",
    "utf8ByteLengthUpTo(trimmed, MAX_PIPELINE_STORAGE_ROOT_BYTES) > MAX_PIPELINE_STORAGE_ROOT_BYTES",
    "utf8ByteLengthUpTo(normalized, MAX_PIPELINE_OPENAI_BASE_URL_BYTES) > MAX_PIPELINE_OPENAI_BASE_URL_BYTES",
    "utf8ByteLengthUpTo(value, maxBytes) > maxBytes",
    "utf8ByteLengthUpTo(value, MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES) > MAX_PIPELINE_EPUBCHECK_COMMAND_BYTES",
    "safeGetPrototypeOf(value, \"NovelPipeline.epubCheckArgs\") !== Array.prototype",
    "for (const key of safeOwnKeys(value, \"NovelPipeline.epubCheckArgs\"))",
    "safeGetOwnPropertyDescriptor(value, key, \"NovelPipeline.epubCheckArgs\")",
    "const descriptor = safeGetOwnPropertyDescriptor(value, String(index), \"NovelPipeline.epubCheckArgs\")",
    "utf8ByteLengthUpTo(descriptor.value, MAX_PIPELINE_EPUBCHECK_ARG_BYTES) > MAX_PIPELINE_EPUBCHECK_ARG_BYTES",
    "assertBoundedNonEmptySingleLineString(object.franchiseName, \"franchiseName\", MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES)",
    "asOptionalBoundedString(object.revisionInstruction, \"revisionInstruction\", MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES)",
    "assertRevisionTargetString(object.target, \"target\", MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES)",
    "assertBoundedNonEmptyString(object.instruction, \"instruction\", MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES)",
    "function truncatePipelineText(value, maxChars, maxBytes)",
    "return truncatePipelineTextByCharsAndBytes(value, maxChars, maxBytes)",
    "function truncatePipelineTextByCharsAndBytes(value, maxChars, maxBytes)",
    "const marker = `... [truncated ${Math.max(0, utf8ByteLength(value) - maxBytes)} UTF-8 bytes]`",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8PrefixLength(value, maxChars, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "throw new Error(errorMessage(error, this.storage.root))"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/pipeline.js must contain reviewed pipeline runtime code: missing ${snippet}.`);
    }
  }
}

function validateJobsRuntime(source) {
  const requiredSnippets = [
    "import { validateToolResultShape } from \"./toolResultValidation.js\"",
    "import { redactErrorMessage, redactInlineSecrets } from \"./redaction.js\"",
    "export class JobManager",
    "validateJobPipeline(pipeline)",
    "validateJobStorage(storage)",
    "assertNoSymbolInjectionProperties(value, \"JobManager.pipeline\")",
    "safeInstanceOf(value, NovelPipeline, \"JobManager.pipeline\")",
    "assertNoSymbolInjectionProperties(value, \"JobManager.storage\")",
    "safeInstanceOf(value, NovelStorage, \"JobManager.storage\")",
    "safeGetOwnPropertyDescriptor(value, \"root\", \"JobManager.storage\")",
    "function assertNoSymbolInjectionProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "function safeInstanceOf(value, constructor, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function validateMethodObject(value, methodName, label)",
    "safeGetOwnPropertyDescriptor(current, methodName, label)",
    "safeGetPrototypeOf(current, label)",
    "const MAX_SET_TIMEOUT_MS = 2_147_483_647",
    "const MAX_JOB_ERROR_BYTES = 4000",
    "const MAX_JOB_RESULT_JSON_BYTES = 256 * 1024",
    "const MAX_JOB_STORAGE_ROOT_BYTES = 4096",
    "const MAX_TITLE_INPUT_BYTES = 512",
    "const MAX_OPTION_INPUT_BYTES = 256",
    "const MAX_INSTRUCTION_INPUT_BYTES = 16 * 1024",
    "const encoder = new TextEncoder()",
    "utf8ByteLengthUpTo(value, MAX_JOB_STORAGE_ROOT_BYTES) > MAX_JOB_STORAGE_ROOT_BYTES",
    "async loadPersistedJobs()",
    "for (const jobId of await listPersistedJobIds(storage))",
    "const saved = validatePersistedJob(await storage.readJob(jobId), jobId)",
    "saved.result = redactToolResultRoot(saved.result, storage.root)",
    "job.status = job.cancelRequested ? \"cancelled\" : \"failed\"",
    "await this.persistOrRecord(job)",
    "await storage.quarantineJob(jobId)",
    "entry.quarantinePath = reportedJobPath(quarantinePath, storage.root)",
    "function reportedJobPath(value, root)",
    "const redacted = redactRoot(errorMessage(value), root)",
    "this.queuePersistence(job)",
    "this.pumpQueue()",
    "const nextOffset = parsed.offset + jobs.length",
    "const hasMore = nextOffset < matched.length",
    "hasMore",
    "...(hasMore ? { nextOffset } : {})",
    "async cancel(input)",
    "persistencePending = !await this.waitForPersistence(this.persistOrRecord(job), deadline)",
    "async shutdown(waitMs = 5000)",
    "Promise.allSettled([...this.activeRuns])",
    "Promise.allSettled(pendingPersistence).then(() => undefined)",
    "async persistOrRecord(job)",
    "const nextSnapshot = snapshot(job, this.storage?.root)",
    "delete nextSnapshot.persistenceError",
    "const next = previous.catch(() => undefined).then(() => this.writeJobSnapshot(job, nextSnapshot))",
    "job.persistenceTail = next",
    "queuePersistence(job)",
    "async writeJobSnapshot(job, nextSnapshot)",
    "job.persistenceError = redactRoot(message, this.storage?.root) ?? message",
    "function listPersistedJobIds(storage)",
    "safeGetPrototypeOf(rawIds, \"JobManager.storage.listJobIds result\") !== Array.prototype",
    "for (const key of safeOwnKeys(rawIds, \"JobManager.storage.listJobIds result\"))",
    "safeGetOwnPropertyDescriptor(rawIds, key, \"JobManager.storage.listJobIds result\")",
    "safeGetOwnPropertyDescriptor(rawIds, String(index), \"JobManager.storage.listJobIds result\")",
    "assertSafeId(descriptor.value, `JobManager.storage.listJobIds result[${index}]`)",
    "throw new Error(`${label} prototype must be readable.`)",
    "throw new Error(`${label} keys must be readable.`)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "seenIds.has(jobId)",
    "JobManager.storage.listJobIds result must not contain duplicate job ids",
    "function validatePersistedJob(value, expectedJobId)",
    "validateJobTimestampOrder(expectedJobId, status, object.createdAt, object.startedAt, object.finishedAt)",
    "validateJobOutcomeFields(expectedJobId, status, object.result, object.error)",
    "validateJobCancellationFields(expectedJobId, status, object.cancelRequested)",
    "!isTerminalStatus(status) && Object.prototype.hasOwnProperty.call(object, \"args\")",
    "optionalJobErrorString(object.error, `persisted job ${expectedJobId}.error`)",
    "redactToolResultRoot(validateToolResult(object.result, `persisted job ${expectedJobId}.result`), undefined)",
    "function assertKnownFields(value, label, allowed)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} must not contain symbol properties.`)",
    "throw new Error(`${label} must not contain non-enumerable or accessor properties.`)",
    "function validateToolResult(value, label)",
    "assertBoundedNonEmptySingleLineString(object.franchiseName, `${label}.franchiseName`, MAX_TITLE_INPUT_CHARS, MAX_TITLE_INPUT_BYTES)",
    "asOptionalBoundedString(object.revisionInstruction, `${label}.revisionInstruction`, MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES)",
    "assertRevisionTargetString(object.target, `${label}.target`, MAX_OPTION_INPUT_CHARS, MAX_OPTION_INPUT_BYTES)",
    "assertBoundedNonEmptyString(object.instruction, `${label}.instruction`, MAX_INSTRUCTION_INPUT_CHARS, MAX_INSTRUCTION_INPUT_BYTES)",
    "function cloneJobArgs(args)",
    "for (const key of safeOwnKeys(args, \"Validated job args\"))",
    "safeGetOwnPropertyDescriptor(args, key, \"Validated job args\")",
    "assertJsonSnapshotSize(result, label)",
    "function validateJobQuarantineCleanupResult(value)",
    "assertRequiredCleanupFields(object)",
    "safeGetPrototypeOf(failuresValue, \"cleanupJobQuarantine.failures\") !== Array.prototype",
    "for (const key of safeOwnKeys(values, \"cleanupJobQuarantine.failures\"))",
    "safeGetOwnPropertyDescriptor(values, key, \"cleanupJobQuarantine.failures\")",
    "const descriptor = safeGetOwnPropertyDescriptor(values, String(index), \"cleanupJobQuarantine.failures\")",
    "function assertRequiredCleanupFields(value)",
    "for (const key of [\"deleted\", \"failed\", \"failures\", \"failureItemLimit\"])",
    "cleanupJobQuarantine.${key} is required",
    "function assertQuarantineCleanupCounts(failed, returnedFailures, failureItemLimit)",
    "cleanupJobQuarantine.failed must be greater than or equal to the returned failure count",
    "cleanupJobQuarantine.failureItemLimit must be greater than or equal to the returned failure count",
    "function quarantineCleanupText(value, label)",
    "cleanupJobQuarantine.failures[${index}].path",
    "cleanupJobQuarantine.failures[${index}].error",
    "utf8ByteLengthUpTo(serialized, MAX_JOB_RESULT_JSON_BYTES) > MAX_JOB_RESULT_JSON_BYTES",
    "function jsonStringifySnapshot(value, label)",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "assertJsonSnapshotArrayProperties(current, currentLabel)",
    "safeGetOwnPropertyDescriptor(current, String(index), currentLabel)",
    "for (const key of safeOwnKeys(current, currentLabel))",
    "safeGetOwnPropertyDescriptor(current, key, currentLabel)",
    "Object.setPrototypeOf(output, null)",
    "value: visit(descriptor.value, `${currentLabel}.${key}`)",
    "function assertJsonSnapshotArrayProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "`${label}.${key} is not a supported array field.`",
    "setTimeout(resolveSleep, timeoutMsForTimer(ms))",
    "function timeoutMsForTimer(ms)",
    "return Math.min(ms, MAX_SET_TIMEOUT_MS)",
    "function truncateErrorMessage(message)",
    "utf8ByteLengthUpTo(message, MAX_JOB_ERROR_BYTES) <= MAX_JOB_ERROR_BYTES",
    "function optionalJobErrorString(value, label)",
    "text.length > MAX_JOB_ERROR_CHARS",
    "utf8ByteLengthUpTo(text, MAX_JOB_ERROR_BYTES) > MAX_JOB_ERROR_BYTES",
    "function truncateErrorMessageByBytes(message)",
    "const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_JOB_ERROR_BYTES)} UTF-8 bytes]`",
    "utf8PrefixLength(message, MAX_JOB_ERROR_BYTES - markerBytes)",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8PrefixLength(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function jobData(fields)",
    "for (const key of safeOwnKeys(fields, \"Job data fields\"))",
    "safeGetOwnPropertyDescriptor(fields, key, \"Job data fields\")",
    "Job data fields must not contain symbol properties",
    "Job data fields.${key} must be an enumerable data property",
    "value: descriptor.value",
    "function snapshot(job, redactionRoot, includePersistencePending = false)",
    "output.result = redactToolResultRoot(job.result, redactionRoot)",
    "function redactToolResultRoot(result, root)",
    "message: redactToolResultString(result.message, root)",
    "output.data = redactJsonValueRoot(result.data, root)",
    "function redactToolResultString(value, root)",
    "const redacted = redactInlineSecrets(value)",
    "function redactJsonValueRoot(value, root)",
    "safeGetPrototypeOf(value, \"Job result data array\") !== Array.prototype",
    "safeOwnKeys(value, \"Job result data array\")",
    "safeGetOwnPropertyDescriptor(value, key, \"Job result data array\")",
    "return \"[Unredactable array with unreadable metadata]\"",
    "safeGetPrototypeOf(value, \"Job result data object\")",
    "safeOwnKeys(value, \"Job result data object\")",
    "safeGetOwnPropertyDescriptor(value, key, \"Job result data object\")",
    "return \"[Unredactable object with unreadable metadata]\"",
    "return \"[Unredactable non-standard array]\""
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/jobs.js must contain reviewed background job runtime code: missing ${snippet}.`);
    }
  }
}

function validateLoggerRuntime(source) {
  const requiredSnippets = [
    "import { redactErrorMessage, redactInlineSecrets } from \"./redaction.js\"",
    "const MAX_LOG_STRING_CHARS = 4000",
    "const MAX_LOG_STRING_BYTES = 16 * 1024",
    "const MAX_LOG_KEY_CHARS = 256",
    "const MAX_LOG_KEY_BYTES = 1024",
    "const MAX_LOG_ARRAY_ITEMS = 50",
    "const MAX_LOG_OBJECT_FIELDS = 100",
    "const MAX_LOG_DEPTH = 8",
    "const LOG_CONTROL_CHARS_GLOBAL = /[\\u0000-\\u001f\\u007f]/gu",
    "export class Logger",
    "this.level = validateLogLevel(level)",
    "process.stderr.write(`${JSON.stringify(entry)}\\n`)",
    "logSerializationError: sanitizeLogString(redactErrorMessage(error))",
    "// Logging must never break the request path.",
    "function logEntry(fields)",
    "const output = Object.create(null)",
    "const keys = safeOwnKeys(fields)",
    "Object.defineProperty(output, \"logEntryError\", {",
    "value: UNREADABLE_LOG_VALUE",
    "for (const key of keys)",
    "if (typeof key !== \"string\")",
    "const descriptor = safeGetOwnPropertyDescriptor(fields, key)",
    "if (!descriptor?.enumerable || !(\"value\" in descriptor))",
    "Object.defineProperty(output, key, {",
    "value: descriptor.value",
    "function sanitizeLogMeta(meta)",
    "const sanitized = sanitizeLogValue(meta)",
    "return { logMetadataError: sanitizeLogString(redactErrorMessage(error)) }",
    "function sanitizeLogValue(value, stack = new WeakSet(), depth = 0)",
    "return UNDEFINED_LOG_VALUE",
    "return NON_FINITE_NUMBER_LOG_VALUE",
    "return FUNCTION_LOG_VALUE",
    "if (depth >= MAX_LOG_DEPTH)",
    "if (stack.has(value))",
    "function sanitizeLogArray(value, stack, depth)",
    "const length = safeArrayLength(value)",
    "output.push(SPARSE_LOG_ARRAY_HOLE)",
    "output.push(NON_DATA_LOG_PROPERTY)",
    "Object.setPrototypeOf(output, null)",
    "function sanitizeLogObject(value, stack, depth)",
    "const keys = safeOwnKeys(value)",
    "omittedSymbolProperties += 1",
    "if (isSensitiveLogKey(key))",
    "setLogField(output, key, \"[Redacted]\")",
    "setLogField(output, key, NON_DATA_LOG_PROPERTY)",
    "function setLogField(output, key, value)",
    "Object.defineProperty(output, uniqueLogKey(output, sanitizeLogKey(key)), {",
    "function safeOwnKeys(value)",
    "return Reflect.ownKeys(value)",
    "function safeGetOwnPropertyDescriptor(value, key)",
    "return Object.getOwnPropertyDescriptor(value, key)",
    "function sanitizeLogString(value)",
    "redactInlineSecrets(value).replace(LOG_CONTROL_CHARS_GLOBAL, \" \")",
    "function sanitizeLogKey(value)",
    "utf8ByteLengthUpTo(normalized, MAX_LOG_KEY_BYTES) <= MAX_LOG_KEY_BYTES",
    "function truncateLogText(value, maxChars, maxBytes)",
    "const truncatedBytes = Math.max(0, utf8ByteLength(value) - maxBytes)",
    "const marker = truncatedBytes > 0",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function utf8PrefixLength(value, maxChars, maxBytes)",
    "function isSensitiveLogKey(key)",
    "normalized.includes(\"authorization\")",
    "normalized.includes(\"accesskey\")",
    "normalized.includes(\"credential\")",
    "normalized.includes(\"password\")",
    "normalized.includes(\"privatekey\")",
    "normalized.includes(\"secret\")",
    "normalized.includes(\"sessionkey\")",
    "normalized.endsWith(\"token\")",
    "normalized.includes(\"accesstoken\")",
    "normalized.includes(\"refreshtoken\")"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/logger.js must contain reviewed logger runtime code: missing ${snippet}.`);
    }
  }
}

function validateConfigRuntime(source) {
  const requiredSnippets = [
    "import { dirname, isAbsolute, resolve } from \"node:path\"",
    "import { assertNoDuplicateJsonObjectKeys } from \"./jsonPreflight.js\"",
    "import { redactErrorMessage } from \"./redaction.js\"",
    "export function loadConfig(env = process.env)",
    "const readEnv = envReader(env)",
    "parseExecutableCommand(readEnv(\"NOVELIST_EPUBCHECK_COMMAND\"), \"NOVELIST_EPUBCHECK_COMMAND\")",
    "parseEpubCheckArgs(epubCheckCommand, readEnv(\"NOVELIST_EPUBCHECK_ARGS\"))",
    "dataDir: parseDataDir(readEnv(\"NOVELIST_DATA_DIR\"))",
    "stdioMaxLineLength: parseStdioMaxLineLength(readEnv(\"NOVELIST_STDIO_MAX_LINE_LENGTH\"))",
    "agentProvider: parseAgentProvider(readEnv(\"NOVELIST_AGENT_PROVIDER\"))",
    "openaiBaseUrl: parseOpenAiBaseUrl(readEnv(\"NOVELIST_OPENAI_BASE_URL\"))",
    "openaiApiKey: parseOpenAiApiKey(readEnv(\"NOVELIST_OPENAI_API_KEY\"))",
    "const MAX_OPENAI_API_KEY_BYTES = 4096",
    "const MAX_OPENAI_MODEL_BYTES = 200",
    "const MAX_OPENAI_BASE_URL_BYTES = 2048",
    "const MAX_DATA_DIR_BYTES = 4096",
    "const MAX_EPUBCHECK_ARG_BYTES = 4096",
    "const MAX_ENV_NAME_BYTES = 512",
    "const MAX_ENV_FIELDS = 10000",
    "const MAX_CONFIG_ERROR_BYTES = 1000",
    "function envReader(env)",
    "validateEnvironmentObject(env)",
    "const descriptor = safeGetOwnPropertyDescriptor(env, name, \"Configuration environment\")",
    "throw new Error(`${name} environment value must be an enumerable data property.`)",
    "function validateEnvironmentObject(env)",
    "const prototype = safeGetPrototypeOf(env, \"Configuration environment\")",
    "prototype !== Object.prototype && prototype !== null && env !== process.env",
    "let fieldCount = 0",
    "for (const key of safeOwnKeys(env, \"Configuration environment\"))",
    "fieldCount += 1",
    "Configuration environment must contain at most",
    "throw new Error(\"Configuration environment must not contain symbol properties.\")",
    "const descriptor = safeGetOwnPropertyDescriptor(env, key, \"Configuration environment\")",
    "validateEnvironmentKey(key)",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "utf8ByteLengthUpTo(key, MAX_ENV_NAME_BYTES) > MAX_ENV_NAME_BYTES",
    "function parseDataDir(value)",
    "utf8ByteLengthUpTo(dataDir, MAX_DATA_DIR_BYTES) > MAX_DATA_DIR_BYTES",
    "if (!isAbsolute(dataDir))",
    "if (dirname(normalized) === normalized)",
    "function parsePositiveInt(value, fallback, name, max)",
    "if (!/^\\d+$/u.test(raw))",
    "if (parsed > max)",
    "function parseNonNegativeInt(value, fallback, name, max)",
    "function parseOpenAiBaseUrl(value)",
    "new URL(raw)",
    "utf8ByteLengthUpTo(raw, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES",
    "parsed.protocol !== \"http:\" && parsed.protocol !== \"https:\"",
    "parsed.protocol === \"http:\" && !isLoopbackHost(parsed.hostname)",
    "if (parsed.username || parsed.password)",
    "if (parsed.search || parsed.hash)",
    "const normalized = parsed.toString().replace(/\\/$/g, \"\")",
    "utf8ByteLengthUpTo(normalized, MAX_OPENAI_BASE_URL_BYTES) > MAX_OPENAI_BASE_URL_BYTES",
    "function parseOpenAiModel(value)",
    "utf8ByteLengthUpTo(model, MAX_OPENAI_MODEL_BYTES) > MAX_OPENAI_MODEL_BYTES",
    "if (/\\s/u.test(model))",
    "function parseOpenAiApiKey(value)",
    "utf8ByteLengthUpTo(apiKey, MAX_OPENAI_API_KEY_BYTES) > MAX_OPENAI_API_KEY_BYTES",
    "if (/\\s/u.test(apiKey))",
    "function parseExecutableCommand(value, name)",
    "utf8ByteLengthUpTo(command, 1024) > 1024",
    "if (/\\s/u.test(command))",
    "if ((command.includes(\"/\") || command.includes(\"\\\\\")) && !isAbsolute(command))",
    "function isSafePathCommand(command)",
    "return /^[A-Za-z0-9._-]+$/u.test(command) && !command.startsWith(\"-\") && command !== \".\" && command !== \"..\"",
    "function trimmedOrUndefined(value, name, maxRawLength)",
    "if (value.length > maxRawLength)",
    "utf8ByteLengthUpTo(value, maxRawLength) > maxRawLength",
    "function parseArgs(value)",
    "utf8ByteLengthUpTo(value, MAX_EPUBCHECK_ARGS_RAW_LENGTH) > MAX_EPUBCHECK_ARGS_RAW_LENGTH",
    "assertNoDuplicateJsonObjectKeys(trimmed, \"NOVELIST_EPUBCHECK_ARGS JSON array\", MAX_EPUBCHECK_ARGS_JSON_DEPTH)",
    "JSON.parse(trimmed)",
    "throw new Error(`NOVELIST_EPUBCHECK_ARGS JSON array is malformed: ${errorMessage(error)}`)",
    "function errorMessage(error)",
    "return truncateConfigError(redactErrorMessage(error).replace(CONFIG_ERROR_CONTROL_CHARS_GLOBAL, \" \"))",
    "function truncateConfigError(message)",
    "const marker = `... [truncated ${Math.max(0, utf8ByteLength(message) - MAX_CONFIG_ERROR_BYTES)} UTF-8 bytes]`",
    "return validateArgs(parsed)",
    "function parseEpubCheckArgs(command, value)",
    "NOVELIST_EPUBCHECK_ARGS requires NOVELIST_EPUBCHECK_COMMAND",
    "countEpubPlaceholders(args) !== 1",
    "NOVELIST_EPUBCHECK_ARGS must include exactly one {epub} when NOVELIST_EPUBCHECK_COMMAND is configured.",
    "function countEpubPlaceholders(args)",
    "function validateArgs(value)",
    "safeGetPrototypeOf(value, \"NOVELIST_EPUBCHECK_ARGS JSON array\") !== Array.prototype",
    "for (const key of safeOwnKeys(value, \"NOVELIST_EPUBCHECK_ARGS JSON array\"))",
    "throw new Error(\"NOVELIST_EPUBCHECK_ARGS JSON array must not contain symbol properties.\")",
    "safeGetOwnPropertyDescriptor(value, key, \"NOVELIST_EPUBCHECK_ARGS JSON array\")",
    "safeGetOwnPropertyDescriptor(value, String(index), \"NOVELIST_EPUBCHECK_ARGS JSON array\")",
    "throw new Error(`NOVELIST_EPUBCHECK_ARGS[${index}] must not be a sparse array hole.`)",
    "utf8ByteLengthUpTo(descriptor.value, MAX_EPUBCHECK_ARG_BYTES) > MAX_EPUBCHECK_ARG_BYTES",
    "function utf8ByteLength(value)",
    "function utf8PrefixLength(value, maxBytes)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/config.js must contain reviewed configuration runtime code: missing ${snippet}.`);
    }
  }
}

function validateAgentFactoryRuntime(source) {
  const requiredSnippets = [
    "import { StubNovelAgents } from \"./agents.js\"",
    "import { OpenAiNovelAgents } from \"./openaiAgents.js\"",
    "const AGENT_FACTORY_CONFIG_FIELDS = new Set([",
    "\"agentProvider\"",
    "\"openaiBaseUrl\"",
    "\"openaiApiKey\"",
    "\"openaiModel\"",
    "export function createNovelAgents(config)",
    "const agentProvider = validateAgentFactoryConfig(config)",
    "if (agentProvider === \"openai\")",
    "return new OpenAiNovelAgents(config)",
    "return new StubNovelAgents()",
    "function validateAgentFactoryConfig(config)",
    "if (!config || typeof config !== \"object\" || Array.isArray(config))",
    "const prototype = safeGetPrototypeOf(config, \"createNovelAgents.config\")",
    "prototype !== Object.prototype && prototype !== null",
    "for (const key of safeOwnKeys(config, \"createNovelAgents.config\"))",
    "throw new Error(\"createNovelAgents.config must not contain symbol properties.\")",
    "if (!AGENT_FACTORY_CONFIG_FIELDS.has(key))",
    "const descriptor = safeGetOwnPropertyDescriptor(config, key, \"createNovelAgents.config\")",
    "throw new Error(`createNovelAgents.${key} must be an enumerable data property.`)",
    "safeGetOwnPropertyDescriptor(config, \"agentProvider\", \"createNovelAgents.config\")",
    "descriptor.value !== \"stub\" && descriptor.value !== \"openai\"",
    "return descriptor.value",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/agentFactory.js must contain reviewed agent factory runtime code: missing ${snippet}.`);
    }
  }
}

function validateRedactionRuntime(source) {
  const requiredSnippets = [
    "const MAX_REDACTION_INPUT_CHARS = 1024 * 1024",
    "const MAX_REDACTION_INPUT_BYTES = 1024 * 1024",
    "const REDACTION_BOUNDARY_LOOKAHEAD_CHARS = 4096",
    "export function redactInlineSecrets(value)",
    "const bounded = boundedRedactionInput(value)",
    "const redacted = redactBoundedText(bounded.text)",
    "truncateRedactionTextWithMarker(redacted, marker, MAX_REDACTION_INPUT_CHARS, MAX_REDACTION_INPUT_BYTES)",
    "function redactBoundedText(value)",
    ".replace(/\\bBearer(\\s+)([\"']?)[A-Za-z0-9._~+/-]+=*([\"']?)/gi, \"Bearer$1$2[Redacted]$3\")",
    ".replace(/\\bAuthorization\\b(\\s*[:=]\\s*)([\"']?)(?!Bearer\\b)(?:[A-Za-z][A-Za-z0-9._~-]*\\s+)?[^\\s\"',;&}/]+([\"']?)/gi, \"Authorization$1$2[Redacted]$3\")",
    ".replace(/\\bsk-[A-Za-z0-9_-]{8,}\\b/g, \"sk-[Redacted]\")",
    ".replace(/\\bAIza[A-Za-z0-9_-]{20,}\\b/g, \"AIza[Redacted]\")",
    ".replace(/\\bgh[pousr]_[A-Za-z0-9_]{20,}\\b/g, \"gh[Redacted]\")",
    ".replace(/\\bgithub_pat_[A-Za-z0-9_]{20,}\\b/g, \"github_pat_[Redacted]\")",
    ".replace(/\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b/g, \"AWS[Redacted]\")",
    ".replace(/\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b/g, \"[Redacted JWT]\")",
    "(?:x|openai)?apiKey",
    "aws[-_]?access[-_]?key[-_]?id",
    "awsSecretAccessKey",
    "accessToken|refreshToken",
    "clientSecret",
    "export function redactErrorMessage(value)",
    "return redactInlineSecrets(coerceErrorMessageInput(value))",
    "function boundedRedactionInput(value)",
    "utf8ByteLengthUpTo(text, MAX_REDACTION_INPUT_BYTES) <= MAX_REDACTION_INPUT_BYTES",
    "const bytes = utf8ByteLength(text)",
    "const boundedPrefix = truncateRedactionText(text, MAX_REDACTION_INPUT_CHARS, MAX_REDACTION_INPUT_BYTES)",
    "text.slice(0, boundedPrefix.length + REDACTION_BOUNDARY_LOOKAHEAD_CHARS)",
    "function coerceRedactionInput(value)",
    "return \"[Function]\"",
    "return \"[Object]\"",
    "function coerceErrorMessageInput(value)",
    "const message = safeOwnMessageDescriptor(value)",
    "message && \"value\" in message && typeof message.value === \"string\"",
    "function safeOwnMessageDescriptor(value)",
    "return Object.getOwnPropertyDescriptor(value, \"message\")",
    "function utf8ByteLength(value)",
    "bytes += utf8ScalarByteLength(scalar)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function truncateRedactionText(value, maxChars, maxBytes)",
    "utf8ByteLengthUpTo(value, maxBytes) <= maxBytes",
    "utf8PrefixLength(value, maxChars, maxBytes)",
    "function truncateRedactionTextWithMarker(value, marker, maxChars, maxBytes)",
    "const markerBytes = utf8ByteLength(marker)",
    "utf8ByteLengthUpTo(value, maxBytes - markerBytes) + markerBytes <= maxBytes",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function utf8PrefixLength(value, maxChars, maxBytes)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/redaction.js must contain reviewed redaction runtime code: missing ${snippet}.`);
    }
  }
}

function validateStartupRuntime(source) {
  const requiredSnippets = [
    "import { redactErrorMessage } from \"./redaction.js\"",
    "const MAX_STARTUP_ERROR_CHARS = 4000",
    "const MAX_STARTUP_ERROR_BYTES = 16 * 1024",
    "const STARTUP_ERROR_CONTROL_CHARS_GLOBAL = /[\\u0000-\\u001f\\u007f]/gu",
    "export function startupErrorMessage(error)",
    "redactErrorMessage(error).replace(STARTUP_ERROR_CONTROL_CHARS_GLOBAL, \" \")",
    "utf8ByteLengthUpTo(message, MAX_STARTUP_ERROR_BYTES) <= MAX_STARTUP_ERROR_BYTES",
    "function truncateStartupErrorText(value, maxChars, maxBytes)",
    "const truncatedBytes = Math.max(0, utf8ByteLength(value) - maxBytes)",
    "const marker = truncatedBytes > 0",
    "utf8PrefixLength(value, maxChars - marker.length, maxBytes - markerBytes)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function utf8PrefixLength(value, maxChars, maxBytes)",
    "export function startupErrorJsonLine(error)",
    "const entry = Object.create(null)",
    "Object.defineProperty(entry, \"level\", {",
    "value: \"error\"",
    "Object.defineProperty(entry, \"event\", {",
    "value: \"novelist_startup_failed\"",
    "Object.defineProperty(entry, \"error\", {",
    "value: startupErrorMessage(error)",
    "return `${JSON.stringify(entry)}\\n`"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/startup.js must contain reviewed startup runtime code: missing ${snippet}.`);
    }
  }
}

function validateCliArgsRuntime(source) {
  const requiredSnippets = [
    "const MAX_CLI_ARGS = 256",
    "const MAX_CLI_ARG_CHARS = 8192",
    "const MAX_CLI_ARG_BYTES = 8192",
    "const MAX_UNSUPPORTED_ARG_PREVIEW_COUNT = 8",
    "const MAX_UNSUPPORTED_ARG_PREVIEW_CHARS = 256",
    "const MAX_UNSUPPORTED_ARG_PREVIEW_BYTES = 256",
    "const CLI_ARG_CONTROL_CHARS_GLOBAL = /[\\u0000-\\u001f\\u007f]/gu",
    "export function parseCliArgs(args)",
    "const parsed = validateCliArgArray(args)",
    "return \"start\"",
    "return \"help\"",
    "return \"version\"",
    "throw new Error(`Unsupported CLI arguments: ${unsupportedArgsPreview(parsed)}`)",
    "function validateCliArgArray(value)",
    "if (!Array.isArray(value))",
    "safeGetPrototypeOf(value) !== Array.prototype",
    "value.length > MAX_CLI_ARGS",
    "for (const key of safeOwnKeys(value))",
    "throw new Error(\"CLI arguments must not contain symbol properties.\")",
    "if (!isArrayIndexKey(key, value.length))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key)",
    "throw new Error(`CLI arguments[${key}] must be an enumerable data item.`)",
    "safeGetOwnPropertyDescriptor(value, String(index))",
    "throw new Error(`CLI arguments[${index}] must not be a sparse array hole.`)",
    "typeof descriptor.value !== \"string\"",
    "utf8ByteLengthUpTo(descriptor.value, MAX_CLI_ARG_BYTES) > MAX_CLI_ARG_BYTES",
    "CLI_ARG_CONTROL_CHARS_GLOBAL.test(descriptor.value)",
    "CLI_ARG_CONTROL_CHARS_GLOBAL.lastIndex = 0",
    "function safeGetPrototypeOf(value)",
    "throw new Error(\"CLI arguments prototype must be readable.\")",
    "function safeOwnKeys(value)",
    "throw new Error(\"CLI arguments property keys must be readable.\")",
    "function safeGetOwnPropertyDescriptor(value, key)",
    "throw new Error(\"CLI arguments property descriptors must be readable.\")",
    "function unsupportedArgsPreview(args)",
    "args.slice(0, MAX_UNSUPPORTED_ARG_PREVIEW_COUNT)",
    "arg.replace(CLI_ARG_CONTROL_CHARS_GLOBAL, \" \")",
    "utf8ByteLengthUpTo(normalized, MAX_UNSUPPORTED_ARG_PREVIEW_BYTES) <= MAX_UNSUPPORTED_ARG_PREVIEW_BYTES",
    "truncateCliTextWithMarker(normalized, marker, MAX_UNSUPPORTED_ARG_PREVIEW_CHARS, MAX_UNSUPPORTED_ARG_PREVIEW_BYTES)",
    "return omitted > 0",
    "function truncateCliTextWithMarker(value, marker, maxChars, maxBytes)",
    "const markerBytes = utf8ByteLength(marker)",
    "function truncateCliText(value, maxChars, maxBytes)",
    "const nextBytes = bytes + utf8ByteLength(scalar)",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function isArrayIndexKey(value, length)",
    "return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === value"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/cliArgs.js must contain reviewed CLI argument runtime code: missing ${snippet}.`);
    }
  }
}

function validateExecutionRuntime(source) {
  const requiredSnippets = [
    "export class OperationTimeoutError extends Error",
    "this.name = \"OperationTimeoutError\"",
    "export class OperationCancelledError extends Error",
    "this.name = \"OperationCancelledError\"",
    "const MAX_OPERATION_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000",
    "const MAX_EXECUTION_SIGNAL_FIELDS = 32",
    "const MAX_EXECUTION_SIGNAL_KEY_BYTES = 256",
    "const MAX_EXECUTION_LABEL_CHARS = 256",
    "const MAX_EXECUTION_LABEL_BYTES = 512",
    "export class ExecutionDeadline",
    "this.deadlineAt = Date.now() + validateTimeoutMs(timeoutMs)",
    "this.isCancelled = validateSignal(signal)",
    "assertActive(label)",
    "const safeLabel = validateLabel(label)",
    "const cancelled = this.isCancelled?.()",
    "typeof cancelled !== \"boolean\"",
    "throw new OperationCancelledError(`Operation was cancelled while ${safeLabel}.`)",
    "throw new OperationTimeoutError(`Operation timed out while ${safeLabel}.`)",
    "remainingMs()",
    "return Math.max(0, this.deadlineAt - Date.now())",
    "requireRemainingMs(label)",
    "const safeLabel = validateLabel(label)",
    "this.assertActive(safeLabel)",
    "throw new OperationTimeoutError(`Operation timed out while ${safeLabel}.`)",
    "function validateSignal(value)",
    "if (!value || typeof value !== \"object\" || Array.isArray(value))",
    "const prototype = safeGetPrototypeOf(value, \"ExecutionDeadline.signal\")",
    "prototype !== Object.prototype && prototype !== null",
    "let fieldCount = 0",
    "for (const key of safeOwnKeys(value, \"ExecutionDeadline.signal\"))",
    "throw new Error(\"ExecutionDeadline.signal must not contain symbol properties.\")",
    "fieldCount > MAX_EXECUTION_SIGNAL_FIELDS",
    "utf8ByteLengthUpTo(key, MAX_EXECUTION_SIGNAL_KEY_BYTES) > MAX_EXECUTION_SIGNAL_KEY_BYTES",
    "ExecutionDeadline.signal field names must not contain control characters",
    "const fieldDescriptor = safeGetOwnPropertyDescriptor(value, key, \"ExecutionDeadline.signal\")",
    "throw new Error(\"ExecutionDeadline.signal must not contain non-enumerable or accessor properties.\")",
    "const descriptor = safeGetOwnPropertyDescriptor(value, \"isCancelled\", \"ExecutionDeadline.signal\")",
    "typeof descriptor.value !== \"function\"",
    "return () => isCancelled.call(value)",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "function validateTimeoutMs(value)",
    "typeof value !== \"number\" || !Number.isInteger(value)",
    "value < 1 || value > MAX_OPERATION_TIMEOUT_MS",
    "function validateLabel(value)",
    "value.trim().length === 0",
    "value.length > MAX_EXECUTION_LABEL_CHARS",
    "utf8ByteLengthUpTo(value, MAX_EXECUTION_LABEL_BYTES) > MAX_EXECUTION_LABEL_BYTES",
    "/[\\u0000-\\u001f\\u007f]/u.test(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/execution.js must contain reviewed execution deadline runtime code: missing ${snippet}.`);
    }
  }
}

function validateToolResultValidationRuntime(source) {
  const requiredSnippets = [
    "const DEFAULT_MAX_MESSAGE_CHARS = 4000",
    "const TOOL_RESULT_CONTROL_CHARS = /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/u",
    "const MAX_TOOL_RESULT_VALUE_DEPTH = 32",
    "const MAX_TOOL_RESULT_OBJECT_FIELDS = 100",
    "const MAX_TOOL_RESULT_OBJECT_KEY_BYTES = 512",
    "const MAX_TOOL_RESULT_ARRAY_ITEMS = 1000",
    "const MAX_TOOL_RESULT_TOTAL_NODES = 10000",
    "const MAX_TOOL_RESULT_STRING_CHARS = 16 * 1024",
    "const MAX_TOOL_RESULT_STRING_BYTES = 32 * 1024",
    "const MAX_TOOL_RESULT_LABEL_BYTES = 512",
    "export function validateToolResultShape(value, label, maxMessageChars = DEFAULT_MAX_MESSAGE_CHARS)",
    "const safeLabel = validateToolResultLabel(label)",
    "const safeMaxMessageChars = validateMaxMessageChars(maxMessageChars)",
    "const result = plainDataObject(value, safeLabel)",
    "assertKnownFields(result, safeLabel, [\"status\", \"message\", \"data\"])",
    "typeof result.status !== \"string\" || !isToolResultStatus(result.status)",
    "result.message.trim().length === 0",
    "TOOL_RESULT_CONTROL_CHARS.test(result.message)",
    "Object.prototype.hasOwnProperty.call(result, \"data\")",
    "data = validateJsonCompatibleValue(result.data, `${safeLabel}.data`)",
    "message: result.message.trim()",
    "function validateToolResultLabel(value)",
    "utf8ByteLengthUpTo(value, MAX_TOOL_RESULT_LABEL_BYTES) > MAX_TOOL_RESULT_LABEL_BYTES",
    "function validateMaxMessageChars(value)",
    "value < 1 || value > MAX_TOOL_RESULT_MESSAGE_LIMIT_CHARS",
    "function validateJsonCompatibleValue(value, label)",
    "const stack = new WeakSet()",
    "let nodes = 0",
    "nodes > MAX_TOOL_RESULT_TOTAL_NODES",
    "depth > MAX_TOOL_RESULT_VALUE_DEPTH",
    "current === undefined",
    "utf8ByteLengthUpTo(result.message, MAX_TOOL_RESULT_STRING_BYTES) > MAX_TOOL_RESULT_STRING_BYTES",
    "!Number.isFinite(current)",
    "Number.isInteger(current) && !Number.isSafeInteger(current)",
    "current.length > MAX_TOOL_RESULT_STRING_CHARS",
    "utf8ByteLengthUpTo(current, MAX_TOOL_RESULT_STRING_BYTES) > MAX_TOOL_RESULT_STRING_BYTES",
    "typeof current !== \"object\"",
    "stack.has(current)",
    "safeGetPrototypeOf(current, currentLabel) !== Array.prototype",
    "current.length > MAX_TOOL_RESULT_ARRAY_ITEMS",
    "assertArrayDataProperties(current, currentLabel)",
    "safeGetOwnPropertyDescriptor(current, String(index), currentLabel)",
    "throw new Error(`${currentLabel}[${index}] must not be a sparse array hole.`)",
    "const entries = plainDataObjectEntries(current, currentLabel)",
    "utf8ByteLengthUpTo(key, MAX_TOOL_RESULT_OBJECT_KEY_BYTES) > MAX_TOOL_RESULT_OBJECT_KEY_BYTES",
    "Object.defineProperty(output, key, {",
    "value: visit(item, `${currentLabel}.${key}`, depth + 1)",
    "function assertArrayDataProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "throw new Error(`${label} must not contain symbol properties.`)",
    "function plainDataObject(value, label)",
    "for (const [key, item] of plainDataObjectEntries(value, label))",
    "function plainDataObjectEntries(value, label)",
    "const prototype = safeGetPrototypeOf(value, label)",
    "prototype !== Object.prototype && prototype !== null",
    "utf8ByteLengthUpTo(key, MAX_TOOL_RESULT_OBJECT_KEY_BYTES) > MAX_TOOL_RESULT_OBJECT_KEY_BYTES",
    "throw new Error(`${label} must not contain non-enumerable or accessor properties.`)",
    "function safeGetPrototypeOf(value, label)",
    "throw new Error(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new Error(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new Error(`${label} property descriptors must be readable.`)",
    "function assertKnownFields(value, label, allowed)",
    "function isToolResultStatus(value)",
    "value === \"pending_user_confirmation\"",
    "value === \"complete\"",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/toolResultValidation.js must contain reviewed tool result validation runtime code: missing ${snippet}.`);
    }
  }
}

function validateStateValidationRuntime(source) {
  const requiredSnippets = [
    "import { CURRENT_STATE_SCHEMA_VERSION } from \"./types.js\"",
    "import { assertSafeId, ValidationError } from \"./validation.js\"",
    "const STATUSES = [\"pending_user_confirmation\", \"planning\", \"drafting\", \"reviewing\", \"blocked\", \"complete\"]",
    "const BEAT_STATUSES = [\"pending\", \"drafted\", \"complete\", \"needs_revision\"]",
    "const CONFIRMATION_KINDS = [\"initial_outline\", \"conflict_resolution\", \"revision\"]",
    "const SEVERITIES = [\"info\", \"warning\", \"blocking\"]",
    "const MAX_CHAPTERS = 200",
    "const MAX_TOTAL_BEATS = 5000",
    "const MAX_CONFIRMATIONS = 1000",
    "const MAX_CONFLICTS = 1000",
    "const MAX_TITLE_BYTES = 512",
    "const MAX_STATE_TEXT_BYTES = 256 * 1024",
    "const MAX_REVISION_INSTRUCTION_BYTES = 16 * 1024",
    "const MAX_CONFLICT_FIELD_BYTES = 4000",
    "const MAX_TIMESTAMP_BYTES = 64",
    "const MAX_STATE_OBJECT_FIELDS = 1000",
    "const MAX_STATE_OBJECT_KEY_BYTES = 2048",
    "const STATE_OBJECT_KEY_CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/u",
    "export function validateVolumeState(value)",
    "const state = assertRecord(value, \"VolumeState\")",
    "assertKnownFields(state, \"VolumeState\", [",
    "schemaVersionField(state.schemaVersion, \"VolumeState.schemaVersion\")",
    "boundedNonEmptyArrayField(state.chapters, \"VolumeState.chapters\", MAX_CHAPTERS).map(validateChapter)",
    "assertUnique(chapters.map((chapter) => chapter.chapterNo), \"ChapterState.chapterNo\")",
    "assertSequential(chapters.map((chapter) => chapter.chapterNo), \"ChapterState.chapterNo\")",
    "totalBeats > MAX_TOTAL_BEATS",
    "Date.parse(updatedAt) < Date.parse(createdAt)",
    "franchiseId: assertSafeId(state.franchiseId, \"VolumeState.franchiseId\")",
    "status: oneOf(state.status, STATUSES, \"VolumeState.status\")",
    "boundedArrayField(state.confirmations, \"VolumeState.confirmations\", MAX_CONFIRMATIONS).map(validateConfirmation)",
    "boundedArrayField(state.conflicts, \"VolumeState.conflicts\", MAX_CONFLICTS).map(validateConflict)",
    "assertUnique(volumeState.confirmations.map((confirmation) => confirmation.id), \"Confirmation.id\")",
    "assertUnique(volumeState.conflicts.map((conflict) => conflict.id), \"ConflictRecord.id\")",
    "validateConfirmationTimeline(volumeState.confirmations, volumeState.createdAt, volumeState.updatedAt)",
    "find((beat) => beat.chapterNo === volumeState.currentChapterNo && beat.beatNo === volumeState.currentBeatNo)",
    "VolumeState active cursor must point to an incomplete beat.",
    "validateCursorPosition(volumeState)",
    "pendingConfirmations.length",
    "VolumeState must not contain more than one unresolved confirmation.",
    "VolumeState pending_user_confirmation status requires an unresolved confirmation.",
    "VolumeState unresolved confirmations require pending_user_confirmation status.",
    "VolumeState complete status requires every beat to be complete.",
    "validatePendingBeatOrder(volumeState)",
    "conflict.severity === \"blocking\" && !conflict.resolved",
    "VolumeState unresolved blocking conflicts require pending_user_confirmation or blocked status.",
    "pendingConfirmations[0]?.kind === \"initial_outline\"",
    "VolumeState blocked status requires an unresolved blocking conflict.",
    "function validatePendingBeatOrder(state)",
    "VolumeState pending beats must not be followed by already-started beats.",
    "function validateCursorPosition(state)",
    "VolumeState complete status cursor must point to the final beat.",
    "VolumeState cursor must point to the first incomplete beat.",
    "function validateConfirmationTimeline(confirmations, volumeCreatedAt, volumeUpdatedAt)",
    "Confirmation.createdAt must be greater than or equal to VolumeState.createdAt.",
    "Confirmation.createdAt must be less than or equal to VolumeState.updatedAt.",
    "Confirmation.resolvedAt must be less than or equal to VolumeState.updatedAt.",
    "function validateConfirmation(value)",
    "Confirmation.resolvedAt must be greater than or equal to createdAt.",
    "Confirmation.resolvedAt requires approved to be true.",
    "Confirmation.approved requires resolvedAt.",
    "Confirmation.revisionInstruction is required when kind is revision.",
    "function validateConflict(value)",
    "severity: oneOf(conflict.severity, SEVERITIES, \"ConflictRecord.severity\")",
    "function validateChapter(value)",
    "assertUnique(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`)",
    "assertSequential(beats.map((beat) => beat.beatNo), `ChapterState(${chapterNo}).beats.beatNo`)",
    "targetWords !== beatTargetWords",
    "function validateBeat(value, chapterNo)",
    "BeatState.chapterNo must match its parent chapter.",
    "BeatState.lastFeedback is required when status is needs_revision.",
    "BeatState.lastFeedback is only allowed when status is needs_revision.",
    "function assertRecord(value, label)",
    "const prototype = safeGetPrototypeOf(value, label)",
    "prototype !== Object.prototype && prototype !== null",
    "for (const key of safeOwnKeys(value, label))",
    "throw new ValidationError(`${label} must not contain symbol properties.`)",
    "fieldCount > MAX_STATE_OBJECT_FIELDS",
    "utf8ByteLengthUpTo(key, MAX_STATE_OBJECT_KEY_BYTES) > MAX_STATE_OBJECT_KEY_BYTES",
    "STATE_OBJECT_KEY_CONTROL_CHARS.test(key)",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new ValidationError(`${label} must not contain non-enumerable or accessor properties.`)",
    "function assertKnownFields(value, label, allowed)",
    "for (const key of safeOwnKeys(value, label))",
    "throw new ValidationError(`${label} must not contain symbol properties.`)",
    "throw new ValidationError(`${label} must not contain non-enumerable or accessor properties.`)",
    "function safeGetPrototypeOf(value, label)",
    "throw new ValidationError(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new ValidationError(`${label} property keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new ValidationError(`${label} property descriptors must be readable.`)",
    "function boundedStringField(value, label, maxChars, maxBytes)",
    "utf8ByteLengthUpTo(text, maxBytes) > maxBytes",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function timestampField(value, label)",
    "utf8ByteLengthUpTo(value, MAX_TIMESTAMP_BYTES) > MAX_TIMESTAMP_BYTES",
    "isCanonicalUtcTimestamp(timestamp)",
    "Date.parse(timestamp) > Date.now() + MAX_TIMESTAMP_FUTURE_SKEW_MS",
    "function schemaVersionField(value, label)",
    "value < CURRENT_STATE_SCHEMA_VERSION",
    "value > CURRENT_STATE_SCHEMA_VERSION",
    "function arrayField(value, label)",
    "safeGetPrototypeOf(value, label) !== Array.prototype",
    "assertArrayDataProperties(value, label)",
    "safeGetOwnPropertyDescriptor(value, index, label)",
    "function assertArrayDataProperties(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new ValidationError(`${label} must not contain symbol properties.`)",
    "function assertSequential(values, label)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/stateValidation.js must contain reviewed state validation runtime code: missing ${snippet}.`);
    }
  }
}

function validateEpubRuntime(source) {
  const requiredSnippets = [
    "import { redactErrorMessage, redactInlineSecrets } from \"./redaction.js\"",
    "import { assertBoundedNonEmptyString, assertObject, assertSafeId } from \"./validation.js\"",
    "const encoder = new TextEncoder()",
    "const decoder = new TextDecoder(\"utf-8\", { fatal: true })",
    "const MAX_EPUB_MARKDOWN_CHARS = 16 * 1024 * 1024",
    "const MAX_EPUB_MARKDOWN_BYTES = 16 * 1024 * 1024",
    "export const MAX_EPUB_ARCHIVE_BYTES = 32 * 1024 * 1024",
    "const MAX_EPUB_PARSED_ZIP_ENTRIES = 4096",
    "const MAX_EPUB_ISSUE_BYTES = 300",
    "const MAX_EPUB_REPORTED_ENTRY_BYTES = 200",
    "const ZIP_UTF8_NAME_FLAG = 0x0800",
    "const ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS = ZIP_UTF8_NAME_FLAG",
    "export function buildEpubArchive(state, markdown)",
    "const metadata = validateEpubStateMetadata(state)",
    "markdown.length > MAX_EPUB_MARKDOWN_CHARS",
    "utf8ByteLengthUpTo(markdown, MAX_EPUB_MARKDOWN_BYTES) > MAX_EPUB_MARKDOWN_BYTES",
    "markdown.trim().length === 0",
    "assertXmlCompatibleText(markdown, \"EPUB markdown\")",
    "{ path: \"mimetype\", data: text(\"application/epub+zip\"), compress: false }",
    "path: \"META-INF/container.xml\"",
    "path: \"EPUB/package.opf\"",
    "path: \"EPUB/nav.xhtml\"",
    "path: \"EPUB/content.xhtml\"",
    "return createStoredZip(files)",
    "export function validateEpubArchive(archive)",
    "if (!isEpubUint8Array(archive))",
    "function isEpubUint8Array(value)",
    "return value instanceof Uint8Array",
    "const archiveByteLength = epubArchiveByteLength(archive)",
    "function epubArchiveByteLength(value)",
    "return value.byteLength",
    "archiveByteLength > MAX_EPUB_ARCHIVE_BYTES",
    "const stableArchive = snapshotEpubArchive(archive)",
    "function snapshotEpubArchive(value)",
    "return new Uint8Array(value)",
    "entries = readStoredZipEntries(stableArchive)",
    "const byPath = new Map(entries.map((entry) => [entry.path, entry.data]))",
    "if (!isSafeZipPath(path))",
    "if (seenPaths.has(path))",
    "paths[0] !== \"mimetype\"",
    "entries[0]?.localExtraLength !== 0",
    "decodeEpubText(byPath.get(\"mimetype\"), \"mimetype\", addIssue) !== \"application/epub+zip\"",
    "for (const required of [\"META-INF/container.xml\", \"EPUB/package.opf\", \"EPUB/nav.xhtml\", \"EPUB/content.xhtml\"])",
    "validateRequiredXmlText(container, \"META-INF/container.xml\", addIssue)",
    "container.includes('full-path=\"EPUB/package.opf\"')",
    "packageOpfText.includes('version=\"3.0\"')",
    "packageOpfText.includes('properties=\"nav\"')",
    "packageOpfText.includes('<item id=\"content\" href=\"content.xhtml\" media-type=\"application/xhtml+xml\"/>')",
    "packageOpfText.includes('<itemref idref=\"content\"/>')",
    "nav.includes('epub:type=\"toc\"')",
    "content.includes(\"<body>\")",
    "function validateEpubStateMetadata(state)",
    "const status = assertBoundedNonEmptyString(value.status, \"EPUB state.status\", MAX_EPUB_METADATA_CHARS)",
    "status !== \"complete\"",
    "isCanonicalUtcTimestamp(updatedAt)",
    "assertXmlCompatibleText(volumeTitle, \"EPUB state.volumeTitle\")",
    "franchiseId: assertSafeId(value.franchiseId, \"EPUB state.franchiseId\")",
    "function createStoredZip(files)",
    "u32(0x04034b50)",
    "u16(ZIP_UTF8_NAME_FLAG)",
    "u32(crc)",
    "u32(0x02014b50)",
    "u32(0x06054b50)",
    "archive.length > MAX_EPUB_ARCHIVE_BYTES",
    "function readStoredZipEntries(archive)",
    "readU32(archive, offset) === 0x04034b50",
    "if ((flags & ~ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0)",
    "compression !== 0",
    "compressedSize !== uncompressedSize || dataEnd > archive.length",
    "const actualCrc = crc32(data)",
    "actualCrc !== expectedCrc",
    "entries.length > MAX_EPUB_PARSED_ZIP_ENTRIES",
    "validateCentralDirectory(archive, offset, entries)",
    "function validateCentralDirectory(archive, centralStart, localEntries)",
    "readU32(archive, offset) === 0x02014b50",
    "if ((flags & ~ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0)",
    "if (offset + 22 > archive.length || readU32(archive, offset) !== 0x06054b50)",
    "commentLength !== 0",
    "diskNumber !== 0 || centralDisk !== 0",
    "ZIP central directory entry count does not match local entries.",
    "ZIP central directory offset or size does not match the archive.",
    "ZIP central directory does not match local entries.",
    "function isSafeZipPath(path)",
    "!path.startsWith(\"/\")",
    "!path.split(\"/\").includes(\"..\")",
    "function decodeEpubText(value, label, addIssue)",
    "decoded = decodeUtf8(value)",
    "assertXmlCompatibleText(decoded, label)",
    "function validateRequiredXmlText(value, label, addIssue)",
    "assertSimpleXmlWellFormed(value, label)",
    "function assertKnownXmlEntities(value, label)",
    "function addValidationIssue(issues, issue)",
    "issues.length >= MAX_EPUB_REPORTED_ISSUES",
    "function truncateIssue(issue)",
    "utf8ByteLengthUpTo(normalized, MAX_EPUB_ISSUE_BYTES) <= MAX_EPUB_ISSUE_BYTES",
    "truncateTextByCharsAndBytesWithMarker(normalized, marker, MAX_EPUB_ISSUE_CHARS, MAX_EPUB_ISSUE_BYTES)",
    "function truncateEntryPath(path)",
    "utf8ByteLengthUpTo(normalized, MAX_EPUB_REPORTED_ENTRY_BYTES) <= MAX_EPUB_REPORTED_ENTRY_BYTES",
    "truncateTextByCharsAndBytesWithMarker(normalized, marker, MAX_EPUB_REPORTED_ENTRY_CHARS, MAX_EPUB_REPORTED_ENTRY_BYTES)",
    "function normalizeReportedField(value)",
    "redactInlineSecrets(value).replace(EPUB_REPORTED_FIELD_CONTROL_CHARS_GLOBAL, \" \")",
    "function truncateTextByCharsAndBytesWithMarker(value, marker, maxChars, maxBytes)",
    "const markerBytes = utf8ByteLength(marker)",
    "function truncateTextByCharsAndBytes(value, maxChars, maxBytes)",
    "const nextBytes = bytes + utf8ByteLength(scalar)",
    "function utf8ByteLength(value)",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)",
    "function errorMessage(error)",
    "return normalizeReportedField(redactErrorMessage(error))"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/epub.js must contain reviewed EPUB runtime code: missing ${snippet}.`);
    }
  }
}

function validateValidationRuntime(source) {
  const requiredSnippets = [
    "const MAX_SAFE_ID_BYTES = 120",
    "const MAX_VALIDATION_LABEL_CHARS = 256",
    "const MAX_VALIDATION_LABEL_BYTES = 512",
    "const MAX_VALIDATION_BOUND_CHARS = 1024 * 1024",
    "const MAX_VALIDATION_STRING_BYTES = 1024 * 1024",
    "const MAX_VALIDATION_OBJECT_FIELDS = 1000",
    "const MAX_VALIDATION_OBJECT_KEY_CHARS = 256",
    "const MAX_VALIDATION_OBJECT_KEY_BYTES = 512",
    "const VALIDATION_CONTROL_CHARS = /[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]/u",
    "const VALIDATION_LABEL_CONTROL_CHARS = /[\\u0000-\\u001f\\u007f]/u",
    "export class ValidationError extends Error",
    "this.name = \"ValidationError\"",
    "export function assertObject(value, label)",
    "const safeLabel = validateValidationLabel(label)",
    "if (!value || typeof value !== \"object\" || Array.isArray(value))",
    "const prototype = safeGetPrototypeOf(value, safeLabel)",
    "prototype !== Object.prototype && prototype !== null",
    "const output = Object.create(null)",
    "for (const key of safeOwnKeys(value, safeLabel))",
    "throw new ValidationError(`${safeLabel} must not contain symbol properties.`)",
    "fieldCount > MAX_VALIDATION_OBJECT_FIELDS",
    "key.length > MAX_VALIDATION_OBJECT_KEY_CHARS",
    "utf8ByteLengthUpTo(key, MAX_VALIDATION_OBJECT_KEY_BYTES) > MAX_VALIDATION_OBJECT_KEY_BYTES",
    "VALIDATION_LABEL_CONTROL_CHARS.test(key)",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, safeLabel)",
    "throw new ValidationError(`${safeLabel} must not contain non-enumerable or accessor properties.`)",
    "Object.defineProperty(output, key, {",
    "function safeGetPrototypeOf(value, label)",
    "throw new ValidationError(`${label} prototype must be readable.`)",
    "function safeOwnKeys(value, label)",
    "throw new ValidationError(`${label} keys must be readable.`)",
    "function safeGetOwnPropertyDescriptor(value, key, label)",
    "throw new ValidationError(`${label} property descriptors must be readable.`)",
    "export function assertShape(value, label, shape)",
    "const safeShape = validateObjectShape(shape)",
    "const allowedKeys = new Set(objectDataKeys(safeShape, \"Validation shape\"))",
    "for (const key of objectDataKeys(object, safeLabel))",
    "for (const key of objectDataKeys(safeShape, \"Validation shape\"))",
    "throw new ValidationError(`${safeLabel}.${key} is not a supported field.`)",
    "assertNonEmptyString(current, `${safeLabel}.${key}`)",
    "type === \"optionalString\"",
    "type === \"optionalBoolean\"",
    "export function assertNonEmptyString(value, label)",
    "return value.trim()",
    "export function assertBoundedNonEmptyString(value, label, maxChars, maxBytes)",
    "const safeMaxChars = validateMaxChars(maxChars)",
    "const safeMaxBytes = validateMaxBytes(maxBytes, safeMaxChars)",
    "utf8ByteLengthUpTo(text, safeMaxBytes) > safeMaxBytes",
    "VALIDATION_CONTROL_CHARS.test(text)",
    "export function assertBoundedNonEmptySingleLineString(value, label, maxChars, maxBytes)",
    "/[\\t\\r\\n]/u.test(text)",
    "export function assertRevisionTargetString(value, label, maxChars, maxBytes)",
    "/^(?:chapter:[1-9]\\d*,? *beat:[1-9]\\d*|[1-9]\\d*[-/][1-9]\\d*)$/iu.test(text)",
    "export function assertSafeId(value, label)",
    "typeof value === \"string\" && value.trim() !== value",
    "/^[a-z0-9가-힣][a-z0-9가-힣._-]*$/u.test(id) || id.includes(\"..\")",
    "utf8ByteLengthUpTo(id, MAX_SAFE_ID_BYTES) > MAX_SAFE_ID_BYTES",
    "export function asOptionalString(value)",
    "text.length > MAX_VALIDATION_BOUND_CHARS",
    "utf8ByteLengthUpTo(text, MAX_VALIDATION_STRING_BYTES) > MAX_VALIDATION_STRING_BYTES",
    "export function asOptionalBoundedString(value, label, maxChars, maxBytes)",
    "export function asOptionalBoundedSingleLineString(value, label, maxChars, maxBytes)",
    "function validateValidationLabel(value)",
    "value.length > MAX_VALIDATION_LABEL_CHARS",
    "utf8ByteLengthUpTo(value, MAX_VALIDATION_LABEL_BYTES) > MAX_VALIDATION_LABEL_BYTES",
    "VALIDATION_LABEL_CONTROL_CHARS.test(value)",
    "function validateMaxChars(value)",
    "typeof value !== \"number\" || !Number.isInteger(value)",
    "value < 1 || value > MAX_VALIDATION_BOUND_CHARS",
    "function validateMaxBytes(value, maxChars)",
    "return Math.min(maxChars * 4, MAX_VALIDATION_STRING_BYTES)",
    "function validateObjectShape(value)",
    "const object = assertObject(value, \"Validation shape\")",
    "for (const key of objectDataKeys(object, \"Validation shape\"))",
    "function objectDataKeys(value, label)",
    "for (const key of safeOwnKeys(value, label))",
    "const descriptor = safeGetOwnPropertyDescriptor(value, key, label)",
    "function isSupportedShapeType(value)",
    "value === \"optionalBoolean\"",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/validation.js must contain reviewed validation runtime code: missing ${snippet}.`);
    }
  }
}

function validateCliEntrypoint(source) {
  const requiredSnippets = [
    'import { writeSync } from "node:fs"',
    'import { parseCliArgs } from "./cliArgs.js"',
    'import { writeCliOutput } from "./cliIo.js"',
    'import { createStdioServer } from "./mcp.js"',
    'import { startupErrorJsonLine } from "./startup.js"',
    'import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js"',
    "const HELP_TEXT = `${PACKAGE_NAME} ${PACKAGE_VERSION}",
    "parseCliArgs(process.argv.slice(2))",
    "createStdioServer()",
    "writeCliOutput(writeSync, 1, HELP_TEXT)",
    "writeCliOutput(writeSync, 1, `${PACKAGE_VERSION}\\n`)",
    "writeCliOutput(writeSync, 2, startupErrorJsonLine(error))",
    "process.exitCode = 1"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/cli.js must contain reviewed CLI startup code: missing ${snippet}.`);
    }
  }
}

function validateCliIoRuntime(source) {
  const requiredSnippets = [
    "const MAX_CLI_OUTPUT_CHARS = 64 * 1024",
    "const MAX_CLI_OUTPUT_BYTES = 64 * 1024",
    "export function writeCliOutput(write, fd, data)",
    "try {",
    "typeof write !== \"function\"",
    "Number.isInteger(fd)",
    "typeof data !== \"string\"",
    "write(fd, boundedCliOutput(data))",
    "catch {",
    "startup failure handling must not throw again",
    "function boundedCliOutput(value)",
    "\"... [truncated CLI output]\\n\"",
    "function utf8ByteLengthUpTo(value, maxBytes)",
    "function utf8ScalarByteLength(scalar)"
  ];
  for (const snippet of requiredSnippets) {
    if (!source.includes(snippet)) {
      throw new Error(`dist/src/cliIo.js must contain reviewed CLI output runtime code: missing ${snippet}.`);
    }
  }
}

function boundedErrorMessage(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const normalized = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
  if (normalized.length <= MAX_ERROR_MESSAGE_CHARS && utf8ByteLength(normalized) <= MAX_ERROR_MESSAGE_BYTES) {
    return normalized;
  }
  const marker = `... [truncated ${Math.max(0, normalized.length - MAX_ERROR_MESSAGE_CHARS)} chars]`;
  return truncatePackCheckMessageWithMarker(normalized, marker, MAX_ERROR_MESSAGE_CHARS, MAX_ERROR_MESSAGE_BYTES);
}

function truncatePackCheckMessageWithMarker(value, marker, maxChars, maxBytes) {
  if (marker.length > maxChars || utf8ByteLength(marker) > maxBytes) {
    return "";
  }
  let low = 0;
  let high = Math.max(0, Math.min(value.length, maxChars - marker.length));
  let best = marker;
  const markerBytes = utf8ByteLength(marker);
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, middle)}${marker}`;
    if (candidate.length <= maxChars && utf8ByteLength(value.slice(0, middle)) + markerBytes <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}
