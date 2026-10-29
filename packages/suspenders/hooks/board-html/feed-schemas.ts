// hooks/board-html/feed-schemas.ts — zod contracts for the polled board
// feeds (schema law W1238.4). ONE definition, two consumers: the
// <klh-board-mediator> installs them as FeedStore validators (drift fails
// loud as a feed error instead of a malformed render), and the server-side
// board suite parses the real route payloads through them. Loose objects:
// the contract pins what the client READS, extra fields ride through.
// zod/mini: the same schemas at a fraction of the client bundle.
import * as z from "zod/mini";

const ObservationSchema = z.looseObject({
	source: z.optional(z.string()),
	target: z.optional(z.string()),
	scope: z.optional(z.string()),
	observedAt: z.optional(z.number()),
	expiresAt: z.optional(z.number()),
});

export const DataFeedSchema = z.looseObject({
	ts: z.number(),
	projects: z.array(z.looseObject({ project: z.string() })),
	sessions: z.optional(z.array(z.looseObject({}))),
	observation: z.optional(ObservationSchema),
});

export const DecisionsFeedSchema = z.looseObject({
	ts: z.number(),
	decisions: z.array(z.looseObject({})),
	projects: z.optional(z.array(z.string())),
});

export const TasksFeedSchema = z.looseObject({
	ok: z.literal(true),
	tasks: z.array(z.looseObject({ id: z.string(), project: z.string() })),
	projects: z.optional(z.array(z.string())),
});

export const SpendSeriesFeedSchema = z.looseObject({
	ok: z.literal(true),
	series: z.record(z.string(), z.unknown()),
	attempts: z.optional(z.record(z.string(), z.unknown())),
});

/** feed name (FeedStore.define) → its wire contract. */
export const FEED_SCHEMAS = {
	data: DataFeedSchema,
	dec: DecisionsFeedSchema,
	tasks: TasksFeedSchema,
	spend: SpendSeriesFeedSchema,
} as const;

/** A FeedStore validator: throws a prettified error on contract drift. */
export function feedValidator(schema: z.ZodMiniType) {
	return (j: unknown): void => {
		const r = schema.safeParse(j);
		if (!r.success) throw new Error(`schema: ${z.prettifyError(r.error)}`);
	};
}
