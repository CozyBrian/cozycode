import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BunSQLiteSessionArchive,
  type BunSQLiteSessionArchiveOptions,
} from "./bun-sqlite-session-archive.ts";

export interface TemporarySessionArchive {
  archive: BunSQLiteSessionArchive;
  directory: string;
  filename: string;
  cleanup(): void;
}

type TemporaryOptions = Omit<BunSQLiteSessionArchiveOptions, "filename"> & {
  parentDirectory?: string;
};

/** Creates an isolated file-backed archive and removes it on cleanup. */
export function createTemporarySessionArchive(options: TemporaryOptions = {}): TemporarySessionArchive {
  const { parentDirectory = tmpdir(), ...archiveOptions } = options;
  const directory = mkdtempSync(join(parentDirectory, "cozycode-sessions-"));
  const filename = join(directory, "sessions.sqlite");
  let archive: BunSQLiteSessionArchive;
  try {
    archive = new BunSQLiteSessionArchive({ ...archiveOptions, filename });
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  let cleaned = false;
  return {
    archive,
    directory,
    filename,
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      try {
        archive.close();
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
