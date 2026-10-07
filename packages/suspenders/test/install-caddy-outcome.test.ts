import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan, type StepContext } from "../scripts/install-run.ts";
import { exitFor } from "../scripts/install-cli.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const repo = mkdtempSync(join(tmpdir(), "fleet-caddy-outcome-"));
	dirs.push(repo);
	const ctx: StepContext = {
		repo,
		prefix: join(repo, "prefix"),
		shimBin: join(repo, "bin"),
		llmHome: join(repo, "llm"),
		dryRun: false,
		yes: true,
		json: true,
		verbose: false,
	};
	return { repo, ctx };
}

describe("W549 truthful Caddy install outcome", () => {
	test.each(["failed", "ok", "skipped"])(
		"machine report preserves Caddy %s and unaffected install steps",
		async (status) => {
			const f = fixture();
			writeFileSync(
				join(f.repo, "install.sh"),
				`#!/bin/bash\nprintf '%s\\n' '{"name":"registerCaddy","status":"${status}","note":"Caddy ${status}"}' > "$SUSPENDERS_LEGACY_REPORT"\necho 'legacy finished'\n`,
			);
			const result = await executePlan("plan", null, f.ctx, () => {});
			expect(
				result.rows.find((row) => row.name === "registerCaddy")?.status,
			).toBe(status);
			expect(
				result.rows.find((row) => row.name === "syncHarness")?.status,
			).toBe("delegated");
			expect(
				result.rows.find((row) => row.name === "releaseNotify")?.status,
			).toBe("delegated");
			expect(result.outcome).toBe(status === "failed" ? "failed" : "ok");
			expect(exitFor(result.outcome)).toBe(status === "failed" ? 1 : 0);
		},
	);
	test("missing registration report cannot silently count as success", async () => {
		const f = fixture();
		writeFileSync(join(f.repo, "install.sh"), "#!/bin/bash\nexit 0\n");
		const result = await executePlan("plan", null, f.ctx, () => {});
		expect(result.outcome).toBe("failed");
		expect(
			result.rows.find((row) => row.name === "registerCaddy")?.status,
		).toBe("failed");
	});
	test("malformed status cannot be coerced into a success report", async () => {
		const f = fixture();
		writeFileSync(
			join(f.repo, "install.sh"),
			'#!/bin/bash\nprintf \'%s\\n\' \'{"name":"registerCaddy","status":["ok"],"note":"incorrect"}\' > "$SUSPENDERS_LEGACY_REPORT"\n',
		);
		const result = await executePlan("plan", null, f.ctx, () => {});
		expect(result.outcome).toBe("failed");
		expect(
			result.rows.find((row) => row.name === "registerCaddy")?.status,
		).toBe("failed");
	});
	test("actual legacy registration branch reports failed reload without losing rollback or other work", () => {
		const f = fixture();
		const source = readFileSync(join(import.meta.dir, "../install.sh"), "utf8");
		const start = source.indexOf("# optional: register the board");
		const end = source.indexOf('echo "done. restart Claude Code', start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const bin = join(f.repo, ".local/bin");
		mkdirSync(bin, { recursive: true });
		const local = join(bin, "klh-local");
		writeFileSync(
			local,
			'#!/bin/bash\nprintf preserved > "$HOME/rollback-proof"\nexit 1\n',
		);
		writeFileSync(join(bin, "caddy"), "#!/bin/bash\nexit 0\n");
		chmodSync(local, 0o755);
		chmodSync(join(bin, "caddy"), 0o755);
		const report = join(f.repo, "report.ndjson");
		const child = Bun.spawnSync(["bash", "-c", source.slice(start, end)], {
			env: {
				HOME: f.repo,
				PATH: `${bin}:/usr/bin:/bin`,
				SUSPENDERS_LEGACY_REPORT: report,
			},
		});
		expect(child.exitCode).toBe(0);
		expect(existsSync(join(f.repo, "rollback-proof"))).toBe(true);
		expect(JSON.parse(readFileSync(report, "utf8")).status).toBe("failed");
		expect(child.stdout.toString()).toContain("degraded");
	});
});
