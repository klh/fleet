// hooks/board/routes-consult.ts — W931 co-supervisor ingress: external
// agents (the ChatGPT co-supervisor connector, any HTTP client) get a
// universal identity on the coord plane over the EXISTING board wire. Auth
// stays the shared W264 perimeter (host allowlist + x-klh-write-token on
// every POST) — no new secret class by default. Handlers are thin HTTP
// adapters over the supported coord verbs (control-plane ops law):
// consult / consult-reply / broadcast spawn the CLI verbatim with cwd
// pinned to the requested project, so every consult carries the CLI's own
// KB/fact/lesson seams, W923 refusal events and W909 item links. The
// agent's plane identity is a long-lived session row (role "external")
// whose heartbeat this module refreshes on every call — live while the
// agent talks, swept honest when it goes quiet. Per-sid rate cap + 10-min
// answer dedup keep a chatty connector from storming the expert queue.
import { db, CLI } from "./context.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { projectList } from "./lanes.ts";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 10; // consult POSTs per sid per window
const DEDUP_MS = 10 * 60_000; // identical (sid, q) inside the window replays

const windowHits = new Map<string, number[]>();
const dedup = new Map<string, { at: number; resp: Record<string, unknown> }>();

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
		if (row.state === "RUNNING" && row.role !== "external")
			return "sid belongs to a live non-external session";
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

function consultState(project: string, cid: string): string | null {
	const id = Number(cid.replace(/^C/i, ""));
	if (!Number.isInteger(id) || id <= 0) return null;
	const row = db
		.query("SELECT state FROM consults WHERE id = ? AND project = ?")
		.get(id, project) as { state: string } | null;
	return row?.state ?? null;
}

function spawnCoord(args: string[], cwd: string): { code: number; out: string } {
	const p = Bun.spawnSync([process.execPath, CLI("coord.ts"), ...args], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		cwd,
	});
	return {
		code: p.exitCode ?? 1,
		out: `${p.stdout.toString()} ${p.stderr.toString()}`.trim(),
	};
}

export async function handleConsultIngress(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/consult") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "").trim();
		const sid = String(parsed.body?.sid ?? "").trim();
		const q = String(parsed.body?.q ?? "").trim().slice(0, 4000);
		const scope = String(parsed.body?.scope ?? "").trim();
		const target = String(parsed.body?.target ?? "").trim();
		const best = parsed.body?.best === true;
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
		const seen = dedup.get(`${sid}:${q}`);
		if (seen) return json({ ...seen.resp, deduped: true });
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
		const r = spawnCoord(args, project);
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
		dedup.set(`${sid}:${q}`, { at: now, resp });
		return json(resp);
	}
	if (req.method === "POST" && url.pathname === "/api/consult-reply") {
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "").trim();
		const sid = String(parsed.body?.sid ?? "").trim();
		const cid = String(parsed.body?.cid ?? "").trim();
		const answer = String(parsed.body?.answer ?? "").trim();
		const decline = parsed.body?.decline === true;
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
		const r = spawnCoord(args, project);
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
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const project = String(parsed.body?.project ?? "").trim();
		const sid = String(parsed.body?.sid ?? "").trim();
		const note = String(parsed.body?.note ?? "").trim().slice(0, 2000);
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
		const r = spawnCoord(["broadcast", "--note", note, "--as", sid], project);
		if (r.code !== 0)
			return json({ ok: false, output: r.out.slice(0, 400) }, 502);
		return json({ ok: true });
	}
	// GET /api/outbox/<sid> — the pull face for WS-less agents: OPEN consults
	// addressed to the sid + its recent consult traffic. A read, never a
	// liveness touch — heartbeat moves on POSTs only.
	const m = url.pathname.match(/^\/api\/outbox\/([^/]+)$/);
	if (req.method === "GET" && m) {
		const sid = decodeURIComponent(m[1] ?? "");
		if (!SID_RE.test(sid))
			return json({ ok: false, error: "bad sid" }, 400);
		const consults = db
			.query(
				"SELECT id, asker_sid, question, scope, state, created_at FROM consults WHERE expert_sid = ? AND state = 'OPEN' ORDER BY id DESC LIMIT 20",
			)
			.all(sid) as {
			id: number;
			asker_sid: string;
			question: string;
			scope: string | null;
			state: string;
			created_at: number;
		}[];
		const events = db
			.query(
				"SELECT id, ts, kind, payload FROM events WHERE target = ? AND kind IN ('consult','consult.answer','consult.feedback') ORDER BY id DESC LIMIT 20",
			)
			.all(sid) as {
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
