import { expect, test } from "./pw";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateConf } from "../scripts/install-conf-migrate.ts";
import type { StepContext } from "../scripts/install-run.ts";

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
