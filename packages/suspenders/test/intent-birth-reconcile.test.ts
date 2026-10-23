import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb.ts";
import {
	reconcileIntentBirth,
	intentBirthReconcile,
	intentSettingsHash,
	type IntentBirthEvidence,
} from "../scripts/lib/intent-birth-reconcile.ts";

test("operator evidence rejects public files, symlinks and forged scope before opening a store", () => {
	const root = mkdtempSync(join(tmpdir(), "birth-reconcile-evidence-"));
	const file = join(root, "proof.json");
	try {
		writeFileSync(file, JSON.stringify(evidence()), { mode: 0o644 });
		expect(() => intentBirthReconcile(root, "W1", file, true)).toThrow(
			"regular 0600 file",
		);
		chmodSync(file, 0o600);
		const link = join(root, "link.json");
		symlinkSync(file, link);
		expect(() => intentBirthReconcile(root, "W1", link, true)).toThrow(
			"regular 0600 file",
		);
		expect(() => intentBirthReconcile(root, "W1", file, true)).toThrow(
			"scope mismatch",
		);
		expect(() => intentBirthReconcile(root, "other", file, true)).toThrow(
			"scope mismatch",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

const evidence = (): IntentBirthEvidence => ({
	version: 1,
	project: "fixture",
	item: "W1",
	sid: "lane",
	worktree: "/fixture/W1",
	intent: {
		project: "fixture",
		item: "W1",
		sid: "lane",
		nonce: "original",
		revision: 7,
		executor: "/fixture/runtime.ts",
		host: "fixture",
		attempt: 1,
		state: "REGISTERED",
		pid: 123,
		birth: "{ sec = 1, usec = 2 }:100:200",
	},
	registryHash: "registry",
	contextHash: "context",
	settingsHash: "settings",
	claimRevision: 9,
	checkpoint: "checkpoint",
	nativeSession: "00000000-0000-0000-0000-000000000001",
	newBirth: "darwin:12345678-1234-1234-1234-123456789abc:100:200",
	native: { pid: 124, birth: "native" },
});

function fixture() {
	const db = new Database(":memory:");
	db.run(
		"CREATE TABLE lane_launch_intents(project TEXT,item TEXT,sid TEXT,nonce TEXT,revision INTEGER,state TEXT,pid INTEGER,birth TEXT)",
	);
	db.run(
		"CREATE TABLE work_items(project TEXT,id TEXT,owner_sid TEXT,state TEXT,updated_at INTEGER)",
	);
	db.run(
		"CREATE TABLE events(ts INTEGER,source TEXT,kind TEXT,scope TEXT,payload TEXT,target TEXT)",
	);
	const proof = evidence();
	db.run(
		"INSERT INTO lane_launch_intents VALUES (?,?,?,?,?,?,?,?)",
		proof.project,
		proof.item,
		proof.sid,
		proof.intent.nonce,
		proof.intent.revision,
		"REGISTERED",
		proof.intent.pid,
		proof.intent.birth,
	);
	db.run("INSERT INTO work_items VALUES ('fixture','W1','lane','CLAIMED',9)");
	return { db, store: db as unknown as GovernorStore, proof };
}

test("explicit repair CAS preserves claim/context and records one immutable event", () => {
	const { db, store, proof } = fixture();
	try {
		reconcileIntentBirth(store, proof, () => structuredClone(proof));
		expect(db.query("SELECT birth FROM lane_launch_intents").get()).toEqual({
			birth: proof.newBirth,
		});
		expect(db.query("SELECT * FROM work_items").get()).toEqual({
			project: "fixture",
			id: "W1",
			owner_sid: "lane",
			state: "CLAIMED",
			updated_at: 9,
		});
		expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
			n: 1,
		});
		expect(() =>
			reconcileIntentBirth(store, proof, () => structuredClone(proof)),
		).toThrow("CAS changed");
		expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
			n: 1,
		});
	} finally {
		db.close();
	}
});

test("stale native/registry/claim evidence cannot mutate the old intent", () => {
	for (const mutation of [
		"contextHash",
		"settingsHash",
		"registryHash",
		"checkpoint",
		"nativeSession",
		"newBirth",
	] as const) {
		const { db, store, proof } = fixture();
		try {
			expect(() =>
				reconcileIntentBirth(store, proof, () => ({
					...proof,
					[mutation]: "changed",
				})),
			).toThrow("evidence changed");
			expect(db.query("SELECT birth FROM lane_launch_intents").get()).toEqual({
				birth: proof.intent.birth,
			});
			expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
				n: 0,
			});
		} finally {
			db.close();
		}
	}
});

test("same settings pathname with changed private contents invalidates sealed evidence", () => {
	const root = mkdtempSync(join(tmpdir(), "birth-reconcile-settings-"));
	const path = join(root, "settings.json");
	try {
		writeFileSync(path, JSON.stringify({ model: "synthetic-a" }), {
			mode: 0o600,
		});
		const first = intentSettingsHash(path);
		writeFileSync(path, JSON.stringify({ model: "synthetic-b" }));
		expect(intentSettingsHash(path)).not.toBe(first);
		chmodSync(path, 0o644);
		expect(() => intentSettingsHash(path)).toThrow("0600");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("competing claim, intent nonce and active/unproven authority fail closed", () => {
	for (const sql of [
		"UPDATE work_items SET updated_at=10",
		"UPDATE work_items SET owner_sid='other'",
		"UPDATE lane_launch_intents SET nonce='replacement'",
		"UPDATE lane_launch_intents SET pid=125",
	]) {
		const { db, store, proof } = fixture();
		try {
			db.run(sql);
			expect(() => reconcileIntentBirth(store, proof, () => proof)).toThrow(
				"CAS changed",
			);
			expect(db.query("SELECT COUNT(*) AS n FROM events").get()).toEqual({
				n: 0,
			});
		} finally {
			db.close();
		}
	}
	const { db, store, proof } = fixture();
	try {
		expect(() =>
			reconcileIntentBirth(store, proof, () => {
				throw Error("Native is active or pause boundary is not proven");
			}),
		).toThrow("Native is active");
		expect(db.query("SELECT birth FROM lane_launch_intents").get()).toEqual({
			birth: proof.intent.birth,
		});
	} finally {
		db.close();
	}
});

test("failed audit insertion rolls the birth update back", () => {
	const { db, store, proof } = fixture();
	try {
		db.run(
			"CREATE TRIGGER reject_audit BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
		);
		expect(() => reconcileIntentBirth(store, proof, () => proof)).toThrow(
			"audit unavailable",
		);
		expect(db.query("SELECT birth FROM lane_launch_intents").get()).toEqual({
			birth: proof.intent.birth,
		});
	} finally {
		db.close();
	}
});
