import { expect, test } from "./pw";
import {
	steerCodexDirectEvent,
	connectCodexAppServer,
} from "../hooks/lib/executors/codex-steer.ts";

const sid = "018f74bb-68f9-70cb-8b42-cc2fbd127e54";
const event = {
	id: 42,
	source: "fleet-knowledge",
	kind: "consult",
	target: sid,
	payload: JSON.stringify({
		cid: "C59",
		question: "Review the proposed gate order",
	}),
};

test("direct consult steers the exact running Codex turn and leaves ack to the lane", async () => {
	const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
	const result = await steerCodexDirectEvent(event, {
		rpc: async (method, params) => {
			calls.push({ method, params });
			if (method === "thread/read")
				return {
					thread: {
						status: { type: "active" },
						turns: [
							{ id: "turn-1", status: "completed" },
							{ id: "turn-2", status: "inProgress" },
						],
					},
				};
			return { turnId: "turn-2" };
		},
	});
	expect(result).toEqual({ state: "steered", turnId: "turn-2" });
	expect(calls.map((call) => call.method)).toEqual([
		"thread/read",
		"turn/steer",
	]);
	expect(calls[1].params).toMatchObject({
		threadId: sid,
		expectedTurnId: "turn-2",
		input: [{ type: "text" }],
	});
	expect(JSON.stringify(calls[1].params)).toContain("C59");
	expect(JSON.stringify(calls[1].params)).toContain(`coord inbox --as ${sid}`);
});

test("idle, absent, and racing turns remain queued in Fleet's durable inbox", async () => {
	for (const status of ["idle", "notLoaded", "systemError"]) {
		const result = await steerCodexDirectEvent(event, {
			rpc: async () => ({ thread: { status: { type: status }, turns: [] } }),
		});
		expect(result.state).toBe("queued");
	}
	const raced = await steerCodexDirectEvent(event, {
		rpc: async (method) => {
			if (method === "thread/read")
				return {
					thread: {
						status: { type: "active" },
						turns: [{ id: "expired", status: "inProgress" }],
					},
				};
			throw new Error("expectedTurnId mismatch");
		},
	});
	expect(raced).toMatchObject({ state: "queued" });
	expect(raced.reason).toContain("expectedTurnId mismatch");
});

test("a Fleet alias without a Codex thread mapping is explicitly unsupported", async () => {
	expect(
		(await steerCodexDirectEvent({ ...event, target: "autow1052-lane" })).state,
	).toBe("unsupported");
	expect(
		(await steerCodexDirectEvent({ ...event, kind: "BROADCAST" })).state,
	).toBe("ignored");
});

test("JSON-RPC transport speaks initialize, read, and steer over one proxy process", async () => {
	const fixture = `${import.meta.dir}/fixtures/codex-app-server-proxy.ts`;
	const delivered = await steerCodexDirectEvent(event, {
		command: [process.execPath, fixture],
	});
	expect(delivered).toEqual({ state: "steered", turnId: "turn-live" });
	const rpc = await connectCodexAppServer([process.execPath, fixture]);
	try {
		const read = await rpc("thread/read", {
			threadId: sid,
			includeTurns: true,
		});
		expect(read).toMatchObject({ thread: { status: { type: "active" } } });
		const steered = await rpc("turn/steer", {
			threadId: sid,
			expectedTurnId: "turn-live",
			input: [{ type: "text", text: "direct event" }],
		});
		expect(steered).toEqual({ turnId: "turn-live" });
	} finally {
		rpc.close();
	}
});
