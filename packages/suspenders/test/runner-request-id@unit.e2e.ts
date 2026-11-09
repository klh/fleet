import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { openRunnerController } from "../hooks/lib/runners/control/controller.ts";
import { sqliteStore } from "../hooks/lib/runners/control/store.ts";

test("request ID reaches durable submit on cold and running delivery @unit", async () => {
	const db = new Database(":memory:");
	try {
		const delivered: unknown[] = [];
		const controller = openRunnerController({
			store: sqliteStore(db),
			durable: {
				async start() {},
				async resume() {},
				async stop() {},
				async submit(_runId, _text, meta) {
					delivered.push(meta);
				},
			},
		});
		const actor = {
			sid: "owner",
			scopes: ["buckle:runner:WRITE_", "buckle:runner:READ_"],
		};
		const runId = crypto.randomUUID();
		await controller.admit({
			actor,
			spec: {
				version: 1,
				runId,
				owner: actor.sid,
				generation: 1,
				kind: "coding",
				seedDigest: "a".repeat(64),
				policyDigest: "b".repeat(64),
				provider: "belt",
				model: "glm-5.3",
			},
		});
		const requestId = crypto.randomUUID();
		await controller.submit({ actor, runId, text: "first", requestId });
		await controller.submit({ actor, runId, text: "first", requestId });
		expect(delivered).toEqual([{ requestId }, { requestId }]);
	} finally {
		db.close();
	}
});

test("parked retries retain IDs and failed equal-text messages survive resume @unit", async () => {
	const db = new Database(":memory:");
	try {
		const delivered: string[] = [];
		const first = crypto.randomUUID();
		const second = crypto.randomUUID();
		let fail = true;
		const durable = {
			async start() {},
			async resume() {},
			async stop() {},
			async submit(
				_runId: string,
				_text: string,
				meta?: { requestId?: string },
			) {
				if (fail && meta?.requestId === second)
					throw new Error("delivery failed");
				if (meta?.requestId) delivered.push(meta.requestId);
			},
		};
		const store = sqliteStore(db);
		const controller = openRunnerController({ store, durable });
		const actor = {
			sid: "owner",
			scopes: ["buckle:runner:WRITE_", "buckle:runner:READ_"],
		};
		const runId = crypto.randomUUID();
		await controller.admit({
			actor,
			spec: {
				version: 1,
				runId,
				owner: actor.sid,
				generation: 1,
				kind: "coding",
				seedDigest: "a".repeat(64),
				policyDigest: "b".repeat(64),
				provider: "belt",
				model: "glm-5.3",
			},
		});
		store.run(
			"UPDATE runner_jobs SET state = ? WHERE run_id = ?",
			"parked",
			runId,
		);
		for (const requestId of [first, first, second])
			await controller.submit({ actor, runId, text: "same", requestId });
		await expect(
			controller.submit({ actor, runId, text: "changed", requestId: first }),
		).rejects.toThrow("runner.request_conflict");
		await controller.resume({ actor, runId });
		expect(delivered).toEqual([first]);
		expect(
			(await controller.read({ actor, runId })).job.held_interrupts,
		).toEqual(["same"]);
		fail = false;
		store.run(
			"UPDATE runner_jobs SET state = ? WHERE run_id = ?",
			"parked",
			runId,
		);
		await openRunnerController({ store, durable }).resume({ actor, runId });
		expect(delivered).toEqual([first, second]);
	} finally {
		db.close();
	}
});
