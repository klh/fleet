import {
	PostureDocumentSchema,
	PostureSelectionSchema,
	ResolvedEntrySchema,
	throwValidationError,
	type PostureDocument,
} from "./posture.zod.ts";
import { resolvePosture } from "./posture.resolve.ts";
import { z } from "zod";

/** Legacy route names alone cannot identify a hub or an unpinned model. */
export const LegacyPostureInventorySchema = z.strictObject({
	selection: PostureSelectionSchema,
	entries: z.array(ResolvedEntrySchema),
});

export type LegacyPostureInventory = z.infer<
	typeof LegacyPostureInventorySchema
>;

export function postureFromLegacyInventory(
	input: LegacyPostureInventory,
	source: string,
): PostureDocument {
	const parsed = LegacyPostureInventorySchema.safeParse(input);
	if (!parsed.success) throwValidationError(source, parsed.error.issues);
	const { selection, entries } = parsed.data;
	const hubs: PostureDocument["hubs"] = {};
	const references: string[] = [];
	for (const entry of entries) {
		let hub = hubs[entry.hub];
		if (!hub) {
			hub = { profiles: { [selection.posture]: { models: {} } } };
			hubs[entry.hub] = hub;
			references.push(`${entry.hub}.${selection.posture}`);
		}
		const models = hub.profiles[selection.posture].models;
		const previous = models[entry.model];
		if (
			previous &&
			(previous.policy !== entry.policy || previous.lanes !== entry.lanes)
		)
			throw new Error(
				`${source}: conflicting legacy rules for ${entry.hub}/${entry.model}`,
			);
		models[entry.model] = { policy: entry.policy, lanes: entry.lanes };
	}
	const document = PostureDocumentSchema.parse({
		version: 1,
		hubs,
		fleets: {
			[selection.fleet]: {
				postures: { [selection.posture]: references },
			},
		},
		selection,
	});
	resolvePosture(document, []);
	return document;
}
