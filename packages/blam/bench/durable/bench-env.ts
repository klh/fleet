// bench/durable/bench-env.ts — W2971.3 machine-local composition env for
// the leaf: reads bench.local.json (0600, never committed) + the mint
// credential file, builds the DesktopLeafDeps shape arm-admit hands to
// createDesktopRunnerLeaf. One place, fail-closed, loud.
import { readFileSync } from "node:fs";
import { z } from "zod";

export const BenchLocalSchema = z.strictObject({
	repos: z.record(z.string(), z.string().min(1)),
	identityUrl: z.string().url(),
	mintCredentialFile: z.string().min(1),
	image: z.string().min(1),
});
export type BenchLocal = z.infer<typeof BenchLocalSchema>;

export function loadBenchLocal(path: string): BenchLocal {
	const parsed = BenchLocalSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
	if (!parsed.success) {
		throw new Error(`bench.local.json drift refused:\n${parsed.error.message}`);
	}
	return parsed.data;
}

/** Compose DesktopLeafDeps-compatible inputs from bench-local state. */
export async function loadBenchEnv(opts: {
	seedRoot: string;
	model: string;
	wallClockMin: number | null;
}) {
	const local = loadBenchLocal(new URL("./bench.local.json", import.meta.url).pathname);
	return {
		identityUrl: local.identityUrl,
		mintCredentialFile: local.mintCredentialFile,
		image: local.image,
		model: opts.model,
		seedRoot: opts.seedRoot,
		wallClockMin: opts.wallClockMin,
	};
}
