import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { createExecutorBindings } from "../hooks/lib/runners/api/bindings.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";

test("host bindings persist old epochs and refuse foreign/expired credentials @unit", () => {
	const db = new Database(":memory:");
	try {
		let now = 1_000;
		const store = sqliteStore(db);
		const bindings = createExecutorBindings({ store, now: () => now });
		const runId = crypto.randomUUID();
		bindings.register({ keyId: "old-key", runId, epoch: 1, expiresAt: 2_000 });
		bindings.register({ keyId: "new-key", runId, epoch: 2, expiresAt: 3_000 });
		const reopened = createExecutorBindings({ store, now: () => now });
		expect(reopened.resolve("old-key", runId)).toEqual({ epoch: 1 });
		expect(reopened.resolve("new-key", runId)).toEqual({ epoch: 2 });
		expect(() => reopened.resolve("new-key", crypto.randomUUID())).toThrow(
			"runner.forbidden",
		);
		expect(() =>
			bindings.register({
				keyId: "old-key",
				runId,
				epoch: 2,
				expiresAt: 3_000,
			}),
		).toThrow("runner.binding_conflict");
		now = 2_000;
		expect(() => reopened.resolve("old-key", runId)).toThrow(
			"runner.forbidden",
		);
		expect(() =>
			bindings.register({ keyId: "bad", runId, epoch: 3, expiresAt: now }),
		).toThrow();
	} finally {
		db.close();
	}
});
