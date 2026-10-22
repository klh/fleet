// e2e/hub-board.spec.ts — W353: Playwright e2e against TWO live fleet boards
// (real fleet-board.ts processes, scratch HOMEs, real work-graph CLI state):
//
//   1. the HUB board GUI shows a delegated item and tracks it through
//      declare → reconcile → done (row, pill, kanban column, drawer)
//   2. scope isolation: the LOCAL board's work never leaks into the hub
//      board GUI (and the local board does show it — positive control)
//
// The GUI is the real served page (Lit-free client chunks poll /api/tasks
// on a 1s tick); the tests never reload to see a transition — they watch
// the live page update itself, like an operator does.
// W1136: rides the shared fixtures — board + peerBoard (the hub/local two
// worlds, worker-scoped), the api fixture (no raw fetch), and the auto
// pageWatcher; the beforeAll(startBoard) copies are gone.
import { mkdirSync } from "node:fs";
import { expect, type Page, test } from "./fixtures";

test.describe.configure({ mode: "serial" });

const SHOTS = "/tmp/w353-shots";

async function openTasks(page: Page): Promise<void> {
	await page.getByRole("button", { name: "Tasks" }).click();
}

test("delegated item rides declare → reconcile → done on the hub board GUI", async ({
	page,
	board,
}) => {
	const H = board;
	mkdirSync(SHOTS, { recursive: true });
	const TITLE = "Delegate: reconcile hub policy manifest on the spoke";
	const ORIGIN = process.env.HUB_BOARD_ORIGIN ?? "nas.example.invalid:claude";

	// DECLARE — the hub declares a delegated work item on its own graph
	// (the CR wire channel that carries it to the spoke is W352's e2e; the
	// GUI sees the hub graph, so declare = a hub-side work item)
	const id = H.mintedId(
		H.workOk(
			[
				"add",
				TITLE,
				"--priority",
				"2",
				"--desc",
				"delegated via buckle CR channel",
			],
			"declare the delegated item",
		),
	);

	await page.goto(`${H.BASE}/`);
	await openTasks(page);
	const row = page.locator(`#tasksBody tr[data-tid="${id}"]`);
	await expect(row).toBeVisible();
	await expect(row).toContainText(TITLE);
	await expect(row.locator(".pill.ready")).toHaveText("Rready");
	await expect(row).toContainText(H.projShort);
	await page.screenshot({ path: `${SHOTS}/1-declared.png`, fullPage: true });

	// RECONCILE — the spoke claims it (status reports back as a hub-side
	// claim with the spoke's origin stamp)
	const hubTake = H.workOk(
		["take", id, "--as", "spoke-lane", "--origin", ORIGIN],
		"spoke reconciles the item into a lane",
	);
	// W643: the raw claim token prints once at take — present it to done
	const token = (hubTake.match(/claim token: (\S+)/) ?? [])[1] ?? "";
	expect(token, "no claim token in take output").not.toBe("");
	await expect(row.locator(".pill.run")).toHaveText("Cclaimed");
	await page.getByRole("button", { name: "Lanes" }).click();
	const card = page.locator(`#kanban .kcard[data-kid="${id}"]`);
	await expect(card).toBeVisible();
	const working = page.locator("#kanban .kcol", {
		has: page.locator("h3", { hasText: "working" }),
	});
	await expect(working.locator(`.kcard[data-kid="${id}"]`)).toBeVisible();
	await expect(card).toContainText(ORIGIN); // delegation provenance, on the card
	await page.screenshot({ path: `${SHOTS}/2-reconciled.png`, fullPage: true });

	// DONE — the spoke closes it; the hub GUI moves it to done
	const SHA = "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3";
	H.workOk(
		["done", id, "--as", "spoke-lane", "--sha", SHA, "--token", token],
		"spoke reports done up to the hub graph",
	);
	await openTasks(page);
	await expect(row).toHaveCount(0); // done rows leave the live list …
	await page.check("#taskDone"); // … unless completed is shown
	await expect(row).toBeVisible();
	await expect(row.locator(".pill.done")).toHaveText("Ddone");
	await page.getByRole("button", { name: "Lanes" }).click();
	await expect(
		page
			.locator("#kanban .kcol", {
				has: page.locator("h3", { hasText: "done" }),
			})
			.locator(`.kcard[data-kid="${id}"]`),
	).toBeVisible();

	// the drawer tells the whole story: DONE pill + the work.done timeline row
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

test("scope isolation: local work never leaks to the hub board", async ({
	page,
	board,
	peerBoard,
	api,
}) => {
	const H = board;
	const L = peerBoard;
	const LOCAL_TITLE = "LOCAL-ONLY: spoke-private item — never on the hub board";

	// positive control: the LOCAL board shows the local item
	const localId = L.mintedId(
		L.workOk(["add", LOCAL_TITLE], "declare a local-only item"),
	);
	await page.goto(`${L.BASE}/`);
	await openTasks(page);
	const localRow = page.locator(`#tasksBody tr[data-tid="${localId}"]`);
	await expect(localRow).toBeVisible();
	await expect(localRow).toContainText(LOCAL_TITLE);

	// negative: the hub board GUI never shows it — not the id, not the title,
	// not the local project; absence must SURVIVE at least one 1s poll tick
	await page.goto(`${H.BASE}/`);
	await openTasks(page);
	await expect(page.locator(`#tasksBody`)).not.toContainText(LOCAL_TITLE);
	await expect(
		page.locator(`#tasksBody tr[data-tid="${localId}"]`),
	).toHaveCount(0);
	await expect(page.locator("#proj")).not.toContainText(L.projShort);
	await page.getByRole("button", { name: "Lanes" }).click();
	await expect(page.locator("#kanban")).not.toContainText(LOCAL_TITLE);
	await page.waitForTimeout(1600); // > one GUI poll tick — absence is stable
	await openTasks(page);
	await expect(page.locator(`#tasksBody`)).not.toContainText(LOCAL_TITLE);

	// API-level cross-check: the hub board server itself never serves it
	const feed = (await (await api.get("/api/tasks")).json()) as {
		tasks: Array<{ title: string }>;
	};
	const titles = feed.tasks.map((t) => t.title);
	expect(titles).not.toContain(LOCAL_TITLE);
	await page.screenshot({
		path: `${SHOTS}/4-scope-isolation.png`,
		fullPage: true,
	});
});
