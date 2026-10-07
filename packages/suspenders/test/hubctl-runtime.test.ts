import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W443: hubctl status reports the runtime + embedded SQLite of the RUNNING
// artifact container (exec into buckle-hub), never the host — informational,
// health keeps gating the exit code.
const dir = mkdtempSync(join(tmpdir(), "fleet-hub-runtime-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const docker = join(bin, "docker");
writeFileSync(
	docker,
	`#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes("ps")) {
  console.log(JSON.stringify({Service:"buckle-hub",State:"running"}));
} else if (args.includes("exec")) {
  console.log(process.env.TEST_RUNTIME_JSON ?? "docker: container not running");
}
`,
);
chmodSync(docker, 0o755);
const stack = join(dir, "stack.json");
writeFileSync(
	stack,
	JSON.stringify({
		hubs: {
			test: {
				host: "localhost",
				deploy: { dir, docker },
				// 0 = skip the network probes — they would hit machine defaults
				buckle_health_port: 0,
				board_health_port: 0,
				store_health_port: 0,
				belt_health_port: 0,
			},
		},
	}),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function status(overrides: Record<string, string> = {}) {
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"status",
			"test",
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				KLH_STACK: stack,
				...overrides,
			},
		},
	);
	return { code: result.exitCode, out: result.stdout.toString() };
}

test("status reports the artifact runtime + embedded SQLite verdict", () => {
	const result = status({
		TEST_RUNTIME_JSON: JSON.stringify({
			bun: "1.4.2",
			sqlite: "3.53.2",
			verified: true,
			reason: "3.53.2 >= 3.51.3 (WAL-reset fix)",
		}),
	});
	expect(result.out).toContain("runtime: bun 1.4.2 · SQLite 3.53.2");
	expect(result.out).toContain("verified");
	expect(result.code).toBe(0);
});

test("status degrades to unknown when the container does not answer", () => {
	const result = status({});
	expect(result.out).toContain("runtime: unknown");
	expect(result.code).toBe(0); // informational — health gates the exit
});
