// trace-tunnel.test.ts — W1097: the managed ssh tunnel (stack.yaml-configured
// trusted transport) and its peers-file face. Co-situated coverage: plan law,
// ssh argv shape, the connector-law-validated peers merge, tunnel lifecycle
// with an injected child, and the end-to-end proof that a NAS row the tunnel
// tooling renders is read by the REAL connector (per-trace attempts +
// coverage status).
import { test, expect } from "@playwright/test";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRemoteTraces } from "../../telemetry/src/remote-traces.ts";
import {
	readTunnelState,
	stopTunnel,
	tracePeerEntry,
	traceTunnelPlan,
	tunnelArgv,
	tunnelUp,
	writePeersFile,
} from "./trace-tunnel.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

const dirs: string[] = [];
test.afterAll(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "fleet-trace-tunnel-"));
	dirs.push(dir);
	return dir;
}

interface TunnelKnobs {
	listen_port: number;
	target_port?: number;
	read_key: string;
}

function hubOf(traceTunnel: TunnelKnobs | undefined): HubProfile {
	return {
		host: "nas.example",
		buckle_port: 4101,
		deploy: { ssh: "operator@nas.example", dir: "/volume1/docker/hub" },
		trace_tunnel: traceTunnel,
	};
}

test("undeclared transport = not configured (null, never an error)", () => {
	expect(traceTunnelPlan(hubOf(undefined), "nas")).toBeNull();
});

test("declared tunnel resolves the full plan (target defaults to buckle_port)", () => {
	const dir = tmpDir();
	const plan = traceTunnelPlan(
		hubOf({ listen_port: 14101, read_key: join(dir, "nas-read.key") }),
		"nas",
	);
	expect(plan).toEqual({
		hub: "nas",
		listenPort: 14101,
		targetPort: 4101,
		sshTarget: "operator@nas.example",
		connectTimeoutS: 10,
		readKeyPath: join(dir, "nas-read.key"),
	});
});

test("missing deploy.ssh refuses — the tunnel IS the trusted transport", () => {
	const hub = hubOf({ listen_port: 14101, read_key: "/tmp/x.key" });
	delete (hub as { deploy?: unknown }).deploy;
	expect(() => traceTunnelPlan(hub, "nas")).toThrow(
		/trace_tunnel needs hubs\.nas\.deploy\.ssh/,
	);
});

test("relative read_key refuses; out-of-range ports refuse", () => {
	expect(() =>
		traceTunnelPlan(hubOf({ listen_port: 1, read_key: "x.key" }), "nas"),
	).toThrow(/absolute PATH/);
	expect(() =>
		traceTunnelPlan(hubOf({ listen_port: 80, read_key: "/tmp/x.key" }), "nas"),
	).toThrow(/integer 1024-65535/);
});

test("ssh argv: one argument array, forward pinned to loopback", () => {
	const dir = tmpDir();
	const plan = traceTunnelPlan(
		hubOf({ listen_port: 14101, target_port: 4101, read_key: join(dir, "k") }),
		"nas",
	);
	expect(plan).not.toBeNull();
	const argv = tunnelArgv(plan);
	expect(argv[0]).toBe("ssh");
	expect(argv).toContain("-N");
	expect(argv).toContain("BatchMode=yes");
	expect(argv).toContain("ExitOnForwardFailure=yes");
	expect(argv).toContain("-L");
	expect(argv.at(-1)).toBe("operator@nas.example");
	expect(argv.at(argv.indexOf("-L") + 1)).toBe(
		"127.0.0.1:14101:127.0.0.1:4101",
	);
});

test("peers file: renders 0600, upserts by hubId, keeps other rows", () => {
	const dir = tmpDir();
	const plan = traceTunnelPlan(
		hubOf({ listen_port: 14101, read_key: join(dir, "nas.key") }),
		"nas",
	);
	expect(plan).not.toBeNull();
	const file = join(dir, "peers.json");
	writePeersFile(file, plan);
	expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
	const first = JSON.parse(readFileSync(file, "utf8")) as {
		peers: Array<{ hubId: string; url: string; tokenFile: string }>;
	};
	expect(first.peers).toEqual([
		{
			hubId: "nas",
			url: "http://127.0.0.1:14101/",
			tokenFile: join(dir, "nas.key"),
		},
	]);
	const desktopKey = join(dir, "desktop.key");
	writeFileSync(
		file,
		JSON.stringify({
			peers: [
				{
					hubId: "desktop",
					url: "http://127.0.0.1:4111/",
					tokenFile: desktopKey,
				},
			],
		}),
		{ mode: 0o600 },
	);
	writePeersFile(file, plan);
	const second = JSON.parse(readFileSync(file, "utf8")) as {
		peers: Array<{ hubId: string }>;
	};
	expect(second.peers.map((p) => p.hubId)).toEqual(["desktop", "nas"]);
	expect((statSync(file).mode & 0o777).toString(8)).toBe("600");
});

test("end-to-end: the tunnel-rendered NAS row feeds the real connector", async () => {
	const dir = tmpDir();
	const traceId = "b".repeat(32);
	const keyFile = join(dir, "nas.key");
	writeFileSync(keyFile, "nas-read-key\n", { mode: 0o600 });
	// stand-in for the tunnel: a real loopback server answering the exact
	// shape the hub's /v1/admin/traces answers through the forward
	const hub = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () =>
			Response.json({
				trace_id: traceId,
				attempts: [
					{
						trace_id: traceId,
						rid: "req-nas-1",
						ordinal: 1,
						ts: "2026-10-22T09:30:00.000Z",
						hop: "litellm",
						status: 200,
						duration_ms: 411,
						retry_after_ms: null,
						call_id: "call-nas-1",
					},
				],
			}),
	});
	try {
		await e2eConnectorRead(dir, traceId, hub.port);
	} finally {
		hub.stop(true);
	}
});

/** The connector-read half of the e2e: render the peers file from the plan,
 *  read it back through the REAL connector, assert attempts + coverage. */
async function e2eConnectorRead(
	dir: string,
	traceId: string,
	port: number,
): Promise<void> {
	const plan = traceTunnelPlan(
		hubOf({ listen_port: port, read_key: join(dir, "nas.key") }),
		"nas",
	);
	expect(plan).not.toBeNull();
	const peersFile = join(dir, "peers.json");
	writePeersFile(peersFile, plan);
	const read = await readRemoteTraces(peersFile, traceId);
	expect(read.status).toBe("ok");
	expect(read.peers[0]).toMatchObject({
		hub_id: "nas",
		status: "ok",
	});
	expect(read.coverage).toEqual({
		hubs: 1,
		ok: 1,
		degraded: 0,
		by_hub: { nas: "ok" },
	});
}

/** Point KLH_TUNNEL_STATE at a temp dir for the duration of `run`. */
async function withTunnelState<T>(
	dir: string,
	run: () => Promise<T>,
): Promise<T> {
	const prev = process.env.KLH_TUNNEL_STATE;
	process.env.KLH_TUNNEL_STATE = join(dir, "state");
	try {
		return await run();
	} finally {
		if (prev === undefined) delete process.env.KLH_TUNNEL_STATE;
		else process.env.KLH_TUNNEL_STATE = prev;
	}
}

test("tunnel lifecycle: banked 0600 state, idempotent reuse, stop reaps", async () => {
	const dir = tmpDir();
	await withTunnelState(dir, async () => {
		const plan = traceTunnelPlan(
			hubOf({ listen_port: 14101, read_key: join(dir, "nas.key") }),
			"nas",
		);
		expect(plan).not.toBeNull();
		let spawns = 0;
		const child = { pid: 42_4242, stderr: () => "", exit: null };
		const state = await tunnelUp(
			plan,
			() => {
				spawns++;
				return child;
			},
			2_000,
			10,
			async () => true,
		);
		expect(state.pid).toBe(42_4242);
		expect(readTunnelState("nas", () => true)).toMatchObject({
			pid: 42_4242,
			hub: "nas",
			listen_port: 14101,
			target_port: 4101,
		});
		// idempotent: live same-forward tunnel reused, never spawned twice
		const again = await tunnelUp(
			plan,
			() => child,
			2_000,
			10,
			async () => true,
		);
		expect(again.pid).toBe(42_4242);
		expect(spawns).toBe(1);
		stopTunnel("nas");
		expect(readTunnelState("nas")).toBeNull();
	});
});

test("tunnel bring-up: ssh dying early fails with the stderr tail", async () => {
	const dir = tmpDir();
	await withTunnelState(dir, async () => {
		const plan = traceTunnelPlan(
			hubOf({ listen_port: 14101, read_key: join(dir, "nas.key") }),
			"nas",
		);
		expect(plan).not.toBeNull();
		expect(tracePeerEntry(plan).url).toBe("http://127.0.0.1:14101/");
		try {
			await tunnelUp(
				plan,
				() => ({
					pid: 42_4243,
					stderr: () => "host key verification failed",
					exit: 255,
				}),
				2_000,
				10,
				async () => false,
			);
			expect.unreachable();
		} catch (e) {
			expect(e).toBeInstanceOf(Error);
			expect((e as Error).message).toContain("exited early");
			expect((e as Error).message).toContain("host key verification failed");
		}
		expect(readTunnelState("nas")).toBeNull();
	});
});
