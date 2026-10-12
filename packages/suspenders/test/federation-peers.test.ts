// test/federation-peers.test.ts — W362 peer policy propagation: labels from
// HUB_PEERS / stack.yaml hubs.<me>.peers; a fresh pull seeds the per-peer
// last-known store; the manifest version echo is the change detector
// (unchanged → CHANGED on version flip); a downed peer degrades honestly
// (last-known kept and echoed, never throws); hubctl renders HUB_PEERS.
import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadPeerLastKnown,
	type PeersEnv,
	peerLastKnownPath,
	pullPeerPolicy,
	resolvePeerLabels,
} from "../hooks/lib/federation-peers.ts";

interface StubPeer {
	url: string;
	seen: string[];
	flip: () => void;
	close: () => void;
}

function stubPeer(startVersion: string): StubPeer {
	let version = startVersion;
	const seen: string[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(req) {
			if (new URL(req.url).pathname === "/federation/policy-manifest") {
				seen.push(req.headers.get("authorization") ?? "");
				return Response.json({
					version,
					rules: [{ id: "gateway.knobs" }],
					cr_queue: [],
				});
			}
			return new Response(null, { status: 404 });
		},
	});
	return {
		url: `http://127.0.0.1:${String(server.port)}`,
		seen,
		flip: () => {
			version = `${startVersion}-flipped`;
		},
		close: () => server.stop(true),
	};
}

const RESOLVE_OK = (url: string) => async (label: string) => ({
	label,
	url,
	via: "test",
});

function tmpEnv(): PeersEnv {
	const home = join(
		tmpdir(),
		`w362-peers-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	mkdirSync(home, { recursive: true });
	return { BUCKLE_SECRETS_HOME: home, HOME: home };
}

describe("resolvePeerLabels: label precedence", () => {
	test("explicit labels win over env, env wins over stack.yaml", () => {
		expect(resolvePeerLabels({ labels: ["a", "b"] })).toEqual(["a", "b"]);
		const env: PeersEnv = { HUB_PEERS: "nas, desktop ,", KLH_HUB_NAME: "x" };
		expect(resolvePeerLabels({ env })).toEqual(["nas", "desktop"]);
		expect(resolvePeerLabels({ labels: [], env })).toEqual([]);
	});

	test("stack.yaml hubs.<me>.peers when no HUB_PEERS", () => {
		const dir = mkdtempSync(join(tmpdir(), "w362-stack-"));
		const stackPath = join(dir, "stack.yaml");
		writeFileSync(
			stackPath,
			"hubs:\n  nas:\n    host: nas.example\n    peers:\n      - desktop\n  desktop:\n    host: 127.0.0.1\n",
		);
		try {
			expect(
				resolvePeerLabels({ env: { KLH_HUB_NAME: "nas" }, stackPath }),
			).toEqual(["desktop"]);
			// a hub with no peers row, an unknown hub, no label — all empty
			expect(
				resolvePeerLabels({ env: { KLH_HUB_NAME: "desktop" }, stackPath }),
			).toEqual([]);
			expect(
				resolvePeerLabels({ env: { KLH_HUB_NAME: "ghost" }, stackPath }),
			).toEqual([]);
			expect(resolvePeerLabels({ env: {}, stackPath })).toEqual([]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("pullPeerPolicy: version echo change detector", () => {
	test("fresh pull seeds; unchanged next cycle; flip reports changed", async () => {
		const env = tmpEnv();
		const peer = stubPeer("fed-v1");
		try {
			const resolve = RESOLVE_OK(peer.url);
			const opts = { labels: ["nas-peer"], env, resolve };
			const first = await pullPeerPolicy(opts);
			expect(first).toHaveLength(1);
			expect(first[0]?.ok).toBe(true);
			expect(first[0]?.seeded).toBe(true);
			expect(first[0]?.changed).toBe(false);
			expect(first[0]?.version).toBe("fed-v1");
			expect(first[0]?.rules).toBe(1);

			const second = await pullPeerPolicy(opts);
			expect(second[0]?.seeded).toBe(false);
			expect(second[0]?.changed).toBe(false);

			peer.flip();
			const third = await pullPeerPolicy(opts);
			expect(third[0]?.changed).toBe(true);
			expect(third[0]?.version).toBe("fed-v1-flipped");

			// per-peer last-known store holds the newest manifest
			expect(loadPeerLastKnown("nas-peer", env)?.manifest.version).toBe(
				"fed-v1-flipped",
			);
			expect(existsSync(peerLastKnownPath("nas-peer", env))).toBe(true);
		} finally {
			peer.close();
		}
	});

	test("spoke-scoped token rides the wire per label", async () => {
		const env: PeersEnv = { ...tmpEnv(), SUSPENDERS_HUB_P1_TOKEN: "bksk_test" };
		const peer = stubPeer("fed-v1");
		try {
			const rows = await pullPeerPolicy({
				labels: ["p1"],
				env,
				resolve: RESOLVE_OK(peer.url),
			});
			expect(rows[0]?.ok).toBe(true);
			expect(peer.seen).toEqual(["Bearer bksk_test"]);
		} finally {
			peer.close();
		}
	});

	test("downed peer degrades honestly, last-known kept and echoed", async () => {
		const env = tmpEnv();
		const peer = stubPeer("fed-keep");
		const resolve = RESOLVE_OK(peer.url);
		await pullPeerPolicy({ labels: ["p2"], env, resolve });
		peer.close();
		const rows = await pullPeerPolicy({
			labels: ["p2"],
			env,
			resolve,
			timeoutMs: 800,
		});
		expect(rows[0]?.ok).toBe(false);
		expect(rows[0]?.degraded).toBe(true);
		expect(rows[0]?.reason).not.toBeNull();
		// the honest echo: the version still in force is last-known's
		expect(rows[0]?.version).toBe("fed-keep");
		expect(rows[0]?.rules).toBe(1);
		// and the store itself is untouched
		expect(loadPeerLastKnown("p2", env)?.manifest.version).toBe("fed-keep");
	});

	test("unresolvable label degrades without throwing", async () => {
		const rows = await pullPeerPolicy({
			labels: ["ghost-hub"],
			env: tmpEnv(),
			resolve: async () => null,
		});
		expect(rows[0]?.degraded).toBe(true);
		expect(rows[0]?.reason).toContain("unresolved");
		expect(rows[0]?.version).toBeNull();
	});
});

describe("hubctl render: peer edges as data", () => {
	test("render emits HUB_PEERS from the stack profile", () => {
		const dir = mkdtempSync(join(tmpdir(), "w362-hubctl-"));
		const stackPath = join(dir, "stack.yaml");
		writeFileSync(
			stackPath,
			"hubs:\n  nas:\n    host: nas.example\n    peers:\n      - desktop\n",
		);
		try {
			const result = Bun.spawnSync(
				[
					process.execPath,
					join(import.meta.dir, "../deploy/hubctl.ts"),
					"render",
					"nas",
				],
				{
					stdout: "pipe",
					stderr: "pipe",
					env: { ...process.env, KLH_STACK: stackPath },
				},
			);
			expect(result.exitCode).toBe(0);
			expect(result.stdout.toString()).toContain("HUB_PEERS=desktop");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
