// test/helpers/dispatch-next-kit.ts — the W145 dispatch-next suite's shared
// fixture face (W1271 1500-line split): the harness instance + the spawn and
// snapshot helpers the surface files share. bun:test isolates modules per
// test file, so the harness (and its afterAll cleanup) instantiates once per
// importing file — the same isolation the original file had.

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { test as pw } from "@playwright/test";
import { dispatchHarness } from "./dispatch-harness.ts";

// dual-runner hook pick (W1294 sweep ports): bun test injects globalThis.expect
// into suites; playwright does not — so this module-level harness instantiates
// once per importing file under EITHER runner without bun:test imports.
const G = globalThis as typeof globalThis & {
	afterAll?: (fn: () => void | Promise<void>) => void;
	expect?: unknown;
};
const bunAfterAll = G.afterAll;
const regAfterAll =
	typeof G.expect === "function" && typeof bunAfterAll === "function"
		? bunAfterAll
		: pw.afterAll;

const {
	HOME,
	REPO,
	BIN,
	executor,
	env,
	g,
	toolWith,
	dispatchWith,
	toolA,
	dispatchA,
	addItem,
} = dispatchHarness(regAfterAll, {
	tag: "w145-dispatch",
	beltEnv: true,
});

export const tool = (bin: string, ...args: string[]) =>
	toolWith({}, bin, ...args);

export const dispatch = (...args: string[]) => dispatchWith({}, ...args);

// W145: expire the launch-backoff fact so a resumed dispatch may launch
// again inside the same test.
export const expireLaunchHold = (id: string): void => {
	const db = new Database(
		join(HOME, ".cache", "claude-governor", "governor.db"),
	);
	db.query(
		"UPDATE facts SET value=json_set(value,'$.eligibleAt',0) WHERE key LIKE ?",
	).run(`dispatch.launch-backoff.%.${id}`);
	db.close();
};

// work show includes live wall-time attribution, which advances even when a
// read-only dispatch leaves the work row untouched.
export const workSnapshot = (id: string): Record<string, unknown> => {
	const row = JSON.parse(tool("work.ts", "show", id, "--json").out) as Record<
		string,
		unknown
	>;
	delete row.attribution;
	return row;
};

export {
	addItem,
	BIN,
	dispatchA,
	dispatchWith,
	env,
	executor,
	g,
	HOME,
	REPO,
	toolA,
	toolWith,
};
