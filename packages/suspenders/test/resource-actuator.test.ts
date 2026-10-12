import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import {
	resourceAction,
	type ActuatorDeps,
} from "../scripts/lib/resource-actuator.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "resource-action-"));
	roots.push(root);
	const path = join(root, "receipts.sqlite");
	let now = 60 * 60_000;
	const kills: number[] = [];
	const target = {
		label: "com.suspenders.cloud-gateway",
		pid: 1234567,
		port: 4100,
		reason: "fixture RSS pressure",
	};
	const deps: ActuatorDeps = {
		owner: (label) => ({
			label,
			state: "running",
			pid: 7654321,
			reason: "verified activation",
		}),
		birth: (pid) => ({ birth: `birth-${pid}`, command: `fixture-${pid}` }),
		parent: () => 7654321,
		listener: () => true,
		kill: (pid) => {
			const db = new Database(path, { readonly: true });
			try {
				expect(
					db.query("SELECT result FROM actions ORDER BY at DESC LIMIT 1").get(),
				).toEqual({ result: "reserved" });
			} finally {
				db.close();
			}
			kills.push(pid);
		},
		now: () => now,
	};
	return {
		path,
		target,
		deps,
		kills,
		advance: (ms: number) => {
			now += ms;
		},
	};
}
test("durable reservation precedes exact-target signal and matching result is recorded", () => {
	const f = fixture();
	const result = resourceAction(f.path, f.target, f.deps.owner, f.deps);
	expect(result.state).toBe("signaled");
	expect(f.kills).toEqual([f.target.pid]);
	const db = new Database(f.path, { readonly: true });
	try {
		expect(
			db
				.query("SELECT result,pid,birth FROM actions WHERE id=?")
				.get(result.receipt),
		).toEqual({
			result: "signaled",
			pid: f.target.pid,
			birth: `birth-${f.target.pid}`,
		});
	} finally {
		db.close();
	}
});
test("unknown ownership, clients and non-owned ancestry never authorize a signal", () => {
	for (const override of [
		{ owner: () => undefined },
		{ listener: () => false },
		{ parent: () => 1 },
		{ birth: () => null },
	] satisfies Partial<ActuatorDeps>[]) {
		const f = fixture();
		expect(
			resourceAction(f.path, f.target, f.deps.owner, { ...f.deps, ...override })
				.state,
		).toBe("held");
		expect(f.kills).toEqual([]);
		expect(existsSync(f.path)).toBe(false);
	}
});
test("PID reuse and owner restart after reservation hold the action", () => {
	for (const ownerChange of [false, true]) {
		const f = fixture();
		let reads = 0;
		const inspect = f.deps.birth;
		f.deps.birth = (pid) => {
			reads++;
			return {
				birth:
					reads > 2 && pid === (ownerChange ? 7654321 : f.target.pid)
						? "new-birth"
						: `birth-${pid}`,
				command: `fixture-${pid}`,
			};
		};
		expect(resourceAction(f.path, f.target, f.deps.owner, f.deps).state).toBe(
			"held",
		);
		expect(f.kills).toEqual([]);
		f.deps.birth = inspect;
		expect(
			resourceAction(f.path, f.target, f.deps.owner, f.deps).detail,
		).toContain("cooldown");
	}
});
test("cooldown and budget survive caller restarts and changed child PIDs", () => {
	const f = fixture();
	expect(resourceAction(f.path, f.target, f.deps.owner, f.deps).state).toBe(
		"signaled",
	);
	expect(
		resourceAction(f.path, { ...f.target, pid: 1234568 }, f.deps.owner, {
			...f.deps,
		}).state,
	).toBe("held");
	for (let next = 0; next < 2; next++) {
		f.advance(5 * 60_000);
		expect(
			resourceAction(
				f.path,
				{ ...f.target, pid: 1234570 + next },
				f.deps.owner,
				{ ...f.deps },
			).state,
		).toBe("signaled");
	}
	f.advance(5 * 60_000);
	expect(
		resourceAction(f.path, { ...f.target, pid: 1234580 }, f.deps.owner, {
			...f.deps,
		}).state,
	).toBe("held");
	expect(f.kills).toHaveLength(3);
});
test("failed signaling retains a reservation and prevents immediate retry", () => {
	const f = fixture();
	f.deps.kill = () => {
		throw new Error("signal denied");
	};
	expect(resourceAction(f.path, f.target, f.deps.owner, f.deps).state).toBe(
		"failed",
	);
	expect(resourceAction(f.path, f.target, f.deps.owner, f.deps).state).toBe(
		"held",
	);
});

test("real process start identity and listener ancestry signal only the server child", async () => {
	const f = fixture();
	const child = Bun.spawn(
		[
			process.execPath,
			"-e",
			'const server = require("node:net").createServer(() => {}); server.listen(0,"127.0.0.1",()=>console.log(server.address().port));',
		],
		{ stdout: "pipe", stderr: "ignore" },
	);
	const reader = child.stdout.getReader();
	let client: ReturnType<typeof createConnection> | undefined;
	try {
		const first = await reader.read();
		const port = Number(new TextDecoder().decode(first.value).trim());
		client = createConnection({ host: "127.0.0.1", port });
		await new Promise<void>((resolve, reject) => {
			client?.once("connect", resolve);
			client?.once("error", reject);
		});
		const result = resourceAction(
			f.path,
			{ ...f.target, pid: child.pid, port },
			(label) => ({
				label,
				state: "running",
				reason: "fixture owner callback",
				pid: process.pid,
			}),
		);
		expect(result.state).toBe("signaled");
		await child.exited;
		expect(child.signalCode).toBe("SIGKILL");
		expect(
			Bun.spawnSync(["/bin/kill", "-0", String(process.pid)]).exitCode,
		).toBe(0);
	} finally {
		client?.destroy();
		reader.releaseLock();
		child.kill();
	}
});
