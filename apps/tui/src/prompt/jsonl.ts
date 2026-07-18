import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readJSONLFile(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

export function writeJSONLFile(filePath: string, entries: readonly unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const text = entries.length > 0 ? `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n` : "";
    writeFileSync(temporary, text, "utf8");
    renameSync(temporary, filePath);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // A successful rename removes the temporary path.
    }
  }
}
