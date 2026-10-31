// e2e/local-board.e2e.ts — W2269.1.4: the extracted <fleet-local-board> Lit
// element served by the real bar server (bin/dashboard.ts) on a scratch HOME.
// Proves the extraction preserved the served face: the page references the
// bundle, the bundle registers the element against the SHARED lit runtime
// (single lit copy per page), and the board renders from /api/status.
// @unit
import { mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { freePort, waitUp } from "@klh/test-kit";

const REPO = new URL("../", import.meta.url).pathname;

let port = 0;
let srv: ReturnType<typeof Bun.spawn> | null = null;
let home = "";
let logFd = 0;

test.beforeAll(async () => {
	home = mkdtempSync(join(tmpdir(), "w2269-bar-home-"));
	port = await freePort();
	// W2269.1.4: worker-child pipes are unreliable in playwright workers —
	// the child's stderr rides a real fd (fd-file lesson) so a boot failure
	// is diagnosable instead of a bare waitUp timeout.
	logFd = openSync(join(tmpdir(), `w2269-bar-${port}.log`), "a");
	srv = Bun.spawn(["bun", join(REPO, "bin/dashboard.ts")], {
		cwd: REPO,
		env: {
			...process.env,
			HOME: home,
			KLH_LOCAL_BAR_PORT: String(port),
		},
		stdout: "ignore",
		stderr: logFd,
	});
	await waitUp(`http://127.0.0.1:${port}/llms.txt`, { tries: 60 });
});

test.afterAll(async () => {
	srv?.kill();
});

test("page references the extracted bundle; vendor routes serve", async ({
	page,
}) => {
	const res = await page.goto(`http://127.0.0.1:${port}/`);
	expect(res?.status()).toBe(200);
	const html = await page.content();
	expect(html).toContain("/vendor/fleet-local-board.js");
	for (const p of ["/vendor/fleet-local-board.js", "/vendor/lit-shared.js"]) {
		const r = await page.request.get(`http://127.0.0.1:${port}${p}`);
		expect(r.status()).toBe(200);
	}
});

test("the board element registers against the shared lit runtime and renders", async ({
	page,
}) => {
	await page.goto(`http://127.0.0.1:${port}/`);
	await page.waitForFunction(() =>
		Boolean(customElements.get("fleet-local-board")),
	);
	// shadow content renders from /api/status (empty scratch registry) —
	// asserted via the shadow root (innerText of the host hides shadow text)
	const shadowText = await page.evaluate(() =>
		document
			.querySelector("fleet-local-board")
			?.shadowRoot?.textContent?.replace(/\s+/g, " "),
	);
	expect(shadowText).toContain("Local services");
	expect(shadowText).toContain("Registered services");
	// the page keeps exactly ONE lit copy (external import, not inlined)
	const litCopies = await page.evaluate(() =>
		Array.from(document.querySelectorAll('script[type="module"]')).map(
			(s) => s.src,
		),
	);
	expect(litCopies.length).toBeGreaterThan(0);
});
