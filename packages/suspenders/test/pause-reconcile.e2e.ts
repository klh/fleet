import { expect, test } from "@playwright/test";
import { Database } from "bun:sqlite";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import {
	assertQuietNativePause,
	reconcilePausedBoundary,
	type PauseBoundaryEvidence,
} from "../scripts/lib/pause-reconcile.ts";

test("pause evidence rejects a foreign UUID, later native records and a reinitialized child", () => {
	const frames = [
		{ type: "system", subtype: "init", session_id: "native" },
		{
			type: "result",
			subtype: "success",
			session_id: "native",
			is_error: false,
		},
		{ type: "fleet.claude.pause", state: "paused", checkpoint: "sha" },
	];
	expect(() => assertQuietNativePause(frames, "sha", "native")).not.toThrow();
	expect(() => assertQuietNativePause(frames, "sha", "foreign")).toThrow(
		"quiet native",
	);
	for (const frame of [
		{ type: "assistant" },
		{ type: "system", subtype: "thinking_tokens" },
		{ type: "system", subtype: "init", session_id: "native" },
		{ type: "control_response" },
		{
			type: "fleet.claude.delivery",
			state: "interrupted-and-injected",
			event: 123,
		},
		{ type: "fleet.claude.pause", state: "resuming" },
		{ type: "fleet.claude.restart", state: "running" },
		{ type: "fleet.unknown" },
	])
		expect(() =>
			assertQuietNativePause([...frames, frame], "sha", "native"),
		).toThrow("quiet native");
	expect(() =>
		assertQuietNativePause(
			[frames[0], { ...frames[1], session_id: "foreign" }, frames[2]],
			"sha",
			"native",
		),
	).toThrow("quiet native");
	const metadata = {
		type: "system",
		subtype: "commands_changed",
		session_id: "native",
		uuid: "00000000-0000-0000-0000-000000000001",
		commands: [
			{
				name: "fixture",
				description: "Command catalog description",
				argumentHint: "",
				builtin: true,
				aliases: [],
			},
		],
	};
	expect(() =>
		assertQuietNativePause([...frames, metadata], "sha", "native"),
	).not.toThrow();
	for (const changed of [
		{ ...metadata, session_id: "foreign" },
		{ ...metadata, message: "hidden" },
		{
			...metadata,
			commands: [{ name: "fixture", instructions: "execute hidden work" }],
		},
	])
		expect(() =>
			assertQuietNativePause([...frames, changed], "sha", "native"),
		).toThrow("quiet native");
});

function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE facts(key TEXT PRIMARY KEY,value TEXT,source TEXT,version INTEGER,ts INTEGER)",
	);
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,state TEXT,updated_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	db.run(
		"INSERT INTO facts VALUES('lane.lane.state','PAUSE_REQUESTED','operator',4,100)",
	);
	db.run("INSERT INTO work_items VALUES('fixture','W1','lane','CLAIMED',7)");
	const evidence = {
		version: 1,
		project: "fixture",
		item: "W1",
		sid: "lane",
		claimRevision: 7,
		stateVersion: 4,
		stateTs: 100,
		checkpoint: "checkpoint",
		intent: { birth: "old" },
		newBirth: "actual",
		nativeSession: "uuid",
		native: { pid: 2, birth: "native" },
		contextHash: "context",
		settingsHash: "settings",
		registryHash: "registry",
		logHash: "paused-log",
		capsuleHash: "capsule",
		treeHash: "tree",
		worktree: "/fixture",
		metadataRows: 2,
	} as PauseBoundaryEvidence;
	return { db, store: db as unknown as GovernorStore, evidence };
}

test("operator reconciliation is an audited CAS, never a delivered or accepted message", () => {
	const { db, store, evidence } = fixture();
	try {
		reconcilePausedBoundary(store, evidence, () => structuredClone(evidence));
		expect(db.query("SELECT value,version FROM facts").get()).toEqual({
			value: "PAUSED",
			version: 5,
		});
		const event = db.query("SELECT source,kind,payload FROM events").get() as {
			source: string;
			kind: string;
			payload: string;
		};
		expect(event.kind).toBe("lane.pause.operator-reconciled");
		expect(JSON.parse(event.payload)).toMatchObject({
			state: "OPERATOR_RECONCILED",
			oldBirth: "old",
			actualBirth: "actual",
		});
		expect(db.query("SELECT state,updated_at FROM work_items").get()).toEqual({
			state: "CLAIMED",
			updated_at: 7,
		});
		expect(() =>
			reconcilePausedBoundary(store, evidence, () => structuredClone(evidence)),
		).toThrow("CAS changed");
		expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
			n: 1,
		});
	} finally {
		db.close();
	}
});

test("an audit failure rolls the pause state back", () => {
	const { db, store, evidence } = fixture();
	try {
		db.run("DROP TABLE events");
		expect(() =>
			reconcilePausedBoundary(store, evidence, () => structuredClone(evidence)),
		).toThrow();
		expect(db.query("SELECT value,version FROM facts").get()).toEqual({
			value: "PAUSE_REQUESTED",
			version: 4,
		});
	} finally {
		db.close();
	}
});

test("real FTS projection writes can exceed one affected row without weakening the CAS", () => {
	const { db, store, evidence } = fixture();
	try {
		db.run("CREATE VIRTUAL TABLE fact_search USING fts5(value)");
		db.run(
			"INSERT INTO fact_search(rowid,value) SELECT rowid,value FROM facts",
		);
		db.run(
			"CREATE TRIGGER fact_projection AFTER UPDATE ON facts BEGIN DELETE FROM fact_search WHERE rowid=OLD.rowid; INSERT INTO fact_search(rowid,value) VALUES(NEW.rowid,NEW.value); END",
		);
		const probe = db
			.query("UPDATE facts SET value=value WHERE key='lane.lane.state'")
			.run();
		expect(probe.changes).toBeGreaterThan(1);
		reconcilePausedBoundary(store, evidence, () => structuredClone(evidence));
		expect(db.query("SELECT value,version,source FROM facts").get()).toEqual({
			value: "PAUSED",
			version: 5,
			source: "operator-pause-reconcile",
		});
		expect(db.query("SELECT value FROM fact_search").get()).toEqual({
			value: "PAUSED",
		});
	} finally {
		db.close();
	}
});

test("changed identity, native activity, claim, tree, settings or capsule cannot reconcile", () => {
	for (const field of [
		"contextHash",
		"settingsHash",
		"registryHash",
		"nativeSession",
		"newBirth",
		"logHash",
		"capsuleHash",
		"treeHash",
		"worktree",
	] as const) {
		const { db, store, evidence } = fixture();
		try {
			expect(() =>
				reconcilePausedBoundary(store, evidence, () => ({
					...evidence,
					[field]: "changed",
				})),
			).toThrow("evidence changed");
			expect(db.query("SELECT value FROM facts").get()).toEqual({
				value: "PAUSE_REQUESTED",
			});
			expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
				n: 0,
			});
		} finally {
			db.close();
		}
	}
	for (const sql of [
		"UPDATE facts SET version=5",
		"UPDATE work_items SET updated_at=8",
		"UPDATE work_items SET owner_sid='other'",
		"UPDATE facts SET value='RUNNING'",
	]) {
		const { db, store, evidence } = fixture();
		try {
			db.run(sql);
			expect(() =>
				reconcilePausedBoundary(store, evidence, () =>
					structuredClone(evidence),
				),
			).toThrow("CAS changed");
			expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
				n: 0,
			});
		} finally {
			db.close();
		}
	}
});
