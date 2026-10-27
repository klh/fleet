// hooks/lib/capacity/ramp-lanes.ts — W1713 the live lane PROCESS counter: the
// `work lanes --json` roster read through the installed work CLI. A different
// number from in-flight RPCs and from distinct productive lane ids — the
// report prints all three side by side, never one for another.

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

/** Roster rows with live:true; null when the text is not a roster. */
export function parseLiveLanes(text: string): number | null {
	let roster: unknown;
	try {
		roster = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(roster)) return null;
	return roster.filter((l) => isRecord(l) && l.live === true).length;
}

/** Spawn `bun <work.ts> lanes --json` (argument array, no shell); null on any failure. */
export async function probeLiveLanes(
	workBin: string,
	timeoutMs = 10_000,
): Promise<number | null> {
	try {
		const proc = Bun.spawn([process.execPath, workBin, "lanes", "--json"], {
			stdout: "pipe",
			stderr: "ignore",
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return parseLiveLanes(text);
	} catch {
		return null;
	}
}
