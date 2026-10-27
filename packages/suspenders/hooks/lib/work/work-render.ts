// hooks/lib/work/work-render.ts — W418 decomposition of bin/work.ts (1500-line law):
// the work-graph state glyphs + the one row renderer shared by the
// list/ready/owned verbs. Presentation only, zero DB access. Local colors
// (bin/ entrypoints define their own paint; lib/watch/frame.ts precedent).
import { dualStamp } from "../wallclock.ts";
export type Item = Record<string, string | number | null>;

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) =>
	tty ? `\x1b[${code}m${s}\x1b[0m` : s;
const dim = paint("2");
const cyan = paint("36");
const green = paint("32");
const amber = paint("33");
const red = paint("31");

export const GLYPH: Record<string, [string, (s: string) => string]> = {
	READY: ["·", cyan],
	CLAIMED: ["◐", cyan],
	RUNNING: ["▶", green],
	BLOCKED: ["⚠", red],
	PAUSED: ["⏸", amber],
	WAITING: ["◷", amber],
	DONE: ["✓", green],
	FAILED: ["✗", red],
	CANCELLED: ["⊘", dim],
	SUPERSEDED: ["■", dim],
	SHATTERED: ["⊞", cyan],
	ORPHANED: ["◌", amber],
};

export const renderRow = (r: Item): string => {
	const [g, col] = GLYPH[r.state as string] ?? ["?", dim];
	const owner = r.owner_sid ? dim(String(r.owner_sid).slice(0, 6)) : "";
	const req = r.requires ? dim(` ⟨needs ${r.requires}⟩`) : "";
	const eff = r.effort ? dim(` ⟨${String(r.effort)}⟩`) : "";
	const tg = r.tags ? dim(` #${String(r.tags)}`) : "";
	return `  ${col(g)} ${cyan(String(r.id).padEnd(7))}${String(r.title).slice(0, 56)}${owner ? `  ${owner}` : ""}${req}${eff}${tg}`;
};

// W902: created/updated always; closed rides the completion record's
// completed_at when the caller has one (DONE items). UTC Z + local twin —
// hub clocks drift; a bare local time is unreadable across hubs.
export const renderTimestamps = (
	r: Item,
	completedAt: number | null,
): string[] => {
	const out = [
		`  ${dim("created:")} ${dualStamp(Number(r.created_at))}`,
		`  ${dim("updated:")} ${dualStamp(Number(r.updated_at))}`,
	];
	if (completedAt !== null)
		out.push(`  ${dim("closed:")} ${dualStamp(completedAt)}`);
	return out;
};
