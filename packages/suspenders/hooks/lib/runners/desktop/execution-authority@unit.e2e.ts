import { Database } from "bun:sqlite";

import { expect, test } from "@playwright/test";
import { openRunnerController } from "../control/controller.ts";
import { admitLease, revokeLease } from "../control/leases.ts";
import { sqliteStore } from "../control/store.ts";

import { captureExecutionAuthority } from "./execution-authority.ts";

test("captured authority cannot adopt a replacement token or caller mutation @unit", async () => {
	const db = new Database(":memory:"),
		store = sqliteStore(db);
	const controller = openRunnerController({ store });
	const first = admitLease(store, {
		runId: "owned",
		controllerSid: "executor",
		now: Date.now(),
		ttlMs: 60_000,
	});
	if (!first.ok) throw new Error(first.reason);
	const tokens = new Map([["owned", { epoch: first.token.epoch }]]);
	const token = tokens.get("owned");
	if (!token) throw new Error("fixture token missing");
	const authority = captureExecutionAuthority({
		runId: "owned",
		executorSid: "executor",
		token,
		fence: controller.fence,
		credentials: { resolve: () => undefined },
	});
	try {
		await authority.authorize("execute", { runId: "owned" });
		expect(revokeLease(store, "owned", Date.now()).ok).toBe(true);
		const next = admitLease(store, {
			runId: "owned",
			controllerSid: "executor",
			now: Date.now(),
			ttlMs: 60_000,
		});
		if (!next.ok) throw new Error(next.reason);
		token.epoch = next.token.epoch;
		tokens.set("owned", { epoch: next.token.epoch });
		await expect(
			authority.authorize("execute", { runId: "owned" }),
		).rejects.toThrow(/fenced/);
		const replacement = captureExecutionAuthority({
			runId: "owned",
			executorSid: "executor",
			token: next.token,
			fence: controller.fence,
			credentials: { resolve: () => undefined },
		});
		await replacement.authorize("execute", { runId: "owned" });
		await expect(
			replacement.authorize("execute", { runId: "other" }),
		).rejects.toThrow("run mismatch");
	} finally {
		db.close();
	}
});

test("captured headers use the exact epoch and refuse a revoked key @unit", async () => {
	const { serveStub } = await import("@klh/test-kit");
	const { createCredentialManager } = await import("./credentials.ts");
	const admin = serveStub((request, _body, n) =>
		new URL(request.url).pathname.endsWith("/revoke")
			? Response.json({ revoked: "fixture" })
			: Response.json(
					{
						key_id: `key-${n}`,
						key: `fixture-${n}`,
						name: "fixture",
						scopes: ["buckle:proxy:WRITE_"],
						expires_at: Date.now() + 60_000,
					},
					{ status: 201 },
				),
	);
	try {
		const credentials = createCredentialManager({
			baseUrl: admin.url,
			adminKey: "fixture-admin",
		});
		const authority = captureExecutionAuthority({
			runId: "owned",
			executorSid: "executor",
			token: { epoch: 1 },
			fence: async () => {},
			credentials,
		});
		expect(() => authority.key()).toThrow("no live credential");
		await credentials.mint("owned", 1);
		await credentials.mint("owned", 3);
		const headers = {
			Authorization: "ambient",
			authorization: "also-ambient",
			custom: "retained",
		};
		expect(authority.transformHeaders(headers)).toEqual({
			authorization: "Bearer fixture-1",
			custom: "retained",
		});
		expect(headers.Authorization).toBe("ambient");
		expect(credentials.resolve("owned")?.epoch).toBe(3);
		await credentials.revoke("owned", 1);
		expect(() => authority.key()).toThrow("no live credential");
		expect(() => authority.transformHeaders({})).toThrow("no live credential");
	} finally {
		admin.close();
	}
});

test("capture copies run identity and never trusts a resolver returning another epoch @unit", async () => {
	const seen: { runId: string; sid: string; epoch?: number }[] = [];
	const input: Parameters<typeof captureExecutionAuthority>[0] = {
		runId: "owned",
		executorSid: "original-executor",
		token: { epoch: 1 },
		fence: async ({ runId, actor }) => {
			seen.push({ runId, sid: actor.sid, epoch: actor.leaseToken?.epoch });
			actor.leaseToken = { epoch: 99 };
		},
		credentials: {
			resolve: () => ({ key: "foreign", keyId: "foreign", epoch: 99 }),
		},
	};
	const authority = captureExecutionAuthority(input);
	input.runId = "other";
	input.executorSid = "replacement-executor";
	input.token = { epoch: 99 };
	await authority.authorize("open", { runId: "owned" });
	await authority.authorize("resume", { runId: "owned" });
	await expect(
		authority.authorize("execute", { runId: "other" }),
	).rejects.toThrow("run mismatch");
	const original = { runId: "owned", sid: "original-executor", epoch: 1 };
	expect(seen).toEqual([original, original]);
	expect(() => authority.key()).toThrow("no live credential");
});
