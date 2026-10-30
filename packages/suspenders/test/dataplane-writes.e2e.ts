// dataplane-writes.e2e.ts — W2328 co-situated proof: dataplane v0.1 writes
// end to end against a scratch world. The real door
// (hooks/bin/dataplane-api.ts) spawns as a child with a stubbed buckle
// verify leg (serveStub answers /v1/admin/keys/verify), a scratch HOME
// (governor.db isolated), and a scratch fleet root (.fleet/lanes.json with a
// provably-live fixture lane — fresh transcript under the scratch HOME).
// Parity contract: every dataplane mutation emits the same event kind the
// CLI verb emits, asserted through the dataplane's own Events/List.

import { spawn } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, scratchWorld, serveStub, waitUp } from "@klh/test-kit";
import { expect, test } from "@playwright/test";
import { projectIdentity } from "../hooks/lib/govdb/govdb-project.ts";

const READ_KEY = "bksk_test_dp_writes_read";
const WRITE_KEY = "bksk_test_dp_writes_write";

const verifyStub = serveStub((_req, body) => {
	const key = typeof body?.key === "string" ? body.key : "";
	if (key === WRITE_KEY)
		return Response.json({
			valid: true,
			key_id: "kw",
			scopes: ["buckle:dataplane:WRITE_"],
		});
	if (key === READ_KEY)
		return Response.json({
			valid: true,
			key_id: "kr",
			scopes: ["buckle:dataplane:READ_"],
		});
	return Response.json({ valid: false, code: "key_not_found" });
});

const world = scratchWorld({ prefix: "dataplane-writes-" });
const fleetRoot = world.repo;
mkdirSync(join(fleetRoot, ".fleet"), { recursive: true });
mkdirSync(join(world.home, ".claude", "projects", "scratch"), {
	recursive: true,
});
const TRANSCRIPT = join(
	world.home,
	".claude",
	"projects",
	"scratch",
	"lane-live.jsonl",
);
writeFileSync(TRANSCRIPT, "seed\n");
// registry: one provably-live lane (fresh transcript under the door's HOME →
// transcriptAlive) + one dead (pid absent from every process table)
writeFileSync(
	join(fleetRoot, ".fleet", "lanes.json"),
	JSON.stringify([
		{
			sid: "lane-live",
			item: "W1",
			branch: "suspenders/W1",
			worktree: join(fleetRoot, ".worktrees", "W1"),
			launchedAt: Date.now() - 60_000,
		},
		{
			sid: "lane-dead",
			item: "W2",
			branch: "suspenders/W2",
			pid: 999_997,
			worktree: join(fleetRoot, ".worktrees", "W2"),
		},
	]),
);

const port = await freePort();
const door = spawn(
	"bun",
	[
		join(import.meta.dir, "..", "hooks", "bin", "dataplane-api.ts"),
		"--port",
		String(port),
	],
	{
		cwd: fleetRoot,
		env: {
			...world.env,
			SUSPENDERS_DATAPLANE_FLEET_ROOT: fleetRoot,
			SUSPENDERS_DATAPLANE_VERIFY_URL: verifyStub.url,
			SUSPENDERS_DATAPLANE_VERIFY_TOKEN: "bksk_test_admin",
			GOVERNOR_STORE_URL: "local",
			SUSPENDERS_SCRUB_DENYLIST: "0",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);
const base = `http://127.0.0.1:${port}`;
await waitUp(base);
const project = projectIdentity(fleetRoot);

const call = async (
	method: string,
	body: unknown,
	key = WRITE_KEY,
): Promise<{ status: number; json: unknown }> => {
	const r = await fetch(`${base}/${method}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(key ? { authorization: `Bearer ${key}` } : {}),
		},
		body: JSON.stringify(body ?? {}),
	});
	return { status: r.status, json: await r.json().catch(() => null) };
};

const eventsOf = async (kind: string): Promise<{ work: string }[]> => {
	const r = await call("fleet.coord.v1.Events/List", {
		filter: `kind = ${kind}`,
		page_size: 100,
	});
	return (r.json as { items: { id: string }[] }).items;
};

test("index documents the v0.1 write methods", async () => {
	const doc = (await (await fetch(base)).json()) as { methods: string[] };
	expect(doc.methods).toContain("fleet.work.v1.WorkItems/Create");
	expect(doc.methods).toContain("fleet.work.v1.WorkItems/Update");
	expect(doc.methods).toContain("fleet.work.v1.WorkItems/Delete");
	expect(doc.methods).toContain("fleet.coord.v1.Lanes/Message");
	expect(doc.methods).toContain("fleet.coord.v1.Lanes/Steer");
});

test("auth: READ_ key cannot Create (403), unauthenticated 401", async () => {
	const anon = await call(
		"fleet.work.v1.WorkItems/Create",
		{ title: "x" },
		null,
	);
	expect(anon.status).toBe(401);
	const ro = await call(
		"fleet.work.v1.WorkItems/Create",
		{ title: "x" },
		READ_KEY,
	);
	expect(ro.status).toBe(403);
});

test("Create: mints READY, work.added parity via Events/List", async () => {
	const r = await call("fleet.work.v1.WorkItems/Create", {
		title: "dataplane-minted item",
		priority: 7,
		tags: ["fleet", "api"],
		description: "from the dataplane",
	});
	expect(r.status).toBe(200);
	const row = r.json as { id: string; state: string; priority: number };
	expect(row.state).toBe("READY");
	expect(row.priority).toBe(7);
	const added = await eventsOf("work.added");
	expect(added).toHaveLength(1);
	expect(added[0]?.work).toBe(row.id);
});

test("Update: mask'd fields edit, work.edited parity; unchanged edit emits nothing", async () => {
	const made = await call("fleet.work.v1.WorkItems/Create", {
		title: "update-target",
	});
	const id = (made.json as { id: string }).id;
	const up = await call("fleet.work.v1.WorkItems/Update", {
		name: `projects/${encodeURIComponent(project)}/workItems/${id}`,
		title: "renamed via dataplane",
		priority: 3,
		reason: "w2328 proof",
	});
	expect(up.status).toBe(200);
	const body = up.json as {
		work_item: { title: string; priority: number };
		changed: Record<string, { to: string | number }>;
	};
	expect(body.work_item.title).toBe("renamed via dataplane");
	expect(body.work_item.priority).toBe(3);
	expect(Object.keys(body.changed).sort()).toEqual(["priority", "title"]);
	const edited = await eventsOf("work.edited");
	expect(edited).toHaveLength(1);
	expect(edited[0]?.work).toBe(id);

	const noop = await call("fleet.work.v1.WorkItems/Update", {
		name: `projects/${encodeURIComponent(project)}/workItems/${id}`,
		title: "renamed via dataplane",
	});
	expect(noop.status).toBe(200);
	expect(Object.keys((noop.json as { changed: object }).changed)).toHaveLength(
		0,
	);
	expect(await eventsOf("work.edited")).toHaveLength(1);

	const badMask = await call("fleet.work.v1.WorkItems/Update", {
		name: `projects/${encodeURIComponent(project)}/workItems/${id}`,
		update_mask: ["state"],
		title: "nope",
	});
	expect(badMask.status).toBe(400);
	expect(JSON.stringify(badMask.json)).toContain("state");
});

test("Delete: CANCELLED transition with work.cancelled parity; second delete 409", async () => {
	const made = await call("fleet.work.v1.WorkItems/Create", {
		title: "delete-target",
	});
	const id = (made.json as { id: string }).id;
	const del = await call("fleet.work.v1.WorkItems/Delete", {
		name: `projects/${encodeURIComponent(project)}/workItems/${id}`,
		note: "w2328 soft delete",
	});
	expect(del.status).toBe(200);
	expect((del.json as { state: string }).state).toBe("CANCELLED");
	const cancelled = await eventsOf("work.cancelled");
	expect(cancelled).toHaveLength(1);
	expect(cancelled[0]?.work).toBe(id);
	const again = await call("fleet.work.v1.WorkItems/Delete", {
		name: `projects/${encodeURIComponent(project)}/workItems/${id}`,
	});
	expect(again.status).toBe(409);
});

test("Message: directed NOTE event + receipt to a registry lane", async () => {
	const msg = await call("fleet.coord.v1.Lanes/Message", {
		name: "lanes/lane-live",
		text: "w2328 correction: re-read the brief",
		source: "coordinator",
	});
	expect(msg.status).toBe(200);
	const body = msg.json as { message_id: number; queued: boolean };
	expect(body.queued).toBe(true);
	const notes = await eventsOf("NOTE");
	expect(notes.length).toBeGreaterThanOrEqual(1);
});

test("Steer: dead lane 409, scrub refusal 409, live accept then rate-limit", async () => {
	const dead = await call("fleet.coord.v1.Lanes/Steer", {
		name: "lanes/lane-dead",
		text: "hello",
	});
	expect(dead.status).toBe(409);

	const secret = await call("fleet.coord.v1.Lanes/Steer", {
		name: "lanes/lane-live",
		// synthetic fixture; the assertion is that Steer refuses it
		text: "key sk-test-abcdef1234567890 refused", // scrub:allow
	});
	expect(secret.status).toBe(409);

	// fresh transcript under the door's HOME → lane-live reads alive
	utimesSync(TRANSCRIPT, new Date(), new Date());
	const ok = await call("fleet.coord.v1.Lanes/Steer", {
		name: "lanes/lane-live",
		text: "w2328 steer: check the new gate",
	});
	expect(ok.status).toBe(200);
	const ackBody = ok.json as { outcome: string; event_id: number | null };
	expect(["accepted", "pending"]).toContain(ackBody.outcome);

	const limited = await call("fleet.coord.v1.Lanes/Steer", {
		name: "lanes/lane-live",
		text: "w2328 second steer within the window",
	});
	expect(limited.status).toBe(409);
	expect(JSON.stringify(limited.json)).toContain("rate-limited");
});

test("Steer pause kill switch refuses with the paused detail", async () => {
	writeFileSync(join(fleetRoot, ".fleet", "steer-paused"), "w2328 proof");
	const paused = await call("fleet.coord.v1.Lanes/Steer", {
		name: "lanes/lane-dead",
		text: "hello",
	});
	expect(paused.status).toBe(409);
	expect(JSON.stringify(paused.json)).toContain("paused");
});

test.afterAll(() => {
	door.kill();
	verifyStub.close();
	world.clean();
});
