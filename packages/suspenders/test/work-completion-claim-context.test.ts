import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { GovernorStore } from "../hooks/lib/govdb/govdb.ts";
import { registeredOriginalBaseline } from "../hooks/lib/lanes/original-baseline.ts";
import { assignTask } from "../hooks/lib/work/work-alloc.ts";

import {
	drainCleanup,
	fixture,
	workFile,
} from "./helpers/work-completion-fixtures.ts";

afterEach(() => drainCleanup());

test("reclaimed standing worktree completes under the new claim with its original baseline", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const context = JSON.parse(
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		join(tree, ".fleet", "lane-context.json"),
		JSON.stringify(context),
		{ mode: 0o600 },
	);
	const merged = Bun.spawnSync(["git", "merge", "--ff-only", f.sha], {
		cwd: tree,
		env: f.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(merged.exitCode).toBe(0);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	const freshToken = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	expect(freshToken).not.toBe(context.claimToken);
	const beforeLoser = readFileSync(
		join(tree, ".fleet", "lane-context.json"),
		"utf8",
	);
	expect(f.work("take", f.id, "--as", "loser-lane").code).not.toBe(0);
	expect(readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8")).toBe(
		beforeLoser,
	);
	const done = Bun.spawnSync(
		[
			process.execPath,
			workFile,
			"done",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			freshToken,
			"--sha",
			f.sha,
			"--summary",
			"Implemented the actual product repair and retained its original immutable baseline after reclaim.",
		],
		{ cwd: tree, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(done.stderr.toString()).not.toContain(
		"Lane completion context does not match",
	);
	expect(done.exitCode).toBe(0);
	const shown = JSON.parse(f.work("show", f.id, "--json").out);
	expect(shown.state).toBe("DONE");
	expect(shown.completion.baseline_sha).toBe(f.baseline);
	expect(shown.completion.completed_by).toBe("replacement-lane");
});

test("retake rejects corrupt provenance without changing the READY row or context", () => {
	for (const change of [
		{ claimToken: "a".repeat(48) },
		{ baseline: "b".repeat(40) },
		{ item: "W999999" },
	]) {
		const f = fixture();
		const tree = join(f.repo, ".worktrees", f.id);
		const original = JSON.parse(
			readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
		);
		mkdirSync(join(tree, ".fleet"), { recursive: true });
		const bytes = JSON.stringify({ ...original, ...change });
		writeFileSync(join(tree, ".fleet", "lane-context.json"), bytes);
		expect(
			f.work(
				"reclaim",
				f.id,
				"--reason",
				"user",
				"--force",
				"--expect-owner",
				"completion-lane",
			).code,
		).toBe(0);
		expect(f.work("take", f.id, "--as", "replacement-lane").code).not.toBe(0);
		expect(
			readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"),
		).toBe(bytes);
		const item = JSON.parse(f.work("show", f.id, "--json").out);
		expect(item.state).toBe("READY");
		expect(item.owner_sid).toBeNull();
	}
});

test("same-owner reconciliation requires current token and durable original receipt", () => {
	const f = fixture();
	const path = join(f.repo, ".worktrees", f.id, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(f.repo, ".worktrees", f.id, ".fleet"), { recursive: true });
	writeFileSync(path, original);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	const token = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	const revision = String(
		JSON.parse(f.work("show", f.id, "--json").out).updated_at,
	);
	writeFileSync(path, original);
	expect(
		f.work("take", f.id, "--as", "replacement-lane", "--token", "c".repeat(48))
			.code,
	).not.toBe(0);
	expect(
		f.work("take", f.id, "--as", "stale-owner", "--token", token).code,
	).not.toBe(0);
	expect(readFileSync(path, "utf8")).toBe(original);
	expect(
		f.work(
			"take",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			token,
			"--expect-updated-at",
			revision,
		).code,
	).toBe(0);
	const context = JSON.parse(readFileSync(path, "utf8"));
	expect(context.sid).toBe("replacement-lane");
	expect(context.claimToken).toBe(token);
	expect(context.baseline).toBe(f.baseline);
	expect(context.launchedAt).toBe(JSON.parse(original).launchedAt);
});

test("failed claim transaction restores context bytes and released ownership", () => {
	const f = fixture();
	const path = join(f.repo, ".worktrees", f.id, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(f.repo, ".worktrees", f.id, ".fleet"), { recursive: true });
	writeFileSync(path, original);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	const project = realpathSync(join(f.repo, ".git"));
	const store = {
		local: true,
		query: db.query.bind(db),
		run: db.run.bind(db),
		close: () => {},
		transaction: <T>(fn: () => T) =>
			db.transaction((): T => {
				fn();
				throw new Error("injected transaction failure after file replacement");
			}),
	} as GovernorStore;
	try {
		expect(
			assignTask(store, project, {
				id: f.id,
				sid: "replacement-lane",
				reason: "rollback test",
			}).ok,
		).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(
			db
				.query(
					"SELECT state,owner_sid FROM work_items WHERE project=? AND id=?",
				)
				.get(project, f.id),
		).toEqual({ state: "READY", owner_sid: null });
	} finally {
		db.close();
	}
});

function operatorEvidenceCase(released: boolean) {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const contextPath = join(tree, ".fleet", "lane-context.json");
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(contextPath, original);
	expect(
		Bun.spawnSync(["git", "-C", tree, "merge", "--ff-only", f.sha], {
			stdout: "pipe",
			stderr: "pipe",
		}).exitCode,
	).toBe(0);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	let token = taken.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	if (released)
		expect(
			f.work(
				"reclaim",
				f.id,
				"--reason",
				"user",
				"--force",
				"--expect-owner",
				"replacement-lane",
			).code,
		).toBe(0);
	const current = JSON.parse(f.work("show", f.id, "--json").out);
	writeFileSync(contextPath, original);
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	const project = realpathSync(join(f.repo, ".git"));
	const events = db
		.query(
			"SELECT id,payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id",
		)
		.all(project, f.id) as { id: number; payload: string }[];
	for (const event of events) {
		const payload = JSON.parse(event.payload);
		delete payload.context_origin;
		delete payload.claim_token_hash;
		db.query("UPDATE events SET payload=? WHERE id=?").run(
			JSON.stringify(payload),
			event.id,
		);
	}
	db.close();
	const digest = (bytes: string) =>
		createHash("sha256").update(bytes).digest("hex");
	const stopReceipt = join(f.home, "operator-stop.json");
	const stopBytes = JSON.stringify({ stopped: true, item: f.id });
	writeFileSync(stopReceipt, stopBytes, { mode: 0o600 });
	const evidencePath = join(f.home, "operator-reconcile.json");
	const evidence = {
		project,
		item: f.id,
		tree,
		owner: "replacement-lane",
		revision: current.updated_at,
		contextHash: digest(original),
		productSha: f.sha,
		originalClaimEventId: events[0]?.id,
		stopReceipt,
		stopReceiptHash: digest(stopBytes),
		attestation:
			"reviewed-original-baseline-and-merged-product-without-original-token-receipt",
	};
	const args = [
		"take",
		f.id,
		"--as",
		"replacement-lane",
		...(released ? [] : ["--token", token]),
		"--expect-updated-at",
		String(current.updated_at),
		"--reconcile-context",
		"--force",
		"--evidence",
	];
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	writeFileSync(evidencePath, JSON.stringify(evidence), { mode: 0o644 });
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	chmodSync(evidencePath, 0o600);
	const linked = join(f.home, "operator-link.json");
	symlinkSync(evidencePath, linked);
	expect(f.work(...args, linked).code).not.toBe(0);
	writeFileSync(
		evidencePath,
		JSON.stringify({ ...evidence, revision: current.updated_at - 1 }),
	);
	expect(f.work(...args, evidencePath).code).not.toBe(0);
	expect(readFileSync(contextPath, "utf8")).toBe(original);
	writeFileSync(evidencePath, JSON.stringify(evidence));
	const repaired = f.work(...args, evidencePath);
	expect(repaired.code).toBe(0);
	if (released)
		token = repaired.out.match(/claim token: ([0-9a-f]{48})/)?.[1] ?? "";
	const afterRepair = readFileSync(contextPath, "utf8");
	if (released) {
		expect(f.work(...args, evidencePath).code).not.toBe(0);
		expect(
			f.work(
				"take",
				f.id,
				"--as",
				"competing-owner",
				"--expect-updated-at",
				String(current.updated_at),
				"--reconcile-context",
				"--force",
				"--evidence",
				evidencePath,
			).code,
		).not.toBe(0);
		expect(readFileSync(contextPath, "utf8")).toBe(afterRepair);
	}
	expect(JSON.parse(readFileSync(contextPath, "utf8")).sid).toBe(
		"replacement-lane",
	);
	const completed = Bun.spawnSync(
		[
			process.execPath,
			workFile,
			"done",
			f.id,
			"--as",
			"replacement-lane",
			"--token",
			token,
			"--sha",
			f.sha,
			"--summary",
			"Reconciled the reviewed historical claim and completed its real merged product without changing the original baseline.",
		],
		{ cwd: tree, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
	expect(completed.exitCode).toBe(0);
	expect(
		JSON.parse(f.work("show", f.id, "--json").out).completion.baseline_sha,
	).toBe(f.baseline);
	const records = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	try {
		const audit = records
			.query(
				"SELECT payload FROM events WHERE kind='work.context-reconciled' AND project=? AND work=?",
			)
			.get(project, f.id) as { payload: string };
		expect(JSON.parse(audit.payload).actor).toBe("operator-reconcile");
		expect(audit.payload).not.toContain(token);
		expect(audit.payload).not.toContain(JSON.parse(original).claimToken);
	} finally {
		records.close();
	}
}
test("explicit operator evidence repairs an old rotated claim and rejects stale or unsafe attestations", () =>
	operatorEvidenceCase(false));
test("lost-token operator reclaim and attested READY retake mint a fresh token for normal completion", () =>
	operatorEvidenceCase(true));

test("an unregistered surviving directory cannot transfer completion identity", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const original = readFileSync(
		join(f.repo, ".fleet", "lane-context.json"),
		"utf8",
	);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	expect(
		Bun.spawnSync(
			["git", "-C", f.repo, "worktree", "remove", "--force", tree],
			{ stdout: "pipe", stderr: "pipe" },
		).exitCode,
	).toBe(0);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(join(tree, ".fleet", "lane-context.json"), original);
	expect(f.work("take", f.id, "--as", "replacement-lane").code).not.toBe(0);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("READY");
});

test("concurrent CLI retakes leave only the winning owner in row and context", async () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		join(tree, ".fleet", "lane-context.json"),
		readFileSync(join(f.repo, ".fleet", "lane-context.json"), "utf8"),
	);
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			"completion-lane",
		).code,
	).toBe(0);
	const contenders = ["replacement-one", "replacement-two"].map((sid) =>
		Bun.spawn([process.execPath, workFile, "take", f.id, "--as", sid], {
			cwd: f.repo,
			env: f.env,
			stdout: "pipe",
			stderr: "pipe",
		}),
	);
	const codes = await Promise.all(contenders.map((process) => process.exited));
	expect(codes.filter((code) => code === 0)).toHaveLength(1);
	const row = JSON.parse(f.work("show", f.id, "--json").out);
	expect(
		JSON.parse(readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8"))
			.sid,
	).toBe(row.owner_sid);
});

type Fixture = ReturnType<typeof fixture>;
const tokenOf = (out: string) =>
	/claim token: ([0-9a-f]{48})/.exec(out)?.[1] ?? "";
const releaseAs = (f: Fixture, sid: string) =>
	expect(
		f.work(
			"reclaim",
			f.id,
			"--reason",
			"user",
			"--force",
			"--expect-owner",
			sid,
		).code,
	).toBe(0);
const completeAs = (f: Fixture, tree: string, sid: string, token: string) =>
	Bun.spawnSync(
		[
			process.execPath,
			workFile,
			"done",
			f.id,
			"--as",
			sid,
			"--token",
			token,
			"--sha",
			Bun.spawnSync(["git", "-C", tree, "rev-parse", "HEAD"])
				.stdout.toString()
				.trim(),
			"--summary",
			"Resumed the released claim's original product from its registered tree base.",
		],
		{ cwd: tree, env: f.env, stdout: "pipe", stderr: "pipe" },
	);
function probeGraph<T>(
	f: Fixture,
	probe: (store: GovernorStore, project: string) => T,
): T {
	const db = new Database(
		join(f.home, ".cache", "claude-governor", "governor.db"),
	);
	try {
		const store = {
			local: true,
			query: db.query.bind(db),
			run: db.run.bind(db),
		};
		return probe(store as GovernorStore, realpathSync(join(f.repo, ".git")));
	} finally {
		db.close();
	}
}
const lastClaimed = (f: Fixture) =>
	probeGraph(f, (store, project) => {
		const row = store
			.query(
				"SELECT payload FROM events WHERE kind='work.claimed' AND project=? AND work=? ORDER BY id DESC LIMIT 1",
			)
			.get(project, f.id) as { payload: string };
		return JSON.parse(row.payload);
	});
// W1730: the W1357/W1315.1 shape — the original claim left a span on the item
// branch and was released; the retake minted its context at the tree's HEAD
function releasedRetake(span: "product" | "none" | "fast-forward" | "merge") {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const inTree = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", tree, ...args], {
			env: f.env,
			stdout: "pipe",
			stderr: "pipe",
		});
	if (span === "product") {
		writeFileSync(join(tree, "retaken.ts"), "export const original = true;\n");
		expect(inTree("add", "retaken.ts").exitCode).toBe(0);
		expect(inTree("commit", "-m", "original claim product").exitCode).toBe(0);
	} else if (span !== "none") {
		const how = span === "merge" ? "--no-ff" : "--ff-only";
		expect(inTree("merge", how, "-m", "integration", f.sha).exitCode).toBe(0);
	}
	const head = inTree("rev-parse", "HEAD").stdout.toString().trim();
	const release = (sid: string) => releaseAs(f, sid);
	release("completion-lane");
	const taken = f.work("take", f.id, "--as", "retake-lane");
	expect(taken.code).toBe(0);
	const contextPath = join(tree, ".fleet", "lane-context.json");
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(
		contextPath,
		JSON.stringify({
			sid: "retake-lane",
			item: f.id,
			baseline: head,
			launchedAt: Date.now(),
			claimToken: tokenOf(taken.out),
		}),
	);
	return { f, tree, head, contextPath, release };
}

test("W1730 retake over the released claim's own product resumes its registered original baseline", () => {
	const { f, tree, head, contextPath, release } = releasedRetake("product");
	const stale = JSON.parse(readFileSync(contextPath, "utf8")).claimToken;
	// the HEAD-minted context hides the original product: the W1357 refusal
	expect(completeAs(f, tree, "retake-lane", stale).stderr.toString()).toContain(
		"Completion has no product commit evidence",
	);
	release("retake-lane");
	const taken = f.work("take", f.id, "--as", "replacement-lane");
	expect(taken.code).toBe(0);
	expect(JSON.parse(readFileSync(contextPath, "utf8")).baseline).toBe(
		f.baseline,
	);
	const receipt = lastClaimed(f);
	expect(receipt.context_origin.baseline).toBe(head);
	expect(receipt.baseline_restored).toMatchObject({
		from: head,
		to: f.baseline,
	});
	const completed = completeAs(f, tree, "replacement-lane", tokenOf(taken.out));
	expect(completed.stderr.toString()).not.toContain("no product commit");
	expect(completed.exitCode).toBe(0);
	const shown = JSON.parse(f.work("show", f.id, "--json").out);
	expect(shown.state).toBe("DONE");
	expect(shown.completion.baseline_sha).toBe(f.baseline);
	// a completed item never re-offers its credited product
	const args = { item: f.id, tree };
	expect(
		probeGraph(f, (store, project) =>
			registeredOriginalBaseline(store, { project, ...args }),
		),
	).toBeNull();
});

test("W1730 a retake inheriting no product or only integrated work keeps the W917 empty-window refusal", () => {
	for (const span of ["none", "fast-forward", "merge"] as const) {
		const { f, tree, head, contextPath, release } = releasedRetake(span);
		release("retake-lane");
		const taken = f.work("take", f.id, "--as", "replacement-lane");
		expect(taken.code).toBe(0);
		expect(JSON.parse(readFileSync(contextPath, "utf8")).baseline).toBe(head);
		expect(lastClaimed(f).baseline_restored).toBeUndefined();
		const refused = completeAs(f, tree, "replacement-lane", tokenOf(taken.out));
		expect(refused.stderr.toString()).toContain(
			"Completion has no product commit evidence",
		);
		expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe(
			"CLAIMED",
		);
	}
});

test("W1730 a context older than its re-minted tree's registered base is refused", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	const release = (sid: string) => releaseAs(f, sid);
	release("completion-lane");
	for (const args of [
		["worktree", "remove", "--force", tree],
		["branch", "-D", `suspenders/${f.id}`],
	])
		expect(Bun.spawnSync(["git", "-C", f.repo, ...args]).exitCode).toBe(0);
	const taken = f.work("take", f.id, "--as", "remint-lane");
	expect(taken.code).toBe(0);
	// the carried-over context claims the pre-mint base: a window over
	// integration history the re-minted tree never produced
	const bytes = JSON.stringify({
		sid: "remint-lane",
		item: f.id,
		baseline: f.baseline,
		launchedAt: Date.now(),
		claimToken: tokenOf(taken.out),
	});
	mkdirSync(join(tree, ".fleet"), { recursive: true });
	writeFileSync(join(tree, ".fleet", "lane-context.json"), bytes);
	release("remint-lane");
	const refused = f.work("take", f.id, "--as", "replacement-lane");
	expect(refused.code).not.toBe(0);
	expect(`${refused.out}${refused.err}`).toContain(
		"predates its registered original tree base",
	);
	expect(readFileSync(join(tree, ".fleet", "lane-context.json"), "utf8")).toBe(
		bytes,
	);
	expect(JSON.parse(f.work("show", f.id, "--json").out).state).toBe("READY");
});

test("W1730 the registered original base binds project, item, tree and an agreeing mint receipt", () => {
	const f = fixture();
	const tree = join(f.repo, ".worktrees", f.id);
	probeGraph(f, (store, project) => {
		const args = { project, item: f.id, tree };
		const mint = store
			.query(
				"SELECT payload FROM events WHERE kind='work.tree' AND project=? AND work=? ORDER BY id DESC LIMIT 1",
			)
			.get(project, f.id) as { payload: string };
		expect(JSON.parse(mint.payload).base).toBe(f.baseline);
		expect(registeredOriginalBaseline(store, args)?.sha).toBe(f.baseline);
		for (const foreign of [
			{ item: "W999999" },
			{ project: `${project}.foreign` },
			{ tree: f.repo },
		])
			expect(
				registeredOriginalBaseline(store, { ...args, ...foreign }),
			).toBeNull();
		// a newer fresh receipt that disagrees with git's creation entry voids it
		store
			.query(
				"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'worktree', 'work.tree', ?, ?, NULL)",
			)
			.run(
				Date.now(),
				f.id,
				JSON.stringify({
					work: f.id,
					project,
					path: tree,
					branch: `suspenders/${f.id}`,
					base: "f".repeat(40),
				}),
			);
		expect(registeredOriginalBaseline(store, args)).toBeNull();
	});
});
