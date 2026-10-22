import { expect, test } from "bun:test";
import { TransactionEvents } from "../hooks/lib/transaction-events.ts";

test("discarded transaction identity never leaks into reused client IDs", () => {
	const sent: number[] = [];
	const bus = new TransactionEvents((id) => sent.push(id));
	const old = { id: "same" };
	const fresh = { id: "same" };
	bus.inserted(old, 2);
	bus.finish(old, false);
	bus.inserted(fresh, 3);
	bus.finish(fresh, true);
	bus.finish(old, true);
	bus.finish(fresh, true);
	expect(sent).toEqual([3]);
});
test("after committed publication failure later rows still publish and no SQL failure is fabricated", () => {
	const sent: number[] = [];
	const failed: number[] = [];
	const tx = {};
	const bus = new TransactionEvents(
		(id) => {
			if (id === 2) throw Error("closed socket");
			sent.push(id);
		},
		(id) => failed.push(id),
	);
	bus.inserted(tx, 3);
	bus.inserted(tx, 2);
	bus.inserted(tx, 3);
	bus.finish(tx, true);
	bus.finish(tx, true);
	expect(sent).toEqual([3]);
	expect(failed).toEqual([2]);
});
