import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultRenderValues,
	loadManifest,
	renderDarwin,
	renderLinux,
	renderWin32,
	usedPlaceholders,
	validateSpec,
	type ServiceSpec,
} from "../scripts/install-services.ts";
import { parsePlistXml } from "./plist-fields.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "fleet envfile ' "));
	dirs.push(dir);
	const entry = join(dir, "capture.ts");
	writeFileSync(
		entry,
		"console.log(JSON.stringify({upstream:process.env.UPSTREAM_FIXTURE,root:process.env.ROOT_FIXTURE,order:process.env.ORDER_FIXTURE,args:process.argv.slice(2)}));",
	);
	const first = join(dir, "belt ' $(touch injected).env");
	const second = join(dir, "spoke &.env");
	writeFileSync(
		first,
		"UPSTREAM_FIXTURE=upstream-fixture\nORDER_FIXTURE=first\n",
	);
	writeFileSync(second, "ROOT_FIXTURE=root-fixture\nORDER_FIXTURE=second\n");
	const spec: ServiceSpec = {
		name: "fixture",
		bunEntry: entry,
		args: ["literal ' & $(touch injected)", ""],
		cwd: dir,
		env: {},
		envFile: [first, second],
		schedule: { runAtLoad: true, keepalive: true, throttleSeconds: 10 },
		logs: { out: join(dir, "out.log"), err: join(dir, "err.log") },
		placeholders: ["__BUN__"],
	};
	const values = defaultRenderValues({
		bun: Bun.which("bun") ?? "bun",
		home: dir,
	});
	return { dir, first, second, spec, values };
}
describe("W501 supervised gateway env files", () => {
	test("Darwin wrapper loads both required files, exports them and preserves literal argv", () => {
		const f = fixture();
		const plist = parsePlistXml(renderDarwin(f.spec, f.values));
		const argv = plist.ProgramArguments as string[];
		expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
		const child = Bun.spawnSync(argv, {
			cwd: f.dir,
			env: { PATH: process.env.PATH ?? "", HOME: f.dir },
		});
		expect(child.exitCode).toBe(0);
		expect(JSON.parse(child.stdout.toString())).toEqual({
			upstream: "upstream-fixture",
			root: "root-fixture",
			order: "second",
			args: f.spec.args,
		});
		expect(existsSync(join(f.dir, "injected"))).toBe(false);
		expect(plist.KeepAlive).toBe(true);
		expect(plist.ThrottleInterval).toBe(10);
	});
	test("missing required env file refuses to launch the gateway", () => {
		const f = fixture();
		rmSync(f.second);
		const argv = parsePlistXml(renderDarwin(f.spec, f.values))
			.ProgramArguments as string[];
		const child = Bun.spawnSync(argv, { cwd: f.dir });
		expect(child.exitCode).not.toBe(0);
		expect(child.stdout.toString()).toBe("");
	});
	test("single envFile remains supported and no-file services retain direct argv", () => {
		const f = fixture();
		const single = { ...f.spec, envFile: f.first };
		expect(
			(
				parsePlistXml(renderDarwin(single, f.values))
					.ProgramArguments as string[]
			)[0],
		).toBe("/bin/sh");
		const direct = { ...f.spec, envFile: undefined };
		expect(
			parsePlistXml(renderDarwin(direct, f.values)).ProgramArguments,
		).toEqual([f.values.bun, f.spec.bunEntry, ...f.spec.args]);
	});
	test("manifest spoke has both machine env paths and supervisor restart behavior", () => {
		const spec = loadManifest().find((row) => row.name === "buckle-spoke");
		expect(spec).toBeDefined();
		expect(spec?.envFile).toEqual([
			"__HOME__/.claude/local-llm/belt.env",
			"__HOME__/.claude/local-llm/buckle-spoke.env",
		]);
		expect(spec?.schedule).toEqual({
			runAtLoad: true,
			keepalive: true,
			throttleSeconds: 10,
		});
		// W546: declared listener port rides into the activation receipt —
		// supervision lsof-verifies :4101, not just the agent PID.
		expect(spec?.port).toBe(4101);
		expect(spec?.bunEntry).toBe("__REPO__/../buckle/src/server.ts");
	});
	test("declared listener port rides the renderer's --json (receipt source, W546)", () => {
		const f = fixture();
		const out = join(f.dir, "units");
		const proc = Bun.spawnSync(
			[
				process.execPath,
				join(import.meta.dir, "../scripts/install-services.ts"),
				"--target",
				"darwin",
				"--service",
				"buckle-spoke",
				"--out",
				out,
				"--json",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(proc.exitCode).toBe(0);
		const report = JSON.parse(proc.stdout.toString()) as {
			services: { service: string; port?: number }[];
		};
		expect(report.services[0]?.service).toBe("buckle-spoke");
		expect(report.services[0]?.port).toBe(4101);
	});
	test("all env files are resolved in cross-platform units without reading contents", () => {
		const f = fixture();
		const spec = {
			...f.spec,
			envFile: ["__HOME__/belt.env", "__HOME__/spoke.env"],
			placeholders: ["__BUN__", "__HOME__"],
		};
		expect(usedPlaceholders(spec)).toEqual(["__BUN__", "__HOME__"]);
		validateSpec(spec);
		const linux = renderLinux(spec, f.values);
		expect(linux).toContain(`EnvironmentFile="${f.values.home}/belt.env"`);
		expect(linux).toContain(`EnvironmentFile="${f.values.home}/spoke.env"`);
		const windows = renderWin32(spec, f.values);
		expect(windows).toContain(`${f.values.home}/belt.env`);
		expect(windows).toContain(`${f.values.home}/spoke.env`);
		for (const unit of [linux, windows, renderDarwin(spec, f.values)]) {
			expect(unit).not.toContain("upstream-fixture");
			expect(unit).not.toContain("root-fixture");
		}
	});
	test("empty lists and invalid env path types are rejected", () => {
		const f = fixture();
		for (const envFile of [[], [null], 123, ["/valid.env", ""]]) {
			expect(() =>
				validateSpec({ ...f.spec, envFile } as unknown as ServiceSpec),
			).toThrow();
		}
	});
	test("invalid declared port fails spec validation (W546)", () => {
		const f = fixture();
		for (const port of [0, 70000, 10.5, Number.NaN]) {
			expect(() =>
				validateSpec({ ...f.spec, port } as unknown as ServiceSpec),
			).toThrow();
		}
	});
});
