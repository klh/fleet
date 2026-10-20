import { expect, test } from "bun:test";
import {
	codexThreadForSession,
	deliverSubscribedCodexEvent,
} from "../hooks/lib/codex-direct-delivery.ts";

const sid = "019b0ba5-4c7e-7d51-99fa-85704ad78b99";
const event = {
	id: 59,
	source: "fleet-knowledge",
	kind: "consult",
	target: sid,
	payload: '{"question":"Please review the architecture"}',
};

test("Codex subscriber resolves the exact thread mapping from Fleet facts", () => {
	const store = {
		query: () => ({
			get: (key: unknown) =>
				key === `codex.thread.${sid}` ? { value: sid } : undefined,
		}),
	};
	expect(codexThreadForSession(store, sid)).toBe(sid);
	expect(codexThreadForSession(store, "other")).toBeNull();
	expect(
		codexThreadForSession(
			{ query: () => ({ get: () => ({ value: "not-a-uuid" }) }) },
			sid,
		),
	).toBeNull();
});

test("only addressed direct events are steered; absent mapping stays queued", async () => {
	const calls: unknown[] = [];
	const steer = async (...args: unknown[]) => {
		calls.push(args);
		return { state: "steered" as const, turnId: "turn-live" };
	};
	expect(await deliverSubscribedCodexEvent(event, sid, sid, steer)).toEqual({
		state: "steered",
		turnId: "turn-live",
	});
	expect(calls).toHaveLength(1);
	expect(
		await deliverSubscribedCodexEvent(
			{ ...event, target: "other" },
			sid,
			sid,
			steer,
		),
	).toMatchObject({ state: "ignored" });
	expect(
		await deliverSubscribedCodexEvent(
			{ ...event, kind: "BROADCAST" },
			sid,
			sid,
			steer,
		),
	).toMatchObject({ state: "ignored" });
	expect(
		await deliverSubscribedCodexEvent(event, sid, null, steer),
	).toMatchObject({ state: "unsupported" });
	expect(calls).toHaveLength(1);
});
