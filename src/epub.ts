import type { VolumeState } from "./types.js";
import { redactErrorMessage, redactInlineSecrets } from "./redaction.js";
import { assertBoundedNonEmptyString, assertObject, assertSafeId } from "./validation.js";

interface ZipEntry {
  path: string;
  data: Uint8Array;
  compress: false;
}

interface EpubStateMetadata {
  franchiseId: string;
  workId: string;
  volumeId: string;
  volumeTitle: string;
  updatedAt: string;
}

interface ParsedZipEntry extends ZipEntry {
  crc: number;
  flags: number;
  localOffset: number;
  localExtraLength: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_EPUB_MARKDOWN_CHARS = 16 * 1024 * 1024;
const MAX_EPUB_MARKDOWN_BYTES = 16 * 1024 * 1024;
export const MAX_EPUB_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_ENTRIES = 256;
const MAX_EPUB_PARSED_ZIP_ENTRIES = 4096;
const MAX_EPUB_ENTRY_NAME_BYTES = 1024;
const MAX_EPUB_REPORTED_ISSUES = 50;
const MAX_EPUB_REPORTED_ENTRIES = 256;
const MAX_EPUB_ISSUE_CHARS = 300;
const MAX_EPUB_ISSUE_BYTES = 300;
const MAX_EPUB_REPORTED_ENTRY_CHARS = 200;
const MAX_EPUB_REPORTED_ENTRY_BYTES = 200;
const MAX_EPUB_METADATA_CHARS = 512;
const ZIP_UTF8_NAME_FLAG = 0x0800;
const ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS = ZIP_UTF8_NAME_FLAG;
const EPUB_REPORTED_FIELD_CONTROL_CHARS_GLOBAL = /[\u0000-\u001f\u007f]/gu;

export function buildEpubArchive(state: VolumeState, markdown: string): Uint8Array {
  const metadata = validateEpubStateMetadata(state);
  if (typeof markdown !== "string") {
    throw new Error("EPUB markdown must be a string.");
  }
  if (markdown.length > MAX_EPUB_MARKDOWN_CHARS) {
    throw new Error(`EPUB markdown must be at most ${MAX_EPUB_MARKDOWN_CHARS} characters before rendering.`);
  }
  if (utf8ByteLengthUpTo(markdown, MAX_EPUB_MARKDOWN_BYTES) > MAX_EPUB_MARKDOWN_BYTES) {
    throw new Error(`EPUB markdown must be at most ${MAX_EPUB_MARKDOWN_BYTES} UTF-8 bytes before rendering.`);
  }
  if (markdown.trim().length === 0) {
    throw new Error("EPUB markdown must be non-empty after trimming.");
  }
  assertXmlCompatibleText(markdown, "EPUB markdown");
  const html = markdownToXhtml(metadata.volumeTitle, markdown);
  const files: ZipEntry[] = [
    { path: "mimetype", data: text("application/epub+zip"), compress: false },
    {
      path: "META-INF/container.xml",
      data: text(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`),
      compress: false
    },
    {
      path: "EPUB/package.opf",
      data: text(packageOpf(metadata)),
      compress: false
    },
    {
      path: "EPUB/nav.xhtml",
      data: text(navXhtml(metadata)),
      compress: false
    },
    {
      path: "EPUB/content.xhtml",
      data: text(html),
      compress: false
    }
  ];
  return createStoredZip(files);
}

export interface EpubValidationResult {
  valid: boolean;
  issues: string[];
  entries: string[];
}

export function validateEpubArchive(archive: Uint8Array): EpubValidationResult {
  const issues: string[] = [];
  const addIssue = (issue: string) => addValidationIssue(issues, issue);
  if (!isEpubUint8Array(archive)) {
    addIssue("EPUB archive must be a Uint8Array.");
    return { valid: false, issues, entries: [] };
  }
  const archiveByteLength = epubArchiveByteLength(archive);
  if (archiveByteLength === undefined) {
    addIssue("EPUB archive byte length must be readable.");
    return { valid: false, issues, entries: [] };
  }
  if (archiveByteLength > MAX_EPUB_ARCHIVE_BYTES) {
    addIssue(`EPUB archive is too large: ${archiveByteLength} bytes.`);
    return { valid: false, issues, entries: [] };
  }
  const stableArchive = snapshotEpubArchive(archive);
  if (!stableArchive) {
    addIssue("EPUB archive must be snapshot-readable.");
    return { valid: false, issues, entries: [] };
  }
  let entries: ParsedZipEntry[];
  try {
    entries = readStoredZipEntries(stableArchive);
  } catch (error) {
    addIssue(`Invalid EPUB ZIP structure: ${errorMessage(error)}`);
    return { valid: false, issues, entries: [] };
  }
  const byPath = new Map(entries.map((entry) => [entry.path, entry.data]));
  const paths = entries.map((entry) => entry.path);
  if (entries.length > MAX_EPUB_ENTRIES) {
    addIssue(`EPUB archive has too many entries: ${entries.length}.`);
  }
  const seenPaths = new Set<string>();
  for (const path of paths) {
    if (!isSafeZipPath(path)) {
      addIssue(`Unsafe EPUB entry path: ${path}`);
    }
    if (seenPaths.has(path)) {
      addIssue(`Duplicate EPUB entry path: ${path}`);
    }
    seenPaths.add(path);
  }

  if (paths[0] !== "mimetype") {
    addIssue("The first EPUB entry must be mimetype.");
  } else if (entries[0]?.localExtraLength !== 0) {
    addIssue("The mimetype EPUB entry must not include a ZIP extra field.");
  }
  if (decodeEpubText(byPath.get("mimetype"), "mimetype", addIssue) !== "application/epub+zip") {
    addIssue("mimetype must be application/epub+zip.");
  }
  for (const required of ["META-INF/container.xml", "EPUB/package.opf", "EPUB/nav.xhtml", "EPUB/content.xhtml"]) {
    if (!byPath.has(required)) {
      addIssue(`Missing required EPUB entry: ${required}.`);
    }
  }

  const container = decodeEpubText(byPath.get("META-INF/container.xml"), "META-INF/container.xml", addIssue);
  validateRequiredXmlText(container, "META-INF/container.xml", addIssue);
  if (!container.includes('full-path="EPUB/package.opf"')) {
    addIssue("container.xml must point to EPUB/package.opf.");
  }
  const packageOpfText = decodeEpubText(byPath.get("EPUB/package.opf"), "EPUB/package.opf", addIssue);
  validateRequiredXmlText(packageOpfText, "EPUB/package.opf", addIssue);
  if (!packageOpfText.includes('version="3.0"')) {
    addIssue("package.opf must declare EPUB 3.0.");
  }
  if (!packageOpfText.includes('properties="nav"')) {
    addIssue("package.opf must include a nav manifest item.");
  }
  if (!packageOpfText.includes('<item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>')) {
    addIssue("package.opf must include content.xhtml as an XHTML manifest item.");
  }
  if (!packageOpfText.includes('<itemref idref="content"/>')) {
    addIssue("package.opf spine must reference the content manifest item.");
  }
  const nav = decodeEpubText(byPath.get("EPUB/nav.xhtml"), "EPUB/nav.xhtml", addIssue);
  validateRequiredXmlText(nav, "EPUB/nav.xhtml", addIssue);
  if (!nav.includes('epub:type="toc"')) {
    addIssue("nav.xhtml must include a table of contents nav.");
  }
  const content = decodeEpubText(byPath.get("EPUB/content.xhtml"), "EPUB/content.xhtml", addIssue);
  validateRequiredXmlText(content, "EPUB/content.xhtml", addIssue);
  if (!content.includes("<body>")) {
    addIssue("content.xhtml must contain a body element.");
  }

  return { valid: issues.length === 0, issues, entries: reportedEntries(paths) };
}

function isEpubUint8Array(value: unknown): value is Uint8Array {
  try {
    return value instanceof Uint8Array;
  } catch {
    return false;
  }
}

function epubArchiveByteLength(value: Uint8Array): number | undefined {
  try {
    return value.byteLength;
  } catch {
    return undefined;
  }
}

function snapshotEpubArchive(value: Uint8Array): Uint8Array | undefined {
  try {
    return new Uint8Array(value);
  } catch {
    return undefined;
  }
}

function validateEpubStateMetadata(state: VolumeState): EpubStateMetadata {
  const value = assertObject(state, "EPUB state");
  const status = assertBoundedNonEmptyString(value.status, "EPUB state.status", MAX_EPUB_METADATA_CHARS);
  if (status !== "complete") {
    throw new Error("EPUB state.status must be complete.");
  }
  const updatedAt = assertBoundedNonEmptyString(value.updatedAt, "EPUB state.updatedAt", MAX_EPUB_METADATA_CHARS);
  if (!isCanonicalUtcTimestamp(updatedAt)) {
    throw new Error("EPUB state.updatedAt must be an ISO timestamp string.");
  }
  const volumeTitle = assertBoundedNonEmptyString(value.volumeTitle, "EPUB state.volumeTitle", MAX_EPUB_METADATA_CHARS);
  assertXmlCompatibleText(volumeTitle, "EPUB state.volumeTitle");
  return {
    franchiseId: assertSafeId(value.franchiseId, "EPUB state.franchiseId"),
    workId: assertSafeId(value.workId, "EPUB state.workId"),
    volumeId: assertSafeId(value.volumeId, "EPUB state.volumeId"),
    volumeTitle,
    updatedAt
  };
}

function isCanonicalUtcTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function packageOpf(state: EpubStateMetadata): string {
  const identifier = `${state.franchiseId}:${state.workId}:${state.volumeId}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(state.volumeTitle)}</dc:title>
    <dc:language>ko</dc:language>
    <meta property="dcterms:modified">${new Date(state.updatedAt).toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="content" href="content.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="content"/>
  </spine>
</package>
`;
}

function navXhtml(state: EpubStateMetadata): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ko">
  <head><title>${escapeXml(state.volumeTitle)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>${escapeXml(state.volumeTitle)}</h1>
      <ol><li><a href="content.xhtml">${escapeXml(state.volumeTitle)}</a></li></ol>
    </nav>
  </body>
</html>
`;
}

function markdownToXhtml(title: string, markdown: string): string {
  const body = markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      if (block.startsWith("# ")) {
        return `<h1>${escapeXml(block.slice(2))}</h1>`;
      }
      if (block.startsWith("## ")) {
        return `<h2>${escapeXml(block.slice(3))}</h2>`;
      }
      if (block.startsWith("### ")) {
        return `<h3>${escapeXml(block.slice(4))}</h3>`;
      }
      return `<p>${escapeXml(block).replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="ko">
  <head>
    <title>${escapeXml(title)}</title>
    <meta charset="UTF-8"/>
  </head>
  <body>
${body}
  </body>
</html>
`;
}

function createStoredZip(files: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = text(file.path);
    const crc = crc32(file.data);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(ZIP_UTF8_NAME_FLAG),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.length),
      u32(file.data.length),
      u16(name.length),
      u16(0),
      name,
      file.data
    ]);
    localParts.push(local);

    centralParts.push(
      concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(ZIP_UTF8_NAME_FLAG),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(file.data.length),
        u32(file.data.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name
      ])
    );
    offset += local.length;
  }

  const centralDirectory = concat(centralParts);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralDirectory.length),
    u32(offset),
    u16(0)
  ]);
  const archive = concat([...localParts, centralDirectory, end]);
  if (archive.length > MAX_EPUB_ARCHIVE_BYTES) {
    throw new Error(`EPUB archive is too large to build: ${archive.length} bytes, maximum is ${MAX_EPUB_ARCHIVE_BYTES} bytes.`);
  }
  return archive;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function text(value: string): Uint8Array {
  return encoder.encode(value);
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function readStoredZipEntries(archive: Uint8Array): ParsedZipEntry[] {
  const entries: ParsedZipEntry[] = [];
  let offset = 0;
  while (offset + 4 <= archive.length && readU32(archive, offset) === 0x04034b50) {
    if (offset + 30 > archive.length) {
      throw new Error("Truncated ZIP local file header.");
    }
    const localOffset = offset;
    const flags = readU16(archive, offset + 6);
    const compression = readU16(archive, offset + 8);
    const expectedCrc = readU32(archive, offset + 14);
    const compressedSize = readU32(archive, offset + 18);
    const uncompressedSize = readU32(archive, offset + 22);
    const nameLength = readU16(archive, offset + 26);
    const extraLength = readU16(archive, offset + 28);
    if (nameLength === 0 || nameLength > MAX_EPUB_ENTRY_NAME_BYTES) {
      throw new Error("Invalid ZIP entry name length.");
    }
    if ((flags & ~ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0) {
      throw new Error(`Unsupported ZIP local entry flags: 0x${flags.toString(16)}.`);
    }
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    if (compression !== 0) {
      throw new Error("Only stored ZIP entries are supported by the EPUB validator.");
    }
    if (compressedSize !== uncompressedSize || dataEnd > archive.length) {
      throw new Error("Invalid ZIP entry sizes.");
    }
    const path = decodeZipEntryName(archive.slice(nameStart, nameStart + nameLength));
    const data = archive.slice(dataStart, dataEnd);
    const actualCrc = crc32(data);
    if (actualCrc !== expectedCrc) {
      throw new Error(`ZIP entry CRC mismatch: ${path}.`);
    }
    entries.push({
      path,
      data,
      crc: expectedCrc,
      flags,
      localOffset,
      localExtraLength: extraLength,
      compress: false
    });
    if (entries.length > MAX_EPUB_PARSED_ZIP_ENTRIES) {
      throw new Error(`EPUB ZIP archive has too many entries to parse: maximum is ${MAX_EPUB_PARSED_ZIP_ENTRIES}.`);
    }
    offset = dataEnd;
  }
  if (entries.length === 0) {
    throw new Error("No local ZIP entries found.");
  }
  validateCentralDirectory(archive, offset, entries);
  return entries;
}

function validateCentralDirectory(archive: Uint8Array, centralStart: number, localEntries: ParsedZipEntry[]): void {
  const centralEntries: Array<{ path: string; crc: number; flags: number; size: number; localOffset: number }> = [];
  let offset = centralStart;
  while (offset + 4 <= archive.length && readU32(archive, offset) === 0x02014b50) {
    if (offset + 46 > archive.length) {
      throw new Error("Truncated ZIP central directory entry.");
    }
    const flags = readU16(archive, offset + 8);
    const compression = readU16(archive, offset + 10);
    const crc = readU32(archive, offset + 16);
    const compressedSize = readU32(archive, offset + 20);
    const uncompressedSize = readU32(archive, offset + 24);
    const nameLength = readU16(archive, offset + 28);
    const extraLength = readU16(archive, offset + 30);
    const commentLength = readU16(archive, offset + 32);
    const localOffset = readU32(archive, offset + 42);
    if (nameLength === 0 || nameLength > MAX_EPUB_ENTRY_NAME_BYTES) {
      throw new Error("Invalid ZIP central directory entry name length.");
    }
    if ((flags & ~ZIP_SUPPORTED_GENERAL_PURPOSE_FLAGS) !== 0) {
      throw new Error(`Unsupported ZIP central directory entry flags: 0x${flags.toString(16)}.`);
    }
    const nameStart = offset + 46;
    const nextOffset = nameStart + nameLength + extraLength + commentLength;
    if (nextOffset > archive.length) {
      throw new Error("Truncated ZIP central directory entry.");
    }
    if (compression !== 0) {
      throw new Error("Only stored ZIP central directory entries are supported by the EPUB validator.");
    }
    if (compressedSize !== uncompressedSize) {
      throw new Error("Invalid ZIP central directory entry sizes.");
    }
    centralEntries.push({
      path: decodeZipEntryName(archive.slice(nameStart, nameStart + nameLength)),
      crc,
      flags,
      size: uncompressedSize,
      localOffset
    });
    if (centralEntries.length > MAX_EPUB_PARSED_ZIP_ENTRIES) {
      throw new Error(`EPUB ZIP central directory has too many entries to parse: maximum is ${MAX_EPUB_PARSED_ZIP_ENTRIES}.`);
    }
    offset = nextOffset;
  }
  if (centralEntries.length === 0) {
    throw new Error("Missing ZIP central directory.");
  }
  if (offset + 22 > archive.length || readU32(archive, offset) !== 0x06054b50) {
    throw new Error("Missing ZIP end of central directory.");
  }
  const diskNumber = readU16(archive, offset + 4);
  const centralDisk = readU16(archive, offset + 6);
  const diskEntryCount = readU16(archive, offset + 8);
  const totalEntryCount = readU16(archive, offset + 10);
  const centralSize = readU32(archive, offset + 12);
  const eocdCentralOffset = readU32(archive, offset + 16);
  const commentLength = readU16(archive, offset + 20);
  if (offset + 22 + commentLength !== archive.length) {
    throw new Error("Invalid ZIP end of central directory length.");
  }
  if (commentLength !== 0) {
    throw new Error("ZIP end of central directory comments are not supported.");
  }
  if (diskNumber !== 0 || centralDisk !== 0) {
    throw new Error("Multi-disk ZIP archives are not supported.");
  }
  if (diskEntryCount !== localEntries.length || totalEntryCount !== localEntries.length || centralEntries.length !== localEntries.length) {
    throw new Error("ZIP central directory entry count does not match local entries.");
  }
  if (centralSize !== offset - centralStart || eocdCentralOffset !== centralStart) {
    throw new Error("ZIP central directory offset or size does not match the archive.");
  }
  for (let index = 0; index < localEntries.length; index += 1) {
    const local = localEntries[index]!;
    const central = centralEntries[index]!;
    if (
      central.path !== local.path ||
      central.crc !== local.crc ||
      central.flags !== local.flags ||
      central.size !== local.data.length ||
      central.localOffset !== local.localOffset
    ) {
      throw new Error("ZIP central directory does not match local entries.");
    }
  }
}

function isSafeZipPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.startsWith("\\") &&
    !path.includes("\\") &&
    !path.split("/").includes("..") &&
    !/[\u0000-\u001f\u007f]/u.test(path)
  );
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function decodeEpubText(value: Uint8Array | undefined, label: string, addIssue: (issue: string) => void): string {
  if (value === undefined) {
    return "";
  }
  let decoded: string;
  try {
    decoded = decodeUtf8(value);
  } catch {
    addIssue(`${label} must be valid UTF-8.`);
    return "";
  }
  try {
    assertXmlCompatibleText(decoded, label);
  } catch (error) {
    addIssue(errorMessage(error));
  }
  return decoded;
}

function validateRequiredXmlText(value: string, label: string, addIssue: (issue: string) => void): void {
  if (!value) {
    return;
  }
  try {
    assertSimpleXmlWellFormed(value, label);
  } catch (error) {
    addIssue(errorMessage(error));
  }
}

function assertSimpleXmlWellFormed(value: string, label: string): void {
  assertKnownXmlEntities(value, label);
  const stack: string[] = [];
  let offset = 0;
  for (;;) {
    const open = value.indexOf("<", offset);
    if (open === -1) {
      break;
    }
    const close = value.indexOf(">", open + 1);
    if (close === -1) {
      throw new Error(`${label} must be well-formed XML: unterminated tag.`);
    }
    const rawTag = value.slice(open + 1, close).trim();
    offset = close + 1;
    if (!rawTag || rawTag.startsWith("?") || rawTag.startsWith("!")) {
      continue;
    }
    if (rawTag.startsWith("/")) {
      const tagName = xmlTagName(rawTag.slice(1), label);
      const expected = stack.pop();
      if (expected !== tagName) {
        throw new Error(`${label} must be well-formed XML: closing tag ${tagName} does not match ${expected ?? "no open tag"}.`);
      }
      continue;
    }
    if (rawTag.endsWith("/")) {
      xmlTagName(rawTag.slice(0, -1), label);
      continue;
    }
    stack.push(xmlTagName(rawTag, label));
  }
  if (stack.length > 0) {
    throw new Error(`${label} must be well-formed XML: unclosed tag ${stack.at(-1)}.`);
  }
}

function assertKnownXmlEntities(value: string, label: string): void {
  const invalid = value.match(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/u);
  if (invalid) {
    throw new Error(`${label} must be well-formed XML: invalid entity reference.`);
  }
  for (const match of value.matchAll(/&#(x[0-9a-fA-F]+|\d+);/gu)) {
    const reference = match[0]!;
    const rawCodePoint = match[1]!;
    const codePoint = rawCodePoint.startsWith("x")
      ? Number.parseInt(rawCodePoint.slice(1), 16)
      : Number.parseInt(rawCodePoint, 10);
    if (!Number.isSafeInteger(codePoint) || !isXmlCodePoint(codePoint)) {
      throw new Error(`${label} must be well-formed XML: invalid numeric character reference ${reference}.`);
    }
  }
}

function xmlTagName(value: string, label: string): string {
  const match = value.match(/^([A-Za-z_][A-Za-z0-9._:-]*)/u);
  if (!match) {
    throw new Error(`${label} must be well-formed XML: invalid tag name.`);
  }
  return match[1]!;
}

function addValidationIssue(issues: string[], issue: string): void {
  if (issues.length >= MAX_EPUB_REPORTED_ISSUES) {
    if (issues.at(-1) !== "[truncated additional EPUB validation issues]") {
      issues[issues.length - 1] = "[truncated additional EPUB validation issues]";
    }
    return;
  }
  issues.push(truncateIssue(issue));
}

function truncateIssue(issue: string): string {
  const normalized = normalizeReportedField(issue);
  if (
    normalized.length <= MAX_EPUB_ISSUE_CHARS &&
    utf8ByteLengthUpTo(normalized, MAX_EPUB_ISSUE_BYTES) <= MAX_EPUB_ISSUE_BYTES
  ) {
    return normalized;
  }
  const marker =
    normalized.length > MAX_EPUB_ISSUE_CHARS
      ? `... [truncated ${normalized.length - MAX_EPUB_ISSUE_CHARS} chars]`
      : `... [truncated ${Math.max(0, utf8ByteLength(normalized) - MAX_EPUB_ISSUE_BYTES)} UTF-8 bytes]`;
  return truncateTextByCharsAndBytesWithMarker(normalized, marker, MAX_EPUB_ISSUE_CHARS, MAX_EPUB_ISSUE_BYTES);
}

function reportedEntries(paths: string[]): string[] {
  const entries = paths.slice(0, MAX_EPUB_REPORTED_ENTRIES).map(truncateEntryPath);
  if (paths.length <= MAX_EPUB_REPORTED_ENTRIES) {
    return entries;
  }
  return [
    ...entries,
    `[truncated ${paths.length - MAX_EPUB_REPORTED_ENTRIES} EPUB entries]`
  ];
}

function truncateEntryPath(path: string): string {
  const normalized = normalizeReportedField(path);
  if (
    normalized.length <= MAX_EPUB_REPORTED_ENTRY_CHARS &&
    utf8ByteLengthUpTo(normalized, MAX_EPUB_REPORTED_ENTRY_BYTES) <= MAX_EPUB_REPORTED_ENTRY_BYTES
  ) {
    return normalized;
  }
  const marker =
    normalized.length > MAX_EPUB_REPORTED_ENTRY_CHARS
      ? `... [truncated ${normalized.length - MAX_EPUB_REPORTED_ENTRY_CHARS} chars]`
      : `... [truncated ${Math.max(0, utf8ByteLength(normalized) - MAX_EPUB_REPORTED_ENTRY_BYTES)} UTF-8 bytes]`;
  return truncateTextByCharsAndBytesWithMarker(normalized, marker, MAX_EPUB_REPORTED_ENTRY_CHARS, MAX_EPUB_REPORTED_ENTRY_BYTES);
}

function normalizeReportedField(value: unknown): string {
  return redactInlineSecrets(value).replace(EPUB_REPORTED_FIELD_CONTROL_CHARS_GLOBAL, " ");
}

function truncateTextByCharsAndBytesWithMarker(value: string, marker: string, maxChars: number, maxBytes: number): string {
  const markerBytes = utf8ByteLength(marker);
  if (marker.length > maxChars || markerBytes > maxBytes) {
    return truncateTextByCharsAndBytes(marker, maxChars, maxBytes);
  }
  const maxPrefixChars = maxChars - marker.length;
  const maxPrefixBytes = maxBytes - markerBytes;
  return `${truncateTextByCharsAndBytes(value, maxPrefixChars, maxPrefixBytes)}${marker}`;
}

function truncateTextByCharsAndBytes(value: string, maxChars: number, maxBytes: number): string {
  let output = "";
  let bytes = 0;
  for (const scalar of value) {
    if (output.length + scalar.length > maxChars) {
      break;
    }
    const nextBytes = bytes + utf8ByteLength(scalar);
    if (nextBytes > maxBytes) {
      break;
    }
    output += scalar;
    bytes = nextBytes;
  }
  return output;
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

function decodeZipEntryName(value: Uint8Array): string {
  try {
    return decodeUtf8(value);
  } catch {
    throw new Error("ZIP entry names must be valid UTF-8.");
  }
}

function decodeUtf8(value: Uint8Array): string {
  return decoder.decode(value);
}

function escapeXml(value: string): string {
  assertXmlCompatibleText(value, "EPUB XML text");
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function assertXmlCompatibleText(value: string, label: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || !isXmlCodePoint(codePoint)) {
      throw new Error(`${label} must not contain characters that are not valid in XML 1.0.`);
    }
  }
}

function isXmlCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
    (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
    (codePoint >= 0x10000 && codePoint <= 0x10ffff)
  );
}

function errorMessage(error: unknown): string {
  return normalizeReportedField(redactErrorMessage(error));
}
