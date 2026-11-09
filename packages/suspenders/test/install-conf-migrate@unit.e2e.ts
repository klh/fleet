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
	const conf = join(home, ".config", "klh");
	mkdirSync(llm, { recursive: true });
	mkdirSync(conf, { recursive: true });
	const json = join(llm, "upstreams.json");
	const policy = join(llm, "routing-policy.json");
	const env = join(llm, "buckle-spoke.env");
	const settings = join(conf, "settings.json");
	const ctx = { home, dryRun: false } as StepContext;
	return { ctx, json, policy, env, settings };
};

test.describe("Buckle spoke config migration", () => {
	test("migrates the legacy yaml to JSON, then retires the spoke BUCKLE_UPSTREAMS pin (W2760)", async () => {
		const f = fixture();
		const yaml = join(f.ctx.home, ".claude", "local-llm", "upstreams.yaml");
		writeFileSync(yaml, "groups: {}\n", { mode: 0o600 });
		writeFileSync(
			f.env,
			`BUCKLE_ROOT_KEY=untouched\nBUCKLE_UPSTREAMS=${yaml}\n`,
			{ mode: 0o600 },
		);
		const result = await migrateConf(f.ctx);
		expect(result.status).toBe("ok");
		// the pin retires entirely — settings.json owns the chain now
		expect(readFileSync(f.env, "utf8")).toBe("BUCKLE_ROOT_KEY=untouched\n");
		expect(statSync(f.env).mode & 0o777).toBe(0o600);
		expect(readFileSync(f.json, "utf8")).toContain('"groups"');
	});

	test("folds the side files into settings.json law homes, idempotently", async () => {
		const f = fixture();
		writeFileSync(f.settings, "{}\n", { mode: 0o600 });
		writeFileSync(f.json, JSON.stringify({ groups: { belt: [] } }), {
			mode: 0o600,
		});
		writeFileSync(f.policy, JSON.stringify({ gateway: { num_retries: 4 } }), {
			mode: 0o600,
		});
		const first = await migrateConf(f.ctx);
		expect(first.status).toBe("ok");
		const doc = JSON.parse(readFileSync(f.settings, "utf8"));
		expect(doc.upstreams.groups.belt).toEqual([]);
		expect(doc.routing_policy.gateway.num_retries).toBe(4);
		const second = await migrateConf(f.ctx);
		expect(second.status).toBe("ok");
		expect(readFileSync(f.settings, "utf8")).toBe(
			`${JSON.stringify(doc, null, 2)}\n`,
		);
	});

	test("existing settings sections win over side files (operator moved deliberately)", async () => {
		const f = fixture();
		writeFileSync(
			f.settings,
			JSON.stringify({ routing_policy: { gateway: { num_retries: 9 } } }),
			{ mode: 0o600 },
		);
		writeFileSync(f.policy, JSON.stringify({ gateway: { num_retries: 1 } }), {
			mode: 0o600,
		});
		const r = await migrateConf(f.ctx);
		expect(r.status).toBe("ok");
		const doc = JSON.parse(readFileSync(f.settings, "utf8"));
		expect(doc.routing_policy.gateway.num_retries).toBe(9);
		expect(JSON.parse(readFileSync(f.policy, "utf8")).gateway.num_retries).toBe(
			1,
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
