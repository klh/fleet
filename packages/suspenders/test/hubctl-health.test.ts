import { afterAll, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "fleet-hub-status-"));
const bin = join(dir, "bin");
mkdirSync(bin);
const docker = join(bin, "docker");
writeFileSync(
	docker,
	`#!${process.execPath}\nconsole.log(JSON.stringify({Service:"board-health",State:"running",Health:process.env.TEST_DOCKER_HEALTH??"healthy"}));\n`,
);
const curl = join(bin, "curl");
writeFileSync(
	curl,
	`#!${process.execPath}\nrequire("node:fs").appendFileSync(process.env.TEST_CALLS,process.argv.at(-1)+"\\n");console.log(process.env.TEST_HTTP??"200");\n`,
);
const ssh = join(bin, "ssh");
writeFileSync(
	ssh,
	`#!${process.execPath}\nconsole.error("ssh: connect to host hub.test port 22: No route to host");process.exit(255);\n`,
);
chmodSync(docker, 0o755);
chmodSync(curl, 0o755);
chmodSync(ssh, 0o755);
const stack = join(dir, "stack.json");
writeFileSync(
	stack,
	JSON.stringify({
		hubs: {
			test: {
				host: "localhost",
				deploy: { dir, docker },
				buckle_health_port: 18101,
				board_health_port: 18102,
				store_health_port: 18103,
				belt_health_port: 18104,
			},
			remote: {
				host: "hub.test",
				deploy: { ssh: "kk@hub.test", dir },
				buckle_health_port: 18101,
				board_health_port: 18102,
				store_health_port: 18103,
				belt_health_port: 18104,
			},
		},
	}),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function status(hubName = "test", overrides: Record<string, string> = {}) {
	const calls = join(dir, "calls");
	writeFileSync(calls, "");
	const result = Bun.spawnSync(
		[
			process.execPath,
			join(import.meta.dir, "../deploy/hubctl.ts"),
			"status",
			hubName,
		],
		{
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH}`,
				KLH_STACK: stack,
				TEST_CALLS: calls,
				...overrides,
			},
		},
	);
	return {
		code: result.exitCode,
		out: result.stdout.toString(),
		errOut: result.stderr.toString(),
		calls: readFileSync(calls, "utf8"),
	};
}

test("local hub status queries the configured independent sidecars without SSH", () => {
	const result = status();
	expect(result.code).toBe(0);
	for (const port of [18101, 18102, 18103, 18104])
		expect(result.calls).toContain(`:${port}/healthz`);
	expect(result.calls).not.toContain("/api/status");
});
test("running but unhealthy containers and failed external verdicts fail status", () => {
	expect(status({ TEST_DOCKER_HEALTH: "unhealthy" }).code).toBe(1);
	expect(status({ TEST_HTTP: "502" }).code).toBe(1);
});
test("ssh-unreachable hub degrades to bounded unreachable verdicts (W671)", () => {
	const result = status("remote");
	expect(result.code).toBe(1);
	expect(result.out).toContain("✗ containers: hub unreachable (kk@hub.test)");
	for (const [svc, port] of [
		["buckle-health", 18101],
		["board-health", 18102],
		["store-health", 18103],
		["belt-health", 18104],
	])
		expect(result.out).toContain(`✗ ${svc} :${port}/healthz → unreachable`);
	expect(result.out).not.toContain("✓");
	expect(result.out).toContain("· runtime: unknown");
	expect(result.errOut).not.toMatch(/error:/i);
});
