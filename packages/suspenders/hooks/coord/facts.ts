// hooks/coord/facts.ts — facts, capsules, kb lookup + retention (W157 command modules).
// Handler bodies moved verbatim from bin/coord.ts's if/else chain —
// one-tab indent preserved, output byte-compatible.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertCapsuleBounds, itemCapsuleKey } from "../lib/capsule-fence.ts";
import {
	ConfidenceError,
	glyphFor,
	makeStamp,
	parseStamp,
	renderStamp,
} from "../lib/confidence.ts";
import { expireConsults } from "../lib/consult-expiry.ts";
import { openIdentity } from "../lib/govdb.ts";
import {
	recordKnowledgeSuggestion,
	renderKnowledgeSuggestion,
	suggestKnowledge,
} from "../lib/kev-curation.ts";
import { archiveAndPrune, pruneArchiveFiles } from "../lib/retention.ts";
import { run } from "../lib/run.ts";
import { reapDeadSubscribes } from "../lib/subscribe-attach.ts";
import { isLiveSession, type LivenessRow } from "./bus.ts";
import { ensureConsultTrust } from "./consult-trust.ts";
import type { Database } from "./shared.ts";
import {
	arg,
	cyan,
	db,
	die,
	dim,
	green,
	kbLookup,
	projectIdentity,
	pruneDeltas,
	realpathSync,
	sweepStaleSessions,
} from "./shared.ts";

// W606 — compare-and-set guard for fact/capsule upserts: the blind upsert
// (facts.version incremented but never checked) races successive writers to
// one key — per-lane capsules and lesson.* updates lose history silently.
// expected == null = legacy unconditional write; otherwise the read-then-write
// rides ONE store transaction, serialized with every writer on both bindings
// (local SQLite + HTTP store) — mirrors work take's CAS on work_items.state.
// Refusal carries the current version so writers can read-then-CAS.
function parseIfVersion(raw: string | null): number | null {
	if (raw == null) return null;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0)
		die(`--if-version must be a non-negative integer, got "${raw}"`);
	return n;
}

function casWrite(
	key: string,
	expected: number | null,
	write: () => void,
): { ok: boolean; cur: number | null } {
	if (expected == null) {
		write();
		return { ok: true, cur: null };
	}
	let cur: number | null = null;
	for (let attempt = 0; ; attempt++) {
		try {
			const ok = db.transaction(() => {
				const r = db
					.query("SELECT version FROM facts WHERE key = ?")
					.get(key) as { version: number } | undefined;
				cur = r ? r.version : null;
				// absent normalizes to 0: --if-version 0 is the create-only
				// expectation
				if ((r ? r.version : 0) !== expected) return false;
				write();
				return true;
			})();
			return { ok, cur };
		} catch (e) {
			// deferred BEGIN upgrades at the first write — under true concurrent
			// CAS the upgrade race loser throws SQLITE_BUSY (busy_timeout does
			// not govern the upgrade path). A retry re-reads the version, so it
			// either matches (writes) or mismatches (clean refusal): no lost
			// update ever lands.
			if (attempt >= 3 || (e as { code?: string }).code !== "SQLITE_BUSY")
				throw e;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
}

// W836 audit trust schema note — rides every fact set/get output so agents
// shape knowledge-bearing facts the same way: a JSON value with the fields
// below; rejected entries NEVER get deleted, they graveyard in kb.
export const FACT_SCHEMA_NOTE =
	"schema note: knowledge-bearing facts carry {rating, detail, evidence (file:line|URL), researched} JSON — rejected entries move to the knowledge graveyard, never deleted";

export async function cmdFact(rest: string[]): Promise<void> {
	const sub = rest[0];
	if (sub === "set") {
		const key = rest[1];
		let value = rest[2];
		const txt = arg("--text");
		// arg() returns null BOTH when absent and when bare — null, not
		// undefined, is the "no --text" signal (hotfix 2026-10-01: the prior
		// `!== undefined` check null-ed every positional fact set)
		if (txt != null) value = txt;
		// a flag-shaped value was the fact-set corruption bug (2026-09-30):
		// `fact set k --text "…"` swallowed "--text" as the value and the real
		// text vanished into an ignored positional — three A/B findings lost.
		// W773: the key has the same trap — `fact set --text "…"` (key
		// omitted) landed a junk row keyed "--text" (cmdFact guarded the
		// value's shape but not the key's)
		if (
			!key ||
			key.startsWith("--") ||
			value === undefined ||
			value.startsWith("--")
		)
			die(
				"usage: fact set <key> <value> | fact set <key> --text <text> [--source s] [--if-version n]",
			);
		const src = arg("--source") ?? "coord";
		// W953 confidence doctrine: --confidence REQUIRES --setter (provenance
		// law — a grade without a logged setter is invalid). Verdict lifecycles
		// (superseded/contradicted) require --ref per addendum 2. The stamp
		// chain cites the row's prior stamp; every event appends to the
		// confidence_history ledger.
		const confArg = arg("--confidence");
		const setterArg = arg("--setter");
		if (confArg != null && setterArg == null)
			die(
				"fact set: --confidence requires --setter (human | model:<id> | mechanical:<tool>)",
			);
		if (confArg == null && setterArg != null)
			die("fact set: --setter requires --confidence");
		let confVal: number | null = null;
		if (confArg != null) {
			confVal = Number(confArg);
			if (!Number.isFinite(confVal))
				die(`fact set: --confidence must be a number, got "${confArg}"`);
		}
		const expected = parseIfVersion(arg("--if-version"));
		const r = casWrite(key, expected, () => {
			const cur = db
				.query("SELECT confidence_stamp FROM facts WHERE key = ?")
				.get(key) as { confidence_stamp: string | null } | undefined;
			const prior = parseStamp(cur?.confidence_stamp);
			let stamp: ReturnType<typeof makeStamp> | null = null;
			if (confVal != null) {
				try {
					stamp = makeStamp({
						value: confVal,
						setter: setterArg,
						evidence: arg("--evidence"),
						verdict: arg("--verdict"),
						ref: arg("--ref"),
						prior,
					});
				} catch (e) {
					if (e instanceof ConfidenceError) die(`fact set: ${e.message}`);
					throw e;
				}
			}
			db.query(
				"INSERT INTO facts (key, value, source, version, ts, confidence, confidence_stamp) VALUES (?, ?, ?, 1, ?, ?, ?) " +
					"ON CONFLICT(key) DO UPDATE SET value = excluded.value, source = excluded.source, version = version + 1, ts = excluded.ts, confidence = excluded.confidence, confidence_stamp = excluded.confidence_stamp",
			).run(
				key,
				value,
				src,
				Date.now(),
				stamp?.value ?? null,
				stamp ? JSON.stringify(stamp) : null,
			);
			if (stamp)
				db.query(
					"INSERT INTO confidence_history (ts, tbl, row_key, value, setter, evidence, verdict, ref, prior, prior_setter, prior_ts, by_sid) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				).run(
					stamp.ts,
					"facts",
					key,
					stamp.value,
					stamp.setter,
					stamp.evidence,
					stamp.verdict ?? null,
					stamp.ref ?? null,
					prior ? prior.value : null,
					prior?.setter ?? null,
					prior?.ts ?? null,
					arg("--as") ?? null,
				);
		});
		if (!r.ok)
			die(
				`fact ${key}: --if-version ${expected} refused — current version ${r.cur ?? "unset"}`,
			);
		console.log(`fact ${key} = ${value}`);
		const stamped = db
			.query("SELECT confidence_stamp FROM facts WHERE key = ?")
			.get(key) as { confidence_stamp: string | null } | undefined;
		const st = parseStamp(stamped?.confidence_stamp);
		if (st)
			console.log(
				dim(`  ${renderStamp(st)}${confVal != null ? " · stamped" : ""}`),
			);
		console.log(dim(FACT_SCHEMA_NOTE));
	} else if (sub === "get") {
		const r = db
			.query(
				"SELECT value, version, ts, confidence, confidence_stamp FROM facts WHERE key = ?",
			)
			.get(rest[1] ?? "") as
			| {
					value: string;
					version: number;
					ts: number;
					confidence: number | null;
					confidence_stamp: string | null;
			  }
			| undefined;
		console.log(r ? `${r.value} (v${r.version})` : "(unset)");
		const st = parseStamp(r?.confidence_stamp);
		if (st) console.log(dim(`  ${renderStamp(st)}`));
		console.log(dim(FACT_SCHEMA_NOTE));
	} else if (sub === "list") {
		// W466 bounding: the facts table is the knowledge read surface. Machine
		// cursor namespaces (govdb v12 moved them to machine_cursors, but
		// pre-v12 writers can re-insert in a mixed fleet) never render by
		// default; --prefix filters, --limit caps, --all lifts the hiding.
		const prefixes = ["activity.tp.", "usage.tp.", "usage.v2.tp."];
		const showAll = rest.includes("--all");
		const prefix = arg("--prefix");
		const limit = Number(arg("--limit") ?? 0);
		let where = prefix ? "key LIKE ?" : "1=1";
		const params: (string | number)[] = prefix ? [`${prefix}%`] : [];
		// an explicit --prefix is a deliberate drill-in: hiding applies only
		// to the unscoped default listing
		if (!showAll && !prefix) {
			const hidden = prefixes.map(() => "key NOT LIKE ?").join(" AND ");
			where += ` AND ${hidden}`;
			for (const p of prefixes) params.push(`${p}%`);
		}
		const orderLimit =
			limit > 0 ? ` ORDER BY key LIMIT ${Math.floor(limit)}` : " ORDER BY key";
		const rows = db
			.query(
				`SELECT key, value, version, ts, confidence, confidence_stamp FROM facts WHERE ${where}${orderLimit}`,
			)
			.all(...params) as {
			key: string;
			value: string;
			version: number;
			ts: number;
			confidence: number | null;
			confidence_stamp: string | null;
		}[];
		console.log(
			rows.length
				? rows
						.map((r) => {
							const st = parseStamp(r.confidence_stamp);
							// W953: band glyph + value ride the line when the row is
							// graded — the grade is displayed, never hidden (verdict
							// #5: board/search show all grades)
							const grade = st
								? `  ${glyphFor(st.value)}${r.confidence ?? st.value}`
								: "";
							return `${r.key} = ${r.value}  (v${r.version})${grade}`;
						})
						.join("\n")
				: "(no facts)",
		);
	} else if (sub === "rm") {
		// W773: the purge path for junk rows — the legacy parse trap minted
		// FLAG-SHAPED keys (the live "--text" row), so the key argument
		// deliberately accepts any shape: `fact rm --text` is the exact call
		// that cleans the W773 row
		const key = rest[1];
		if (!key) die("usage: fact rm <key>");
		const n = db.query("DELETE FROM facts WHERE key = ?").run(key).changes;
		if (!n) die(`fact rm: no such key "${key}"`);
		console.log(`${green("✓")} fact ${key} removed`);
	} else
		die(
			"usage: fact set <key> <value> [--if-version n] | fact get <key> | fact rm <key> | fact list [--prefix p] [--limit n] [--all]",
		);
}

export async function cmdCapsule(rest: string[]): Promise<void> {
	// continuation capsule: the minimum restart packet (checkpoint/step/next/assumptions)
	// W617: --item <W-id> banks the capsule on the ITEM too (the project-scoped
	// itemCapsuleKey, W687 — item ids are per-project sequences) alongside the
	// lane-scoped lane.<sid>.capsule — an item reclaimed and re-taken by a
	// fresh lane resumes from it instead of starting blind.
	const item = arg("--item");
	const as = arg("--as") ?? rest[0];
	if (!as || rest[0] === "get") {
		const key = item
			? itemCapsuleKey(projectIdentity(), item)
			: `lane.${as ?? ""}.capsule`;
		const cap = db.query("SELECT value FROM facts WHERE key = ?").get(key) as {
			value: string;
		} | null;
		// W516 --verify: re-check the schema-delta fields against the disk
		// (files exist? snippet ranges inside the file?) — a successor lane
		// verifies instead of trusting prose
		if (cap && rest.includes("--verify"))
			console.log(renderCapsuleVerified(cap.value));
		else console.log(cap?.value ?? dim("(no capsule)"));
	} else {
		const extra: Record<string, unknown> = {};
		let iv: string | null = null;
		for (const t of process.argv.slice(2)) {
			const m = /^--([\w-]+)=(.+)$/.exec(t);
			if (!m) continue;
			// W606: --if-version=N is the CAS expectation, not capsule payload
			if (m[1] === "if-version") iv = m[2];
			else if (m[1] !== "as" && m[1] !== "item") extra[m[1]] = m[2];
		}
		if (item) extra.item = item;
		// W516 capsule schema delta (amp handoff lift, research-ampcode.md
		// §M1): checkable fields — files-touched list, snippet paths WITH line
		// ranges, todo list — stored as arrays so a successor lane can
		// re-verify each on disk (capsule get --verify) instead of trusting
		// prose
		const toList = (key: string, sep: string): void => {
			const v = extra[key];
			if (typeof v === "string")
				extra[key] = v
					.split(sep)
					.map((s) => s.trim())
					.filter(Boolean);
		};
		toList("files", ",");
		toList("snippets", ";");
		toList("todos", ";");
		// W577: a capsule checkpoint is git evidence, not free text — "none" stays
		// the explicit nothing-banked marker, anything else must be a 40-hex sha
		// that resolves to a commit in the caller's repo (the stop evaluator
		// re-proves reachability from HEAD at park time; outside a
		// repo the format check is all the producer can do).
		const ckpt =
			typeof extra.checkpoint === "string" ? extra.checkpoint : undefined;
		if (ckpt !== undefined && ckpt !== "none") {
			if (!/^[a-f0-9]{40}$/i.test(ckpt))
				die(
					`capsule: --checkpoint must be a 40-hex commit sha or "none", got "${ckpt}"`,
				);
			const repo = run("git", ["rev-parse", "--is-inside-work-tree"]);
			if (repo.ok && !run("git", ["cat-file", "-e", `${ckpt}^{commit}`]).ok)
				die(`capsule: --checkpoint ${ckpt} is not a commit in this repo`);
			// W643: freshness rides the payload — the checkpoint's commit epoch,
			// so resume briefs age the hand-off without re-proving git.
			const ckptTs = run("git", ["log", "-1", "--format=%ct", ckpt]);
			if (ckptTs.ok) extra.checkpoint_ts = ckptTs.out.trim();
		}
		// arg() fallback covers the two-token form --if-version N
		const expected = parseIfVersion(iv ?? arg("--if-version"));
		const upsert = (key: string) =>
			db
				.query(
					"INSERT INTO facts (key, value, source, version, ts) VALUES (?, ?, ?, 1, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = version + 1, ts = excluded.ts",
				)
				.run(
					key,
					assertCapsuleBounds(extra, Date.now()),
					arg("--as") ?? as,
					Date.now(),
				);
		// with --item the CAS expectation guards the item key — that is the
		// key successive lane writers race over the item's life; the lane key
		// stays single-writer and rides along unconditionally
		const primary = item
			? itemCapsuleKey(projectIdentity(), item)
			: `lane.${as}.capsule`;
		const r = casWrite(primary, expected, () => upsert(primary));
		if (!r.ok)
			die(
				`capsule ${primary}: --if-version ${expected} refused — current version ${r.cur ?? "unset"}`,
			);
		if (item) upsert(`lane.${as}.capsule`);
		console.log(
			`${green("✓")} ${dim(item ? `capsule stored for item ${item} + @${as.slice(0, 8)}` : `capsule stored for @${as.slice(0, 8)}`)}`,
		);
		const verdict = await suggestKnowledge({
			kind: "capsule",
			title: item ?? `lane ${as.slice(0, 8)}`,
			text: JSON.stringify(extra),
			reference: primary,
			timeoutMs: 1500,
		});
		try {
			recordKnowledgeSuggestion(db, verdict, {
				sid: as,
				project: projectIdentity(),
			});
		} catch {
			// The capsule is already durable; advice is best effort.
		}
		console.log(renderKnowledgeSuggestion(verdict));
		if (verdict.choice !== "noise")
			console.log(
				`Ask a live expert: coord consult --best "<question>" --as ${as}`,
			);
	}
}

/** W516: human rendering of a capsule with the schema-delta fields
 *  re-verified against the current worktree (cwd-relative paths). */
export function renderCapsuleVerified(value: string): string {
	let c: Record<string, unknown>;
	try {
		c = JSON.parse(value) as Record<string, unknown>;
	} catch {
		return `${value}\n  ✗ (capsule is not valid JSON — cannot verify)`;
	}
	const lines: string[] = [];
	for (const [k, v] of Object.entries(c)) {
		if (k === "ts") continue;
		if (k === "files" || k === "snippets" || k === "todos") continue;
		lines.push(`${k}: ${String(v)}`);
	}
	const lineCount = (p: string): number | null => {
		try {
			return readFileSync(existsSync(p) ? p : resolve(p), "utf8").split("\n")
				.length;
		} catch {
			return null;
		}
	};
	return finishCapsuleVerify(c, lines, lineCount);
}

/** W516 part two of the verified render (kept under the mutation cap). */
function finishCapsuleVerify(
	c: Record<string, unknown>,
	lines: string[],
	lineCount: (p: string) => number | null,
): string {
	if (Array.isArray(c.files))
		for (const f of c.files as string[])
			lines.push(`  ${lineCount(f) !== null ? "✓" : "✗ MISSING"} ${f}`);
	if (Array.isArray(c.snippets))
		for (const s of c.snippets as string[]) {
			const m = /^(.+):(\d+)(?:-(\d+))?$/.exec(s);
			const n = m ? lineCount(m[1] ?? "") : null;
			if (!m || n === null) lines.push(`  ✗ MISSING ${s}`);
			else if (Number(m[2]) > n)
				lines.push(`  ✗ ${s} — range past EOF (file has ${n} lines)`);
			else lines.push(`  ✓ ${s} (file has ${n} lines)`);
		}
	if (Array.isArray(c.todos))
		for (const t of c.todos as string[]) lines.push(`  [ ] ${t}`);
	return lines.join("\n");
}

export async function cmdLeaseRelease(rest: string[]): Promise<void> {
	// explicit handover: a session done with a file releases it now instead of
	// pinning it for its remaining TTL. Owner-predicated — only the caller's
	// own rows; taking a foreign lease is monitor --fix / arbitration work.
	const paths = rest.filter((r) => !r.startsWith("--"));
	const as = arg("--as");
	if (!paths.length || !as) die("usage: lease-release <path...> --as <sid>");
	const del = db.query("DELETE FROM locks WHERE path = ? AND sid = ?");
	let n = 0;
	for (const p of paths) {
		let P = p;
		try {
			P = realpathSync(p); // the gate stores canonical paths
		} catch {}
		n += del.run(P, as).changes;
	}
	console.log(`${green("✓")} lease-release: ${n} lock(s) released`);
}

export async function cmdKb(rest: string[]): Promise<void> {
	// the fleet's shared memory: what consults have already answered
	const sub = rest[0];
	if (sub === "add") {
		// direct seed: distill a mistake/lesson without a consult round-trip
		// (owner 2026-09-28: harvest worker logs -> kb so mistakes don't repeat)
		const sep = rest.indexOf("--solution");
		const problem = rest.slice(1, sep === -1 ? rest.length : sep).join(" ");
		const solution =
			sep === -1
				? ""
				: rest
						.slice(sep + 1)
						.filter((a) => a !== "--as")
						.join(" ");
		const as = (() => {
			const i = rest.indexOf("--as");
			return i >= 0 ? rest[i + 1] : null;
		})();
		if (!problem || !solution)
			die('usage: kb add "<problem>" --solution "<solution>" [--as <sid>]');
		const kr = db
			.query(
				"INSERT INTO consult_kb (problem, solution, project, asked_by, answered_by, consult_id, created_at, confidence, confidence_stamp) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)",
			)
			.run(
				problem,
				solution,
				projectIdentity(),
				as ?? "harvest",
				as ?? "harvest",
				Date.now(),
				as ? 0.6 : 0.4,
				JSON.stringify(
					makeStamp({
						value: as ? 0.6 : 0.4,
						setter: as ? `model:${as}` : "mechanical:harvest",
					}),
				),
			);
		db.query("INSERT INTO consult_kb_fts (rowid, problem) VALUES (?, ?)").run(
			kr.lastInsertRowid,
			problem,
		);
		console.log(`✓ kb#${kr.lastInsertRowid} seeded`);
		process.exit(0);
	}
	if (sub === "stats") {
		const project = projectIdentity();
		ensureConsultTrust(db);
		const tot = (
			db
				.query("SELECT COUNT(*) AS n FROM consult_kb WHERE project = ?")
				.get(project) as { n: number }
		).n;
		const hits = (
			db
				.query(
					"SELECT COALESCE(SUM(hits), 0) AS n FROM consult_kb WHERE project = ?",
				)
				.get(project) as {
				n: number;
			}
		).n;
		const byState = db
			.query(
				"SELECT state, COUNT(*) AS n FROM consults WHERE project = ? GROUP BY state",
			)
			.all(project) as { state: string; n: number }[];
		const lat = db
			.query(
				"SELECT answered_at - created_at AS ms FROM consults WHERE project = ? AND state = 'ANSWERED' AND answered_at IS NOT NULL ORDER BY ms",
			)
			.all(project) as { ms: number }[];
		const median = lat.length ? lat[Math.floor(lat.length / 2)].ms : 0;
		const s = (k: string) => byState.find((b) => b.state === k)?.n ?? 0;
		console.log(
			`kb: ${tot} solutions · ${hits} repeat questions auto-answered · consults: ${s("OPEN")} open, ${s("ANSWERED")} human, ${s("KB")} via kb, ${s("DECLINED")} declined`,
		);
		const outcomes = db
			.query(
				"SELECT f.outcome, COUNT(*) AS n FROM consult_feedback f JOIN consults c ON c.id = f.consult_id WHERE c.project = ? GROUP BY f.outcome",
			)
			.all(project) as { outcome: string; n: number }[];
		const outcome = (name: string) =>
			outcomes.find((o) => o.outcome === name)?.n ?? 0;
		console.log(
			`outcomes: ${outcome("resolved")} resolved, ${outcome("failed")} failed, ${outcome("unused")} unused (verification, not message volume)`,
		);
		if (median && hits)
			console.log(
				dim(
					`median human answer ${Math.round(median / 60000)}min — est. ${Math.round((hits * median) / 60000)}min of round-trips skipped (hits × median)`,
				),
			);
	} else if (sub === "search") {
		const q = rest.slice(1).join(" ");
		if (!q) die('usage: kb search "<query words>" | kb list | kb stats');
		const hit = kbLookup(q);
		if (!hit) {
			console.log(dim("(no kb match)"));
			process.exitCode = 1;
		} else
			console.log(
				`${cyan(`kb#${hit.id}`)} ${dim(`learned from ${String(hit.answered_by).slice(0, 8)}, ${hit.hits} hits`)}\n  Q: ${hit.problem}\n  A: ${hit.solution}`,
			);
	} else if (sub === "list") {
		const rows = db
			.query(
				"SELECT id, problem, solution, answered_by, hits, created_at FROM consult_kb WHERE project = ? ORDER BY id DESC LIMIT 20",
			)
			.all(projectIdentity()) as {
			id: number;
			problem: string;
			solution: string;
			answered_by: string;
			hits: number;
		}[];
		console.log(
			rows
				.map(
					(r) =>
						`${cyan(`kb#${r.id}`)} ${dim(String(r.answered_by).slice(0, 8))} ${r.problem.slice(0, 50)} ${dim("→")} ${r.solution.slice(0, 50)}`,
				)
				.join("\n") || dim("(kb empty — answers land here via consult-reply)"),
		);
	} else die('usage: kb stats | kb list | kb search "<query words>"');
}

export async function cmdGc(_rest: string[]): Promise<void> {
	// retention: events + closed sessions + their cursors age out; terminal
	// work items are the ledger and are NEVER auto-deleted
	const days = Number(arg("--days") ?? 30);
	const cut = Date.now() - days * 86_400_000;
	// W174 retention: events age out with archive-before-delete (lib/retention
	// .ts) — the NDJSON lines under ~/.cache/claude-governor/archive/ keep
	// everything gc deletes; route_audit/auth_events/usage_rollup/admin_audit
	// were previously unbounded (governor bloat).
	// W603 cursor-aware events retention: orphan cursors go FIRST (a dead
	// session's stuck cursor must not hold the prune floor), then the events
	// prune cuts only past EVERY live cursor — unread inbox traffic is never
	// pruned out from under a reader (min over remaining cursors; no cursor
	// rows = age-only cut).
	const c = db
		.query("DELETE FROM cursors WHERE sid NOT IN (SELECT sid FROM sessions)")
		.run().changes;
	const floor = (
		db.query("SELECT MIN(event_id) AS f FROM cursors").get() as {
			f: number | null;
		}
	).f;
	const e = pruneSafe(db, {
		table: "events",
		tsCol: "ts",
		cut,
		floorCol: "id",
		floorVal: floor ?? undefined,
		cols: ["id", "ts", "source", "kind", "scope", "payload", "target"],
	});
	const auditDays = Number(arg("--audit-days") ?? 90);
	const usageDays = Number(arg("--usage-days") ?? 180);
	const ms = (d: number): number => d * 86_400_000;
	// archive failure must never kill gc — skip that prune (rows survive to
	// the next pass); archive-before-delete is the contract
	function pruneSafe(
		store: Parameters<typeof archiveAndPrune>[0],
		spec: Parameters<typeof archiveAndPrune>[1],
	): number {
		try {
			return archiveAndPrune(store, spec);
		} catch (e) {
			console.error(
				`gc: ${spec.table} archive failed — prune skipped: ${e instanceof Error ? e.message : String(e)}`,
			);
			return 0;
		}
	}
	const ra = pruneSafe(db, {
		table: "route_audit",
		tsCol: "ts",
		cut: Date.now() - ms(auditDays),
		cols: [
			"rid",
			"ts",
			"actor",
			"dialect",
			"hint",
			"candidates",
			"resolved_target",
			"decision",
			"latency_class",
			"error_code",
		],
	});
	// W156: auth_events ride identity.db post-split — the prune opens the
	// same identity binding openIdentity() hands every other consumer
	const idb = openIdentity();
	const ae = pruneSafe(idb, {
		table: "auth_events",
		tsCol: "ts",
		cut: Date.now() - ms(usageDays),
		cols: ["id", "ts", "actor", "event", "jti", "via"],
	});
	const ur = pruneSafe(db, {
		table: "usage_rollup",
		tsCol: "hour_bucket",
		cut: Date.now() - ms(usageDays),
		cols: [
			"hour_bucket",
			"actor",
			"model",
			"model_group",
			"in_tok",
			"out_tok",
			"cache_r",
			"cache_c",
			"requests",
		],
	});
	const aa = pruneSafe(db, {
		table: "admin_audit",
		tsCol: "ts",
		cut: Date.now() - ms(365),
		cols: ["id", "ts", "actor", "action", "target", "detail"],
	});
	const af = pruneArchiveFiles(365);
	const s = db
		.query("DELETE FROM sessions WHERE state = 'CLOSED' AND hb < ?")
		.run(cut).changes;
	const f = db
		.query("DELETE FROM facts WHERE key LIKE 'lane.%' AND ts < ?")
		.run(cut).changes;
	// W466: machine cursors live in machine_cursors (govdb v12) — facts rows
	// in the cursor namespaces are strays from pre-v12 writers (mixed fleet);
	// move them along so the knowledge surface stays clean. The machine
	// keyspace itself gets NO time-prune: a cursor is an offset into a
	// transcript that may still exist — deleting it would re-harvest the file
	// from byte 0 into UPSERT-ADD rollups (double count).
	for (const p of ["activity.tp.%", "usage.tp.%", "usage.v2.tp.%"]) {
		db.run(
			"INSERT OR IGNORE INTO machine_cursors (key, value, source, ts) SELECT key, value, source, ts FROM facts WHERE key LIKE ?",
			p,
		);
		db.run("DELETE FROM facts WHERE key LIKE ?", p);
	}
	// consults: open questions expire past their deadline (W611: the flip also
	// emits consult.expired at the asker); closed threads age out
	const x = expireConsults(db, Date.now());
	const cd = db
		.query(
			"DELETE FROM consults WHERE state IN ('ANSWERED','DECLINED','EXPIRED') AND answered_at < ? AND answered_at IS NOT NULL",
		)
		.run(cut).changes;
	const sw = db.local ? sweepStaleSessions(db as Database) : 0;
	const lk = db
		.query("DELETE FROM locks WHERE ts < ?")
		.run(Date.now() - 15 * 60_000).changes;
	const d = pruneDeltas(db as Database, days * 86_400_000);
	// W418: ghost-subscribe sweep — a CLOSED or transcript-dead session's WS
	// subscribe is a dead connection riding the process table; gc reaps it
	// with the session garbage (done/release reap at the transition, this is
	// the backstop for sessions that die un-ended).
	const rs = reapDeadSubscribes((sid) => {
		const row = db
			.query(
				"SELECT hb, parent_sid, role, transcript_path, state FROM sessions WHERE sid = ?",
			)
			.get(sid) as (LivenessRow & { state: string }) | undefined;
		return !row || row.state === "CLOSED" || !isLiveSession(row);
	});
	console.log(
		`gc: ${e} events, ${s} closed sessions, ${sw} stale RUNNING sessions swept, ${rs.length} ghost subscribe(s) reaped, ${lk} expired locks, ${c} stale cursors, ${f} lane facts, ${x} consults expired, ${cd} consult threads pruned, ${d} deltas (>${days}d; work ledger untouched)`,
	);
	console.log(
		`gc: archived → ${ra} route_audit (>${auditDays}d), ${ae} auth_events, ${ur} usage_rollup (>${usageDays}d), ${aa} admin_audit (365d); ${af} stale archive files; NDJSON in ~/.cache/claude-governor/archive/`,
	);
}
