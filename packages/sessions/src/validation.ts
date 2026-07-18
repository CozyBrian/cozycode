import {
  SessionArchiveError,
  type AgentMode,
  type JsonObject,
  type JsonValue,
  type ModelHistory,
  type ModelRef,
  type RollbackCheckpoint,
  type SessionEvent,
} from "./types.ts";

type UnknownRecord = Record<string, unknown>;

export function assertID(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (value.length > 512) invalid(`${label} must be at most 512 characters`);
}

export function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${label} must be a non-empty string`);
}

export function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") invalid(`${label} must be a string`);
}

export function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    invalid(`${label} must be a non-negative safe integer`);
  }
}

export function assertNonNegativeInteger(value: unknown, label: string): asserts value is number {
  assertTimestamp(value, label);
}

export function assertMode(value: unknown, label = "mode"): asserts value is AgentMode {
  if (value !== "build" && value !== "plan") invalid(`${label} must be "build" or "plan"`);
}

export function assertModelRef(value: unknown, label = "model"): asserts value is ModelRef {
  const model = record(value, label);
  exactKeys(model, ["providerID", "modelID"], label);
  assertNonEmptyString(model.providerID, `${label}.providerID`);
  assertNonEmptyString(model.modelID, `${label}.modelID`);
}

export function encodeJson(value: unknown, label: string): string {
  assertJsonValue(value, label);
  try {
    return JSON.stringify(value);
  } catch (cause) {
    throw new SessionArchiveError("INVALID", `${label} cannot be encoded as JSON`, { cause });
  }
}

export function parseJson(text: string, label: string): JsonValue {
  try {
    const value: unknown = JSON.parse(text);
    assertJsonValue(value, label, "CORRUPT");
    return value;
  } catch (cause) {
    if (cause instanceof SessionArchiveError) throw cause;
    throw new SessionArchiveError("CORRUPT", `Stored ${label} is not valid JSON`, { cause });
  }
}

export function assertJsonValue(
  value: unknown,
  label: string,
  code: "INVALID" | "CORRUPT" = "INVALID",
  seen = new Set<object>(),
  depth = 0,
): asserts value is JsonValue {
  const fail = (message: string): never => {
    throw new SessionArchiveError(code, message);
  };
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object" || value === null) {
    throw new SessionArchiveError(code, `${label} contains a non-JSON value`);
  }
  if (depth > 100) fail(`${label} is nested too deeply`);
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`, code, seen, depth + 1));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(`${label} contains a non-plain object`);
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${label}.${key}`, code, seen, depth + 1);
    }
  }
  seen.delete(value);
}

export function assertModelHistory(value: unknown, label = "model history"): asserts value is ModelHistory {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  value.forEach((entry, index) => {
    const message = record(entry, `${label}[${index}]`);
    if (!["system", "user", "assistant", "tool"].includes(String(message.role))) {
      invalid(`${label}[${index}].role is invalid`);
    }
    if (!Object.hasOwn(message, "content")) invalid(`${label}[${index}].content is required`);
    assertJsonValue(message, `${label}[${index}]`);
  });
}

export function parseModelHistory(text: string, label = "model history"): ModelHistory {
  const value = parseJson(text, label);
  try {
    assertModelHistory(value, label);
  } catch (cause) {
    if (cause instanceof SessionArchiveError) {
      throw new SessionArchiveError("CORRUPT", cause.message, { cause });
    }
    throw cause;
  }
  return value;
}

export function assertRollbackCheckpoint(value: unknown, label = "rollback checkpoint"): asserts value is RollbackCheckpoint {
  const checkpoint = record(value, label);
  exactKeys(checkpoint, ["history", "data"], label);
  assertModelHistory(checkpoint.history, `${label}.history`);
  assertJsonValue(checkpoint.data, `${label}.data`);
}

export function parseRollbackCheckpoint(text: string): RollbackCheckpoint {
  const value = parseJson(text, "rollback checkpoint");
  try {
    assertRollbackCheckpoint(value);
  } catch (cause) {
    if (cause instanceof SessionArchiveError) {
      throw new SessionArchiveError("CORRUPT", cause.message, { cause });
    }
    throw cause;
  }
  return value;
}

export function assertSessionEvent(value: unknown, label = "session event"): asserts value is SessionEvent {
  validateSessionEvent(value, label, 0);
  assertJsonValue(value, label);
}

export function parseSessionEvent(text: string): SessionEvent {
  const value = parseJson(text, "session event");
  try {
    validateSessionEvent(value, "session event", 0);
  } catch (cause) {
    if (cause instanceof SessionArchiveError) {
      throw new SessionArchiveError("CORRUPT", cause.message, { cause });
    }
    throw cause;
  }
  return value;
}

function validateSessionEvent(value: unknown, label: string, depth: number): asserts value is SessionEvent {
  if (depth > 16) invalid(`${label} is nested too deeply`);
  const event = record(value, label);
  assertString(event.type, `${label}.type`);
  switch (event.type) {
    case "session-start":
      exactKeys(event, ["type", "sessionId"], label);
      assertNonEmptyString(event.sessionId, `${label}.sessionId`);
      return;
    case "title-change":
      exactKeys(event, ["type", "title"], label);
      assertNonEmptyString(event.title, `${label}.title`);
      return;
    case "text-delta":
      exactKeys(event, ["type", "text"], label);
      assertString(event.text, `${label}.text`);
      return;
    case "tool-call-start":
      exactKeys(event, ["type", "toolCallId", "toolName", "args"], label);
      assertNonEmptyString(event.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(event.toolName, `${label}.toolName`);
      assertJsonValue(event.args, `${label}.args`);
      return;
    case "tool-result":
      exactKeys(event, ["type", "toolCallId", "toolName", "result", "isError", "metadata"], label);
      assertNonEmptyString(event.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(event.toolName, `${label}.toolName`);
      assertBoolean(event.isError, `${label}.isError`);
      assertJsonValue(event.result, `${label}.result`);
      if (event.metadata !== undefined) {
        record(event.metadata, `${label}.metadata`);
        assertJsonValue(event.metadata, `${label}.metadata`);
      }
      return;
    case "step-finish":
      exactKeys(event, ["type", "stepNumber"], label);
      assertNonNegativeInteger(event.stepNumber, `${label}.stepNumber`);
      return;
    case "error":
      exactKeys(event, ["type", "message"], label);
      assertNonEmptyString(event.message, `${label}.message`);
      return;
    case "mode-change":
      exactKeys(event, ["type", "mode"], label);
      assertMode(event.mode, `${label}.mode`);
      return;
    case "effort-change":
      exactKeys(event, ["type", "effort"], label);
      if (event.effort !== undefined) assertNonEmptyString(event.effort, `${label}.effort`);
      return;
    case "reasoning-start":
      exactKeys(event, ["type", "id"], label);
      assertNonEmptyString(event.id, `${label}.id`);
      return;
    case "reasoning-delta":
      exactKeys(event, ["type", "id", "text"], label);
      assertNonEmptyString(event.id, `${label}.id`);
      assertString(event.text, `${label}.text`);
      return;
    case "reasoning-end":
      exactKeys(event, ["type", "id", "durationMs"], label);
      assertNonEmptyString(event.id, `${label}.id`);
      if (event.durationMs !== undefined) assertNonNegativeInteger(event.durationMs, `${label}.durationMs`);
      return;
    case "permission-asked":
      exactKeys(event, ["type", "request"], label);
      validatePermissionRequest(event.request, `${label}.request`);
      return;
    case "permission-replied":
      exactKeys(event, ["type", "requestId", "reply"], label);
      assertNonEmptyString(event.requestId, `${label}.requestId`);
      if (!["once", "always", "reject"].includes(String(event.reply))) invalid(`${label}.reply is invalid`);
      return;
    case "question-asked":
      exactKeys(event, ["type", "request"], label);
      validateQuestionRequest(event.request, `${label}.request`);
      return;
    case "question-answered":
      exactKeys(event, ["type", "requestId", "answers"], label);
      assertNonEmptyString(event.requestId, `${label}.requestId`);
      stringMatrix(event.answers, `${label}.answers`);
      return;
    case "question-rejected":
      exactKeys(event, ["type", "requestId"], label);
      assertNonEmptyString(event.requestId, `${label}.requestId`);
      return;
    case "subagent-start":
      exactKeys(event, ["type", "toolCallId", "sessionId", "agent", "description"], label);
      assertNonEmptyString(event.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(event.sessionId, `${label}.sessionId`);
      assertNonEmptyString(event.agent, `${label}.agent`);
      assertNonEmptyString(event.description, `${label}.description`);
      return;
    case "subagent-event":
      exactKeys(event, ["type", "toolCallId", "sessionId", "event"], label);
      assertNonEmptyString(event.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(event.sessionId, `${label}.sessionId`);
      validateSessionEvent(event.event, `${label}.event`, depth + 1);
      return;
    case "subagent-finish":
      exactKeys(event, ["type", "toolCallId", "sessionId", "result", "isError"], label);
      assertNonEmptyString(event.toolCallId, `${label}.toolCallId`);
      assertNonEmptyString(event.sessionId, `${label}.sessionId`);
      assertString(event.result, `${label}.result`);
      if (event.isError !== undefined) assertBoolean(event.isError, `${label}.isError`);
      return;
    case "session-settled":
      exactKeys(event, ["type"], label);
      return;
    case "finish":
      exactKeys(event, ["type", "reason", "usage"], label);
      assertNonEmptyString(event.reason, `${label}.reason`);
      if (event.usage !== undefined) validateUsage(event.usage, `${label}.usage`);
      return;
    default:
      invalid(`${label}.type is unsupported`);
  }
}

function validatePermissionRequest(value: unknown, label: string): void {
  const request = record(value, label);
  exactKeys(request, ["id", "sessionId", "permission", "patterns", "metadata", "always", "tool"], label);
  assertNonEmptyString(request.id, `${label}.id`);
  assertNonEmptyString(request.sessionId, `${label}.sessionId`);
  assertNonEmptyString(request.permission, `${label}.permission`);
  stringArray(request.patterns, `${label}.patterns`);
  record(request.metadata, `${label}.metadata`);
  assertJsonValue(request.metadata, `${label}.metadata`);
  stringArray(request.always, `${label}.always`);
  if (request.tool !== undefined) validateTool(request.tool, `${label}.tool`);
}

function validateQuestionRequest(value: unknown, label: string): void {
  const request = record(value, label);
  exactKeys(request, ["id", "sessionId", "questions", "tool"], label);
  assertNonEmptyString(request.id, `${label}.id`);
  assertNonEmptyString(request.sessionId, `${label}.sessionId`);
  if (!Array.isArray(request.questions) || request.questions.length === 0) invalid(`${label}.questions must not be empty`);
  request.questions.forEach((value, index) => {
    const question = record(value, `${label}.questions[${index}]`);
    exactKeys(question, ["question", "header", "options", "multiple"], `${label}.questions[${index}]`);
    assertNonEmptyString(question.question, `${label}.questions[${index}].question`);
    assertNonEmptyString(question.header, `${label}.questions[${index}].header`);
    if (!Array.isArray(question.options)) invalid(`${label}.questions[${index}].options must be an array`);
    question.options.forEach((value, optionIndex) => {
      const option = record(value, `${label}.questions[${index}].options[${optionIndex}]`);
      exactKeys(option, ["label", "description"], `${label}.questions[${index}].options[${optionIndex}]`);
      assertNonEmptyString(option.label, `${label}.questions[${index}].options[${optionIndex}].label`);
      if (option.description !== undefined) assertString(option.description, `${label}.questions[${index}].options[${optionIndex}].description`);
    });
    if (question.multiple !== undefined) assertBoolean(question.multiple, `${label}.questions[${index}].multiple`);
  });
  if (request.tool !== undefined) validateTool(request.tool, `${label}.tool`);
}

function validateTool(value: unknown, label: string): void {
  const tool = record(value, label);
  exactKeys(tool, ["callId", "toolName"], label);
  assertNonEmptyString(tool.callId, `${label}.callId`);
  assertNonEmptyString(tool.toolName, `${label}.toolName`);
}

function validateUsage(value: unknown, label: string): void {
  const usage = record(value, label);
  exactKeys(usage, ["inputTokens", "outputTokens", "totalTokens"], label);
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (usage[key] !== undefined) assertNonNegativeInteger(usage[key], `${label}.${key}`);
  }
}

function stringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  value.forEach((item, index) => assertString(item, `${label}[${index}]`));
}

function stringMatrix(value: unknown, label: string): asserts value is string[][] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`);
  value.forEach((row, index) => stringArray(row, `${label}[${index}]`));
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean`);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) invalid(`${label}.${key} is not supported`);
  }
}

function invalid(message: string): never {
  throw new SessionArchiveError("INVALID", message);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(encodeJson(value, "JSON value")) as T;
}

export function jsonObject(value: JsonObject): JsonObject {
  return value;
}
