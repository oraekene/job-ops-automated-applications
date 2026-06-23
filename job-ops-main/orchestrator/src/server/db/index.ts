/**
 * Database connection and initialization.
 *
 * The underlying `better-sqlite3` connection is cached on `globalThis` so
 * that `vi.resetModules()` re-evaluations in tests reuse the existing
 * connection instead of opening a second one to the same file. The cache
 * also tracks the resolved database path so that calls to `getDb()` with
 * a different `DATA_DIR` (e.g. after a test assigns a new temp dir) open
 * a fresh connection rather than reusing a stale one bound to the
 * previous path.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import {
  type BetterSQLite3Database,
  drizzle,
} from "drizzle-orm/better-sqlite3";
import { getDataDir } from "../config/dataDir";
import * as schema from "./schema";

type CachedDb = { sqlite: Database.Database; path: string };

const globalForDb = globalThis as unknown as {
  __jobopsDb?: CachedDb;
};

function ensureDataDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function openSqlite(): Database.Database {
  const dbPath = join(getDataDir(), "jobs.db");
  ensureDataDir(dbPath);
  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  return sqlite;
}

function currentDbPath(): string {
  return join(getDataDir(), "jobs.db");
}

/**
 * Returns the singleton `better-sqlite3` connection, creating it on first
 * access. The instance is stored on `globalThis` so it survives module
 * re-evaluation (e.g. `vi.resetModules()` in tests), but is invalidated
 * and recreated if the resolved `DATA_DIR` changes between calls.
 */
export function getDb(): Database.Database {
  const path = currentDbPath();
  if (globalForDb.__jobopsDb && globalForDb.__jobopsDb.path !== path) {
    globalForDb.__jobopsDb.sqlite.close();
    globalForDb.__jobopsDb = undefined;
  }
  if (!globalForDb.__jobopsDb) {
    globalForDb.__jobopsDb = { sqlite: openSqlite(), path };
  }
  return globalForDb.__jobopsDb.sqlite;
}

export const db: BetterSQLite3Database<typeof schema> = drizzle(getDb(), {
  schema,
});

export { schema };

export function closeDb(): void {
  const cached = globalForDb.__jobopsDb;
  if (!cached) return;
  cached.sqlite.close();
  globalForDb.__jobopsDb = undefined;
}
