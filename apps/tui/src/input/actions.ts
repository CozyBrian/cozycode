import {
  formatKeyChord,
  isKeyChordPrefix,
  keyChordMatches,
  normalizeKeyInput,
  parseKeyChord,
  parseKeyChordList,
  type KeyChord,
  type KeyInput,
  type KeyStroke,
} from "./keys.ts";

export type ActionOutcome = void | boolean | "fallthrough";

export interface ActionMatch {
  action: string;
  chord?: KeyChord;
  key?: KeyInput | string;
}

export interface ActionDefinition<Context> {
  name: string;
  title?: string;
  scope?: string;
  priority?: number;
  bindings?: ActionBindingConfig;
  fallthrough?: boolean;
  enabled?: (context: Context) => boolean;
  run: (context: Context, match: ActionMatch) => ActionOutcome;
}

export interface ActionBinding {
  key: string | KeyChord;
  preventDefault?: boolean;
  fallthrough?: boolean;
}

export type ActionBindingConfig = false | "none" | string | ActionBinding | readonly (string | ActionBinding)[];

export interface InputScope {
  name: string;
  modal?: boolean;
}

export interface ActionDispatchOptions<Context> {
  context: Context;
  /** Ordered from outermost to most specific. The last active scope wins. */
  scopes?: readonly (string | InputScope)[];
  now?: number;
}

export type ActionDispatchStatus = "handled" | "pending" | "fallthrough" | "unmatched";

export interface ActionDispatchResult {
  status: ActionDispatchStatus;
  actions: readonly string[];
  preventDefault: boolean;
  pendingChord?: string;
}

export interface ActionRegistryOptions {
  leader?: string;
  leaderTimeoutMs?: number;
  baseScope?: string;
  globalScope?: string;
  now?: () => number;
}

interface CompiledBinding {
  chord: KeyChord;
  preventDefault: boolean;
  fallthrough: boolean;
}

interface RegisteredAction<Context> extends ActionDefinition<Context> {
  order: number;
  compiled: CompiledBinding[];
}

interface Candidate<Context> {
  action: RegisteredAction<Context>;
  binding: CompiledBinding;
  scopeRank: number;
}

interface PendingSequence {
  chord: KeyStroke[];
  startedAt: number;
}

export class ActionRegistry<Context = void> {
  readonly leader: string;
  readonly leaderTimeoutMs: number;

  private readonly baseScope: string;
  private readonly globalScope: string;
  private readonly now: () => number;
  private readonly actions = new Map<string, RegisteredAction<Context>>();
  private readonly listeners = new Set<() => void>();
  private pending?: PendingSequence;
  private order = 0;
  private revision = 0;

  constructor(options: ActionRegistryOptions = {}) {
    this.leader = options.leader ?? "ctrl+x";
    this.leaderTimeoutMs = options.leaderTimeoutMs ?? 2_000;
    if (!Number.isFinite(this.leaderTimeoutMs) || this.leaderTimeoutMs < 0) {
      throw new Error("leaderTimeoutMs must be a finite non-negative number");
    }
    parseKeyChord(this.leader);
    this.baseScope = options.baseScope ?? "base";
    this.globalScope = options.globalScope ?? "global";
    this.now = options.now ?? Date.now;
  }

  getSnapshot = (): number => this.revision;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  register(action: ActionDefinition<Context>): () => void {
    if (!action.name.trim()) throw new Error("Action name cannot be empty");
    if (this.actions.has(action.name)) throw new Error(`Action "${action.name}" is already registered`);

    const registered: RegisteredAction<Context> = {
      ...action,
      order: this.order++,
      compiled: compileBindings(action.bindings, this.leader),
    };
    this.actions.set(action.name, registered);
    this.changed();

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (!this.actions.delete(action.name)) return;
      this.changed();
    };
  }

  configure(name: string, bindings: ActionBindingConfig): void {
    const action = this.actions.get(name);
    if (!action) throw new Error(`Unknown action "${name}"`);
    action.bindings = bindings;
    action.compiled = compileBindings(bindings, this.leader);
    this.clearPending();
    this.changed();
  }

  list(): readonly Readonly<ActionDefinition<Context>>[] {
    return [...this.actions.values()].map(({ order: _order, compiled: _compiled, ...action }) => action);
  }

  bindings(name: string): readonly string[] {
    return this.actions.get(name)?.compiled.map((binding) => formatKeyChord(binding.chord)) ?? [];
  }

  isPending(): boolean {
    return this.pending !== undefined;
  }

  expire(now = this.now()): boolean {
    if (!this.pending || now - this.pending.startedAt < this.leaderTimeoutMs) return false;
    this.clearPending();
    this.changed();
    return true;
  }

  cancelPending(): boolean {
    if (!this.pending) return false;
    this.clearPending();
    this.changed();
    return true;
  }

  dispatch(input: KeyInput | string, options: ActionDispatchOptions<Context>): ActionDispatchResult {
    const now = options.now ?? this.now();
    this.expire(now);
    const stroke = normalizeKeyInput(input);

    if (this.pending && stroke.name === "escape" && !stroke.ctrl && !stroke.meta && !stroke.super && !stroke.hyper) {
      this.clearPending();
      this.changed();
      return { status: "handled", actions: [], preventDefault: true };
    }

    const candidates = this.candidates(options.context, options.scopes);
    if (this.pending) {
      const sequence = [...this.pending.chord, stroke];
      const result = this.resolveSequence(sequence, candidates, input, options.context, now);
      if (result) return result;
      this.clearPending();
    }

    return (
      this.resolveSequence([stroke], candidates, input, options.context, now) ?? {
        status: "unmatched",
        actions: [],
        preventDefault: false,
      }
    );
  }

  dispatchAction(name: string, context: Context): ActionDispatchResult {
    const action = this.actions.get(name);
    if (!action || action.enabled?.(context) === false) {
      return { status: "unmatched", actions: [], preventDefault: false };
    }
    const outcome = action.run(context, { action: name });
    const fallthrough = action.fallthrough || outcome === false || outcome === "fallthrough";
    return {
      status: fallthrough ? "fallthrough" : "handled",
      actions: [name],
      preventDefault: !fallthrough,
    };
  }

  private resolveSequence(
    sequence: KeyStroke[],
    candidates: Candidate<Context>[],
    input: KeyInput | string,
    context: Context,
    now: number,
  ): ActionDispatchResult | undefined {
    const matching = candidates.filter((candidate) => isKeyChordPrefix(sequence, candidate.binding.chord));
    if (matching.length === 0) return;

    if (matching.some((candidate) => candidate.binding.chord.length > sequence.length)) {
      const startedAt = this.pending?.startedAt ?? now;
      this.pending = { chord: sequence, startedAt };
      this.changed();
      return {
        status: "pending",
        actions: [],
        preventDefault: true,
        pendingChord: formatKeyChord(sequence),
      };
    }

    const exact = matching.filter((candidate) => keyChordMatches(candidate.binding.chord, sequence));
    if (exact.length === 0) return;
    this.clearPending();

    const invoked: string[] = [];
    let preventDefault = false;
    for (const candidate of exact) {
      const outcome = candidate.action.run(context, {
        action: candidate.action.name,
        chord: candidate.binding.chord,
        key: input,
      });
      invoked.push(candidate.action.name);
      preventDefault ||= candidate.binding.preventDefault;
      const fallthrough =
        candidate.binding.fallthrough ||
        candidate.action.fallthrough === true ||
        outcome === false ||
        outcome === "fallthrough";
      if (!fallthrough) {
        this.changed();
        return { status: "handled", actions: invoked, preventDefault };
      }
    }

    this.changed();
    return { status: "fallthrough", actions: invoked, preventDefault };
  }

  private candidates(context: Context, scopes?: readonly (string | InputScope)[]): Candidate<Context>[] {
    const ranks = activeScopeRanks(scopes, this.baseScope);
    return [...this.actions.values()]
      .flatMap((action): Candidate<Context>[] => {
        if (action.enabled?.(context) === false) return [];
        const scope = action.scope ?? this.baseScope;
        const scopeRank = scope === this.globalScope ? -1 : ranks.get(scope);
        if (scopeRank === undefined) return [];
        return action.compiled.map((binding) => ({ action, binding, scopeRank }));
      })
      .sort(
        (a, b) =>
          b.scopeRank - a.scopeRank ||
          (b.action.priority ?? 0) - (a.action.priority ?? 0) ||
          b.action.order - a.action.order,
      );
  }

  private clearPending(): void {
    this.pending = undefined;
  }

  private changed(): void {
    this.revision++;
    for (const listener of this.listeners) listener();
  }
}

export function createActionRegistry<Context = void>(
  actions: readonly ActionDefinition<Context>[] = [],
  options: ActionRegistryOptions = {},
): ActionRegistry<Context> {
  const registry = new ActionRegistry<Context>(options);
  for (const action of actions) registry.register(action);
  return registry;
}

function compileBindings(input: ActionBindingConfig | undefined, leader: string): CompiledBinding[] {
  if (input === undefined || input === false || input === "none") return [];
  const items = Array.isArray(input) ? input : [input];
  return items.flatMap((item): CompiledBinding[] => {
    if (typeof item === "string") {
      return parseKeyChordList(item, { leader }).map((chord) => ({
        chord,
        preventDefault: true,
        fallthrough: false,
      }));
    }
    const chords = typeof item.key === "string" ? parseKeyChordList(item.key, { leader }) : [item.key];
    return chords.map((chord) => ({
      chord,
      preventDefault: item.preventDefault !== false,
      fallthrough: item.fallthrough === true,
    }));
  });
}

function activeScopeRanks(scopes: readonly (string | InputScope)[] | undefined, baseScope: string): Map<string, number> {
  const normalized = (scopes?.length ? scopes : [baseScope]).map((scope) =>
    typeof scope === "string" ? { name: scope, modal: false } : scope,
  );
  let start = 0;
  for (let index = 0; index < normalized.length; index++) {
    if (normalized[index]?.modal) start = index;
  }

  return new Map(normalized.slice(start).map((scope, index) => [scope.name, index]));
}
