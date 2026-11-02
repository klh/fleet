// hooks/coord/json-out.ts — W2569: the ONE machine-output contract for coord
// verbs, generalizing the W1131 pattern (work report renders FROM one
// versioned JSON contract; every other view renders FROM the same contract).
// Every verb that grows --json emits through here: a schema_version envelope
// { schema_version: 1, verb, ...payload } safeParse'd against a zod schema
// (Schema law W1238.4 — wire-facing shapes fail LOUD on drift instead of
// silently emitting a malformed row), so the pretty tty face and the machine
// face can never disagree.
import { z } from "zod";

// The envelope core every verb contract extends: schema_version pins the
// machine contract (bump on breaking shape change), verb names the emitting
// verb for log-line provenance.
export const envelopeSchema = z.object({
	schema_version: z.literal(1),
	verb: z.string(),
});

/** Compile a verb contract: envelope + payload fields. Returns the zod schema
 *  plus the emitter that renders it — one call site per verb, no hand-rolled
 *  JSON.stringify faces. */
export function verbContract<T extends z.ZodRawShape>(fields: T) {
	const schema = envelopeSchema.extend(fields);
	return {
		schema,
		/** Validate + print the JSON face. A payload that fails the contract
		 *  dies loudly (coord: prefix, exit 2) — never a silent bad row. */
		emit(payload: z.infer<typeof schema>): void {
			const parsed = schema.safeParse(payload);
			if (!parsed.success)
				throw new Error(
					`json contract violation: ${parsed.error.issues
						.map((i) => `${i.path.join(".")}: ${i.message}`)
						.join("; ")}`,
				);
			console.log(JSON.stringify(parsed.data));
		},
	};
}

// --json detection shared by the verb bodies: presence in the raw rest array,
// the same convention the existing --json verbs (fleet/hubs/diff/events/…)
// already use.
export function wantsJson(rest: string[]): boolean {
	return rest.includes("--json");
}
