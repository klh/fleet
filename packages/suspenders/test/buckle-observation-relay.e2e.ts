import { expect, test } from "./pw";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportObservations } from "../../buckle/src/observation-export.ts";
import type { Observation } from "../../buckle/src/observe.ts";
import { LaneProjection } from "../../buckle/src/projection.ts";
import {
	type BuckleObservationPeerState,
	peersFromStack,
	pullBuckleObservationPage,
	readBuckleObservationPeers,
	startBuckleObservationRelay,
} from "../hooks/board/buckle-observation-relay.ts";

const dirs: string[] = [];
test.afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function rig() {
	const dir = mkdtempSync(join(tmpdir(), "buckle-relay-"));
	dirs.push(dir);
	const tokenFile = join(dir, "token");
	writeFileSync(tokenFile, "read-only-secret\n", { mode: 0o600 });
	const state: BuckleObservationPeerState = {
		peer: { hubId: "desktop", url: "http://127.0.0.1:4111", tokenFile },
		cursor: 0,
		generation: null,
		lastSuccessAt: null,
		lastError: null,
		applied: 0,
	};
	const remote = new LaneProjection(join(dir, "remote.db"));
	const local = new LaneProjection(join(dir, "local.db"));
	return { dir, state, remote, local };
}

function event(id: string, type: Observation["type"]): Observation {
	return {
		specversion: "1.0",
		source: "buckle://desktop/boot1",
		id,
		type,
		time: "2026-10-20T12:00:00.000Z",
		data: {
			rid: "request-1",
			lane: "fleet-lane",
			actor: "key-1",
			dialect: "anthropic",
			model: "glm-5.3-flash",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			origin: "mac",
			peer: "mac",
		},
	};
}

test("bounded hub export and relay preserve source, sequence, lane, trace and peer", async () => {
	const { dir, state, remote, local } = rig();
	try {
		remote.ingest([
			event("1", "lane.request.admitted"),
			event("2", "lane.request.started"),
			event("3", "lane.request.ended"),
		]);
		const request = async (
			_url: string | URL | Request,
			init?: RequestInit,
		) => {
			expect(init?.headers).toEqual({
				authorization: "Bearer read-only-secret",
			});
			return Response.json(
				exportObservations(join(dir, "remote.db"), state.cursor, 64),
			);
		};
		expect(
			await pullBuckleObservationPage(
				state,
				local,
				request as unknown as typeof fetch,
			),
		).toBe(false);
		expect(state.cursor).toBe(3);
		expect(state.generation).toBeTruthy();
		expect(state.applied).toBe(3);
		const edge = local.snapshot({}).edges[0];
		expect(edge?.source).toBe("buckle://desktop/boot1");
		expect(edge?.lane).toBe("fleet-lane");
		expect(edge?.origin).toBe("mac");
		expect(edge?.peer).toBe("mac");
		expect(edge?.traceparent).toContain("4bf92f3577b34da6a3ce929d0e0e4736");
		await pullBuckleObservationPage(
			state,
			local,
			request as unknown as typeof fetch,
		);
		expect(state.applied).toBe(3);
	} finally {
		remote.close();
		local.close();
	}
});

test("rejects a page whose source does not belong to the configured hub", async () => {
	const { state, local, remote } = rig();
	try {
		const forged = {
			...event("1", "lane.request.admitted"),
			source: "buckle://other/boot1",
		};
		const request = async () =>
			Response.json({
				events: [forged],
				generation: "other",
				nextCursor: 1,
				maxCursor: 1,
				hasMore: false,
			});
		await expect(
			pullBuckleObservationPage(
				state,
				local,
				request as unknown as typeof fetch,
			),
		).rejects.toThrow("Invalid hub observation page");
		expect(state.cursor).toBe(0);
		expect(local.snapshot({}).edges).toHaveLength(0);
	} finally {
		remote.close();
		local.close();
	}
});

test("projection generation change rewinds cursor before ingest", async () => {
	const { state, local, remote } = rig();
	try {
		state.cursor = 500;
		state.generation = "old projection";
		const request = async () =>
			Response.json({
				events: [event("1", "lane.request.admitted")],
				generation: "new projection",
				nextCursor: 1,
				maxCursor: 1,
				hasMore: false,
			});
		expect(
			await pullBuckleObservationPage(
				state,
				local,
				request as unknown as typeof fetch,
			),
		).toBe(true);
		expect(state.cursor).toBe(0);
		expect(local.snapshot({}).edges).toHaveLength(0);
		expect(
			await pullBuckleObservationPage(
				state,
				local,
				request as unknown as typeof fetch,
			),
		).toBe(false);
		expect(local.snapshot({}).edges).toHaveLength(1);
	} finally {
		remote.close();
		local.close();
	}
});

test("operator config requires private file and safe target URL", () => {
	const { dir, local, remote } = rig();
	try {
		const config = join(dir, "peers.json");
		writeFileSync(
			config,
			JSON.stringify({
				peers: [
					{
						hubId: "desktop",
						url: "http://127.0.0.1:4111/",
						tokenFile: join(dir, "token"),
					},
				],
			}),
			{ mode: 0o600 },
		);
		expect(readBuckleObservationPeers(config)).toHaveLength(1);
		chmodSync(config, 0o644);
		expect(() => readBuckleObservationPeers(config)).toThrow("mode 600");
		chmodSync(config, 0o600);
		writeFileSync(
			config,
			JSON.stringify({
				peers: [
					{
						hubId: "desktop",
						url: "http://remote:4111/",
						tokenFile: join(dir, "token"),
					},
				],
			}),
		);
		expect(() => readBuckleObservationPeers(config)).toThrow("require HTTPS");
	} finally {
		remote.close();
		local.close();
	}
});

test("stack profiles select local Docker hubs without hardcoded names", () => {
	const { dir, local, remote } = rig();
	try {
		const peers = peersFromStack({
			hubs: {
				workhub: {
					host: "local",
					buckle_port: 4111,
					token_file: join(dir, "token"),
					deploy: { dir },
				},
				farhub: {
					host: "remote",
					buckle_port: 4101,
					token_file: join(dir, "token"),
					deploy: { dir, ssh: "remote" },
				},
				unconfigured: { host: "local", buckle_port: 4201, deploy: { dir } },
			},
		});
		expect(peers).toEqual([
			{
				hubId: "workhub",
				url: "http://127.0.0.1:4111",
				tokenFile: join(dir, "token"),
			},
		]);
	} finally {
		remote.close();
		local.close();
	}
});

test("relay restart resumes its durable cursor without replaying the full hub log", async () => {
	const { dir, remote, local } = rig();
	local.close();
	remote.ingest([event("1", "lane.request.admitted")]);
	remote.close();
	const config = join(dir, "peers.json");
	writeFileSync(
		config,
		JSON.stringify({
			peers: [
				{
					hubId: "desktop",
					url: "http://127.0.0.1:4111/",
					tokenFile: join(dir, "token"),
				},
			],
		}),
		{ mode: 0o600 },
	);
	const env = {
		KLH_BUCKLE_OBSERVATION_PEERS: config,
		KLH_LANE_ROUTES_DB: join(dir, "local.db"),
	};
	const cursors: number[] = [];
	const request = async (url: string | URL | Request) => {
		const cursor = Number(new URL(String(url)).searchParams.get("cursor"));
		cursors.push(cursor);
		return Response.json(exportObservations(join(dir, "remote.db"), cursor));
	};
	const first = startBuckleObservationRelay(
		env,
		request as unknown as typeof fetch,
	);
	try {
		for (let i = 0; i < 30 && first.states[0]?.cursor !== 1; i++)
			await Bun.sleep(10);
		expect(first.states[0]?.cursor).toBe(1);
	} finally {
		first.stop();
	}
	const second = startBuckleObservationRelay(
		env,
		request as unknown as typeof fetch,
	);
	try {
		for (let i = 0; i < 30 && cursors.length < 2; i++) await Bun.sleep(10);
		expect(cursors).toEqual([0, 1]);
		expect(second.states[0]?.cursor).toBe(1);
	} finally {
		second.stop();
	}
});
