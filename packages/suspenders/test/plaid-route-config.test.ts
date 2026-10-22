import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const home = mkdtempSync(join(tmpdir(), "plaid-config-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));
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
	const plaid = resolve(import.meta.dir, "../hooks/lib/plaid.ts");
	const board = resolve(import.meta.dir, "../hooks/lib/board-config.ts");
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
