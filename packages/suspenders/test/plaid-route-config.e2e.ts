import { expect, test } from "./pw";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const home = mkdtempSync(join(tmpdir(), "plaid-config-"));
test.afterAll(() => rmSync(home, { recursive: true, force: true }));
const config = join(home, ".claude/local-llm/suspenders-board.json");
mkdirSync(join(home, ".claude/local-llm"), { recursive: true });
const row = (name: string) => ({
	name,
	label: name,
	executor: "claude",
	model: name,
	provider: "zai",
});

test("fresh process binds configured routes without setter; reload and board save preserve authority", () => {
	writeFileSync(config, JSON.stringify({ plaid_routes: [row("glm-one")] }));
	const plaid = resolve(import.meta.dir, "../hooks/lib/plaid/plaid.ts");
	const board = resolve(import.meta.dir, "../hooks/lib/board/board-config.ts");
	const script = [
		"import { Database } from 'bun:sqlite';",
		"import { writeFileSync } from 'node:fs';",
		"import { plaidRoutes, plaidHealth, plaidGate } from " +
			JSON.stringify(plaid) +
			";",
		"import { applyBoardSettings, readBoardSettings } from " +
			JSON.stringify(board) +
			";",
		"const db=new Database(':memory:'); db.run('CREATE TABLE facts (key TEXT PRIMARY KEY,value TEXT)');",
		"const first=plaidRoutes().map(r=>r.name);",
		"const health=[...plaidHealth(new Map()).keys()];",
		"const plan=plaidGate(db,[],new Map(),null).routes.map(r=>r.name);",
		`const c=${JSON.stringify(config)};`,
		"applyBoardSettings(c, { status_refresh_s: 7 });",
		"const saved=readBoardSettings(c).settings.plaid_routes.map(r=>r.name);",
		"writeFileSync(c,JSON.stringify({plaid_routes:" +
			JSON.stringify([row("glm-two")]) +
			"}));",
		"const changed=plaidRoutes().map(r=>r.name);",
		"writeFileSync(c,JSON.stringify({plaid_routes:[]})); const disabled=plaidRoutes();",
		"writeFileSync(c,JSON.stringify({plaid_routes:[null]})); let invalid=false;try{plaidRoutes()}catch{invalid=true}",
		"console.log(JSON.stringify({first,health,plan,saved,changed,disabled,invalid}));db.close();",
	].join("\n");
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(child.exitCode).toBe(0);
	expect(child.stderr.toString()).toBe("");
	expect(JSON.parse(child.stdout.toString())).toEqual({
		first: ["glm-one"],
		health: ["glm-one"],
		plan: ["glm-one"],
		saved: ["glm-one"],
		changed: ["glm-two"],
		disabled: [],
		invalid: true,
	});
});

test("local-coder: fresh process binds the declared local route; junk local rows fall back", () => {
	const plaid = resolve(import.meta.dir, "../hooks/lib/plaid/plaid.ts");
	const rc = resolve(
		import.meta.dir,
		"../hooks/lib/plaid/plaid-route-config.ts",
	);
	writeFileSync(
		config,
		JSON.stringify({
			plaid_routes: [
				{
					name: "local-coder",
					label: "Belt local coder",
					executor: "claude",
					model: "local-coder",
					provider: "local",
				},
				row("glm-one"),
			],
		}),
	);
	const script = [
		"import { Database } from 'bun:sqlite';",
		"import { plaidRoutes, plaidHealth, plaidDispatch, plaidModelHealth, PLAID_ROUTES } from " +
			JSON.stringify(plaid) +
			";",
		`import { validatePlaidRoutes } from ${JSON.stringify(rc)};`,
		"const db=new Database(':memory:'); db.run('CREATE TABLE facts (key TEXT PRIMARY KEY, value TEXT)');",
		"const pin = (mh) => plaidDispatch({store: db, sids: [], quota: new Map(), ordinal: 0, hub: null, routePin: 'local-coder', modelHealth: mh});",
		"const served = pin(plaidModelHealth(plaidRoutes(), ['local-coder']));",
		"const unserved = pin(plaidModelHealth(plaidRoutes(), []));",
		"const held = pin(null);",
		"const noProbe = plaidDispatch({store: db, sids: [], quota: new Map(), ordinal: 0, hub: null, routePin: 'local-coder'});",
		"const junk = (r) => plaidRoutes([r]) === PLAID_ROUTES;",
		"const thr = (fn) => { try { validatePlaidRoutes([fn]); return null; } catch (e) { return String(e.message); } };",
		"const out = {",
		"first: plaidRoutes().map(r => r.name),",
		"health: [...plaidHealth(new Map()).keys()],",
		"served: [served.skip, served.pick.model, served.pick.fallbackModels],",
		"unserved: unserved.skip,",
		"held: held.skip,",
		"noProbe: noProbe.skip,",
		"noModel: junk({name:'local-coder', executor:'claude', provider:'local'}),",
		"badProvider: junk({name:'x', executor:'claude', provider:'openai'}),",
		"badName: junk({name:'local-x', executor:'claude', provider:'zai'}),",
		"vNoModel: thr({name:'local-coder', executor:'claude', provider:'local'}),",
		"vBadProvider: thr({name:'x', executor:'claude', provider:'openai'}),",
		"vBadName: thr({name:'local-x', executor:'claude', provider:'zai'}),",
		"};",
		"console.log(JSON.stringify(out));db.close();",
	].join("\n");
	const child = Bun.spawnSync([process.execPath, "-e", script], {
		env: { ...process.env, HOME: home },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(child.exitCode).toBe(0);
	expect(child.stderr.toString()).toBe("");
	expect(JSON.parse(child.stdout.toString())).toEqual({
		first: ["local-coder", "glm-one"],
		health: ["local-coder", "glm-one"],
		served: [null, "local-coder", []],
		unserved: expect.stringContaining("not served"),
		held: expect.stringContaining("catalog unavailable"),
		noProbe: null,
		noModel: true,
		badProvider: true,
		badName: true,
		vNoModel: expect.stringContaining("must pin a model"),
		vBadProvider: expect.stringContaining("provider must be one of"),
		vBadName: expect.stringContaining("reserved for provider local"),
	});
});
