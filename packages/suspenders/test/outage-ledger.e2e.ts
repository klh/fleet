// outage-ledger.test.ts — W576.3: audited fail-open at enforcement
// boundaries. recordOutage dedupes per (op, phase, reasonCode) inside the
// window, never throws (even a failed audit keeps the boundary open), and
// classifyOutage bounds reasonCodes for audit readers.
import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	classifyOutage,
	lastOutage,
	recordOutage,
} from "../hooks/lib/outage-ledger.ts";

const LEDGER = join(
	mkdtempSync(join(tmpdir(), "outage-ledger-")),
	"outage.jsonl",
);
const envBefore = process.env.SUSPENDERS_OUTAGE_LEDGER;

test.afterAll(() => {
	if (envBefore === undefined) delete process.env.SUSPENDERS_OUTAGE_LEDGER;
	else process.env.SUSPENDERS_OUTAGE_LEDGER = envBefore;
	rmSync(join(LEDGER, ".."), { recursive: true, force: true });
});

test("records one structured event per outage and exposes it via lastOutage", () => {
	process.env.SUSPENDERS_OUTAGE_LEDGER = LEDGER;
	mkdirSync(join(LEDGER, ".."), { recursive: true });
	expect(
		recordOutage(
			{
				op: "governor.edit",
				phase: "db-open",
				reasonCode: "store-unavailable",
				path: "/some/file.ts",
			},
			1000,
		),
	).toBe(true);
	const last = lastOutage();
	expect(last).toEqual({
		at: 1000,
		op: "governor.edit",
		phase: "db-open",
		reasonCode: "store-unavailable",
		path: "/some/file.ts",
	});
});

test("dedupes the same (op, phase, reasonCode) inside the window, not across reasonCodes", () => {
	expect(
		recordOutage(
			{
				op: "governor.edit",
				phase: "db-open",
				reasonCode: "store-unavailable",
			},
			1000 + 29_999,
		),
	).toBe(false);
	expect(
		recordOutage(
			{ op: "governor.edit", phase: "db-open", reasonCode: "fs-denied" },
			1000 + 29_999,
		),
	).toBe(true);
	// outside the window the same class records again — recurrence stays visible
	expect(
		recordOutage(
			{
				op: "governor.edit",
				phase: "db-open",
				reasonCode: "store-unavailable",
			},
			1000 + 30_001,
		),
	).toBe(true);
});

test("never throws — a failed audit write reports false and leaves the boundary open", () => {
	// ledger path under a REGULAR FILE → mkdirSync(dirname) must fail
	const base = mkdtempSync(join(tmpdir(), "outage-ledger-dead-"));
	writeFileSync(join(base, "blocker"), "");
	process.env.SUSPENDERS_OUTAGE_LEDGER = join(base, "blocker", "outage.jsonl");
	expect(
		recordOutage(
			{
				op: "governor.edit",
				phase: "db-open",
				reasonCode: "store-unavailable",
			},
			5000,
		),
	).toBe(false);
	rmSync(base, { recursive: true, force: true });
	process.env.SUSPENDERS_OUTAGE_LEDGER = LEDGER;
});

test("classifyOutage bounds raw error text to a stable class", () => {
	expect(classifyOutage(new Error("SQLite file is not a database"))).toBe(
		"store-unavailable",
	);
	expect(
		classifyOutage(new Error("EACCES: permission denied, open '/x'")),
	).toBe("fs-denied");
	expect(classifyOutage(new Error("user_version migration failed"))).toBe(
		"schema",
	);
	expect(classifyOutage("weird")).toBe("unknown");
	expect(lastOutage()).not.toBeNull();
});
