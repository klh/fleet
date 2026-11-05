import { describe, expect, test } from "bun:test";
import {
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

describe("Buckle spoke config migration", () => {
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
