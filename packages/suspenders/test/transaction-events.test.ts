import { expect, test } from "bun:test";
import { TransactionEvents } from "../hooks/lib/govdb/transaction-events.ts";

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

test("autocommit publication and reporting failures do not block later committed events", () => {
	const sent: number[] = [];
	const failed: number[] = [];
	const bus = new TransactionEvents(
		(id) => {
			if (id === 2) throw Error("closed socket");
			sent.push(id);
		},
		(id) => {
			failed.push(id);
			throw Error("closed diagnostic pipe");
		},
	);
	expect(() => bus.inserted(null, 2)).not.toThrow();
	bus.inserted(null, 3);
	expect(sent).toEqual([3]);
	expect(failed).toEqual([2]);
	const tx = {};
	bus.inserted(tx, 2);
	bus.inserted(tx, 4);
	expect(() => bus.finish(tx, true)).not.toThrow();
	expect(sent).toEqual([3, 4]);
});
