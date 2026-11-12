import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CommitSchema } from "../contract.ts";
import { hostProcess } from "../process.ts";
import { hash } from "./evidence.ts";

const PREFIX = "packages/suspenders/deploy/host/";
export const PUBLISHER_FILES = [
	...[
		"build.ts",
		"contract.ts",
		"process.ts",
		"process-protocol.ts",
		"process-guardian.ts",
		"release/cli.ts",
		"release/contract.ts",
		"release/evidence.ts",
		"release/http.ts",
		"release/identity.ts",
		"release/plan.ts",
		"release/preflight.ts",
		"release/provenance.ts",
		"release/registry.ts",
		"release/verify.ts",
		"release/workflow.ts",
	].map((name) => PREFIX + name),
	...[
		"verb-kit.ts",
		"cli-version.ts",
		"install/harness-manifest.ts",
		"govdb/schema-version.ts",
	].map((name) => `packages/suspenders/hooks/lib/${name}`),
].sort();
export const HelperHashSchema = z.strictObject({
	path: z.string().min(1),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const PublisherIdentitySchema = z.strictObject({
	publisherCommit: CommitSchema,
	helpers: z.array(HelperHashSchema).min(1),
});
export type PublisherIdentity = z.infer<typeof PublisherIdentitySchema>;
export type IdentityRunner = (
	argv: readonly string[],
	cwd: string,
) => Promise<Uint8Array>;
const defaultRun: IdentityRunner = async (argv, cwd) => {
	const result = await hostProcess(argv, {
		cwd,
		timeoutMs: 30_000,
		maxBytes: 8 * 1024 * 1024,
	});
	if (result.code !== 0 || result.signal)
		throw Error("Publisher Git identity unavailable");
	return result.stdout;
};
async function readHelper(path: string) {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size <= 0 || stat.size > 1024 * 1024)
			throw Error("Publisher helper byte/type bound");
		const bytes = new Uint8Array(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const part = await file.read(
				bytes,
				offset,
				bytes.length - offset,
				offset,
			);
			if (!part.bytesRead) throw Error("Publisher helper changed");
			offset += part.bytesRead;
		}
		const after = await file.stat();
		if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
			throw Error("Publisher helper changed");
		return bytes;
	} finally {
		await file.close();
	}
}
/** Exact current publisher source; independent of the older selected image recipe. */
export async function publisherIdentity(
	repository: string,
	run: IdentityRunner = defaultRun,
): Promise<PublisherIdentity> {
	const publisherCommit = CommitSchema.parse(
		new TextDecoder()
			.decode(await run(["git", "rev-parse", "HEAD"], repository))
			.trim(),
	);
	const helpers = [];
	for (const path of PUBLISHER_FILES) {
		let expected: Uint8Array;
		try {
			expected = await run(
				["git", "--no-replace-objects", "show", `${publisherCommit}:${path}`],
				repository,
			);
		} catch {
			throw Error(
				`Publisher helper must be committed at own publisher source: ${path}`,
			);
		}
		const actual = await readHelper(join(repository, path));
		if (hash(expected) !== hash(actual))
			throw Error(
				`Publisher helper differs from own committed source: ${path}`,
			);
		helpers.push({ path, sha256: hash(actual).slice(7) });
	}
	return PublisherIdentitySchema.parse({ publisherCommit, helpers });
}
