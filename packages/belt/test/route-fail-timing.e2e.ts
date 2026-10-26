import { expect, test } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// W986.1: failRoute must log the REAL elapsed time of the failed attempt.
// The child imports the real route-policy.ts with HOME pointed at a fixture
// dir (log paths bake process.env.HOME at module load), fails one local and
// one remote route with known elapsed ms, and reports both routing-log
// lines — env-isolated from the operator's live logs (belt.log W670).

const CHILD = `
const { readFileSync } = await import("node:fs");
const { join } = await import("node:path");
const rp = await import(process.env.ROUTE_MOD);
const home = process.env.HOME;
const localCand = { kind: "local", machine: "mac", port: 8902, model: "m", protocol: "openai" };
const remoteCand = {
	kind: "remote", machine: "nas", port: 4101, model: "x", protocol: "openai",
	m: { host: "nas" }, ep: {},
};
const rLocal = rp.failRoute(localCand, "tok", "code", "why-a", new Error("boom"), 1234);
const rRemote = rp.failRoute(remoteCand, "tok", "code", "why-b", "errstr", 2345);
const swarm = readFileSync(join(home, ".claude-insights/swarm-routing.log"), "utf8")
	.trim().split("\\n").map((l) => JSON.parse(l));
const remotes = readFileSync(join(home, ".claude/local-llm/remotes-routes.log"), "utf8")
	.trim().split("\\n").map((l) => JSON.parse(l));
console.log(JSON.stringify({
	statusLocal: rLocal.status,
	statusRemote: rRemote.status,
	swarm,
	remotes,
}));
`;

test("failRoute logs the real elapsed ms of failed calls, never 0 @unit", async () => {
	const home = mkdtempSync(join(tmpdir(), "belt-fail-"));
	mkdirSync(join(home, ".claude", "local-llm"), { recursive: true });
	mkdirSync(join(home, ".claude-insights"), { recursive: true });
	try {
		const child = Bun.spawnSync([process.execPath, "-e", CHILD], {
			env: {
				...process.env,
				HOME: home,
				ROUTE_MOD: join(import.meta.dir, "..", "bin", "route-policy.ts"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(child.exitCode, child.stderr.toString()).toBe(0);
		const out = JSON.parse(child.stdout.toString());
		expect(out.statusLocal).toBe(503);
		expect(out.statusRemote).toBe(503);
		// local failure → swarm-routing.log with the true elapsed ms
		expect(out.swarm).toHaveLength(1);
		expect(out.swarm[0].duration_ms).toBe(1234);
		expect(out.swarm[0].ok).toBe(false);
		expect(out.swarm[0].outcome).toBe("error");
		expect(out.swarm[0].port).toBe(8902);
		// remote failure → remotes-routes.log with the true elapsed ms
		expect(out.remotes).toHaveLength(1);
		expect(out.remotes[0].duration_ms).toBe(2345);
		expect(out.remotes[0].ok).toBe(false);
		expect(out.remotes[0].machine).toBe("nas");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
