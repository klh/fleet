import { z } from "zod";
import { safeUrl } from "./safe-text.ts";
const label = z.string().max(400);
const count = z.number().int().nonnegative();
const CandidateSchema = z
	.object({ source: label, up: z.boolean(), ms: z.number().nonnegative() })
	.strip();
export const HubSchema = z
	.object({
		label,
		up: z.boolean(),
		url: z.string().nullable().transform(safeUrl),
		models: z
			.array(z.object({ id: label }).strip())
			.max(1000)
			.nullable(),
		candidates: z.array(CandidateSchema).max(100),
	})
	.strip();
export const HubsSchema = z
	.object({ hubs: z.array(HubSchema).max(100) })
	.strip();
export const WorkItemSchema = z
	.object({
		id: label,
		title: z.string().max(4000),
		status: label,
		stalled: z.boolean(),
		needs_you_reason: z.string().nullable(),
		best_action: z.string(),
		model: label,
		hub: label.nullable(),
		last_output_ms_ago: z.number().nonnegative().nullable(),
	})
	.strip();
export const WorkSchema = z
	.object({
		schema_version: z.literal(1),
		generated_at: z.iso.datetime(),
		items: z.array(WorkItemSchema).max(2000),
		needs_you: z.object({ count, ids: z.array(label).max(2000) }).strip(),
		capacity: z
			.object({ pending: count, held: count, admitted: count, target: count })
			.strip()
			.nullable(),
		model_health: z.object({ down: z.array(label).max(1000) }).strip(),
	})
	.strip();
export const PeerSchema = z
	.object({
		sid: label,
		label,
		sessionName: label.nullable(),
		capabilities: z.array(label).max(200),
	})
	.strip();
export const PeersSchema = z.array(PeerSchema).max(1000);
export type Hub = z.infer<typeof HubSchema>;
export type Work = z.infer<typeof WorkSchema>;
export type Peer = z.infer<typeof PeerSchema>;
export type Source<T> = {
	state: "ok" | "invalid" | "unavailable";
	observedAt: number;
	value: T | null;
};
export type Snapshot = {
	hubs: Source<Hub[]>;
	work: Source<Work>;
	peers: Source<Peer[]>;
};
