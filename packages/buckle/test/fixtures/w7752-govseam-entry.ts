// test/fixtures/w7752-govseam-entry.ts — W775.2 phase-3 fixture: HTTP-walk
// doubles for the enterprise gov-seam providers. The real laws (private
// guard, claim binding, content-addressed versioning) live in the overlay's
// own tests; this module exists so the e2e walk drives REAL routes through
// boot() → loadOverlay → createGovSeam → startServer auth opts.
import type {
	CrProbe,
	CrRow,
	CrVerdict,
	ManifestCrProvider,
} from "../../src/gov/hub-seam.ts";
import type { Database } from "bun:sqlite";

const DDL =
	"CREATE TABLE IF NOT EXISTS federation_cr_queue (id TEXT PRIMARY KEY, action TEXT NOT NULL, target TEXT NOT NULL, declared_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'declared', note TEXT, updated_at INTEGER, reported_at INTEGER, payload TEXT, origin TEXT, verified_at INTEGER, claimed_by TEXT, claimed_at INTEGER)";

const stash = (spokes: unknown): void => {
	(globalThis as { __w7752fed?: unknown }).__w7752fed = { spokes };
};

const codes = new Map<string, string | null>();
let mintN = 0;

const spokes = {
	mint: ({ spokeId, ttlS }: { spokeId: string; ttlS: number | null }) => {
		mintN += 1;
		const code = `code-${mintN}`;
		codes.set(code, spokeId);
		return { code, expiresAt: Date.now() + (ttlS ?? 900) * 1000 };
	},
	redeem: ({ code }: { code: string }) => {
		if (!codes.has(code))
			return { ok: false, code: "buckle.enroll_unknown", why: "no such code" };
		const spokeId = codes.get(code);
		if (spokeId === null)
			return { ok: false, code: "buckle.enroll_used", why: "already redeemed" };
		codes.set(code, null);
		return {
			ok: true,
			spokeId,
			keyId: `key-${spokeId}`,
			key: `bksk_test_${spokeId}`,
			expiresAt: null,
		};
	},
	touch: () => {},
	list: () => [],
};

function miniPick(
	probes: Array<{ prefix: string; probe: CrProbe }>,
	target: string,
): { prefix: string; probe: CrProbe } | null {
	let best: { prefix: string; probe: CrProbe } | null = null;
	for (const p of probes)
		if (
			target.startsWith(p.prefix) &&
			(best === null || p.prefix.length > best.prefix.length)
		)
			best = p;
	return best;
}

function miniApply(
	db: Database,
	rowOf: (id: string) => CrRow | null,
	o: { id: string; note: string | null; actor: { id: string } },
): CrVerdict {
	const now = Date.now();
	db.query(
		"UPDATE federation_cr_queue SET state='applied', reported_at=?, updated_at=?, claimed_by=?, claimed_at=? WHERE id=?",
	).run(now, now, o.actor.id, now, o.id);
	return { ok: true, row: rowOf(o.id) as CrRow };
}

function miniVerify(
	db: Database,
	rowOf: (id: string) => CrRow | null,
	probes: Array<{ prefix: string; probe: CrProbe }>,
	o: { id: string; note: string | null },
	row: CrRow,
): CrVerdict {
	const found = miniPick(probes, row.target);
	if (found === null)
		return {
			ok: false,
			status: 409,
			code: "buckle.cr_state",
			why: `no verification probe for ${row.target}`,
		};
	const v = found.probe(row);
	if (!v.ok)
		return {
			ok: false,
			status: 409,
			code: "buckle.cr_probe",
			why: `probe refused: ${v.why ?? "probe said no"}`,
		};
	const now = Date.now();
	db.query(
		"UPDATE federation_cr_queue SET state='verified', verified_at=?, updated_at=? WHERE id=?",
	).run(now, now, o.id);
	return { ok: true, row: rowOf(o.id) as CrRow };
}

function miniRowOf(db: Database, id: string): CrRow | null {
	return (db
		.query("SELECT * FROM federation_cr_queue WHERE id = ?")
		.get(id) ?? null) as CrRow | null;
}

function miniList(db: Database): CrRow[] {
	return (db
		.query("SELECT * FROM federation_cr_queue ORDER BY declared_at")
		.all() ?? []) as CrRow[];
}

function miniManifest(db: Database): {
	version: string;
	rules: Array<Record<string, unknown>>;
	cr_queue: CrRow[];
} {
	const q = miniList(db);
	return {
		version: `fed-${q.length}-${q.length ? q[q.length - 1]?.state : "empty"}`,
		rules: [{ id: "gateway.knobs", kind: "gateway" }] as Array<
			Record<string, unknown>
		>,
		cr_queue: q,
	};
}

function miniTransition(
	db: Database,
	probes: Array<{ prefix: string; probe: CrProbe }>,
	o: { id: string; to: string; note: string | null; actor: { id: string; admin: boolean } },
): CrVerdict {
	const row = miniRowOf(db, o.id);
	if (row === null)
		return { ok: false, status: 404, code: "buckle.cr_unknown", why: `unknown CR ${o.id}` };
	if (row.state === "declared" && o.to === "applied")
		return miniApply(db, (id) => miniRowOf(db, id), { id: o.id, note: o.note, actor: o.actor });
	if (row.state === "applied" && o.to === "verified")
		return miniVerify(db, (id) => miniRowOf(db, id), probes, { id: o.id, note: o.note }, row);
	return { ok: false, status: 409, code: "buckle.cr_state", why: `illegal ${row.state} -> ${o.to}` };
}

function miniCr(db: Database): ManifestCrProvider {
	db.exec(DDL);
	const probes: Array<{ prefix: string; probe: CrProbe }> = [];
	return {
		manifest: () => miniManifest(db),
		list: () => miniList(db),
		declare: (o) => {
			db.query(
				"INSERT INTO federation_cr_queue (id, action, target, declared_at, state, payload, origin) VALUES (?, ?, ?, ?, 'declared', ?, ?)",
			).run(
				o.id,
				o.action,
				o.target,
				new Date().toISOString(),
				JSON.stringify(o.payload ?? null),
				JSON.stringify(o.origin ?? null),
			);
			return { ok: true, row: miniRowOf(db, o.id) as CrRow };
		},
		transition: (o) => miniTransition(db, probes, o),
		registerProbe: (prefix, probe) => {
			probes.push({ prefix, probe });
		},
	};
}

export function createGovSeam() {
	return {
		spokeEnrollment: () => {
			stash(spokes);
			return spokes;
		},
		hubEntitlements: () => ({
			models: () => [
				{
					id: "glm-5.3-flash",
					family: null,
					tier: "cloud",
					locality: "cloud" as const,
					available: true,
				},
			],
		}),
		manifestCr: (db: Database) => {
			const cr = miniCr(db);
			cr.registerProbe("model:", () => ({ ok: true, why: null }));
			return cr;
		},
	};
}
