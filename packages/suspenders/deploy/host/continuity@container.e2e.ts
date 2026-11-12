import { randomUUID, createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import {
	containerNameOf,
	resolvedPolicyDigest,
} from "../../hooks/lib/runners/desktop/docker-executor.ts";
import { DESKTOP_RUNNER_IMAGE } from "../../hooks/lib/runners/desktop/prereqs.ts";
import { canonicalSeedDigest } from "../../hooks/lib/runners/desktop/seed.ts";
import { continuityAuthorityScript } from "./authority.fixture.ts";
import { openHostFixture } from "./runtime.fixture.ts";
import {
	facts,
	StatsSchema,
	BoundarySchema,
	wireFor,
	type HostFixture,
} from "./continuity.fixture.ts";

const marker = `WORKSPACE_WITNESS_${randomUUID()}`;
const firstPrompt = "Create the workspace continuity witness before parking.";
const nextPrompt =
	"Read the existing workspace witness after authorized resume.";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
async function world() {
	const image = process.env.FLEET_SUPERVISOR_TEST_IMAGE;
	if (!image)
		throw new Error(
			"FLEET_SUPERVISOR_TEST_IMAGE must identify the immutable candidate",
		);
	return openHostFixture(
		image,
		DESKTOP_RUNNER_IMAGE,
		{
			seedDigest: canonicalSeedDigest([
				{ path: "marker", bytes: Buffer.from("HOST_FIXTURE_SEED_MARKER") },
			]),
			policyDigest: resolvedPolicyDigest({
				image: DESKTOP_RUNNER_IMAGE,
				seedRoot: "/fixture/seed",
				workspacesDir: "/fixture/workspaces",
			}),
		},
		continuityAuthorityScript({ marker, firstPrompt, nextPrompt }),
		(check) => expect(check).toPass({ timeout: 5000, intervals: [50] }),
	);
}
async function ready(host: HostFixture) {
	const wire = wireFor(host);
	await expect(async () =>
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs`,
					"GET",
					undefined,
					"fixture-reader",
				)
			).status,
		).toBe(200),
	).toPass({ timeout: 10000, intervals: [100] });
	expect(JSON.parse(await host.health())).toEqual({
		check: "protected-runner-list",
		ok: true,
	});
}
async function absent(host: HostFixture, cid: string) {
	await expect(() =>
		expect(host.command(["docker", "inspect", cid])).rejects.toThrow(
			/No such (object|container)/i,
		),
	).toPass({ timeout: 5000, intervals: [50] });
}
const stats = async (host: HostFixture) =>
	StatsSchema.parse(
		(await wireFor(host)(`${host.identityUrl}/fixture-stats`)).body,
	);
for (const mode of ["corruptCheckpoint", "missingJournal"] as const)
	test(`packaged HOST ${mode} refuses resume without surviving authority @container`, async () => {
		test.setTimeout(150000);
		const host = await world();
		let evidence: unknown;
		try {
			const p = await parked(host),
				wire = wireFor(host);
			const changed =
				await host.storage(`const fs=require('node:fs'),{Database}=require('bun:sqlite');
 const runId=${JSON.stringify(p.runId)},mode=${JSON.stringify(mode)};
 if(mode==='missingJournal')fs.unlinkSync(root+'/state/durable/'+runId+'/state/main.jsonl');
 else{const db=new Database(root+'/state/control.sqlite',{readonly:true});try{
 const row=db.query('SELECT checkpoint_json FROM runner_handoffs WHERE run_id = ?').get(runId);
 const id=JSON.parse(row.checkpoint_json).checkpoint.id;
 if(!/^[a-f0-9-]{36}$/.test(id))throw Error('checkpoint identity');
 const fd=fs.openSync(root+'/state/durable/.checkpoints/'+id+'/workspace.tar','r+');try{const b=Buffer.alloc(1);if(fs.readSync(fd,b,0,1,0)!==1)throw Error('empty archive');b[0]^=255;fs.writeSync(fd,b,0,1,0);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
 }finally{db.close()}}
 console.log(JSON.stringify({changed:true}));`);
			z.strictObject({ changed: z.literal(true) }).parse(JSON.parse(changed));
			const newHostCid = (await host.supervisor([], true)).trim();
			expect(newHostCid).not.toBe(p.oldHostCid);
			await ready(host);
			const before = await stats(host);
			const response = await wire(
				`${host.controlUrl}/v1/runner/runs/${p.runId}/resume`,
				"POST",
				{},
			);
			expect(response).toEqual({
				status: 503,
				body: { error: "runner.unavailable" },
			});
			expect((await facts(host, p.runId)).state).toBe("failed");
			const after = await stats(host);
			expect(after.inference).toBe(before.inference);
			expect(after.minted).toBe(before.minted);
			expect(after.keys.every((k) => !k.active)).toBe(true);
			await absent(host, p.oldGuestCid);
			await absent(host, p.name);
			evidence = {
				mode,
				refused: true,
				modelEffects: after.inference - before.inference,
				liveGuests: 0,
				liveKeys: after.keys.filter((k) => k.active).length,
				mintedAfterRefusal: after.minted - before.minted,
			};
		} finally {
			await host.clean();
		}
		console.log(
			JSON.stringify({
				kind: "continuity-negative",
				evidence,
				checkedCleanup: true,
			}),
		);
	});
async function parked(host: HostFixture) {
	const wire = wireFor(host),
		runId = randomUUID(),
		name = containerNameOf(runId);
	host.trackGuest(name, runId);
	await wire(`${host.identityUrl}/fixture-release-control`);
	const oldHostCid = (await host.supervisor([], true)).trim();
	await ready(host);
	expect(
		(
			await wire(`${host.controlUrl}/v1/runner/runs`, "POST", {
				profile: "standard",
				runId,
			})
		).status,
	).toBe(201);
	expect(
		(
			await wire(`${host.controlUrl}/v1/runner/runs/${runId}/submit`, "POST", {
				requestId: randomUUID(),
				text: firstPrompt,
			})
		).status,
	).toBe(200);
	await expect(async () =>
		expect((await stats(host)).observations.before?.matched).toBe(true),
	).toPass({ timeout: 20000, intervals: [100] });
	const before = await facts(host, runId),
		oldGuestCid = await host.captureGuest(name);
	expect(before.record.containerId).toBe(oldGuestCid);
	const boundary = BoundarySchema.parse(
		JSON.parse(
			await host.command([
				"docker",
				"inspect",
				oldGuestCid,
				"--format",
				"{{json .}}",
			]),
		),
	);
	expect(boundary.Mounts.filter((m) => m.Type === "bind")).toEqual([
		{
			Type: "bind",
			Source: `${host.root}/state/workspaces/${runId}/seed`,
			Destination: "/seed",
			RW: false,
		},
	]);
	expect(Object.keys(boundary.HostConfig.Tmpfs).sort()).toEqual([
		"/tmp",
		"/workspace",
	]);
	for (const value of [
		host.root,
		host.identityUrl,
		host.controlUrl,
		"fixture-owner",
		"fixture-reader",
		"fixture-mint",
		"fixture-model-key",
	])
		expect(boundary.Config.Env.join("\n")).not.toContain(value);
	expect((await stats(host)).observations.before?.markerSha256).toBe(
		sha(marker),
	);
	await host.command(["docker", "kill", "--signal=SIGTERM", oldHostCid]);
	expect(
		(await host.command(["docker", "wait", oldHostCid], 20000)).trim(),
	).toBe("0");
	expect((await facts(host, runId)).state).toBe("parked");
	await absent(host, oldGuestCid);
	expect((await stats(host)).keys.every((key) => !key.active)).toBe(true);
	return { runId, name, before, oldHostCid, oldGuestCid };
}
test("packaged HOST graceful park and fresh authorized resume @container", async () => {
	test.setTimeout(150000);
	const host = await world();
	let evidence: unknown;
	try {
		const p = await parked(host),
			wire = wireFor(host);
		const newHostCid = (await host.supervisor([], true)).trim();
		expect(newHostCid).not.toBe(p.oldHostCid);
		await ready(host);
		const prior = await stats(host);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${p.runId}/resume`,
					"POST",
					{},
					"fixture-reader",
				)
			).status,
		).toBe(403);
		const denied = await stats(host);
		expect(denied).toEqual(prior);
		expect((await facts(host, p.runId)).state).toBe("parked");
		await absent(host, p.name);
		expect(denied.keys.filter((key) => key.active)).toHaveLength(0);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${p.runId}/resume`,
					"POST",
					{},
				)
			).body,
		).toEqual({ ok: true, state: "running" });
		const after = await facts(host, p.runId);
		expect(after.epoch).toBeGreaterThan(p.before.epoch);
		expect(after.record.deadlineAt).toBe(p.before.record.deadlineAt);
		expect(after.record.containerId).not.toBe(p.oldGuestCid);
		await host.captureGuest(p.name);
		const boundary = BoundarySchema.parse(
			JSON.parse(
				await host.command([
					"docker",
					"inspect",
					after.record.containerId,
					"--format",
					"{{json .}}",
				]),
			),
		);
		expect(boundary.Mounts.filter((m) => m.Type === "bind")).toEqual([
			{
				Type: "bind",
				Source: `${host.root}/state/workspaces/${p.runId}/seed`,
				Destination: "/seed",
				RW: false,
			},
		]);
		expect(Object.keys(boundary.HostConfig.Tmpfs).sort()).toEqual([
			"/tmp",
			"/workspace",
		]);
		for (const value of [
			host.root,
			host.identityUrl,
			host.controlUrl,
			"fixture-owner",
			"fixture-reader",
			"fixture-mint",
			"fixture-model-key",
		])
			expect(boundary.Config.Env.join("\n")).not.toContain(value);
		z.literal(true).parse(boundary.HostConfig.ReadonlyRootfs);
		expect(
			(
				await wire(
					`${host.identityUrl}/v1/chat/completions`,
					"POST",
					{ model: "fixture", messages: [] },
					"fixture-model-key-1",
				)
			).status,
		).toBe(403);
		expect((await stats(host)).inference).toBe(prior.inference);
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${p.runId}/submit`,
					"POST",
					{ requestId: randomUUID(), text: nextPrompt },
				)
			).status,
		).toBe(200);
		await expect(async () =>
			expect((await stats(host)).observations.after?.matched).toBe(true),
		).toPass({ timeout: 20000, intervals: [100] });
		const s = await stats(host),
			old = s.keys[0],
			fresh = s.keys[1],
			o = s.observations;
		if (!old || !fresh || old.revokedSequence === null || !o.before || !o.after)
			throw new Error("Continuity witnesses missing");
		expect(s.keys).toHaveLength(2);
		expect(old.active).toBe(false);
		expect(fresh.active).toBe(true);
		expect(old.revokedSequence).toBeLessThan(fresh.issuedSequence);
		expect(o.after.keyId).toBe(fresh.id);
		expect(o.after.toolCallId).toBe("call-after-resume");
		expect(o.after.markerSha256).toBe(sha(marker));
		expect(o.priorJournalContent).toBe(true);
		expect(o.continuedConversation).toBe(true);
		expect(o.resumedPriorConversationSha256).toBe(o.priorConversationSha256);
		expect(o.continuedConversationSha256).not.toBe(o.priorConversationSha256);
		evidence = {
			oldHostCid: p.oldHostCid,
			newHostCid,
			oldGuestCid: p.oldGuestCid,
			newGuestCid: after.record.containerId,
			oldEpoch: p.before.epoch,
			newEpoch: after.epoch,
			oldKeyId: old.id,
			newKeyId: fresh.id,
			resumedModelKeyId: o.after.keyId,
			originalDeadline: new Date(p.before.record.deadlineAt).toISOString(),
			resumedDeadline: new Date(after.record.deadlineAt).toISOString(),
			oldKeyRevokedSequence: old.revokedSequence,
			newKeyIssuedSequence: fresh.issuedSequence,
			postResumeToolCallId: o.after.toolCallId,
			workspaceMarkerSha256: o.before.markerSha256,
			resumedMarkerSha256: o.after.markerSha256,
			priorConversationSha256: o.priorConversationSha256,
			resumedPriorConversationSha256: o.resumedPriorConversationSha256,
			continuedConversationSha256: o.continuedConversationSha256,
			negatives: {
				unauthorizedResume: {
					refused: true,
					modelEffects: denied.inference - prior.inference,
					liveGuests: 0,
					liveKeys: denied.keys.filter((key) => key.active).length,
					checkedCleanup: true,
				},
			},
		};
		expect(
			(
				await wire(
					`${host.controlUrl}/v1/runner/runs/${p.runId}/abort`,
					"POST",
					{},
				)
			).body,
		).toEqual({ ok: true, state: "stopped" });
		await absent(host, after.record.containerId);
		expect((await stats(host)).keys.every((key) => !key.active)).toBe(true);
	} finally {
		await host.clean();
	}
	console.log(
		JSON.stringify({
			kind: "continuity-witness",
			evidence,
			checkedCleanup: true,
		}),
	);
});
