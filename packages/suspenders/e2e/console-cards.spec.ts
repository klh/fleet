// e2e/console-cards.spec.ts — W669.11: the console data cards (routing
// policy, upstream pool, .local registry, board knobs, admin audit) upgrade
// from their esc(JSON) data attributes and render tokens-styled shadow DOM
// (UI law). Render-and-look against a real fleet-board.ts (scratch HOME —
// policy missing, registry empty: the cards' degraded states are the
// fixture). Screenshots land in /tmp/w66911-shots.
// W1136: rides the shared fixtures — worker board + the auto pageWatcher
// (the local watch() copy is gone); the beforeAll(startBoard) copy is gone.
import { mkdirSync } from "node:fs";
import { expect, test } from "./fixtures";

const SHOTS = "/tmp/w66911-shots";

test("belt console: policy + upstream-pool cards upgrade and render", async ({
	page,
	board,
}) => {
	mkdirSync(SHOTS, { recursive: true });
	await page.goto(`${board.BASE}/console/buckle`);
	const network = page.locator("klh-network-card");
	const inventory = page.locator("details.consoleInventory");
	await expect(network).toBeVisible();
	await expect(inventory).not.toHaveAttribute("open", "");
	await expect(page.locator("klh-policy-card")).not.toBeVisible();
	await inventory.locator("summary").click();
	// the scratch board still resolves the committed-default policy (the walk
	// ends at the repo checkout) — the card renders the resolved ladder
	const policy = page.locator("klh-policy-card");
	await expect(policy).toBeVisible();
	await expect(
		policy.getByText(/Routing policy · .* · source: /),
	).toBeVisible();
	await expect(policy.getByText(/num_retries/)).toBeVisible();
	// the fallback ladder table renders inside shadow DOM
	await expect(
		policy.getByText("fallback ladder (order = priority)"),
	).toBeVisible();
	const pool = page.locator("klh-upstreams-card");
	await expect(pool).toBeVisible();
	await expect(pool.getByText(/Configured upstream pool · /)).toBeVisible();
	// dormant groups ride the state column
	await expect(pool.getByText("dormant")).toBeVisible();
	await page.screenshot({ path: `${SHOTS}/belt-cards.png`, fullPage: true });
});

test("local page: registry card upgrades; settings: knobs + audit cards", async ({
	page,
	board,
}) => {
	await page.goto(`${board.BASE}/console/local`);
	const inventory = page.locator("details.consoleInventory");
	await expect(page.locator("klh-service-row").first()).toBeVisible();
	await expect(inventory).not.toHaveAttribute("open", "");
	await inventory.locator("summary").click();
	const reg = page.locator("klh-registry-card");
	await expect(reg).toBeVisible();
	await expect(reg.getByText(/Registered services · 0/)).toBeVisible();
	await expect(
		reg.getByText(/Route registration is configuration/),
	).toBeVisible();
	const service = page.locator("klh-service-row").first();
	await expect(service).toBeVisible();
	const evidence = service.locator("details.evidence");
	await expect(evidence.locator("summary")).toContainText(
		/\d{2}\.\d{2}\.\d{2} \d{2}:\d{2}/,
	);
	await expect(evidence.locator("summary")).toHaveAttribute("title", /UTC/);
	await evidence.locator("summary").click();
	await expect(evidence.locator(".evidenceBody")).toContainText("Source:");
	await page.screenshot({ path: `${SHOTS}/local-cards.png`, fullPage: true });

	await page.goto(`${board.BASE}/console/settings`);
	const knobs = page.locator("klh-knobs-card");
	await expect(knobs).toBeVisible();
	await expect(knobs.getByText(/suspenders-board\.json · /)).toBeVisible();
	await expect(knobs.getByText(/STATUS_REFRESH_S/)).toBeVisible();
	const audit = page.locator("klh-audit-list");
	await expect(audit).toBeVisible();
	await expect(audit.getByText(/no admin actions recorded yet/)).toBeVisible();
	await page.screenshot({
		path: `${SHOTS}/settings-cards.png`,
		fullPage: true,
	});
});
