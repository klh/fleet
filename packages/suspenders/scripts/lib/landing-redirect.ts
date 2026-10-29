// landing-redirect.ts — archived-origin landing guard (the W428 lesson),
// extracted from dispatch-next.ts (W636 decomposition, the 1500-line law):
// probe the origin's GitHub archive flag once per dispatch (10-min cache)
// and, when archived, redirect the brief's landing chain to the living repo
// so a lane never dies silently pushing to a push-dead remote.
import { run } from "../../hooks/lib/lane.ts";

const ARCHIVE_PROBE_TTL_MS = 10 * 60_000;
const archiveProbeCache = new Map<string, { at: number; archived: boolean }>();
const GITHUB_SLUG = /github\.com[:/]+([^/]+)\/([^.]+?)(?:\.git)?$/;

export const landingRedirect = async (
	repo: string,
	branch: string,
): Promise<string | null> => {
	const note = (a: boolean): string | null =>
		a
			? `ORIGIN ARCHIVED (monorepo cutover): ${repo} is push-dead. Commit on ${branch} as usual, then push the branch to the living repo instead of the archived origin: git push https://github.com/klh/fleet.git HEAD:refs/heads/${branch} — work done --sha takes the FLEET head sha. Pushing to the archived origin bounces and ends the lane's run silently.`
			: null;
	return await probeArchive(repo, note);
};

const probeArchive = async (
	repo: string,
	note: (a: boolean) => string | null,
): Promise<string | null> => {
	const cached = archiveProbeCache.get(repo);
	if (cached && Date.now() - cached.at < ARCHIVE_PROBE_TTL_MS)
		return note(cached.archived);
	return await fetchArchiveFlag(repo, note);
};

const fetchArchiveFlag = async (
	repo: string,
	note: (a: boolean) => string | null,
): Promise<string | null> => {
	let archived = false;
	try {
		const r = run(["git", "-C", repo, "remote", "get-url", "origin"]);
		if (r.code === 0) {
			const m = GITHUB_SLUG.exec(r.out);
			if (m) {
				const res = await fetch(
					`https://api.github.com/repos/${m[1]}/${m[2]}`,
					{
						headers: { accept: "application/vnd.github+json" },
						signal: AbortSignal.timeout(8_000),
					},
				);
				if (res.ok)
					archived =
						((await res.json()) as { archived?: boolean }).archived === true;
			}
		}
	} catch {
		archived = false;
	}
	archiveProbeCache.set(repo, { at: Date.now(), archived });
	return note(archived);
};
