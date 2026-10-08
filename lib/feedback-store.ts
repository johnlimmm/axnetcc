import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { FeedbackRecord, FeedbackStore } from "./feedback.ts";

// Node deployments use one durable file per receipt; exclusive create makes retries idempotent.
export function fileFeedbackStore(directory = resolve(process.env.FEEDBACK_DIRECTORY ?? ".local-feedback")): FeedbackStore {
  return {
    async save(record) {
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `${record.id}-${crypto.randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx");
        try { await file.writeFile(JSON.stringify(record)); await file.sync(); }
        finally { await file.close(); }
        // Publish only a fully written file, atomically and without replacing an existing receipt.
        await link(temporary, join(directory, `${record.id}.json`));
        return { created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return { created: false };
        throw error;
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
    async list() {
      const { readdir } = await import("node:fs/promises");
      let names: string[];
      try { names = await readdir(directory); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
      return Promise.all(names.filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name)).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8")) as FeedbackRecord));
    },
  };
}

export interface FeedbackDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): ReturnType<FeedbackDatabase["prepare"]>;
    run(): Promise<{ meta?: { changes?: number } }>;
    all<T>(): Promise<{ results: T[] }>;
  };
}

export function databaseFeedbackStore(db: FeedbackDatabase): FeedbackStore {
  const ready = () => db.prepare("CREATE TABLE IF NOT EXISTS user_feedback (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)").run();
  return {
    async save(record) {
      await ready();
      const result = await db.prepare("INSERT OR IGNORE INTO user_feedback (id, created_at, payload) VALUES (?, ?, ?)")
        .bind(record.id, record.createdAt, JSON.stringify(record)).run();
      return { created: result.meta?.changes !== 0 };
    },
    async list() {
      await ready();
      const rows = await db.prepare("SELECT payload FROM user_feedback ORDER BY created_at DESC").all<{ payload: string }>();
      return rows.results.map((row) => JSON.parse(row.payload) as FeedbackRecord);
    },
  };
}
