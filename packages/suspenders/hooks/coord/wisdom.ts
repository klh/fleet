// hooks/coord/wisdom.ts — W438/W469: the wisdom tier. Fleet-wide, read-only
// correction detector over the graph + event bus. It watches the watchers:
// its subject is the correction history itself; its ONLY writes are
// finding.wisdom.* facts and NEED_DECISION emissions (spec §4.5 in
// docs/owner-correction-taxonomy.md). NEVER work add/done/take/reclaim,
// never dispatch, never gate or settings changes.
//
// Runs in-process on the fleet-loop cadence (cycle step 5) and manually via
// `coord wisdom` for testing/manual passes. Emission budget: one open
// NEED_DECISION per class per subject per 24h (facts wisdom.<C>.<subject>),
// suppressed detections park in the finding.wisdom.queue digest.
import { spawnSync } from "node:child_process";
import { db, green, dim, projectIdentity } from "./shared.ts";
import { projectRootOf } from "../lib/govdb.ts";
import { emitEvent } from "./bus.ts";

// rules-as-data (spec §4.5): a ruling can promote one of these into a
// reflex-tier gate without new code.
const RULES = [
	{ id: "C1", name: "stub mints" },
	{ id: "C2", name: "evidence-less closure" },
	{ id: "C7", name: "broadcast flood" },
];
const DAY = 24 * 3_600_000;
const LOOKBACK = DAY;

// one open NEED_DECISION per class per subject per 24h
function underBudget(id: string, subject: string): boolean {
	const row = db
		.query("SELECT ts FROM facts WHERE key = ?")
		.get(`wisdom.${id}.${subject}`) as { ts: number } | null;
	return !row || Date.now() - row.ts > DAY;
}

function markEmitted(id: string, subject: string, label: string): void {
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'wisdom', 1, ?)",
	).run(`wisdom.${id}.${subject}`, label, Date.now());
}

function bumpQueue(): void {
	const r = db
		.query("SELECT value FROM facts WHERE key = 'finding.wisdom.queue'")
		.get() as { value: string } | null;
	const q = r
		? (JSON.parse(r.value) as { suppressed: number })
		: { suppressed: 0 };
	db.query(
		"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES ('finding.wisdom.queue', ?, 'wisdom', 1, ?)",
	).run(
		JSON.stringify({ suppressed: q.suppressed + 1, ts: Date.now() }),
		Date.now(),
	);
}

// fixed skeleton (spec §4.5): CLASS, EVIDENCE, OPTIONS, ROLLBACK, DEDUPE
function note(
	id: string,
	evidence: string,
	options: string,
	rollback: string,
	subject: string,
): string {
	return [
		`CLASS ${id}`,
		`EVIDENCE ${evidence}`,
		`OPTIONS ${options}`,
		`ROLLBACK ${rollback}`,
		`DEDUPE wisdom.${id}.${subject} 24h`,
	].join("\n");
}

function emitDecision(n: string): void {
	// on the bus — the board surfaces NEED_DECISIONs; addressed routing to
	// the owner sid is a follow-up once interactive-session identity is
	// stable (spec §4.5 keeps NEED_DECISION off the broadcast channel)
	emitEvent({ kind: "NEED_DECISION", source: "wisdom", note: n });
}

function hashNote(n: string): string {
	const h = new Bun.CryptoHasher("sha256");
	h.update(n);
	return h.digest("hex").slice(0, 12);
}
// ---- per-class detectors: read-only SELECTs + spawnSync git reads

// C1 stub mints: title == id, or READY/CLAIMED with neither description
// nor scope, on non-terminal items (33 such rows exist in the graph today)
function detectC1(proj: string): { subject: string; label: string } | null {
	const stubs = db
		.query(
			"SELECT id FROM work_items WHERE project = ? AND state IN ('READY','CLAIMED') AND (title = id OR (description IS NULL AND scope IS NULL)) ORDER BY id LIMIT 10",
		)
		.all(proj) as { id: string }[];
	if (!stubs.length) return null;
	const subject = stubs.length === 1 ? stubs[0].id : "stubs-batch";
	const list = stubs
		.map((s) => s.id)
		.join(",")
		.concat(stubs.length === 10 ? " …" : "");
	return {
		subject,
		label: note(
			"C1",
			`${stubs.length} stub item(s): ${list}`,
			"(a) retire/re-mint the stubs with filled titles; (b) fill title/desc in place",
			"re-mint restores the prior rows; fills are in-place edits",
			subject,
		),
	};
}

// C2 evidence-less closure: work.done shas that do not resolve in the
// item's repo (cat-file -e) — the W318 mis-closed class. A repo path that
// is gone is the same verdict: the evidence is unverifiable.
function detectC2(since: number): { subject: string; label: string } | null {
	const dones = db
		.query(
			"SELECT payload FROM events WHERE kind = 'work.done' AND ts >= ? ORDER BY id",
		)
		.all(since) as { payload: string | null }[];
	const bad: string[] = [];
	for (const d of dones) {
		let p: { work?: string; sha?: string; project?: string } = {};
		try {
			p = JSON.parse(d.payload ?? "{}");
		} catch {
			continue;
		}
		if (!p.work || !p.sha || !p.project) continue;
		const root = projectRootOf(p.project);
		const r = spawnSync(
			"git",
			["-C", root, "cat-file", "-e", `${p.sha}^{commit}`],
			{ stdout: "ignore", stderr: "ignore" },
		);
		if (r.error || r.status !== 0) bad.push(`${p.work}@${p.sha}`);
	}
	if (!bad.length) return null;
	const subject = bad.length === 1 ? bad[0].split("@")[0] : "done-shas";
	return {
		subject,
		label: note(
			"C2",
			`work.done sha unresolvable: ${bad.slice(0, 3).join(", ")}`,
			"(a) re-close with a valid sha; (b) re-open the item",
			"re-open undoes the closure",
			subject,
		),
	};
}
// C7 broadcast flood: the same note re-broadcast under >=3 distinct ids
// within the lookback (per-target fan-out rows are by design; what W438
// measured was one note re-minted again and again)
function detectC7(since: number): { subject: string; label: string } | null {
	const brd = db
		.query(
			"SELECT payload FROM events WHERE kind = 'BROADCAST' AND ts >= ? ORDER BY id",
		)
		.all(since) as { payload: string | null }[];
	const noteBids = new Map<string, Set<string>>();
	for (const b of brd) {
		let p: { id?: string; note?: string } = {};
		try {
			p = JSON.parse(b.payload ?? "{}");
		} catch {
			continue;
		}
		if (!p.id || !p.note) continue;
		const s = noteBids.get(p.note) ?? new Set<string>();
		s.add(p.id);
		noteBids.set(p.note, s);
	}
	for (const [n, bids] of noteBids) {
		if (bids.size < 3) continue;
		const subject = `note-${hashNote(n)}`;
		if (!underBudget("C7", subject)) return null;
		return {
			subject,
			label: note(
				"C7",
				`note re-broadcast ${bids.size}x as ${[...bids].join(",")} in 24h`,
				"(a) stop re-broadcasting — SessionStart injects broadcast.latest anyway; (b) lengthen the re-broadcast interval",
				"re-broadcasts resume",
				subject,
			),
		};
	}
	return null;
}
// ---- orchestrator: one sweep pass; the fleet-loop cadence calls this
export function wisdomSweep(): { flagged: number; emitted: number } {
	const proj = projectIdentity();
	const since = Date.now() - LOOKBACK;
	let flagged = 0;
	let emitted = 0;
	let suppressed = 0;
	const hits = [detectC1(proj), detectC2(since), detectC7(since)];
	for (const h of hits) {
		if (!h) continue;
		flagged++;
		const id = h.label.split("\n")[0].replace("CLASS ", "");
		if (underBudget(id, h.subject)) {
			emitDecision(h.label);
			markEmitted(
				id,
				h.subject,
				`${id} sweep ${new Date().toISOString().slice(0, 16)}`,
			);
			emitted++;
		} else {
			suppressed++;
		}
	}
	if (suppressed > 0) bumpQueue();
	return { flagged, emitted };
}

// CLI face: `coord wisdom` — one manual sweep pass
export async function cmdWisdom(_rest: string[]): Promise<void> {
	const r = wisdomSweep();
	console.log(
		`${green("✓")} wisdom sweep: ${r.flagged} flagged, ${r.emitted} emitted${dim(` (${RULES.map((x) => x.id).join("/")})`)}`,
	);
}
