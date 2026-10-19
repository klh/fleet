#!/usr/bin/env bun
// fleet-report.ts — the ONE supervisor report (W892 standard, owner GO 2026-10-19).
// Emits the ASCII micro-metrics table for the work pool: ITEM/ST/TASK/TOKENS/
// CACHE/OUT-MIN/AGENT parsed from each item spend line. Fixed-width pads are
// computed, never eyeballed. ST: R riding (claimed) | Q queued (ready) |
// D done | F failed. Usage: bun fleet-report.ts [W-id ...] (default: the
// active pool — claimed + ready + up to 5 most-recent done).

const WORK = process.env.SUSPENDERS_WORK_CLI ?? "";
const workCli = WORK || new URL("work.ts", import.meta.url).pathname;
const run = (args: string[]): string => {
	const p = Bun.spawnSync(["bun", workCli, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return new TextDecoder().decode(p.stdout ?? new Uint8Array());
};

const list = run(["list"]);
const want = process.argv.slice(2);
const ids: { id: string; st: string }[] = [];
if (want.length > 0) {
	for (const raw of want) {
		const id = raw.replace(/^W/i, "");
		const line = list.split("\n").find((l) => l.includes(`W${id}`));
		const st = line?.trim().startsWith("✓")
			? "D"
			: line?.trim().startsWith("✗")
				? "F"
				: "?";
		ids.push({ id, st });
	}
} else {
	for (const l of list.split("\n")) {
		const m = l.trim().match(/^([✓✗◐·])\s+W([\d.]+)\s/);
		if (!m) continue;
		const st =
			m[1] === "✓" ? "D" : m[1] === "✗" ? "F" : m[1] === "·" ? "Q" : "R";
		if (st !== "D") ids.push({ id: m[2], st });
		if (st === "D" && ids.filter((x) => x.st === "D").length < 5)
			ids.push({ id: m[2], st });
	}
}
if (ids.length === 0) {
	console.log("no pool items");
	process.exit(0);
}

const rows: string[][] = [];
for (const { id } of ids) {
	const t = run(["show", `W${id}`]);
	const line1 = t.split("\n")[0] ?? "";
	const state = line1.includes("✓")
		? "D"
		: line1.includes("✗")
			? "F"
			: line1.startsWith("·")
				? "Q"
				: "R";
	const title = line1
		.replace(/^.\s+W[\d.]+\s+(CLAIMED|READY|DONE|FAILED|SPLIT)\s+/, "")
		.replace(/ — .*/, "")
		.slice(0, 26);
	const num = (m: RegExpMatchArray | null) =>
		m ? parseFloat(m[1]) * (m[2] === "M" ? 1e6 : m[2] === "k" ? 1e3 : 1) : 0;
	const fresh = num(t.match(/fresh ([0-9.]+)([kM]?)/));
	const cached = num(t.match(/cached ([0-9.]+)([kM]?)/));
	const out = num(t.match(/out ([0-9.]+)([kM]?)/));
	const ag = t.match(/agent ((\d+)d)?((\d+)h)?((\d+)m)?\)/);
	const mins = +(ag?.[2] ?? 0) * 1440 + +(ag?.[4] ?? 0) * 60 + +(ag?.[6] ?? 0);
	const total = fresh + cached;
	const cache = total > 0 ? Math.round((cached / total) * 100) : -1;
	const opm = mins > 0 ? Math.round(out / mins) : -1;
	const tok =
		total >= 1e6
			? `${(total / 1e6).toFixed(1)}M`
			: total > 0
				? `${Math.round(total / 1e3)}k`
				: "-";
	const agent =
		mins >= 1440
			? `${Math.floor(mins / 1440)}d${Math.floor((mins % 1440) / 60)}h`
			: mins >= 60
				? `${Math.floor(mins / 60)}h${mins % 60}m`
				: mins > 0
					? `${mins}m`
					: "-";
	rows.push([
		`W${id}`,
		state,
		title,
		tok,
		cache < 0 ? "-" : `${cache}%`,
		opm < 0 ? "-" : String(opm),
		agent,
	]);
}
const pad = (s: string, n: number): string => (s + " ".repeat(n)).slice(0, n);
const lp = (s: string, n: number): string => (" ".repeat(n) + s).slice(-n);
const w = [9, 2, 26, 6, 5, 7, 6];
const line = (a: string[]): string =>
	pad(a[0], w[0]) +
	"  " +
	a[1] +
	"  " +
	pad(a[2], w[2]) +
	"  " +
	lp(a[3], w[3]) +
	"  " +
	lp(a[4], w[4]) +
	"  " +
	lp(a[5], w[5]) +
	"  " +
	lp(a[6], w[6]);
console.log(
	line(["ITEM", "ST", "TASK", "TOKENS", "CACHE", "OUT/MIN", "AGENT"]),
);
console.log(
	"-".repeat(w[0]) +
		"  --  " +
		"-".repeat(w[2]) +
		"  " +
		"-".repeat(w[3]) +
		"  " +
		"-".repeat(w[4]) +
		"  " +
		"-".repeat(w[5]) +
		"  " +
		"-".repeat(w[6]),
);
for (const r of rows) console.log(line(r));
console.log(
	"ST: R riding | Q queued | D done | F failed  ·  deep-link: #lanes?w=<id> (W890)",
);
