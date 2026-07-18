export interface SlashCommandCandidate {
  name: string;
  aliases?: readonly string[];
  description?: string;
  hidden?: boolean;
}

export interface FileReferenceCandidate {
  path: string;
  hidden?: boolean;
  directory?: boolean;
}

export interface RankedSuggestion<Item> {
  item: Item;
  score: number;
  matched: string;
}

export interface RankOptions {
  limit?: number;
  maximumQueryLength?: number;
  maximumCandidateLength?: number;
}

interface Match {
  score: number;
  target: string;
}

export function rankSlashCommands<Item extends SlashCommandCandidate>(
  commands: readonly Item[],
  query: string,
  options: RankOptions = {},
): RankedSuggestion<Item>[] {
  const value = query.startsWith("/") ? query.slice(1) : query;
  if (/\s/.test(value) || !safeQuery(value, options)) return [];

  return rankItems(
    commands.filter((command) => !command.hidden && validCandidate(command.name, options)),
    value,
    (command) => {
      const targets = [command.name, ...(command.aliases ?? [])]
        .map((target) => target.replace(/^\//, ""))
        .filter((target) => validCandidate(target, options));
      const direct = bestMatch(value, targets);
      const description = command.description && validCandidate(command.description, options)
        ? fuzzyMatch(value, command.description, -4_000)
        : undefined;
      return betterMatch(direct, description);
    },
    (command) => command.name,
    options,
  );
}

export function rankFileReferences<Item extends FileReferenceCandidate>(
  files: readonly Item[],
  query: string,
  options: RankOptions = {},
): RankedSuggestion<Item>[] {
  const value = stripLineRange(query.startsWith("@") ? query.slice(1) : query).replace(/\\/g, "/");
  if (!safeQuery(value, options)) return [];

  return rankItems(
    files.filter((file) => !file.hidden && validCandidate(file.path, options)),
    value,
    (file) => {
      const path = file.path.replace(/\\/g, "/");
      const basename = path.slice(path.lastIndexOf("/") + 1);
      const pathMatch = fuzzyMatch(value, path);
      const basenameMatch = fuzzyMatch(value, basename, 500);
      return betterMatch(pathMatch, basenameMatch);
    },
    (file) => file.path,
    options,
  );
}

function rankItems<Item>(
  items: readonly Item[],
  query: string,
  match: (item: Item) => Match | undefined,
  label: (item: Item) => string,
  options: RankOptions,
): RankedSuggestion<Item>[] {
  const limit = normalizeLimit(options.limit);
  return items
    .flatMap((item): RankedSuggestion<Item>[] => {
      if (!query) return [{ item, score: 0, matched: label(item) }];
      const result = match(item);
      return result ? [{ item, score: result.score, matched: result.target }] : [];
    })
    .sort((a, b) => b.score - a.score || label(a.item).localeCompare(label(b.item)))
    .slice(0, limit);
}

function bestMatch(query: string, targets: readonly string[]): Match | undefined {
  return targets.reduce<Match | undefined>((best, target) => betterMatch(best, fuzzyMatch(query, target)), undefined);
}

function betterMatch(a: Match | undefined, b: Match | undefined): Match | undefined {
  if (!a) return b;
  if (!b) return a;
  return b.score > a.score ? b : a;
}

function fuzzyMatch(query: string, target: string, bonus = 0): Match | undefined {
  const needle = query.toLowerCase();
  const haystack = target.toLowerCase();
  if (!needle) return { score: bonus, target };
  if (needle === haystack) return { score: 10_000 + bonus, target };
  if (haystack.startsWith(needle)) return { score: 8_000 - haystack.length + bonus, target };

  const contiguous = haystack.indexOf(needle);
  if (contiguous !== -1) return { score: 6_000 - contiguous * 10 - haystack.length + bonus, target };

  let score = 2_000 + bonus;
  let queryIndex = 0;
  let previous = -1;
  for (let index = 0; index < haystack.length && queryIndex < needle.length; index++) {
    if (haystack[index] !== needle[queryIndex]) continue;
    if (index === 0 || isBoundary(haystack[index - 1]!)) score += 120;
    if (previous !== -1) score -= Math.max(0, index - previous - 1) * 12;
    previous = index;
    queryIndex++;
  }
  if (queryIndex !== needle.length) return;
  return { score: score - haystack.length, target };
}

function stripLineRange(query: string): string {
  const hash = query.lastIndexOf("#");
  if (hash === -1) return query;
  return /^\d+(?:-\d*)?$/.test(query.slice(hash + 1)) ? query.slice(0, hash) : query;
}

function isBoundary(value: string): boolean {
  return value === "/" || value === "\\" || value === "-" || value === "_" || value === "." || value === " ";
}

function safeQuery(query: string, options: RankOptions): boolean {
  const maximum = normalizeMaximum(options.maximumQueryLength, 256);
  return query.length <= maximum && !query.includes("\0");
}

function validCandidate(candidate: string, options: RankOptions): boolean {
  const maximum = normalizeMaximum(options.maximumCandidateLength, 4_096);
  return candidate.length > 0 && candidate.length <= maximum && !candidate.includes("\0");
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 10;
  return Math.max(0, Math.trunc(limit));
}

function normalizeMaximum(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.trunc(value));
}
