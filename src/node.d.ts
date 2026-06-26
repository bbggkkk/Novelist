declare module "node:fs/promises" {
  export function access(path: string, mode?: number): Promise<void>;
  export interface FileHandle {
    close(): Promise<void>;
    read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number; buffer: Uint8Array }>;
    stat(): Promise<Stats>;
    sync(): Promise<void>;
    writeFile(data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
  }
  export interface Dirent {
    name: string;
  }
  export interface Dir extends AsyncIterable<Dirent> {
    close(): Promise<void>;
  }
  export function mkdtemp(prefix: string): Promise<string>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export interface Stats {
    dev: number;
    ino: number;
    mode: number;
    mtimeMs: number;
    size: number;
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }
  export function lstat(path: string): Promise<Stats>;
  export function lutimes(path: string, atime: Date, mtime: Date): Promise<void>;
  export function open(path: string, flags: "r" | "wx"): Promise<FileHandle>;
  export function opendir(path: string): Promise<Dir>;
  export function readFile(path: string): Promise<Uint8Array>;
  export function readFile(path: string, encoding: BufferEncoding): Promise<string>;
  export function readdir(path: string, options?: { withFileTypes?: false }): Promise<string[]>;
  export function realpath(path: string): Promise<string>;
  export function rename(oldPath: string, newPath: string): Promise<void>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function rmdir(path: string): Promise<void>;
  export function stat(path: string): Promise<Stats>;
  export function symlink(target: string, path: string): Promise<void>;
  export function unlink(path: string): Promise<void>;
  export function utimes(path: string, atime: Date, mtime: Date): Promise<void>;
  export function writeFile(path: string, data: string | Uint8Array, encoding?: BufferEncoding): Promise<void>;
}

declare module "node:fs" {
  export const constants: {
    R_OK: number;
    X_OK: number;
  };
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function writeSync(fd: number, data: string): number;
}

declare module "node:http" {
  export interface IncomingMessage {
    method?: string;
    url?: string;
    on(event: "data", listener: (chunk: Uint8Array) => void): void;
    on(event: "end", listener: () => void): void;
  }

  export interface ServerResponse {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(data?: string | Uint8Array): void;
  }

  export interface Server {
    listen(port: number, host: string, callback: () => void): void;
    close(callback: () => void): void;
    address(): { port: number } | string | null;
  }

  export function createServer(listener: (request: IncomingMessage, response: ServerResponse) => void): Server;
}

declare module "node:child_process" {
  export interface ExecFileError extends Error {
    code?: number | string;
    stdout?: string;
    stderr?: string;
  }

  export interface ChildProcess {
    stdin: {
      end(data?: string | Uint8Array): void;
    } | null;
  }

  export function execFile(
    file: string,
    args: string[],
    options: { encoding: "utf8"; timeout?: number; maxBuffer?: number; cwd?: string; env?: Record<string, string | undefined> },
    callback: (error: ExecFileError | null, stdout: string, stderr: string) => void
  ): ChildProcess;
}

declare module "node:path" {
  export function basename(path: string): string;
  export function dirname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string): Hash;
    digest(encoding: "hex"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomUUID(): string;
}

declare module "node:test" {
  export default function test(name: string, fn: () => Promise<void> | void): void;
  export function after(fn: () => Promise<void> | void): void;
}

declare module "node:assert/strict" {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(value: string, regexp: RegExp, message?: string): void;
    doesNotMatch(value: string, regexp: RegExp, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp): void;
  };
  export default assert;
}

declare const process: {
  argv: string[];
  execPath: string;
  cwd(): string;
  env: Record<string, string | undefined>;
  stdin: {
    setEncoding(encoding: BufferEncoding): void;
    resume(): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
    off(event: "data", listener: (chunk: string) => void): void;
    off(event: "end", listener: () => void): void;
    listenerCount(event: string): number;
  };
  on(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): void;
  stdout: {
    write(data: string): void;
  };
  stderr: {
    write(data: string): void;
  };
  exitCode?: number;
};

declare function setTimeout(callback: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
declare function setInterval(callback: () => void, ms: number): unknown;
declare function clearInterval(handle: unknown): void;

declare class TextEncoder {
  encode(value: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(value: Uint8Array): string;
}

declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}

declare class URL {
  readonly protocol: string;
  readonly hostname: string;
  readonly username: string;
  readonly password: string;
  readonly search: string;
  readonly hash: string;
  constructor(input: string);
  toString(): string;
}

declare class Headers {
  constructor(init?: Record<string, string>);
  get(name: string): string | null;
}

declare class Response {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  constructor(body?: string, init?: { status?: number; headers?: Record<string, string> });
  static error(): Response;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

declare function fetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
  }
): Promise<Response>;

type BufferEncoding = "utf8";
