// hooks/board/routes-note.ts — board note routing (/api/comment,
// /api/message): a board note to an item's owner/parent/supervisor over the
// coord bus — W1298: moved verbatim out of routes-actions by action family.
import { CLI, db } from "./context.ts";
import { json, readJson, writeGuard } from "./helpers.ts";
import { type OrchRoute, orchRecipient, orchTargets } from "./orch-targets.ts";

export async function handleNoteActions(
	req: Request,
	url: URL,
): Promise<Response | null> {
	if (req.method === "POST" && url.pathname === "/api/comment") {
		// W55 — review line-comments: route a board note to the item's
		// owning lane over the same coord path /api/answer uses. Mirrors
		// its guards (writeGuard + JSON-only body) and its emit shape
		// (spawnSync argument array, --as fleet-board). Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const file = String(parsed.body?.file ?? "")
			.trim()
			.slice(0, 500);
		const line = String(parsed.body?.line ?? "")
			.trim()
			.slice(0, 20);
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !file || !line || !note)
			return json({ ok: false, error: "missing id, file, line or note" }, 400);
		const w = db
			.query(
				"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
			)
			.get(id) as { owner_sid: string | null } | null;
		if (!w) return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!w.owner_sid)
			return json(
				{ ok: false, error: `work item ${id} has no owning lane` },
				404,
			);
		const full = `review ${id} ${file}:${line} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				w.owner_sid,
				"--note",
				full,
				"--as",
				"fleet-board",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json(
				{ ok: false, output: out.slice(0, 400), to: w.owner_sid },
				500,
			);
		return json({ ok: true, to: w.owner_sid });
	}
	if (req.method === "POST" && url.pathname === "/api/message") {
		// W76 — message-to-lane: a general board note routed to the owning
		// lane over coord, emitted as the published coordinator identity
		// (fact `coordinator.sid`; fallback `fleet-board` when unset so the
		// route degrades to the /api/comment identity, never to "unknown").
		// Mirrors /api/comment's guards and emit shape. Unknown or
		// ownerless item = 404.
		const guard = writeGuard(req, url);
		if (guard) return guard;
		const parsed = await readJson(req);
		if (!parsed.ok) return parsed.resp;
		const id = String(parsed.body?.id ?? "");
		const project = String(parsed.body?.project ?? "");
		const route = String(parsed.body?.target ?? "lane");
		const note = String(parsed.body?.note ?? "")
			.trim()
			.slice(0, 2000);
		if (!id || !note)
			return json({ ok: false, error: "missing id or note" }, 400);
		if (route !== "lane" && route !== "parent" && route !== "supervisor")
			return json({ ok: false, error: "unknown message target" }, 400);
		if (route !== "lane" && !project)
			return json(
				{ ok: false, error: "project required for routed message" },
				400,
			);
		const targets = project ? orchTargets(db, project, id) : null;
		const legacy = !project
			? (db
					.query(
						"SELECT owner_sid FROM work_items WHERE id = ? ORDER BY updated_at DESC LIMIT 1",
					)
					.get(id) as { owner_sid: string | null } | null)
			: null;
		if (project && !targets)
			return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		if (!project && !legacy)
			return json({ ok: false, error: `unknown work item: ${id}` }, 404);
		const to = targets
			? orchRecipient(targets, route as OrchRoute)
			: (legacy?.owner_sid ?? null);
		if (!to)
			return json(
				{ ok: false, error: `work item ${id} has no ${route} recipient` },
				404,
			);
		const as =
			(
				db
					.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
					.get() as { value: string } | null
			)?.value ?? "fleet-board";
		const full = `board ${id}${project ? ` (${project})` : ""} — ${note}`;
		const p = Bun.spawnSync(
			[
				process.execPath,
				CLI("coord.ts"),
				"emit",
				"NOTE",
				"--to",
				to,
				"--note",
				full,
				"--as",
				as,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const out = `${p.stdout.toString()} ${p.stderr.toString()}`.trim();
		if (p.exitCode !== 0)
			return json({ ok: false, output: out.slice(0, 400), to }, 500);
		return json({ ok: true, to, as, target: route });
	}
	return null;
}
