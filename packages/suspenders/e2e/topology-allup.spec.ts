// e2e/topology-allup.spec.ts — W373: the all-up topology e2e. ONE serial
// test riding the whole chain on REAL surfaces:
//
//   local dispatch (the real dispatch-next on a scratch spoke repo)
//     → buckle front /w/<sid> (a real buckle boot; the lane key is minted
//       AT the hub, and a real /v1/messages round-trip rides the front)
//     → hub buckle federation (real CR declare + signed manifest pull)
//     → hub board shows it (Playwright: tasks row, pill, kanban, drawer)
//     → spoke reconcile (the real federation-pull once + the W352 work-cr
//       reconcile into the spoke graph)
//     → done-status returns (applied on the hub CR queue; the origin
//       closes the mirror; the GUI rides it to done)
//
// The hub is the REAL buckle server boot; the federation seam rides the
// w7752 overlay fixture (the same HTTP-walk double the buckle federation
// e2e uses for the private enterprise overlay — the routes, db, signing
// and auth are the real hub surfaces). Everything else is the real
// process: dispatch-next, work.ts, work-cr.ts, federation-pull.ts,
// fleet-board.ts, and the served board page.
// W1136: rides the shared fixtures — the auto pageWatcher replaces the
// local watch() copy; the module-level hub world stays (it stands up a real
// buckle boot + federation seam, far more than one board).
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unusedPort } from "./harness";
import { dispatchHarness } from "../test/helpers/dispatch-harness.ts";
import { laneSid } from "../hooks/lib/laneslug.ts";
import { projectIdentity } from "../hooks/lib/govdb.ts";

test.describe.configure({ mode: "serial" });
test.setTimeout(300_000);

const SHOTS = "/tmp/w373-shots";
// break-glass root credential for the e2e hub — runtime env only, the
// same fixture-credential pattern as the buckle federation e2e ("e2e-root")
const HUB_ROOT = "w373-e2e-root";
const PKG = join(import.meta.dir, "..");
const FLEET = join(import.meta.dir, "..", "..", "..");

// ─── hub stand-up (real buckle boot + real board) ─────────────────────────

/** Copy the w7752 gov-seam fixture into an overlay dir with its manifest. */
async function writeOverlay(dir: string): Promise<void> {
	mkdirSync(dir, { recursive: true });
	const entry = join(dir, "entry.ts");
	await Bun.write(
		entry,
		await Bun.file(
			join(
				FLEET,
				"packages",
				"buckle",
				"test",
				"fixtures",
				"w7752-govseam-entry.ts",
			),
		).text(),
	);
	const digest = new Bun.CryptoHasher("sha256")
		.update(await Bun.file(entry).arrayBuffer())
		.digest("hex");
	await Bun.write(
		join(dir, "manifest.json"),
		JSON.stringify({
			name: "w373-topology",
			protocol: 1,
			entry: "entry.ts",
			sha256: digest,
		}),
	);
}

/** Poll a loopback surface until it answers /status. */
async function waitUp(base: string, what: string): Promise<void> {
	for (let i = 0; i < 200; i++) {
		try {
			if (
				(await fetch(`${base}/status`, { signal: AbortSignal.timeout(500) })).ok
			)
				return;
		} catch {}
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(`${what} did not start`);
}

/** Render-and-look guards ride the auto pageWatcher fixture (W1136). */
async function openTasks(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Tasks" }).click();
}

// ─── worlds ────────────────────────────────────────────────────────────────

// the stub upstream the hub rides for the LLM leg (anthropic wire)
const upstreamHits: string[] = [];
const upstream = Bun.serve({
	port: 0,
	fetch: async (req) => {
		const path = new URL(req.url).pathname;
		if (req.method === "POST" && path.endsWith("/v1/messages")) {
			const body = (await req.json()) as { model?: string };
			upstreamHits.push(body.model ?? "");
			return Response.json({
				id: "msg_w373",
				type: "message",
				role: "assistant",
				model: body.model ?? "glm-5.3-flash",
				content: [{ type: "text", text: "w373 all-up ride ok" }],
				stop_reason: "end_turn",
				usage: { input_tokens: 1, output_tokens: 2 },
			});
		}
		return new Response("not found", { status: 404 });
	},
});

const hubDir = mkdtempSync(join(tmpdir(), "w373-hub-"));
const HUB_PORT = unusedPort();
const HUB_BASE = `http://127.0.0.1:${String(HUB_PORT)}`;
await Bun.write(
	join(hubDir, "upstreams-override.yaml"),
	`version: 1
groups:
  glm-5.3-flash:
    - url: http://127.0.0.1:${String(upstream.port)}
      dialect: anthropic
`,
);
await writeOverlay(join(hubDir, "overlay"));

const hubProc = Bun.spawn(
	["bun", join(FLEET, "packages", "buckle", "src", "server.ts")],
	{
		cwd: hubDir,
		env: {
			...process.env,
			BUCKLE_PORT: String(HUB_PORT),
			// break-glass root credential (the boot law: without a root key
			// nothing can authenticate — see server.ts boot())
			BUCKLE_ROOT_KEY: HUB_ROOT,
			BUCKLE_AUTH: "on",
			BUCKLE_DB: join(hubDir, "hub.db"),
			BUCKLE_SECRETS_HOME: join(hubDir, "secrets"),
			KLH_OVERLAY_DIR: join(hubDir, "overlay"),
			KLH_OVERLAY_ALLOW: hubDir,
			BUCKLE_UPSTREAMS: join(hubDir, "upstreams-override.yaml"),
			HOME: hubDir,
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "ignore",
	},
);
{
	let hubLog = "";
	const drain = async (s: ReadableStream<Uint8Array>): Promise<void> => {
		for await (const chunk of s)
			hubLog = `${hubLog}${new TextDecoder().decode(chunk)}`.slice(-16_384);
	};
	void drain(hubProc.stdout);
	void drain(hubProc.stderr);
}

// the HUB board is the fixtures.ts `board` (real fleet-board process, its
// own scratch graph, per-worker) — the module-level startBoard copy is gone

// the SPOKE world: scratch repo + HOME + stub executor (dispatch-harness)
// (test.afterAll, not the bare bun:test hook — this file runs under the
// Playwright runner, where the bun:test globals do not exist)
const spoke = dispatchHarness(test.afterAll, {
	tag: "w373-spoke",
	executorBody:
		'#!/bin/sh\nenv > "$HOME/lane-env-dump"\necho $$ >> "$HOME/lane-pids"\nexec /bin/sleep 30\n',
	envOverrides: ({ HOME }) => ({
		ANTHROPIC_BASE_URL: undefined,
		SUSPENDERS_BELT_ENV: join(HOME, "belt.env"),
	}),
});

const PIDFILE = join(spoke.HOME, "lane-pids");
const ENVFILE = join(spoke.HOME, "lane-env-dump");

/** Reaper: never leave a sleep-30 lane behind between legs. */
function reapLanes(): void {
	try {
		for (const pid of readFileSync(PIDFILE, "utf8").trim().split("\n")) {
			try {
				process.kill(Number(pid));
			} catch {}
		}
	} catch {}
	rmSync(PIDFILE, { force: true });
	rmSync(ENVFILE, { force: true });
}

test.afterAll(async () => {
	reapLanes();
	hubProc.kill();
	await hubProc.exited;
	upstream.stop(true);
	rmSync(hubDir, { recursive: true, force: true });
});

test.beforeAll(async () => {
	mkdirSync(SHOTS, { recursive: true });
	await waitUp(HUB_BASE, "hub buckle");
});

// ─── the one all-up walk ───────────────────────────────────────────────────

test("all-up topology: dispatch → hub front → federation → board → reconcile → done returns", async ({
	page,
	board,
}) => {
	const H = board;
	mkdirSync(SHOTS, { recursive: true });

	// LEG 1 — local dispatch: a real dispatch-next with hub pinning; the
	// lane key is minted AT the hub (registry token = the hub root) and the
	// lane rides <hub>/w/<sid>.
	const regFile = join(spoke.HOME, "w373-hubs.json");
	await Bun.write(
		regFile,
		JSON.stringify({ HUB: { candidates: [HUB_BASE], token: HUB_ROOT } }),
	);
	// repo hub intent: the hub label + the one-off hub-url (most specific)
	writeFileSync(join(spoke.REPO, ".prefer"), `hub=HUB\nhub-url=${HUB_BASE}\n`);
	const spokeItem = await spoke.addItem(
		"w373 all-up: spoke lane rides the hub",
	);
	const disp = await spoke.dispatchA(
		{ SUSPENDERS_HUBS_FILE: regFile },
		"--item",
		spokeItem,
	);
	expect(disp.code, `dispatch failed: ${disp.err || disp.out}`).toBe(0);
	expect(disp.out).toContain("dispatched ");
	expect(disp.out).toContain(`hub HUB -> ${HUB_BASE} (prefer hub-url)`);
	// deterministic sid — the same formula dispatch used (laneslug.ts)
	const sid = laneSid(spokeItem, projectIdentity(spoke.REPO));
	expect(disp.out).toContain(`lane attribution: hub HUB /w/${sid}`);

	// the lane settings pin the hub front + the hub-minted scoped key
	const laneSettingsPath = join(
		spoke.REPO,
		".fleet",
		`lane-settings-${sid}.json`,
	);
	expect(existsSync(laneSettingsPath)).toBe(true);
	const laneSettings = JSON.parse(readFileSync(laneSettingsPath, "utf8")) as {
		env: Record<string, string>;
	};
	expect(laneSettings.env.ANTHROPIC_BASE_URL).toBe(`${HUB_BASE}/w/${sid}`);
	expect(laneSettings.env.ANTHROPIC_AUTH_TOKEN).toMatch(/^bksk_/);
	const laneKey = laneSettings.env.ANTHROPIC_AUTH_TOKEN;

	// LEG 2 — buckle front /w/<sid>: a real LLM round-trip through the
	// lane front with the lane key; the stub upstream answers, so the hub
	// really routed the lane's traffic.
	const ride = await fetch(`${HUB_BASE}/w/${sid}/v1/messages`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${laneKey}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "glm-5.3-flash",
			max_tokens: 32,
			messages: [{ role: "user", content: "w373" }],
		}),
	});
	expect(ride.status).toBe(200);
	const rideBody = (await ride.json()) as {
		content: Array<{ text: string }>;
	};
	expect(rideBody.content[0]?.text).toContain("w373 all-up ride ok");
	expect(upstreamHits.length).toBeGreaterThanOrEqual(1);
	// the executor's process env carried the hub pin too
	const envDump = existsSync(ENVFILE) ? readFileSync(ENVFILE, "utf8") : "";
	expect(envDump).toContain(`ANTHROPIC_BASE_URL=${HUB_BASE}/w/${sid}`);
	expect(envDump).toContain("SUSPENDERS_HUB=HUB");
	reapLanes();

	// LEG 3 — hub buckle federation: the hub mirror item + the real CR
	// declare (work-cr, buckle:admin:WRITE_) + a real spoke key mint, then
	// the signed manifest carries the CR.
	const hubItem = H.mintedId(
		H.workOk(
			[
				"add",
				"Delegate: reconcile hub policy manifest on the spoke",
				"--desc",
				"delegated via the buckle CR channel (w373 all-up)",
			],
			"hub declares the delegated item",
		),
	);
	const spokeKeyRes = await fetch(`${HUB_BASE}/v1/admin/keys`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${HUB_ROOT}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			name: "w373-spoke",
			scopes: ["buckle:spoke:READ_", "buckle:spoke:WRITE_"],
		}),
	});
	expect(spokeKeyRes.status).toBe(201);
	const spokeKey = ((await spokeKeyRes.json()) as { key: string }).key;
	expect(spokeKey).toMatch(/^bksk_/);

	const workCrEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
		...process.env,
		HOME: H.HOME,
		SUSPENDERS_MDNS: "0",
		SUSPENDERS_BELT_URL: "http://127.0.0.1:1",
		SUSPENDERS_LLM_URL: "http://127.0.0.1:1/v1/chat/completions",
		...extra,
	});
	const declare = Bun.spawnSync(
		[
			"bun",
			join(PKG, "hooks", "bin", "work-cr.ts"),
			"declare",
			hubItem,
			"--as",
			"w373-origin",
		],
		{
			cwd: H.MY_PROJ,
			env: workCrEnv({ BUCKLE_HUB_URL: HUB_BASE, BUCKLE_ADMIN_KEY: HUB_ROOT }),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const crId = `wcr-${hubItem}`;
	expect(
		declare.exitCode,
		`work-cr declare failed: ${declare.stderr.toString() || declare.stdout.toString()}`,
	).toBe(0);
	expect(declare.stdout.toString()).toContain(
		`declared ${crId} target=work@${hubItem} state=declared`,
	);

	// the signed manifest carries the CR (W193: detached JWS header)
	const manifest = await fetch(`${HUB_BASE}/federation/policy-manifest`, {
		headers: { authorization: `Bearer ${spokeKey}` },
	});
	expect(manifest.status).toBe(200);
	expect(manifest.headers.get("x-buckle-manifest-signature")).toMatch(/^ey/);
	const manBody = (await manifest.json()) as {
		cr_queue: Array<{ id: string; state: string }>;
	};
	expect(manBody.cr_queue.map((r) => r.id)).toContain(crId);

	// LEG 4 — the hub board shows it (tasks row, ready pill)
	await page.goto(`${H.BASE}/`);
	await openTasks(page);
	const row = page.locator(`#tasksBody tr[data-tid="${hubItem}"]`);
	await expect(row).toBeVisible();
	await expect(row).toContainText(
		"Delegate: reconcile hub policy manifest on the spoke",
	);
	await expect(row.locator(".pill.ready")).toHaveText(/ready/);
	await page.screenshot({ path: `${SHOTS}/1-declared.png`, fullPage: true });

	// LEG 5 — spoke reconcile: the real federation-pull once rides the hub
	// (pull + reconcile + status reports). The delegated item lands READY in
	// the spoke graph; the CR reports applied back to the hub.
	mkdirSync(join(spoke.HOME, "federation"), { recursive: true });
	const pull = Bun.spawnSync(
		["bun", join(PKG, "hooks", "bin", "federation-pull.ts"), "once"],
		{
			cwd: spoke.REPO,
			env: {
				...process.env,
				HOME: spoke.HOME,
				BUCKLE_HUB_URL: HUB_BASE,
				BUCKLE_SPOKE_TOKEN: spokeKey,
				BUCKLE_SECRETS_HOME: join(spoke.HOME, "federation"),
				SUSPENDERS_MDNS: "0",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const pullOut = pull.stdout.toString();
	expect(
		pull.exitCode,
		`federation-pull failed: ${pull.stderr.toString() || pullOut}`,
	).toBe(0);
	expect(pullOut).toContain(
		"work-cr: scanned=1 delivered=1 applied=1 failed=0",
	);

	// the delegated item sits READY in the spoke graph with carried title
	const show = spoke.tool("work.ts", "show", crId);
	expect(show.code, `work show failed: ${show.err || show.out}`).toBe(0);
	expect(show.out).toContain(crId);
	expect(show.out).toContain("READY");
	expect(show.out).toContain(
		"Delegate: reconcile hub policy manifest on the spoke",
	);
	// done-status returned: the hub CR queue holds the applied state
	const crList = Bun.spawnSync(
		["bun", join(PKG, "hooks", "bin", "work-cr.ts"), "list"],
		{
			cwd: H.MY_PROJ,
			env: workCrEnv({ BUCKLE_HUB_URL: HUB_BASE, BUCKLE_ADMIN_KEY: HUB_ROOT }),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(crList.exitCode).toBe(0);
	expect(crList.stdout.toString()).toContain(`${crId}\t`);
	expect(crList.stdout.toString()).toContain("applied");
	await page.screenshot({ path: `${SHOTS}/2-reconciled.png`, fullPage: true });

	// LEG 6 — done-status returns all the way: the spoke closes the
	// delegated item, the origin reads `applied` off the wire and closes the
	// mirror, and the hub GUI rides declare → done with the evidence.
	const SHA = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3";
	const takeOut = spoke.tool("work.ts", "take", crId, "--as", "w373-spoke");
	expect(takeOut.code, `spoke take failed: ${takeOut.err || takeOut.out}`).toBe(
		0,
	);
	// W643: the raw claim token prints once at take — present it to done
	const token = (takeOut.out.match(/claim token: (\S+)/) ?? [])[1] ?? "";
	expect(token, "no claim token in take output").not.toBe("");
	const spokeDone = spoke.tool(
		"work.ts",
		"done",
		crId,
		"--as",
		"w373-spoke",
		"--sha",
		SHA,
		"--token",
		token,
	);
	expect(
		spokeDone.code,
		`spoke done failed: ${spokeDone.err || spokeDone.out}`,
	).toBe(0);
	// the origin lane closes the mirror on the wire evidence (applied)
	const hubTake = H.workOk(
		["take", hubItem, "--as", "w373-origin"],
		"origin takes mirror",
	);
	const hubToken = (hubTake.match(/claim token: (\S+)/) ?? [])[1] ?? "";
	expect(hubToken, "no claim token at hub take").not.toBe("");
	H.workOk(
		["done", hubItem, "--as", "w373-origin", "--sha", SHA, "--token", hubToken],
		"origin closes the mirror after applied",
	);
	await openTasks(page);
	await expect(row).toHaveCount(0); // done rows leave the live list …
	await page.check("#taskDone"); // … unless completed is shown
	await expect(row).toBeVisible();
	await expect(row.locator(".pill.done")).toHaveText(/done/);
	await page.getByRole("button", { name: "Lanes" }).click();
	await expect(
		page
			.locator("#kanban .kcol", {
				has: page.locator("h3", { hasText: "done" }),
			})
			.locator(`.kcard[data-kid="${hubItem}"]`),
	).toBeVisible();
	await openTasks(page);
	await page.check("#taskDone");
	await row.locator(".tidbtn").click();
	const drawer = page.locator("#drawer");
	await expect(drawer).toBeVisible();
	await expect(drawer.locator(".pill.done")).toBeVisible();
	await expect(drawer).toContainText("work.done");
	await expect(drawer).toContainText(SHA.slice(0, 7));
	await page.screenshot({ path: `${SHOTS}/3-done.png`, fullPage: true });
});
