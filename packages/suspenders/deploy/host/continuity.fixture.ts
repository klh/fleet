import { z } from "zod";
import type { openHostFixture } from "./runtime.fixture.ts";

export type HostFixture = Awaited<ReturnType<typeof openHostFixture>>;
export const BoundarySchema = z.object({
	Config: z.object({ Env: z.array(z.string()) }),
	HostConfig: z.object({
		NetworkMode: z.literal("none"),
		ReadonlyRootfs: z.literal(true),
		Tmpfs: z.record(z.string(), z.string()),
	}),
	Mounts: z.array(
		z.object({
			Type: z.enum(["bind", "tmpfs"]),
			Source: z.string().optional(),
			Destination: z.enum(["/seed", "/tmp", "/workspace"]),
			RW: z.boolean(),
		}),
	),
});
const WireSchema = z.object({ status: z.number().int(), body: z.unknown() });
export const wireFor =
	(host: HostFixture) =>
	async (url: string, method = "GET", body?: unknown, key = "fixture-owner") =>
		WireSchema.parse(
			JSON.parse(
				await host.client(
					`const response=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{authorization:${JSON.stringify(`Bearer ${key}`)},"content-type":"application/json"},${body === undefined ? "" : `body:${JSON.stringify(JSON.stringify(body))},`}signal:AbortSignal.timeout(25000)});console.log(JSON.stringify({status:response.status,body:await response.json().catch(()=>null)}));`,
				),
			),
		);
export const KeySchema = z.object({
	id: z.string(),
	active: z.boolean(),
	issuedSequence: z.number().int(),
	revokedSequence: z.number().int().nullable(),
});
const WitnessSchema = z.object({
	toolCallId: z.string(),
	markerSha256: z.string().length(64),
	matched: z.boolean(),
	keyId: z.string(),
});
export const StatsSchema = z.object({
	minted: z.number(),
	inference: z.number(),
	keys: z.array(KeySchema),
	observations: z.object({
		before: WitnessSchema.optional(),
		after: WitnessSchema.optional(),
		priorConversationSha256: z.string().optional(),
		resumedPriorConversationSha256: z.string().optional(),
		continuedConversationSha256: z.string().optional(),
		priorJournalContent: z.boolean().optional(),
		continuedConversation: z.boolean().optional(),
	}),
});
export const FactsSchema = z.object({
	state: z.string(),
	epoch: z.number().int(),
	record: z.object({
		containerId: z.string().regex(/^[a-f0-9]{64}$/),
		deadlineAt: z.number().int(),
	}),
});
export async function facts(host: HostFixture, runId: string) {
	return FactsSchema.parse(
		JSON.parse(
			await host.storage(`
 const {Database}=require('bun:sqlite'),fs=require('node:fs');
 const db=new Database(root+'/state/control.sqlite',{readonly:true});
 const runId=${JSON.stringify(runId)};
 try{const job=db.query('SELECT state FROM runner_jobs WHERE run_id = ?').get(runId);
 const lease=db.query('SELECT epoch FROM runner_leases WHERE run_id = ?').get(runId);
 const record=JSON.parse(fs.readFileSync(root+'/state/workspaces/'+runId+'/executor.json','utf8'));
 console.log(JSON.stringify({state:job.state,epoch:lease.epoch,record:{containerId:record.containerId,deadlineAt:record.deadlineAt}}));}finally{db.close()}`),
		),
	);
}
