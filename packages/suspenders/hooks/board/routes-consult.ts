// hooks/board/routes-consult.ts — W931 co-supervisor ingress: external
// agents (the ChatGPT co-supervisor connector, any HTTP client) get a
// universal identity on the coord plane over the EXISTING board wire. Auth
// stays the shared W264 perimeter (host allowlist + x-klh-write-token on
// every write AND on the outbox GET) — no new secret class by default.
// Handlers are thin HTTP
// adapters over the supported coord verbs (control-plane ops law):
// consult / consult-reply / broadcast spawn the CLI verbatim with cwd
// pinned to the requested project, so every consult carries the CLI's own
// KB/fact/lesson seams, W923 refusal events and W909 item links. The
// agent's plane identity is a long-lived session row (role "external")
// whose heartbeat this module refreshes on every call — live while the
// agent talks, swept honest when it goes quiet. Per-sid rate cap + 10-min
// answer dedup keep a chatty connector from storming the expert queue.
import { db, CLI } from "./context.ts";
import { json, readJsonCapped, writeGuard } from "./helpers.ts";
import { projectList } from "./lanes.ts";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10; // consult POSTs per sid per window
const DEDUP_MS = 10 * 60_000; // identical request identity inside the window replays

const windowHits = new Map<string, number[]>();
const dedup = new Map<string, { at: number; project: string; cid: number }>();

// W947 (verdict #47393 finding 3): the coord CLI spawn is bounded — a
// per-spawn timeout kills a wedged CLI, ONE global semaphore caps every
// ingress spawn (a queued consult storm cannot flood the host with coord
// processes), and the child output read is size-capped so a spewing child
// cannot buffer the board unboundedly. Knobs are env, not code.
const SPAWN_TIMEOUT_MS =
	Number(process.env.SUSPENDERS_CONSULT_SPAWN_TIMEOUT_MS ?? 30_000) || 30_000;
const MAX_CONCURRENT =
	Number(process.env.SUSPENDERS_CONSULT_MAX_CONCURRENT ?? 2) || 2;
const BODY_CAP = 64 * 1024; // request body ceiling (readJsonCapped, 413 past it)
const OUT_CAP = 16 * 1024; // child output ceiling per stream (read capped)

let activeSpawns = 0;
const spawnWaiters: (() => void)[] = [];

// the ONE semaphore over every coord spawn this module performs. The slot
// TRANSFERS on release (no decrement when a waiter is woken) — arrivals
// cannot steal a granted slot between release and the waiter's microtask.
async function acquireSpawnSlot(): Promise<void> {
	if (activeSpawns < MAX_CONCURRENT) {
		activeSpawns++;
		return;
	}
	await new Promise<void>((done) => spawnWaiters.push(done));
}

function releaseSpawnSlot(): void {
	const next = spawnWaiters.shift();
	if (next) next(); // slot transfers — activeSpawns already counts it
	else activeSpawns--;
}

// bounded child: timeout kill + capped output read — a wedged CLI cannot hang
// the handler forever, a spewing one cannot buffer the board unboundedly
async function spawnCoordBounded(
	args: string[],
	cwd: string,
): Promise<{ code: number; out: string }> {
	await acquireSpawnSlot();
	try {
		const p = Bun.spawn([process.execPath, CLI("coord.ts"), ...args], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd,
		});
		let timedOut = false;
		let capped = false;
		const killTimer = setTimeout(() => {
			timedOut = true;
			p.kill();
		}, SPAWN_TIMEOUT_MS);
		try {
			const [stdout, stderr] = await Promise.all([
				readChildCapped(p.stdout, () => {
					capped = true;
				}),
				readChildCapped(p.stderr, () => {
					capped = true;
				}),
			]);
			// a capped stream means the child out-spewed the bound — kill it so
			// a spewing writer cannot outlive the read (no zombie risk)
			if (capped) p.kill();
			const code = await p.exited;
			return {
				code: timedOut ? 124 : (code ?? 1),
				out: timedOut
					? `coord CLI timed out after ${SPAWN_TIMEOUT_MS}ms`
					: `${stdout} ${stderr}`.trim(),
			};
		} finally {
			clearTimeout(killTimer);
		}
	} finally {
		releaseSpawnSlot();
	}
}

// read a child stream UP TO OUT_CAP then cancel (streams law: bounded reads);
// onCap fires when the bound was hit so the caller can kill the writer
async function readChildCapped(
	stream: ReadableStream<Uint8Array>,
	onCap: () => void,
): Promise<string> {
	const reader = stream.getReader();
	let size = 0;
	const chunks: Uint8Array[] = [];
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			chunks.push(value);
			if (size > OUT_CAP) {
				onCap();
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks).toString("utf8");
}

function gcMaps(now: number): void {
	for (const [k, hits] of windowHits) {
		const alive = hits.filter((t) => now - t < WINDOW_MS);
		if (alive.length === 0) windowHits.delete(k);
		else windowHits.set(k, alive);
	}
	for (const [k, v] of dedup) if (now - v.at > DEDUP_MS) dedup.delete(k);
}

function rateLimited(sid: string, now: number): boolean {
	const hits = (windowHits.get(sid) ?? []).filter((t) => now - t < WINDOW_MS);
	if (hits.length >= MAX_PER_WINDOW) {
		windowHits.set(sid, hits);
		return true;
	}
	hits.push(now);
	windowHits.set(sid, hits);
	return false;
}

const SID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/i;

// touchAgent: refresh (or mint) the agent's session row. A RUNNING row that
// is NOT an external agent (a real lane) refuses the takeover — the sid is
// identity, not a tag; so does a row bound to another project.
function touchAgent(sid: string, project: string): string | null {
	const now = Date.now();
	const row = db
		.query("SELECT project, role, state FROM sessions WHERE sid = ?")
		.get(sid) as
		| { project: string | null; role: string | null; state: string }
		| null;
	if (row) {
		// W947 (verdict #47393 finding 2): sid is identity, never a revive —
		// ANY non-external role refuses the takeover regardless of state (a
		// CLOSED lane sid is still a lane's identity).
		if (row.role !== "external")
			return "sid belongs to a non-external session";
		if (row.project && row.project !== project)
			return "sid is bound to another project";
		db.query(
			"UPDATE sessions SET hb = ?, state = 'RUNNING' WHERE sid = ?",
		).run(now, sid);
		return null;
	}
	db.query(
		"INSERT INTO sessions (sid, project, role, started_at, hb, state) VALUES (?, ?, 'external', ?, ?, 'RUNNING')",
	).run(sid, project, now, now);
	return null;
}

interface ConsultRow {
	id: number;
	state: string;
	answer: string | null;
	expert_sid: string | null;
}

function latestConsult(project: string, sid: string): ConsultRow | null {
	return db
		.query(
			"SELECT id, state, answer, expert_sid FROM consults WHERE project = ? AND asker_sid = ? ORDER BY id DESC LIMIT 1",
		)
		.get(project, sid) as ConsultRow | null;
}

// verdict #47393 finding 4: the dedup key is the FULL request identity —
// (sid, best/target, scope, q) — not (sid, q); two asks that differ in
// target or scope are different consults, never deduped into one.
function dedupKey(
	sid: string,
	best: boolean,
	target: string,
	scope: string,
	q: string,
): string {
	return `${sid}:${best ? "best" : target}:${scope}:${q}`;
}

function consultState(project: string, cid: string): string | null {
	const id = Number(cid.replace(/^C/i, ""));
	if (!Number.isInteger(id) || id <= 0) return null;
	const row = db
		.query("SELECT state FROM consults WHERE id = ? AND project = ?")
		.get(id, project) as { state: string } | null;
	return row?.state ?? null;
}

export async function handleConsultIngress(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/consult") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJsonCapped(req, BODY_CAP);
		if (!parsed.ok) return parsed.resp;
		const b = parsed.body as Record<string, unknown>;
		const project = String(b?.project ?? "").trim();
		const sid = String(b?.sid ?? "").trim();
		const q = String(b?.q ?? "").trim().slice(0, 4000);
		const scope = String(b?.scope ?? "").trim();
		const target = String(b?.target ?? "").trim();
		const best = b?.best === true;
		if (!project || !SID_RE.test(sid) || !q)
			return json({ ok: false, error: "project, sid and q are required" }, 400);
		if (!projectList().includes(project))
			return json({ ok: false, error: `unknown project: ${project}` }, 404);
		const agentErr = touchAgent(sid, project);
		if (agentErr) return json({ ok: false, error: agentErr }, 409);
		const now = Date.now();
		gcMaps(now);
		if (rateLimited(sid, now))
			return json({ ok: false, error: "rate limited; slow down" }, 429);
		const seen = dedup.get(dedupKey(sid, best, target, scope, q));
		if (seen) {
			// verdict #47393 finding 4: replay reads CURRENT consult state —
			// the dedup entry stores an id, never a frozen snapshot
			const cur = db
				.query(
					"SELECT state, answer, expert_sid FROM consults WHERE id = ? AND project = ?",
				)
				.get(seen.cid, project) as
				| { state: string; answer: string | null; expert_sid: string | null }
				| null;
			if (!cur)
				return json(
					{ ok: false, output: "deduped consult no longer exists" },
					502,
				);
			return json({
				ok: true,
				consult: `C${seen.cid}`,
				state: cur.state,
				...(cur.answer ? { answer: cur.answer } : {}),
				...(cur.expert_sid ? { expert: cur.expert_sid } : {}),
				deduped: true,
			});
		}
		// CLI arg shapes (coord consult usage): [--best] "<q>" |
		// <sid> <q> | bare "<q>" — argv carries q as ONE element; the CLI
		// joins positions, so no shell quoting is involved anywhere.
		const args = best
			? ["consult", "--best", q]
			: target
				? ["consult", target, q]
				: ["consult", q];
		if (scope) args.push("--scope", scope);
		args.push("--as", sid);
		const r = await spawnCoordBounded(args, project);
		if (r.code !== 0) {
			if (r.out.includes("no ranked expert"))
				// W923 already events the refusal inside the CLI — surface it
				// honestly instead of a 5xx so the agent can adapt its question.
				return json({
					ok: false,
					state: "REFUSED",
					why: "no ranked expert",
					output: r.out.slice(0, 400),
				});
			if (r.out.includes("consult queue is full"))
				return json(
					{ ok: false, state: "QUEUE_FULL", output: r.out.slice(0, 400) },
					429,
				);
			return json({ ok: false, output: r.out.slice(0, 400) }, 502);
		}
		const row = latestConsult(project, sid);
		if (!row) return json({ ok: false, output: r.out.slice(0, 400) }, 502);
		const resp = {
			ok: true,
			consult: `C${row.id}`,
			state: row.state,
			...(row.answer ? { answer: row.answer } : {}),
			...(row.expert_sid ? { expert: row.expert_sid } : {}),
		};
		dedup.set(dedupKey(sid, best, target, scope, q), {
			at: now,
			project,
			cid: row.id,
		});
		return json(resp);
	}
	if (req.method === "POST" && url.pathname === "/api/consult-reply") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJsonCapped(req, BODY_CAP);
		if (!parsed.ok) return parsed.resp;
		const b = parsed.body as Record<string, unknown>;
		const project = String(b?.project ?? "").trim();
		const sid = String(b?.sid ?? "").trim();
		const cid = String(b?.cid ?? "").trim();
		const answer = String(b?.answer ?? "").trim();
		const decline = b?.decline === true;
		if (!project || !SID_RE.test(sid) || !cid)
			return json(
				{ ok: false, error: "project, sid and cid are required" },
				400,
			);
		if (!answer && !decline)
			return json({ ok: false, error: "answer or decline required" }, 400);
		if (!projectList().includes(project))
			return json({ ok: false, error: `unknown project: ${project}` }, 404);
		const agentErr = touchAgent(sid, project);
		if (agentErr) return json({ ok: false, error: agentErr }, 409);
		const now = Date.now();
		gcMaps(now);
		if (rateLimited(sid, now))
			return json({ ok: false, error: "rate limited; slow down" }, 429);
		const args = decline
			? ["consult-reply", cid, "--decline"]
			: ["consult-reply", cid, answer];
		args.push("--as", sid);
		const r = await spawnCoordBounded(args, project);
		if (r.code !== 0) {
			if (r.out.includes("no such consult"))
				return json({ ok: false, error: `no such consult: ${cid}` }, 404);
			return json({ ok: false, output: r.out.slice(0, 400) }, 409);
		}
		return json({ ok: true, cid, state: consultState(project, cid) });
	}
	if (req.method === "POST" && url.pathname === "/api/broadcast") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJsonCapped(req, BODY_CAP);
		if (!parsed.ok) return parsed.resp;
		const b = parsed.body as Record<string, unknown>;
		const project = String(b?.project ?? "").trim();
		const sid = String(b?.sid ?? "").trim();
		const note = String(b?.note ?? "").trim().slice(0, 2000);
		if (!project || !SID_RE.test(sid) || !note)
			return json({ ok: false, error: "project, sid and note are required" }, 400);
		if (!projectList().includes(project))
			return json({ ok: false, error: `unknown project: ${project}` }, 404);
		const agentErr = touchAgent(sid, project);
		if (agentErr) return json({ ok: false, error: agentErr }, 409);
		const now = Date.now();
		gcMaps(now);
		if (rateLimited(sid, now))
			return json({ ok: false, error: "rate limited; slow down" }, 429);
		const r = await spawnCoordBounded(
			["broadcast", "--note", note, "--as", sid],
			project,
		);
		if (r.code !== 0)
			return json({ ok: false, output: r.out.slice(0, 400) }, 502);
		return json({ ok: true });
	}
	// GET /api/outbox/<sid>?project= — the pull face for WS-less agents: OPEN
	// consults addressed to the sid + its recent consult traffic. A read, never
	// a liveness touch — heartbeat moves on POSTs only.
	// W947 (verdict #47393 finding 1, CRITICAL): the outbox is a CREDENTIALED
	// read — the W264 guard (host allowlist + write token) extended to GET,
	// scoped to one project via the required ?project= param. A sid is not a
	// secret; the token is. Unknown-vs-quiet sids stay indistinguishable: both
	// answer the same empty-list shape.
	const m = url.pathname.match(/^\/api\/outbox\/([^/]+)$/);
	if (req.method === "GET" && m) {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const sid = decodeURIComponent(m[1] ?? "");
		if (!SID_RE.test(sid))
			return json({ ok: false, error: "bad sid" }, 400);
		const project = (url.searchParams.get("project") ?? "").trim();
		if (!projectList().includes(project))
			return json(
				{ ok: false, error: "known ?project= query param required" },
				400,
			);
		const consults = db
			.query(
				"SELECT id, asker_sid, question, scope, state, created_at FROM consults WHERE expert_sid = ? AND project = ? AND state = 'OPEN' ORDER BY id DESC LIMIT 20",
			)
			.all(sid, project) as {
			id: number;
			asker_sid: string;
			question: string;
			scope: string | null;
			state: string;
			created_at: number;
		}[];
		// events join through the consult id embedded in every payload — the
		// events table has no project column, so project-scoping rides the
		// consults table (subquery bounded: newest 50 consults of the project)
		const events = db
			.query(
				"SELECT id, ts, kind, payload FROM events WHERE target = ? AND kind IN ('consult','consult.answer','consult.feedback') AND json_extract(payload, '$.consult') IN (SELECT 'C' || id FROM consults WHERE project = ? ORDER BY id DESC LIMIT 50) ORDER BY id DESC LIMIT 20",
			)
			.all(sid, project) as {
			id: number;
			ts: number;
			kind: string;
			payload: string | null;
		}[];
		return json({
			ok: true,
			sid,
			consults: consults.map((c) => ({ ...c, consult: `C${c.id}` })),
			events,
		});
	}
	return null;
}
