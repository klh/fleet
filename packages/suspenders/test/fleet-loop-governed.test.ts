// test/fleet-loop-governed.test.ts — W1119.2: the fleet-loop dispatch verb
// governs its lanes — a live front mints a scoped key + attributes the lane
// env (0600 meta file); a dead front or a failed mint refuses fail-closed
// (claim released to READY, nothing spawned).
import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectIdentity } from "../hooks/lib/govdb/govdb.ts";
import { laneSid } from "../hooks/lib/lanes/laneslug.ts";
import { dispatchHarness, stubBuckle } from "./helpers/dispatch-harness.ts";

const h = dispatchHarness(afterAll, {
	tag: "w1119-2-governed",
	beltEnv: true,
	executorBody: `#!/usr/bin/env bun
await Bun.write(process.env.HOME + "/lane-env.json", JSON.stringify({
	base: process.env.ANTHROPIC_BASE_URL,
	token: process.env.ANTHROPIC_AUTH_TOKEN,
}));
await Bun.sleep(15000);
`,
});

test("W1119.2 fleet-loop governed: live front mints scoped key + attributes lane env", async () => {
	const stub = stubBuckle(true);
	const id = await h.addItem("governed fleet-loop dispatch");
	const r = await h.toolA(
		{
			SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
			SUSPENDERS_BELT_ENV: join(h.HOME, "belt.env"),
		},
		"fleet-loop.ts",
		"dispatch",
		"--repo",
		h.REPO,
		"--item",
		id,
		"--agent",
		"claude",
	);
	expect(r.out).toContain(`dispatched ${id} → `);
	const lane = JSON.parse(
		readFileSync(join(h.REPO, ".fleet", "lanes.json"), "utf8"),
	).find((l: { item: string }) => l.item === id);
	expect(lane).toBeDefined();
	const metaPath = join(h.REPO, ".fleet", `lane-key-${lane.sid}.json`);
	expect(statSync(metaPath).mode & 0o777).toBe(0o600);
	const meta = JSON.parse(readFileSync(metaPath, "utf8"));
	expect(meta.key_id).toBe("owned-key");
	const laneEnv = JSON.parse(
		readFileSync(join(h.HOME, "lane-env.json"), "utf8"),
	);
	expect(laneEnv.base).toBe(`http://127.0.0.1:${stub.port}/w/${lane.sid}`);
	expect(laneEnv.token).toBe("bksk_fixture_only");
	stub.stop();
});

test("W1119.2 fleet-loop governed: dead front refuses fail-closed", async () => {
	const id = await h.addItem("dead front refusal");
	const sid = laneSid(id, projectIdentity(h.REPO));
	const r = await h.toolA(
		{},
		"fleet-loop.ts",
		"dispatch",
		"--repo",
		h.REPO,
		"--item",
		id,
		"--agent",
		"claude",
	);
	expect(r.code).toBe(1);
	expect(r.err).toContain(`REFUSED ${id}`);
	expect(r.err).toContain("buckle front unreachable");
	expect(existsSync(join(h.REPO, ".fleet", `lane-key-${sid}.json`))).toBe(
		false,
	);
	const show = JSON.parse(
		(await h.toolA({}, "work.ts", "show", id, "--json")).out,
	);
	expect(show.state).toBe("READY");
});

test("W1119.2 fleet-loop governed: failed mint refuses fail-closed", async () => {
	const stub = stubBuckle(false);
	const id = await h.addItem("mint fail refusal");
	const r = await h.toolA(
		{
			SUSPENDERS_BUCKLE_FRONT: `http://127.0.0.1:${stub.port}`,
			SUSPENDERS_BELT_ENV: join(h.HOME, "belt.env"),
		},
		"fleet-loop.ts",
		"dispatch",
		"--repo",
		h.REPO,
		"--item",
		id,
		"--agent",
		"claude",
	);
	expect(r.code).toBe(1);
	expect(r.err).toContain(`REFUSED ${id}`);
	expect(r.err).toContain("buckle lane-key mint failed");
	expect(stub.calls).toContain("POST /v1/admin/keys");
	stub.stop();
});
