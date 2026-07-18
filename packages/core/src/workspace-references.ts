import { spawnSync } from "node:child_process";
import {
  opendirSync,
  readFileSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const DEFAULT_WORKSPACE_REFERENCE_LIMITS = {
  maxFileBytes: 256 * 1024,
  maxTotalBytes: 1024 * 1024,
  maxReferences: 32,
  maxDirectoryEntries: 100,
  maxTotalEntries: 200,
  maxCandidates: 5_000,
  maxScannedEntries: 20_000,
  maxDepth: 20,
  maxIndexBytes: 2 * 1024 * 1024,
  gitTimeoutMs: 1_500,
} as const;

export interface WorkspaceReferenceOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxReferences?: number;
  maxDirectoryEntries?: number;
  maxTotalEntries?: number;
  maxCandidates?: number;
  maxScannedEntries?: number;
  maxDepth?: number;
  maxIndexBytes?: number;
  gitTimeoutMs?: number;
  ignoredDirectories?: readonly string[];
}

export interface WorkspaceReferenceCandidate {
  path: string;
  directory: boolean;
  size?: number;
}

export interface WorkspaceReferenceIndex {
  workspaceRoot: string | null;
  source: "git" | "filesystem";
  candidates: readonly WorkspaceReferenceCandidate[];
  warnings: readonly WorkspaceReferenceWarning[];
}

export interface FileReferenceRange {
  start: number;
  end: number;
}

export interface ParsedFileReference {
  raw: string;
  path: string;
  range?: FileReferenceRange;
  malformedRange?: string;
  textStart: number;
  textEnd: number;
}

export type WorkspaceReferenceWarningCode =
  | "workspace-unavailable"
  | "discovery-limit"
  | "malformed-range"
  | "not-found"
  | "outside-workspace"
  | "unreadable"
  | "unsupported-type"
  | "binary"
  | "file-byte-limit"
  | "reference-limit"
  | "directory-entry-limit"
  | "total-entry-limit"
  | "total-byte-limit";

export interface WorkspaceReferenceWarning {
  code: WorkspaceReferenceWarningCode;
  message: string;
  reference?: string;
}

export interface ResolvedWorkspaceReference {
  path: string;
  absolutePath: string;
  canonicalPath: string;
  kind: "file" | "directory";
  size: number;
}

export type WorkspaceReferenceResolution =
  | { ok: true; reference: ResolvedWorkspaceReference }
  | { ok: false; warning: WorkspaceReferenceWarning };

export interface ExpandedWorkspaceReference {
  raw: string;
  path: string;
  kind: "file" | "directory";
  range?: FileReferenceRange;
  bytes: number;
  entries: number;
}

export interface WorkspaceReferenceExpansion {
  displayText: string;
  modelText: string;
  references: readonly ExpandedWorkspaceReference[];
  warnings: readonly WorkspaceReferenceWarning[];
}

interface ResolvedLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxReferences: number;
  maxDirectoryEntries: number;
  maxTotalEntries: number;
  maxCandidates: number;
  maxScannedEntries: number;
  maxDepth: number;
  maxIndexBytes: number;
  gitTimeoutMs: number;
  ignoredDirectories: ReadonlySet<string>;
}

interface DirectoryListing {
  entries: string[];
  truncated: boolean;
  unreadable: boolean;
}

const DEFAULT_IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".cache",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export function canonicalizeWorkspace(workspaceRoot: string): string {
  const canonical = realpathSync(resolve(workspaceRoot));
  if (!statSync(canonical).isDirectory()) throw new Error(`Workspace is not a directory: ${workspaceRoot}`);
  return canonical;
}

export function indexWorkspaceReferences(
  workspaceRoot: string,
  options: WorkspaceReferenceOptions = {},
): WorkspaceReferenceIndex {
  const limits = resolveLimits(options);
  let canonical: string;
  try {
    canonical = canonicalizeWorkspace(workspaceRoot);
  } catch {
    return {
      workspaceRoot: null,
      source: "filesystem",
      candidates: [],
      warnings: [createWarning("workspace-unavailable", undefined, `Workspace is unavailable: ${workspaceRoot}`)],
    };
  }

  const warnings: WorkspaceReferenceWarning[] = [];
  const candidates = new Map<string, WorkspaceReferenceCandidate>();
  const gitPaths = readGitIndex(canonical, limits);
  if (gitPaths) {
    let scanned = 0;
    for (const value of gitPaths) {
      if (scanned++ >= limits.maxScannedEntries || candidates.size >= limits.maxCandidates) {
        warnings.push(createWarning("discovery-limit", undefined, "Workspace reference discovery was truncated"));
        break;
      }
      addIndexedCandidate(canonical, value, candidates, limits.maxCandidates);
      for (const parent of parentPaths(value)) addIndexedCandidate(canonical, parent, candidates, limits.maxCandidates);
    }
    return {
      workspaceRoot: canonical,
      source: "git",
      candidates: sortCandidates(candidates),
      warnings,
    };
  }

  let scanned = 0;
  let truncated = false;
  const walk = (absoluteDirectory: string, relativeDirectory: string, depth: number): void => {
    if (truncated || depth > limits.maxDepth) return;
    const entries = readDirectoryEntries(absoluteDirectory, limits.maxScannedEntries - scanned);
    for (const entry of entries) {
      if (scanned++ >= limits.maxScannedEntries || candidates.size >= limits.maxCandidates) {
        truncated = true;
        return;
      }
      if (entry.isDirectory() && limits.ignoredDirectories.has(entry.name)) continue;
      const path = normalizeReferencePath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const candidate = addIndexedCandidate(canonical, path, candidates, limits.maxCandidates);
      if (!candidate?.directory || entry.isSymbolicLink()) continue;
      walk(resolve(absoluteDirectory, entry.name), path, depth + 1);
    }
  };
  walk(canonical, "", 0);
  if (truncated) warnings.push(createWarning("discovery-limit", undefined, "Workspace reference discovery was truncated"));

  return {
    workspaceRoot: canonical,
    source: "filesystem",
    candidates: sortCandidates(candidates),
    warnings,
  };
}

export function parseFileReferences(text: string): ParsedFileReference[] {
  const references: ParsedFileReference[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf("@", cursor);
    if (start === -1) break;
    cursor = start + 1;
    const before = start === 0 ? undefined : text[start - 1];
    if (before !== undefined && !isReferenceBoundary(before)) continue;

    let end = start + 1;
    while (end < text.length && !/\s/.test(text[end]!)) end++;
    const trimmed = trimTrailingPunctuation(text.slice(start + 1, end));
    if (!trimmed) continue;
    const textEnd = start + 1 + trimmed.length;
    const parsed = parseReferenceToken(trimmed);
    if (!parsed.path) continue;
    references.push({
      raw: text.slice(start, textEnd),
      path: normalizeReferencePath(parsed.path),
      ...(parsed.range ? { range: parsed.range } : {}),
      ...(parsed.malformedRange !== undefined ? { malformedRange: parsed.malformedRange } : {}),
      textStart: start,
      textEnd,
    });
    cursor = end;
  }
  return references;
}

export function resolveWorkspaceReference(
  workspaceRoot: string,
  reference: string | ParsedFileReference,
): WorkspaceReferenceResolution {
  const value = typeof reference === "string" ? normalizeReferencePath(reference) : reference.path;
  let canonical: string;
  try {
    canonical = canonicalizeWorkspace(workspaceRoot);
  } catch {
    return {
      ok: false,
      warning: createWarning("workspace-unavailable", displayReference(reference), `Workspace is unavailable: ${workspaceRoot}`),
    };
  }
  return resolveCanonicalReference(canonical, value, displayReference(reference));
}

export function expandWorkspaceReferences(
  displayText: string,
  workspaceRoot: string,
  options: WorkspaceReferenceOptions = {},
): WorkspaceReferenceExpansion {
  const parsed = parseFileReferences(displayText);
  if (parsed.length === 0) return { displayText, modelText: displayText, references: [], warnings: [] };

  let canonical: string;
  try {
    canonical = canonicalizeWorkspace(workspaceRoot);
  } catch {
    return {
      displayText,
      modelText: displayText,
      references: [],
      warnings: [createWarning("workspace-unavailable", undefined, `Workspace is unavailable: ${workspaceRoot}`)],
    };
  }

  const limits = resolveLimits(options);
  const warnings: WorkspaceReferenceWarning[] = [];
  const references: ExpandedWorkspaceReference[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  let consideredReferences = 0;
  let referenceLimitWarned = false;
  let totalEntries = 0;

  for (const item of parsed) {
    if (item.malformedRange !== undefined) {
      warnings.push(createWarning("malformed-range", item.raw, `Malformed line range in ${item.raw}`));
      continue;
    }

    const resolution = resolveCanonicalReference(canonical, item.path, item.raw);
    if (!resolution.ok) {
      warnings.push(resolution.warning);
      continue;
    }
    const dedupeKey = `${resolution.reference.canonicalPath}\0${item.range?.start ?? ""}\0${item.range?.end ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    if (consideredReferences >= limits.maxReferences) {
      if (!referenceLimitWarned) {
        referenceLimitWarned = true;
        warnings.push(createWarning("reference-limit", item.raw, `Only ${limits.maxReferences} references can be expanded`));
      }
      continue;
    }
    consideredReferences++;

    if (resolution.reference.kind === "file") {
      if (totalEntries >= limits.maxTotalEntries) {
        warnings.push(createWarning("total-entry-limit", item.raw, "The total reference entry limit was reached"));
        continue;
      }
      if (resolution.reference.size > limits.maxFileBytes) {
        warnings.push(
          createWarning("file-byte-limit", item.raw, `${item.raw} exceeds the ${limits.maxFileBytes}-byte file limit`),
        );
        continue;
      }

      let buffer: Buffer;
      try {
        buffer = readFileSync(resolution.reference.canonicalPath);
      } catch {
        warnings.push(createWarning("unreadable", item.raw, `${item.raw} could not be read`));
        continue;
      }
      if (buffer.byteLength > limits.maxFileBytes) {
        warnings.push(
          createWarning("file-byte-limit", item.raw, `${item.raw} exceeds the ${limits.maxFileBytes}-byte file limit`),
        );
        continue;
      }
      if (isBinary(buffer)) {
        warnings.push(createWarning("binary", item.raw, `${item.raw} appears to be binary`));
        continue;
      }

      const content = normalizeText(buffer.toString("utf8"));
      const selected = selectLineRange(content, item.range);
      if (!selected.ok) {
        warnings.push(createWarning("malformed-range", item.raw, selected.message));
        continue;
      }
      const block = formatFileBlock(resolution.reference.path, selected.text, item.range);
      if (contextBytes([...blocks, block]) > limits.maxTotalBytes) {
        warnings.push(createWarning("total-byte-limit", item.raw, "The total reference byte limit was reached"));
        continue;
      }

      blocks.push(block);
      totalEntries++;
      references.push({
        raw: item.raw,
        path: resolution.reference.path,
        kind: "file",
        ...(item.range ? { range: item.range } : {}),
        bytes: Buffer.byteLength(selected.text),
        entries: 1,
      });
      continue;
    }

    if (item.range) {
      warnings.push(createWarning("malformed-range", item.raw, "Line ranges can only be used with files"));
      continue;
    }
    const remainingEntries = Math.max(0, limits.maxTotalEntries - totalEntries);
    if (remainingEntries === 0) {
      warnings.push(createWarning("total-entry-limit", item.raw, "The total reference entry limit was reached"));
      continue;
    }
    const listingLimit = Math.min(limits.maxDirectoryEntries, remainingEntries);
    const listing = listDirectory(canonical, resolution.reference.canonicalPath, listingLimit, limits);
    if (listing.unreadable) {
      warnings.push(createWarning("unreadable", item.raw, `${item.raw} could not be listed`));
      continue;
    }
    if (listing.truncated) {
      const code = listingLimit < limits.maxDirectoryEntries ? "total-entry-limit" : "directory-entry-limit";
      warnings.push(createWarning(code, item.raw, `${item.raw} was truncated to ${listingLimit} entries`));
    }

    const fitted = fitDirectoryBlock(resolution.reference.path, listing.entries, blocks, limits.maxTotalBytes);
    if (fitted.entries.length < listing.entries.length) {
      warnings.push(createWarning("total-byte-limit", item.raw, "The total reference byte limit truncated the directory listing"));
    }
    if (!fitted.block) {
      warnings.push(createWarning("total-byte-limit", item.raw, "The total reference byte limit was reached"));
      continue;
    }

    blocks.push(fitted.block);
    totalEntries += fitted.entries.length;
    references.push({
      raw: item.raw,
      path: resolution.reference.path,
      kind: "directory",
      bytes: Buffer.byteLength(fitted.entries.join("\n")),
      entries: fitted.entries.length,
    });
  }

  return {
    displayText,
    modelText: blocks.length > 0 ? `${displayText}${formatContext(blocks)}` : displayText,
    references,
    warnings,
  };
}

function resolveLimits(options: WorkspaceReferenceOptions): ResolvedLimits {
  return {
    maxFileBytes: safeLimit(options.maxFileBytes, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxFileBytes),
    maxTotalBytes: safeLimit(options.maxTotalBytes, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxTotalBytes),
    maxReferences: safeLimit(options.maxReferences, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxReferences),
    maxDirectoryEntries: safeLimit(
      options.maxDirectoryEntries,
      DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxDirectoryEntries,
    ),
    maxTotalEntries: safeLimit(options.maxTotalEntries, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxTotalEntries),
    maxCandidates: safeLimit(options.maxCandidates, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxCandidates),
    maxScannedEntries: safeLimit(
      options.maxScannedEntries,
      DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxScannedEntries,
    ),
    maxDepth: safeLimit(options.maxDepth, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxDepth),
    maxIndexBytes: Math.max(1, safeLimit(options.maxIndexBytes, DEFAULT_WORKSPACE_REFERENCE_LIMITS.maxIndexBytes)),
    gitTimeoutMs: Math.max(1, safeLimit(options.gitTimeoutMs, DEFAULT_WORKSPACE_REFERENCE_LIMITS.gitTimeoutMs)),
    ignoredDirectories: new Set(options.ignoredDirectories ?? DEFAULT_IGNORED_DIRECTORIES),
  };
}

function readGitIndex(workspaceRoot: string, limits: ResolvedLimits): string[] | undefined {
  const result = spawnSync("git", ["-c", "core.quotepath=false", "ls-files", "-co", "--exclude-standard", "-z"], {
    cwd: workspaceRoot,
    encoding: "utf8",
    maxBuffer: limits.maxIndexBytes,
    timeout: limits.gitTimeoutMs,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return;
  return result.stdout.split("\0").filter(Boolean);
}

function addIndexedCandidate(
  workspaceRoot: string,
  value: string,
  candidates: Map<string, WorkspaceReferenceCandidate>,
  limit: number,
): WorkspaceReferenceCandidate | undefined {
  if (candidates.size >= limit) return;
  const path = normalizeReferencePath(value);
  if (!path || path === "." || candidates.has(path)) return candidates.get(path);
  const resolution = resolveCanonicalReference(workspaceRoot, path, `@${path}`);
  if (!resolution.ok) return;
  const candidate: WorkspaceReferenceCandidate = {
    path,
    directory: resolution.reference.kind === "directory",
    ...(resolution.reference.kind === "file" ? { size: resolution.reference.size } : {}),
  };
  candidates.set(path, candidate);
  return candidate;
}

function sortCandidates(candidates: Map<string, WorkspaceReferenceCandidate>): WorkspaceReferenceCandidate[] {
  return [...candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function parentPaths(value: string): string[] {
  const parts = normalizeReferencePath(value).split("/");
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"));
}

function readDirectoryEntries(directory: string, maximum: number): Dirent[] {
  if (maximum <= 0) return [];
  let handle: ReturnType<typeof opendirSync>;
  try {
    handle = opendirSync(directory);
  } catch {
    return [];
  }
  const entries: Dirent[] = [];
  try {
    while (entries.length < maximum) {
      const entry = handle.readSync();
      if (!entry) break;
      entries.push(entry);
    }
  } finally {
    handle.closeSync();
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function parseReferenceToken(value: string): {
  path: string;
  range?: FileReferenceRange;
  malformedRange?: string;
} {
  const hash = value.lastIndexOf("#");
  if (hash === -1) return { path: value };
  const path = value.slice(0, hash);
  const suffix = value.slice(hash + 1);
  const match = /^(\d+)(?:-(\d+))?$/.exec(suffix);
  if (!match) return { path, malformedRange: suffix };
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) {
    return { path, malformedRange: suffix };
  }
  return { path, range: { start, end } };
}

function resolveCanonicalReference(
  workspaceRoot: string,
  value: string,
  display: string,
): WorkspaceReferenceResolution {
  const normalized = normalizeReferencePath(value);
  if (!normalized || /^[A-Za-z]:\//.test(normalized)) {
    return { ok: false, warning: createWarning("outside-workspace", display, `${display} is outside the workspace`) };
  }
  const requested = isAbsolute(normalized) ? resolve(normalized) : resolve(workspaceRoot, normalized);
  if (!isInsideWorkspace(workspaceRoot, requested)) {
    return { ok: false, warning: createWarning("outside-workspace", display, `${display} is outside the workspace`) };
  }

  let canonical: string;
  try {
    canonical = realpathSync(requested);
  } catch (error) {
    const code = errorCode(error);
    const warningCode = code === "EACCES" || code === "EPERM" ? "unreadable" : "not-found";
    return { ok: false, warning: createWarning(warningCode, display, `${display} could not be resolved`) };
  }
  if (!isInsideWorkspace(workspaceRoot, canonical)) {
    return { ok: false, warning: createWarning("outside-workspace", display, `${display} resolves outside the workspace`) };
  }

  try {
    const stats = statSync(canonical);
    if (!stats.isFile() && !stats.isDirectory()) {
      return { ok: false, warning: createWarning("unsupported-type", display, `${display} is not a file or directory`) };
    }
    return {
      ok: true,
      reference: {
        path: normalizeReferencePath(relative(workspaceRoot, requested)) || ".",
        absolutePath: requested,
        canonicalPath: canonical,
        kind: stats.isDirectory() ? "directory" : "file",
        size: stats.size,
      },
    };
  } catch {
    return { ok: false, warning: createWarning("unreadable", display, `${display} could not be inspected`) };
  }
}

function listDirectory(
  workspaceRoot: string,
  directory: string,
  limit: number,
  limits: ResolvedLimits,
): DirectoryListing {
  const entries: string[] = [];
  let scanned = 0;
  let truncated = false;
  let unreadable = false;

  const walk = (absoluteDirectory: string, depth: number): void => {
    if (truncated || depth > limits.maxDepth) return;
    let handle: ReturnType<typeof opendirSync>;
    try {
      handle = opendirSync(absoluteDirectory);
    } catch {
      unreadable = true;
      return;
    }
    const children: Dirent[] = [];
    try {
      while (scanned < limits.maxScannedEntries) {
        const child = handle.readSync();
        if (!child) break;
        scanned++;
        children.push(child);
      }
      if (scanned >= limits.maxScannedEntries && handle.readSync()) truncated = true;
    } finally {
      handle.closeSync();
    }

    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
      if (child.isDirectory() && limits.ignoredDirectories.has(child.name)) continue;
      const absolute = resolve(absoluteDirectory, child.name);
      let canonical: string;
      let stats: ReturnType<typeof statSync>;
      try {
        canonical = realpathSync(absolute);
        if (!isInsideWorkspace(workspaceRoot, canonical)) continue;
        stats = statSync(canonical);
      } catch {
        continue;
      }
      if (!stats.isFile() && !stats.isDirectory()) continue;
      const item = normalizeReferencePath(relative(workspaceRoot, absolute)) + (stats.isDirectory() ? "/" : "");
      entries.push(item);
      if (stats.isDirectory() && !child.isSymbolicLink()) walk(absolute, depth + 1);
    }
  };

  walk(directory, 0);
  return { entries, truncated, unreadable };
}

function fitDirectoryBlock(path: string, entries: string[], blocks: string[], maxTotalBytes: number) {
  const fitted = [...entries];
  while (true) {
    const block = formatDirectoryBlock(path, fitted);
    if (contextBytes([...blocks, block]) <= maxTotalBytes) return { block, entries: fitted };
    if (fitted.length === 0) return { block: undefined, entries: fitted };
    fitted.pop();
  }
}

function selectLineRange(
  content: string,
  range: FileReferenceRange | undefined,
): { ok: true; text: string } | { ok: false; message: string } {
  if (!range) return { ok: true, text: content };
  const lines = content.split("\n");
  if (range.start > lines.length) return { ok: false, message: `Line ${range.start} is outside the referenced file` };
  const end = Math.min(range.end, lines.length);
  return {
    ok: true,
    text: lines
      .slice(range.start - 1, end)
      .map((line, index) => `${range.start + index}: ${line}`)
      .join("\n"),
  };
}

function formatFileBlock(path: string, content: string, range?: FileReferenceRange): string {
  const lines = range ? ` lines="${range.start}-${range.end}"` : "";
  return `<workspace-file path="${escapeAttribute(path)}"${lines}>\n${content}\n</workspace-file>`;
}

function formatDirectoryBlock(path: string, entries: string[]): string {
  return `<workspace-directory path="${escapeAttribute(path)}">\n${entries.join("\n")}\n</workspace-directory>`;
}

function formatContext(blocks: string[]): string {
  return `\n\n<workspace-references>\n${blocks.join("\n")}\n</workspace-references>`;
}

function contextBytes(blocks: string[]): number {
  return blocks.length > 0 ? Buffer.byteLength(formatContext(blocks)) : 0;
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  let controlBytes = 0;
  for (const byte of buffer) {
    if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) controlBytes++;
  }
  if (controlBytes >= Math.max(1, Math.ceil(buffer.byteLength * 0.3))) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return false;
  } catch {
    return true;
  }
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizeReferencePath(value: string): string {
  const normalized = value.replace(/\\/g, "/");
  if (normalized === ".") return normalized;
  return normalized.replace(/^\.\//, "").replace(/\/{2,}/g, "/").replace(/\/$/, "");
}

function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const path = relative(workspaceRoot, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isReferenceBoundary(value: string): boolean {
  return /\s/.test(value) || value === "(" || value === "[" || value === "{" || value === '"' || value === "'" || value === "`";
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.),:;!?\]}'"`]+$/, "");
}

function displayReference(reference: string | ParsedFileReference): string {
  return typeof reference === "string" ? `@${reference}` : reference.raw;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function createWarning(
  code: WorkspaceReferenceWarningCode,
  reference: string | undefined,
  message: string,
): WorkspaceReferenceWarning {
  return { code, message, ...(reference ? { reference } : {}) };
}

function safeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return;
  return typeof error.code === "string" ? error.code : undefined;
}
