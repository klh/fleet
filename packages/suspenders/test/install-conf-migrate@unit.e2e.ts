import { expect, test } from "@playwright/test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateConf } from "../scripts/install/install-conf-migrate.ts";
import type { StepContext } from "../scripts/install/install-run.ts";

/** W2582: the machine stack document the cutover migrates — carries the
 *  incident's sections (route_preflight/admin/knowledge) so the migrated
 *  settings.json must cover them. */
const stackDoc = {
	version: "9.9.9",
	hubs: { nas: { host: "kk@nas.example", url: "https://nas.example:4101" } },
	route_preflight: { terminal_origins: ["http://127.0.0.1:11434"] },
	admin: { gui: true },
	knowledge: { distill: { enabled: true, model_group: "glm-5.3" } },
	lane_target: 20,
};

const fixture = () => {
	const home = mkdtempSync(join(tmpdir(), "fleet-conf-migrate-"));
	const llm = join(home, ".claude", "local-llm");
	mkdirSync(llm, { recursive: true });
	const yaml = join(llm, "upstreams.yaml");
	const json = join(llm, "upstreams.json");
	const env = join(llm, "buckle-spoke.env");
	const ctx = {
		home,
		dryRun: false,
	} as StepContext;
	return { ctx, yaml, json, env };
};

test.describe("Buckle spoke config migration", () => {
	test("moves upstreams to JSON and rewrites the spoke env pointer at mode 600", async () => {
		const f = fixture();
		writeFileSync(f.yaml, "groups: {}\n", { mode: 0o600 });
		writeFileSync(
			f.env,
			`BUCKLE_ROOT_KEY=untouched\nBUCKLE_UPSTREAMS=${f.yaml}\n`,
			{ mode: 0o600 },
		);
		const result = await migrateConf(f.ctx);
		expect(result.status).toBe("ok");
		expect(readFileSync(f.env, "utf8")).toBe(
			`BUCKLE_ROOT_KEY=untouched\nBUCKLE_UPSTREAMS=${f.json}\n`,
		);
		expect(statSync(f.env).mode & 0o777).toBe(0o600);
		expect(readFileSync(f.json, "utf8")).toContain('"groups"');
	});

	test("repairs a stale pointer on a later install after JSON already exists", async () => {
		const f = fixture();
		writeFileSync(f.json, "{}\n", { mode: 0o600 });
		writeFileSync(f.env, `BUCKLE_UPSTREAMS=${f.yaml}\n`, { mode: 0o600 });
		expect((await migrateConf(f.ctx)).status).toBe("ok");
		expect(readFileSync(f.env, "utf8")).toBe(`BUCKLE_UPSTREAMS=${f.json}\n`);
	});

	test("preserves an explicit nondefault upstream path", async () => {
		const f = fixture();
		writeFileSync(f.json, "{}\n", { mode: 0o600 });
		writeFileSync(f.env, "BUCKLE_UPSTREAMS=/custom/upstreams.yaml\n", {
			mode: 0o600,
		});
		expect((await migrateConf(f.ctx)).status).toBe("ok");
		expect(readFileSync(f.env, "utf8")).toBe(
			"BUCKLE_UPSTREAMS=/custom/upstreams.yaml\n",
		);
	});
});

test.describe("Settings cutover (W2582)", () => {
	const confDir = (home: string) => join(home, ".config", "klh");

	test("stack-only home migrates now: settings.json written 0600 covering the stack sections", async () => {
		const f = fixture();
		const dir = confDir(f.ctx.home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "stack.json"),
			`${JSON.stringify(stackDoc, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const result = await migrateConf(f.ctx);
		expect(result.status).toBe("ok");
		const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
		expect(doc.route_preflight).toEqual({
			terminal_origins: ["http://127.0.0.1:11434"],
		});
		expect(doc.admin).toEqual({ gui: true });
		expect(doc.knowledge.distill.enabled).toBe(true);
		// legacy top-level lane knob folded into fleet_loop, not stranded
		expect(doc.fleet_loop.lane_target).toBe(20);
		expect(statSync(join(dir, "settings.json")).mode & 0o777).toBe(0o600);
		// stack.json kept as read-compat fallback, and a re-run is a no-op
		expect(existsSync(join(dir, "stack.json"))).toBe(true);
		expect((await migrateConf(f.ctx)).status).toBe("ok");
	});

	test("a partial settings.json that would mask stack sections fails loud", async () => {
		const f = fixture();
		const dir = confDir(f.ctx.home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "stack.json"),
			`${JSON.stringify(stackDoc, null, 2)}\n`,
			{ mode: 0o600 },
		);
		writeFileSync(
			join(dir, "settings.json"),
			`${JSON.stringify({ version: "9.9.9" }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const result = await migrateConf(f.ctx);
		expect(result.status).toBe("failed");
		expect(result.note).toContain("would mask stack.json sections");
		expect(result.note).toContain("coord settings migrate");
		// the masking settings.json is left untouched for the operator
		expect(
			JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")),
		).toEqual({ version: "9.9.9" });
	});

	test("a settings.json covering the stack is a clean pass", async () => {
		const f = fixture();
		const dir = confDir(f.ctx.home);
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "stack.json"),
			`${JSON.stringify(stackDoc, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const covered = {
			version: "9.9.9",
			route_preflight: stackDoc.route_preflight,
			admin: stackDoc.admin,
			knowledge: stackDoc.knowledge,
			fleet_loop: { lane_target: 20 },
		};
		writeFileSync(
			join(dir, "settings.json"),
			`${JSON.stringify(covered, null, 2)}\n`,
			{ mode: 0o600 },
		);
		const result = await migrateConf(f.ctx);
		expect(result.status).toBe("ok");
		expect(result.note).toContain("covers the stack document");
	});
});
