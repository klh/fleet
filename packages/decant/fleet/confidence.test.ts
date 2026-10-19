// fleet/confidence.test.ts — ingest-time confidence stamps (W950 addendum).

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ensureConfidenceTable, INGEST_STAMP, latestStamp, validateStamp } from "./confidence.ts";

function stubDb(): Database {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE session (id INTEGER PRIMARY KEY, tool TEXT NOT NULL)");
  ensureConfidenceTable(db);
  return db;
}

test("every session insert is stamped at ingest, same transaction", () => {
  const db = stubDb();
  db.query("INSERT INTO session (id, tool) VALUES (1, ?)").run("claude_code");
  const s = latestStamp(db, "session", 1);
  expect(s?.value).toBe(INGEST_STAMP.value);
  expect(s?.setter).toBe(INGEST_STAMP.setter);
  expect(s?.verdict).toBe(INGEST_STAMP.verdict);
  expect(s?.evidence).toBe("ingest:claude_code");
});

test("stamps are append-only history with per-source evidence", () => {
  const db = stubDb();
  db.query("INSERT INTO session (id, tool) VALUES (1, ?)").run("codex");
  db.query("INSERT INTO session (id, tool) VALUES (2, ?)").run("gemini");
  const n = db.query("SELECT COUNT(*) AS n FROM confidence_stamp").get() as {
    n: number;
  };
  expect(n.n).toBe(2);
  expect(latestStamp(db, "session", 2)?.evidence).toBe("ingest:gemini");
});

test("ensureConfidenceTable is idempotent; unknown ids read as null", () => {
  const db = stubDb();
  ensureConfidenceTable(db);
  ensureConfidenceTable(db);
  expect(latestStamp(db, "session", 999)).toBeNull();
});

test("validateStamp enforces the W953/W955 verdict/ref rules", () => {
  expect(validateStamp({ verdict: "fresh" })).toBeNull();
  expect(validateStamp({ verdict: "retracted" })).toBeNull();
  expect(validateStamp({ verdict: "bogus" })).toContain("bad verdict");
  expect(validateStamp({ verdict: "superseded", ref: null })).toContain("requires ref");
  expect(validateStamp({ verdict: "contradicted", ref: "r-1" })).toBeNull();
});
