// review-lane.ts — W182 second-opinion runner. One-shot, detached, READ-ONLY
// (never claims the item): assembles the item's diff + thread as review
// context, asks the picked executor, parses the verdict line, and lands the
// findings: coord NOTE(s) on the item thread, a work.review verdict event,
// and fact review.<item>.<executor>. Works on DONE items — reviewing landed
// work is the point. Spawned by the board's POST /api/second-opinion.
// usage:
//   bun review-lane.ts --item <Wn> --project <p> --executor <name> \
//     (--bin <path> | --belt <machine>:<port>[:<model>] | --llm-url <url> [--llm-model <m>])
// exits 0 on a landed verdict, 2 on a failed leg (verdict=error recorded).
import { openStore, projectRootOf } from "../lib/govdb.ts";
import { resolveBelt } from "../lib/belt-locate.ts";

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name: string): string | null => {
	const i = argv.indexOf(name);
	return i >= 0 ? (argv[i + 1] ?? null) : null;
};
const item = arg("--item");
const project = arg("--project");
const executor = arg("--executor") ?? "claude";
if (!item || !project) {
	console.error(
		"usage: bun review-lane.ts --item <Wn> --project <p> --executor <name> (--bin <path> | --belt <m>:<p>[:<model>] | --llm-url <url> [--llm-model <m>])",
	);
	process.exit(1);
}
const repo = projectRootOf(project);
if (!repo || repo.includes("..") || !repo.startsWith("/")) {
	console.error(`review-lane: bad project root for ${project}`);
	process.exit(1);
}

// ---- context: the item, its thread, the diff -------------------------------
const db = openStore();
type Row = Record<string, unknown>;
const w = db
	.query("SELECT * FROM work_items WHERE project = ? AND id = ?")
	.get(project, item) as Row | null;
if (!w) {
	console.error(`review-lane: no work item ${item} in ${project}`);
	process.exit(1);
}

// the branch diff vs main — capped; absent branch = claims-only review
function gitDiff(): string {
	const branch = `suspenders/${item}`;
	const g = (a: string[]): { code: number; out: string } => {
		const p = Bun.spawnSync(["/usr/bin/git", "-C", repo, ...a], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return { code: p.exitCode ?? 1, out: p.stdout.toString() };
	};
	if (
		g(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code !== 0
	)
		return "";
	const d = g(["diff", `main...${branch}`]);
	return d.out.slice(0, 60_000);
}

// the coord thread: last 20 events on the item (work + project stamped)
const thread: string[] = (
	db
		.query(
			"SELECT ts, source, kind, payload FROM events WHERE work = ? AND project = ? ORDER BY id DESC LIMIT 20",
		)
		.all(item, project) as Row[]
).map(
	(e) =>
		`${new Date(Number(e.ts)).toISOString()} ${e.source} ${e.kind} ${String(
			e.payload,
		).slice(0, 200)}`,
);

// ---- the review prompt ------------------------------------------------------
const diff = gitDiff();
const prompt = [
	`You are a read-only second-opinion reviewer for Work Graph item ${item} in ${repo}.`,
	`Verify the work against the mission; you are auditing, NOT re-doing it. Do not edit anything.`,
	``,
	`MISSION (work show):`,
	`${String(w.title)}${w.description ? ` — ${String(w.description)}` : ""}`,
	`state: ${String(w.state)}; owner: ${String(w.owner_sid ?? "none")}`,
	``,
	`ITEM THREAD (newest first, last 20):`,
	...(thread.length ? thread : ["(no events)"]),
	``,
	`BRANCH DIFF (main...suspenders/${item}, capped):`,
	diff || "(no branch — review the thread/claims only)",
	``,
	`Report findings as terse bullets; end your reply with ONE machine-parseable final line:`,
	`VERDICT: PASS | VERDICT: FAIL - <reason>`,
].join("\n");

// ---- executor legs ----------------------------------------------------------
type Leg =
	| { kind: "bin"; bin: string }
	| { kind: "belt"; target: string }
	| { kind: "llm"; url: string; model: string };
const leg: Leg | null = (() => {
	const bin = arg("--bin");
	if (bin) return { kind: "bin", bin };
	const belt = arg("--belt");
	if (belt) return { kind: "belt", target: belt };
	const url = arg("--llm-url");
	if (url)
		return {
			kind: "llm",
			url,
			model: arg("--llm-model") ?? process.env.SUSPENDERS_LLM_MODEL ?? "local",
		};
	return null;
})();

// ---- run the leg ------------------------------------------------------------
const LEG_TIMEOUT_MS = 15 * 60_000;
async function runLeg(): Promise<string> {
	if (leg?.kind === "bin") {
		const p = Bun.spawn([leg.bin, "-p", prompt], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			cwd: repo,
		});
		const timer = setTimeout(() => p.kill(), LEG_TIMEOUT_MS);
		const out = await new Response(p.stdout).text();
		clearTimeout(timer);
		await p.exited;
		return out;
	}
	if (leg?.kind === "belt") {
		// belt targeting: remotes.ts route-to owns auth + model override
		const belt = await resolveBelt();
		if (!belt) throw new Error("belt repo not found (resolveBelt)");
		const parts = leg.target.split(":");
		const model = parts[2];
		const c = Bun.spawnSync([
			process.execPath,
			`${belt}/bin/remotes.ts`,
			"route-to",
			parts[0],
			parts[1],
			prompt,
			...(model ? ["--model", model] : []),
		]);
		if (c.exitCode !== 0)
			throw new Error(
				`belt route-to failed: ${c.stderr.toString().slice(0, 200)}`,
			);
		return c.stdout.toString();
	}
	if (leg?.kind === "llm") {
		const r = await fetch(leg.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...(process.env.SUSPENDERS_LLM_KEY
					? { authorization: `Bearer ${process.env.SUSPENDERS_LLM_KEY}` }
					: {}),
			},
			body: JSON.stringify({
				model: leg.model,
				messages: [{ role: "user", content: prompt }],
				max_tokens: 1500,
				temperature: 0.2,
			}),
			signal: AbortSignal.timeout(LEG_TIMEOUT_MS),
		});
		if (!r.ok)
			throw new Error(`LLM ${r.status}: ${(await r.text()).slice(0, 200)}`);
		const j = (await r.json()) as {
			choices?: { message?: { content?: string } }[];
		};
		return j.choices?.[0]?.message?.content ?? "";
	}
	throw new Error("no executor leg (--bin | --belt | --llm-url)");
}

// ---- verdict parse + emit ----------------------------------------------------
const emitCli = (args: string[]): void => {
	const p = Bun.spawnSync(
		[
			process.execPath,
			new URL("./coord.ts", import.meta.url).pathname,
			...args,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (p.exitCode !== 0)
		console.error(
			`review-lane: coord emit failed: ${p.stderr.toString().slice(0, 200)}`,
		);
};

const noteFor = (headline: string): string =>
	`review ${item} by ${executor} — ${headline}`;

const findings = await runLeg().catch((e: unknown) => {
	console.error(
		`review-lane ${item}: leg failed: ${e instanceof Error ? e.message : String(e)}`,
	);
	return null;
});

// verdict line: the LAST VERDICT: match wins (models restate headers)
const verdictLine = [
	...(findings ?? "").matchAll(/VERDICT: (PASS|FAIL[^\n]*)/g),
].at(-1)?.[1];
const verdict =
	findings && verdictLine
		? verdictLine.startsWith("PASS")
			? "PASS"
			: "FAIL"
		: "ERROR";
const headline = (
	verdictLine ?? (findings ? "no verdict line in reply" : "leg failed")
).slice(0, 300);
const factKey = `review.${item}.${executor}`;
db.query(
	"INSERT OR REPLACE INTO facts (key, value, source, version, ts) VALUES (?, ?, 'review-lane', 1, ?)",
).run(
	factKey,
	JSON.stringify({ verdict, headline, ts: Date.now() }),
	Date.now(),
);

// NOTE targeted at the owner (inbox push) + thread stamp (--work/--project
// land it on the drawer timeline); absent owner → coordinator or fleet-board
const owner = String(w.owner_sid ?? "");
const noteArgs = [
	"emit",
	"NOTE",
	"--to",
	owner ||
		String(
			(
				db
					.query("SELECT value FROM facts WHERE key = 'coordinator.sid'")
					.get() as { value: string } | null
			)?.value ?? "fleet-board",
		),
	"--note",
	noteFor(headline),
	`--work=${item}`,
	`--project=${project}`,
	"--as",
	`review:${executor}`,
];
emitCli(noteArgs);

// the verdict event: work.review, payload stamped work+project so the drawer
// timeline picks it up; the findings body rides the note (capped)
emitCli([
	"emit",
	"work.review",
	`--work=${item}`,
	`--project=${project}`,
	`--executor=${executor}`,
	`--verdict=${verdict}`,
	"--note",
	`${headline}\n\n${(findings ?? "").slice(0, 3000)}`,
	"--as",
	`review:${executor}`,
]);
console.log(
	`review-lane: ${item} reviewed by ${executor} — ${verdict}: ${headline.slice(0, 120)}`,
);
process.exit(verdict === "ERROR" ? 2 : 0);
