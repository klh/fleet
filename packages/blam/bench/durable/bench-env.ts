// bench/durable/bench-env.ts — W2971.3 machine-local composition env for
// the leaf: reads bench.local.json (0600, never committed) + the mint
// credential file, builds the FULL DesktopLeafDeps shape arm-admit hands
// to createDesktopRunnerLeaf — composed exactly as the host service does
// (runners/service/desktop-runtime.ts): sqlite runner store (lease +
// reader schemas ensured), private workspaces/durable dirs, belt-provider
// leaf runtime, buckle-admin credential manager. One place, fail-closed,
// loud.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { z } from "zod";

export const BenchLocalSchema = z.strictObject({
	repos: z.record(z.string(), z.string().min(1)),
	/** Buckle admin base — the key-mint authority face. */
	identityUrl: z.string().url(),
	/** Model-plane base for the belt provider; defaults to identityUrl. */
	modelBaseUrl: z.string().url().optional(),
	mintCredentialFile: z.string().min(1),
	image: z.string().min(1),
	/** Machine-local bench state root — runner store, workspaces, durable
	 *  journals, credential receipts (private, never committed). */
	stateDir: z.string().min(1),
	/** Digest-pinned judge image for this problem repo (klh/blam-judge@sha256…,
	 *  built by judge-image.ts — python + patch + the repo's own deps baked;
	 *  the judge RUN is networkless). */
	judgeImage: z.string().min(8),
});
export type BenchLocal = z.infer<typeof BenchLocalSchema>;

export function loadBenchLocal(path: string): BenchLocal {
	const parsed = BenchLocalSchema.safeParse(
		JSON.parse(readFileSync(path, "utf8")),
	);
	if (!parsed.success) {
		throw new Error(`bench.local.json drift refused:\n${parsed.error.message}`);
	}
	return parsed.data;
}

/** Compose the FULL DesktopLeafDeps from bench-local state. Heavy imports
 *  stay lazy so the schema layer loads without docker or the leaf. */
export async function loadBenchEnv(opts: {
	seedRoot: string;
	model: string;
	wallClockMin: number | null;
	/** Override the pinned machine-local bench.local.json (tests). */
	localPath?: string;
}) {
	const localPath = opts.localPath ?? join(import.meta.dir, "bench.local.json");
	const local = loadBenchLocal(localPath);
	const { sqliteStore } = await import(
		"@klh/suspenders/hooks/lib/runners/control/store.ts"
	);
	const { ensureRunnerLeaseSchema } = await import(
		"@klh/suspenders/hooks/lib/runners/control/leases.ts"
	);
	const { ensureRunnerReaderSchema } = await import(
		"@klh/suspenders/hooks/lib/runners/control/cursors.ts"
	);
	const { privateDirectory } = await import(
		"@klh/suspenders/hooks/lib/runners/durable/private-paths.ts"
	);
	const { beltLeafRuntime } = await import(
		"@klh/suspenders/hooks/lib/runners/service/belt-models.ts"
	);
	mkdirSync(local.stateDir, { recursive: true });
	const workspacesDir = join(local.stateDir, "workspaces");
	const durableRoot = join(local.stateDir, "durable");
	await Promise.all([
		privateDirectory(workspacesDir),
		privateDirectory(durableRoot),
	]);
	const store = sqliteStore(new Database(join(local.stateDir, "runner.db")));
	ensureRunnerLeaseSchema(store);
	ensureRunnerReaderSchema(store);
	const adminKey = readFileSync(local.mintCredentialFile, "utf8").trim();
	if (!adminKey)
		throw new Error(`mint credential file empty: ${local.mintCredentialFile}`);
	return {
		store,
		durableRoot,
		executorSid: "desktop-runner",
		runtime: beltLeafRuntime(local.modelBaseUrl ?? local.identityUrl, [
			opts.model,
		]),
		container: {
			image: local.image,
			seedRoot: opts.seedRoot,
			workspacesDir,
		},
		credentials: {
			baseUrl: local.identityUrl,
			adminKey,
			receiptsPath: join(local.stateDir, "credentials.json"),
		},
	};
}
