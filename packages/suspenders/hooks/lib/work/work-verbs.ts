// work-verbs.ts — W892: the work CLI's verb declarations, extracted from
// bin/work.ts (the 1500-line cap left it ~4 lines of headroom — a new verb
// could not land). Pure verb-kit data, zero DB: one defineVerb entry per verb.
// Add a verb = one defineVerb entry here + a branch in work.ts dispatchVerb.
import { defineVerb, type VerbSpec } from "../verb-kit.ts";

// vocabulary shared by the item commands: option-looking tokens are never
// content — a known flag consumes its value, unknown ones die
export const ITEM_FLAGS = [
	"--token",
	"--evidence",
	"--scope",
	"--parent",
	"--priority",
	"--desc",
	"--by",
	"--reason",
	"--kind",
	"--until",
	"--keep",
	"--sha",
	"--origin",
	"--note",
	"--on",
	"--as",
	"--requires",
	"--effort",
	"--tag",
	"--title",
];

// ---- the verb registry (W651) -------------------------------------------
// ONE declaration per verb — hooks/lib/verb-kit.ts owns argv parsing (the
// Bun strips-`--` reality baked in), per-verb --help, the unknown-command
// try-list and top-level help. Add a verb = one defineVerb entry here
// (+ a branch in dispatchVerb below).
export const VERBS: VerbSpec[] = [
	defineVerb({
		name: "reconcile-completion",
		usage:
			"usage: reconcile-completion <id> --force --expect-owner <sid> --expect-updated-at <revision> --evidence <0600-json> (explicit local operator graph repair; preserves immutable completion, SID is not authentication)",
		flags: ["--force", "--expect-owner", "--expect-updated-at", "--evidence"],
		switches: ["--force"],
		reqFlags: ["--expect-owner", "--expect-updated-at", "--evidence"],
		minPos: 1,
	}),
	defineVerb({
		name: "add",
		usage:
			'usage: add <title> [--scope s] [--parent <id>] [--priority n] [--desc "..."] [--by sid] [--tag t1,t2]',
		flags: [...ITEM_FLAGS],
		minPos: 1,
	}),
	defineVerb({
		name: "list",
		lax: true,
	}),
	defineVerb({
		name: "ready",
		lax: true,
	}),
	defineVerb({
		name: "mine",
		usage: "usage: mine --as <sid>",
		flags: ["--as"],
		reqFlags: ["--as"],
		lax: true,
	}),
	defineVerb({
		name: "owned",
		lax: true,
	}),
	defineVerb({
		name: "show",
		usage: "usage: show <id...> [--json] — ids space- or comma-separated",
		flags: [...ITEM_FLAGS, "--json"],
		switches: ["--json"],
		minPos: 1,
	}),
	defineVerb({
		name: "stats",
		usage: "usage: stats (project-scoped JSON progress snapshot)",
	}),
	defineVerb({
		name: "take",
		usage:
			"usage: take <id> --as <sid> [--origin <host:agent>] | take <id> --as <current-owner> --token <current-token> --expect-updated-at <revision> [--reconcile-context --force --evidence <0600-json>] (explicit local operator repair; SID is not authentication)",
		flags: [
			...ITEM_FLAGS,
			"--expect-updated-at",
			"--reconcile-context",
			"--force",
		],
		switches: ["--reconcile-context", "--force"],
		minPos: 1,
		reqFlags: ["--as"],
	}),
	defineVerb({
		name: "release",
		usage: "usage: release <id> --as <sid>",
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--as"],
	}),
	defineVerb({
		name: "start",
		flags: [...ITEM_FLAGS],
	}),
	defineVerb({
		name: "summary",
		usage: "usage: summary <id> [--json]",
		flags: ["--json"],
		switches: ["--json"],
		minPos: 1,
	}),
	defineVerb({
		name: "done",
		usage:
			"usage: done <id> [--as sid] --sha <sha> [--summary paragraph] [--spend fresh=N,cache=N,out=N,model=<group>] [--report md-file]",
		flags: [...ITEM_FLAGS, "--summary", "--spend", "--report"],
		minPos: 1,
	}),
	defineVerb({
		name: "backfill",
		usage:
			"usage: backfill <id> [--as sid] — W2059: link a DONE item's closer-session ledger rows (sid key + interactive keys, final claim window) as a work.attribution stamp so the report renders MODEL/TOKENS/CACHE; no rows = stays '-' (honest no-data)",
		flags: [...ITEM_FLAGS],
		minPos: 1,
	}),
	defineVerb({
		name: "fail",
		usage:
			'usage: fail <id> --note "repro: <failing command + output> | no-repro: <why> (environment gone / flake proven / carrier death)" [--as sid]',
		flags: [...ITEM_FLAGS],
	}),
	defineVerb({
		name: "retry",
		usage:
			"usage: retry <id...> — FAILED → READY, stale claim released, launch budget reset (W761); ids space- or comma-separated (W795)",
		flags: [...ITEM_FLAGS],
		minPos: 1,
	}),
	defineVerb({
		name: "wait",
		usage:
			'usage: wait <id> --kind quota|credentials|operator|dependency|external --reason "external prerequisite" [--until ISO-8601]',
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--kind", "--reason"],
	}),
	defineVerb({
		name: "wake",
		usage: 'usage: wake <id> --note "evidence prerequisite cleared" [--force]',
		flags: [...ITEM_FLAGS, "--force"],
		switches: ["--force"],
		minPos: 1,
		reqFlags: ["--note"],
	}),
	defineVerb({
		name: "cancel",
		usage: 'usage: cancel <id> --note "reason"',
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--note"],
	}),
	defineVerb({
		name: "edit",
		usage:
			"usage: edit <id> [--title t] [--desc d] [--tag a,b] [--priority n] [--reason r] — amend in place; terminal items refuse; CLAIMED items point at coord message <sid>",
		flags: [...ITEM_FLAGS],
		minPos: 1,
	}),
	defineVerb({
		name: "supersede",
		usage: "usage: supersede <id> --by <new-id>",
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--by"],
	}),
	defineVerb({
		name: "block",
		usage: "usage: block <id> --on <other-id>",
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--on"],
	}),
	defineVerb({
		name: "unblock",
		usage: "usage: unblock <id> --on <id2>",
		flags: [...ITEM_FLAGS],
		minPos: 1,
		reqFlags: ["--on"],
	}),
	defineVerb({
		name: "split",
		usage:
			'usage: split <id> "title1" "title2" ... --reason independent-scopes [--keep N] [--plan <itemId>]',
		flags: ["--reason", "--keep", "--plan"],
		minPos: 3,
		reqFlags: ["--reason"],
	}),
	defineVerb({
		name: "orphaned",
		usage: "usage: orphaned [--item <id>] [--json]",
		flags: ["--item", "--json"],
		switches: ["--json"],
	}),
	defineVerb({
		name: "lanes",
		flags: ["--json", "--fleet"],
	}),
	defineVerb({
		name: "reclaim",
		usage:
			"usage: reclaim <id> [--reason user|crash] [--force] [--expect-owner sid] [--expect-updated-at revision] [--json] | reclaim all",
		flags: [
			...ITEM_FLAGS,
			"--force",
			"--expect-owner",
			"--expect-updated-at",
			"--json",
		],
		switches: ["--json"],
		minPos: 1,
	}),
	defineVerb({
		name: "extend",
		usage:
			"usage: extend <id> [--as sid] --for <duration> (45m | 2h | 90s; max 24h) — hold `reclaim all` off a CLAIMED/RUNNING item for a known-long op",
		flags: [...ITEM_FLAGS, "--for"],
		minPos: 1,
		reqFlags: ["--for"],
	}),
	defineVerb({
		name: "allocate",
		usage:
			"usage: allocate [--apply] [--json] [--capacity N] [--fleet <path>] — score READY work × lanes; decisions {assign|recommend}; --apply claims only the assign kind",
		flags: ["--apply", "--json", "--capacity", "--fleet"],
		switches: ["--apply", "--json"],
	}),
	defineVerb({
		name: "migrate-ledger",
		usage: "usage: migrate-ledger <path>",
		minPos: 1,
	}),
	defineVerb({
		name: "report",
		usage:
			"usage: report [--ids w1,w2] [--done-window 2d] — the supervisor micro-metrics table (ITEM/ST/TASK/TOKENS/CACHE/OUT-MIN/AGENT); rows = riding+queued+recent-done (default window 48h) or strict --ids",
		flags: ["--ids", "--done-window"],
	}),
	defineVerb({
		name: "stamp",
		usage:
			"usage: stamp <id> --requires <csv> — set an existing item's requires set (W1211 audit face; the credential vocabulary: shell, fs, git, build, mcp, vision, browser, network, gh, az, cloud-<provider>, tool-<cli>)",
		flags: ["--requires"],
		minPos: 1,
	}),
	defineVerb({
		name: "report-regen",
		usage:
			"usage: report-regen <id> --file <md-file> [--sha <sha>] — (re)generate the single-file HTML report view of a DONE/SUPERSEDED item's markdown record (W1199); the graph gets a work.report provenance event, the artifact lands under .fleet/reports/",
		flags: [...ITEM_FLAGS, "--file", "--sha"],
		minPos: 1,
	}),
];
