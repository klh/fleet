// e2e/fixtures.ts — W1136: the ONE extended test every e2e spec consumes.
// Replaces the per-spec beforeAll(startBoard) copies (23 of them) with:
//
//   board      — per-WORKER real fleet-board from the one shared harness
//   peerBoard  — lazy per-worker SECOND board for two-world specs
//                (hub/local scope isolation, core/entitled enterprise)
//   cleanBoard — a fresh scratch world per TEST (hermetic single-test specs)
//   pageWatcher— auto-attaches pageerror + console-error collection and
//                asserts clean at teardown — a GUI defect fails the test,
//                never test noise (the W353 watch() contract, fleet-wide)
//   api        — APIRequestContext pinned to the board BASE (kills raw fetch
//                cross-checks against the live board API)
//
// Boards are spawned per world, never one shared server — webServer stays
// out (W353 doctrine). Browsers resolve from the machine cache; the shared
// pre-flight lives in global-setup.ts.
import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { basename } from "node:path";
import { startBoard, type Board } from "./harness";

export { expect };
export type { Board };

/** startBoard options (env pins + board args), as a fixture option. */
export interface BoardOpts {
	env?: NodeJS.ProcessEnv;
	args?: string[];
}

type TestOptions = {
	boardOptions: BoardOpts;
	peerBoardOptions: BoardOpts;
	cleanBoardOptions: BoardOpts;
	/** console-error texts matching any of these are watcher-exempt (designed
	 *  noise only — a spec must name its exemptions in its header comment). */
	watcherIgnore: RegExp[];
};

type WorkerFixtures = {
	board: Board;
	peerBoard: Board;
};

type TestFixtures = {
	cleanBoard: Board;
	pageWatcher: undefined;
	api: APIRequestContext;
};

export const test = base.extend<TestFixtures & WorkerFixtures & TestOptions>({
	// board/peerBoardOptions are worker-scoped (the worker boards consume
	// them; test.use overrides happen at file/describe level only)
	boardOptions: [{}, { option: true, scope: "worker" }],
	peerBoardOptions: [{}, { option: true, scope: "worker" }],
	cleanBoardOptions: [{}, { option: true }],
	watcherIgnore: [[], { option: true }],

	board: [
		async ({ boardOptions }, use, workerInfo) => {
			const board = await startBoard(
				`w${workerInfo.workerIndex}-${workerInfo.project.name}`,
				boardOptions,
			);
			await use(board);
			await board.stop();
		},
		{ scope: "worker" },
	],

	// lazy: only the two-world specs (hub-board, board-ent-zone) pay for it
	peerBoard: [
		async ({ peerBoardOptions }, use, workerInfo) => {
			const peer = await startBoard(
				`w${workerInfo.workerIndex}-peer-${workerInfo.project.name}`,
				peerBoardOptions,
			);
			await use(peer);
			await peer.stop();
		},
		{ scope: "worker" },
	],

	cleanBoard: [
		async ({ cleanBoardOptions }, use, testInfo) => {
			const world = await startBoard(
				`t-${basename(testInfo.file, ".spec.ts")}`,
				cleanBoardOptions,
			);
			await use(world);
			await world.stop();
		},
		{ scope: "test" },
	],

	pageWatcher: [
		async ({ page, watcherIgnore }, use) => {
			const pageErrors: string[] = [];
			const consoleErrors: string[] = [];
			// the W775.1 ent-zone probes /api/entitlements + /api/enterprise at
			// connect and polls them for the life of the page — provider-less
			// those answer the DESIGNED honest 501 (the GUI probe keys on the
			// status), so the resource-load console noise those two endpoints
			// provoke is exempted, with the response listener proving every 501
			// is one of them
			const entProbe = /\/api\/(entitlements|enterprise)(\?|$)/;
			const seen501: string[] = [];
			page.on("response", (r) => {
				if (r.status() === 501) seen501.push(r.url());
			});
			page.on("pageerror", (e) => pageErrors.push(String(e)));
			page.on("console", (m) => {
				if (m.type() === "error") consoleErrors.push(m.text());
			});
			await use();
			expect(pageErrors, "uncaught page exceptions").toEqual([]);
			const rogue = consoleErrors.filter(
				(t) =>
					!(
						t.includes("status of 501") && seen501.some((u) => entProbe.test(u))
					) && !watcherIgnore.some((rx) => rx.test(t)),
			);
			expect(rogue, "console errors (ent-zone 501 noise exempted)").toEqual([]);
			expect(
				seen501.filter((u) => !entProbe.test(u)),
				"501s outside the ent-zone probe endpoints",
			).toEqual([]);
		},
		{ auto: true },
	],

	api: [
		async ({ board }, use) => {
			const api = await base.request.newContext({ baseURL: board.BASE });
			await use(api);
			await api.dispose();
		},
		{ scope: "test" },
	],
});
