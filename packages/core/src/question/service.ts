import type { QuestionRequest, QuestionSpec, SessionEvent } from "@cozycode/protocol";

/** The user declined to answer (cancelled the prompt, or the turn was aborted). */
export class QuestionRejectedError extends Error {
  constructor(readonly feedback?: string) {
    super(
      feedback
        ? `The user declined to answer and left this note: ${feedback}`
        : "The user declined to answer the question.",
    );
    this.name = "QuestionRejectedError";
  }
}

export interface AskQuestionInput {
  questions: QuestionSpec[];
  tool?: { callId: string; toolName: string };
}

interface PendingEntry {
  info: QuestionRequest;
  resolve: (answers: string[][]) => void;
  reject: (err: Error) => void;
}

/**
 * The interactive-question boundary for one session. A parallel to
 * `PermissionService`, minus the ruleset: `ask()` always parks a request
 * (emitting `question-asked`) until a frontend answers or rejects it. Mirrors
 * the same suspend/resume + emit pattern so both frontends can reuse their
 * permission-queue plumbing.
 */
export class QuestionService {
  private readonly pending = new Map<string, PendingEntry>();
  private counter = 0;

  constructor(
    private readonly sessionId: string,
    private readonly emit: (event: SessionEvent) => void,
  ) {}

  listPending(): QuestionRequest[] {
    return Array.from(this.pending.values(), (entry) => entry.info);
  }

  ask(input: AskQuestionInput): Promise<string[][]> {
    const id = `qst_${++this.counter}`;
    const info: QuestionRequest = {
      id,
      sessionId: this.sessionId,
      questions: input.questions,
      tool: input.tool,
    };
    return new Promise<string[][]>((resolve, reject) => {
      this.pending.set(id, { info, resolve, reject });
      this.emit({ type: "question-asked", request: info });
    }).finally(() => this.pending.delete(id));
  }

  answer(requestId: string, answers: string[][]): void {
    const existing = this.pending.get(requestId);
    if (!existing) return; // unknown / already-resolved id → no-op
    this.pending.delete(requestId);
    this.emit({ type: "question-answered", requestId, answers });
    existing.resolve(answers);
  }

  reject(requestId: string, message?: string): void {
    const existing = this.pending.get(requestId);
    if (!existing) return;
    this.pending.delete(requestId);
    this.emit({ type: "question-rejected", requestId });
    existing.reject(new QuestionRejectedError(message));
  }

  /** Reject every pending question. Called on session teardown/abort. */
  rejectAll(): void {
    for (const [id, item] of this.pending) {
      this.pending.delete(id);
      this.emit({ type: "question-rejected", requestId: id });
      item.reject(new QuestionRejectedError());
    }
  }
}
