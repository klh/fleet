import { randomUUID } from "node:crypto";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry } from "@earendil-works/pi-durable";
import { scratchWorld } from "@klh/test-kit";
import { expect, test } from "@playwright/test";

test("Durable job preserves conversation and rejects changed seed across reopen @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-job-" });
	const actions: string[] = [];
	const spec = {
		version: 1,
		runId: randomUUID(),
		owner: "fixture-owner",
		generation: 1,
		kind: "knowledge",
		seedDigest: "a".repeat(64),
		policyDigest: "b".repeat(64),
		provider: "fixture",
		model: "fixture",
	};
	const options = {
		root: world.home,
		spec,
		runtime: { models: createModels(), registry: createRegistry() },
		authorize: async (action: string) => {
			actions.push(action);
		},
	};
	try {
		const first = await openDurableJob(options),
			id = first.conversationId;
		await expect(openDurableJob(options)).rejects.toThrow("writer");
		await first.close();
		const reopened = await openDurableJob(options);
		expect(reopened.conversationId).toBe(id);
		await reopened.close();
		await expect(
			openDurableJob({
				...options,
				spec: { ...spec, seedDigest: "c".repeat(64) },
			}),
		).rejects.toThrow("manifest");
		expect(actions).toContain("open");
	} finally {
		world.clean();
	}
});

test("Durable job checks host authorization before opening storage @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	await expect(
		openDurableJob({
			root: "/nonexistent/fixture",
			spec: {
				version: 1,
				runId: randomUUID(),
				owner: "fixture",
				generation: 1,
				kind: "knowledge",
				seedDigest: "a".repeat(64),
				policyDigest: "b".repeat(64),
				provider: "fixture",
				model: "fixture",
			},
			runtime: { models: createModels(), registry: createRegistry() },
			authorize: async () => {
				throw new Error("denied by host");
			},
		}),
	).rejects.toThrow("denied by host");
});

test("Durable request IDs survive reopen and authorization cannot be bypassed through a submission @unit", async () => {
	const { openDurableJob } = await import(
		"../hooks/lib/runners/durable/job.ts"
	);
	const world = scratchWorld({ prefix: "durable-request-" });
	const spec = {
		version: 1,
		runId: randomUUID(),
		owner: "fixture",
		generation: 1,
		kind: "knowledge",
		seedDigest: "a".repeat(64),
		policyDigest: "b".repeat(64),
		provider: "missing-fixture-provider",
		model: "fixture",
	};
	let deny = false;
	const options = {
		root: world.home,
		spec,
		runtime: {
			models: createModels(),
			registry: createRegistry(),
			settings: { retry: { enabled: false, maxRetries: 0 } },
		},
		authorize: async () => {
			if (deny) throw new Error("rights revoked");
		},
	};
	let job: Awaited<ReturnType<typeof openDurableJob>> | undefined;
	try {
		job = await openDurableJob(options);
		const input = {
			requestId: "request-1",
			text: "fixture only; no configured provider",
		};
		const first = await job.submit(input);
		expect((await first.wait()).status).toBe("unanswered");
		deny = true;
		await expect(first.abort()).rejects.toThrow("rights revoked");
		await expect(job.resume()).rejects.toThrow("rights revoked");
		deny = false;
		await job.close();
		job = await openDurableJob(options);
		const duplicate = await job.submit(input);
		expect(duplicate.id).toBe(first.id);
		expect((await duplicate.wait()).status).toBe("unanswered");
	} finally {
		await job?.close();
		world.clean();
	}
});
