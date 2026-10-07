/** Controllers use supported work verbs in their configured checkout.
 * Ambient private Git stores must not redirect the ledger partition. */
function command(
	repo: string,
	cli: string,
	args: string[],
	env: NodeJS.ProcessEnv,
) {
	const clean = { ...env };
	delete clean.GIT_DIR;
	delete clean.GIT_WORK_TREE;
	delete clean.GIT_COMMON_DIR;
	return Bun.spawnSync([process.execPath, cli, ...args], {
		cwd: repo,
		env: clean,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 15000,
		maxBuffer: 8 * 1024 * 1024,
	});
}
export function canonicalWorkClaim(
	repo: string,
	item: string,
	project: string,
	cli: string,
	env: NodeJS.ProcessEnv = process.env,
): {
	project: string;
	id: string;
	state: string;
	owner_sid: string | null;
	updated_at: number;
} | null {
	const result = command(repo, cli, ["show", item, "--json"], env);
	if (result.exitCode !== 0) return null;
	try {
		const row = JSON.parse(result.stdout.toString());
		return row &&
			row.project === project &&
			row.id === item &&
			typeof row.state === "string" &&
			(typeof row.owner_sid === "string" || row.owner_sid === null) &&
			typeof row.updated_at === "number"
			? row
			: null;
	} catch {
		return null;
	}
}
/** Verify the canonical partition before mutation; the supported producer
 * pins owner/revision atomically and its receipt must identify that partition. */
export function canonicalWorkReclaim(
	repo: string,
	expected: { project: string; id: string; owner: string; revision: number },
	cli: string,
	env: NodeJS.ProcessEnv = process.env,
): { code: number; out: string } {
	const claim = canonicalWorkClaim(
		repo,
		expected.id,
		expected.project,
		cli,
		env,
	);
	if (
		!claim ||
		claim.owner_sid !== expected.owner ||
		claim.updated_at !== expected.revision
	)
		return { code: 1, out: "" };
	const result = command(
		repo,
		cli,
		[
			"reclaim",
			expected.id,
			"--expect-owner",
			expected.owner,
			"--expect-updated-at",
			String(expected.revision),
			"--json",
		],
		env,
	);
	if (result.exitCode !== 0) return { code: result.exitCode ?? 1, out: "" };
	const out = result.stdout.toString();
	try {
		const receipt = JSON.parse(out);
		return receipt.released === true &&
			receipt.project === expected.project &&
			receipt.id === expected.id &&
			receipt.previousOwner === expected.owner &&
			receipt.previousUpdatedAt === expected.revision
			? { code: 0, out }
			: { code: 1, out: "" };
	} catch {
		return { code: 1, out: "" };
	}
}
