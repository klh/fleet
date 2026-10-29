// e2e/board-posture-panel.spec.ts — W1315.4: the board posture surface.
// Proves the full contract: guarded read (no token → 403 on POST), the
// configured panel view (entries, disabled badge state, .prefer override),
// the CAS save with 412-on-stale, persistence across a SERVER restart
// (stop + startBoard on the same scratch KLH_STACK) and a fresh browser
// page (browser restart), plus the un-migrated (configured:false) state.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { postureDocument } from "../hooks/lib/posture/posture.fixtures.ts";
import { type Board, startBoard } from "../test/helpers/board-harness";

const TOKEN = "posture-e2e-write-token-0123456789abcdef";
let board: Board | null = null;
let scratch: string;
let stackPath: string;
let tokenFile: string;
let project: string;
const env = (): NodeJS.ProcessEnv => ({
	KLH_STACK: stackPath,
	SUSPENDERS_WRITE_TOKEN_FILE: tokenFile,
});

test.beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), "board-posture-"));
	stackPath = join(scratch, "stack.json");
	tokenFile = join(scratch, "write-token");
	project = join(scratch, "proj");
	writeFileSync(tokenFile, TOKEN);
	mkdirSync(project, { recursive: true });
	writeFileSync(
		stackPath,
		JSON.stringify({ version: "e2e", postures: postureDocument() }),
	);
	// JSON-overlay dialect .prefer (starts with "{"): pins the effective
	// posture for this project to `development` while the base stays `plaid`
	writeFileSync(
		join(project, ".prefer"),
		JSON.stringify({ version: 1, selection: { posture: "development" } }),
	);
	board = await startBoard("posture-panel", { env: env() });
});

test.afterAll(async () => {
	if (board) await board.stop();
	rmSync(scratch, { recursive: true, force: true });
});

test("GET /api/posture renders configured view with override", async () => {
	if (!board) throw new Error("board not started");
	const res = await fetch(`${board.BASE}/api/posture`);
	expect(res.status).toBe(200);
	const body = await res.json();
	expect(body.configured).toBe(true);
	expect(body.selection.posture).toBe("plaid");
	expect(body.postures).toEqual(["plaid", "minimal", "development"]);
	const disabled = body.effective.entries.find(
		(e: { model: string }) => e.model === "disabled",
	);
	expect(disabled.disabled).toBe(true);
	const res2 = await fetch(
		`${board.BASE}/api/posture?project=${encodeURIComponent(project)}`,
	);
	const body2 = await res2.json();
	expect(body2.effective.overridden).toBe(true);
	expect(body2.effective.posture).toBe("development");
	expect(body2.effective.overrides[0]).toContain(".prefer");
});

test("POST without a write token is refused", async () => {
	if (!board) throw new Error("board not started");
	const res = await fetch(`${board.BASE}/api/posture/selection`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			selection: {
				fleet: "fleet",
				posture: "minimal",
				developmentOverride: false,
			},
			revision: "x".repeat(64),
		}),
	});
	expect(res.status).toBe(403);
});

test("CAS save persists across server restart + fresh browser", async ({
	page,
}) => {
	if (!board) throw new Error("board not started");
	const read = async () =>
		(await (await fetch(`${board.BASE}/api/posture`)).json()).selection.posture;
	expect(await read()).toBe("plaid");
	// node-side CAS save with the token header
	const view = await (await fetch(`${board.BASE}/api/posture`)).json();
	const save = await fetch(`${board.BASE}/api/posture/selection`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-klh-write-token": TOKEN,
		},
		body: JSON.stringify({
			selection: {
				fleet: "fleet",
				posture: "minimal",
				developmentOverride: false,
			},
			revision: view.revision,
		}),
	});
	expect(save.status).toBe(200);
	expect(await read()).toBe("minimal");
	// stale revision → 412, config untouched
	const stale = await fetch(`${board.BASE}/api/posture/selection`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-klh-write-token": TOKEN,
		},
		body: JSON.stringify({
			selection: {
				fleet: "fleet",
				posture: "development",
				developmentOverride: false,
			},
			revision: "0".repeat(64),
		}),
	});
	expect(stale.status).toBe(412);
	expect(await read()).toBe("minimal");
	// UI: fresh browser page shows the persisted selection
	await page.goto(`${board.BASE}/`);
	const panel = page.locator("klh-posture-panel");
	const summary = panel.locator("summary").first();
	await expect(summary).toContainText("Posture");
	await summary.click();
	const select = panel.locator("select");
	await expect(select).toHaveValue("minimal");
	// UI save through the same endpoint (rides the page's write cookie)
	await select.selectOption("development");
	await expect
		.poll(async () => read(), { intervals: [250, 500, 1_000] })
		.toBe("development");
	// server restart: same scratch stack, brand-new board process
	await board.stop();
	board = await startBoard("posture-panel-restart", { env: env() });
	expect(await read()).toBe("development");
	await page.goto(`${board.BASE}/`);
	await summary.click();
	await expect(panel.locator("select")).toHaveValue("development");
});

test("un-migrated stack renders configured:false and POST → 409", async () => {
	if (!board) throw new Error("board not started");
	const bare = join(scratch, "bare.json");
	writeFileSync(bare, JSON.stringify({ version: "e2e" }));
	const b2 = await startBoard("posture-unmigrated", {
		env: { KLH_STACK: bare, SUSPENDERS_WRITE_TOKEN_FILE: tokenFile },
	});
	try {
		const res = await fetch(`${b2.BASE}/api/posture`);
		const body = await res.json();
		expect(body.configured).toBe(false);
		expect(body.unconfiguredReason).toContain("not migrated");
		// the store's CAS check fires before the migration check — send the
		// CURRENT revision so the 409 path is the one under test
		const post = await fetch(`${b2.BASE}/api/posture/selection`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-klh-write-token": TOKEN,
			},
			body: JSON.stringify({
				selection: {
					fleet: "fleet",
					posture: "plaid",
					developmentOverride: false,
				},
				revision: body.revision,
			}),
		});
		expect(post.status).toBe(409);
	} finally {
		await b2.stop();
	}
});
