// W609 extraction from bin/work.ts (1500-line law): the work CLI's surface —
// per-verb flag schema + the generic arg parser. Data + one parser; command
// semantics stay in bin/work.ts. `work <verb> --help` renders the verb's spec.
import { CAPABILITIES } from "./govdb.ts";

export type Spec = {
	flags: string[];
	switches?: string[];
	minPos: number;
	reqFlags: string[];
	usage: string;
	lax?: boolean;
};

// vocabulary shared by the item commands: option-looking tokens are never
// content — a known flag consumes its value, unknown ones die
export const ITEM_FLAGS = [
	"--scope",
	"--parent",
	"--priority",
	"--desc",
	"--by",
	"--reason",
	"--keep",
	"--sha",
	"--origin",
	"--claim-epoch",
	"--note",
	"--on",
	"--as",
	"--requires",
];
export const CAPS = new Set(CAPABILITIES);
export const SCHEMA: Record<string, Spec> = {
	add: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: [],
		usage: `usage: add <title> [--scope s] [--parent <id>] [--priority n] [--desc "..."] [--by sid]`,
	},
	list: { flags: [], minPos: 0, reqFlags: [], usage: "", lax: true },
	ready: { flags: [], minPos: 0, reqFlags: [], usage: "", lax: true },
	mine: {
		flags: ["--as"],
		minPos: 0,
		reqFlags: ["--as"],
		usage: "usage: mine --as <sid>",
		lax: true,
	},
	owned: { flags: [], minPos: 0, reqFlags: [], usage: "" },
	show: {
		flags: [...ITEM_FLAGS, "--json"],
		switches: ["--json"],
		minPos: 1,
		reqFlags: [],
		usage: "usage: show <id> [--json]",
	},
	stats: {
		flags: [],
		minPos: 0,
		reqFlags: [],
		usage: "usage: stats (project-scoped JSON progress snapshot)",
	},
	take: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--as"],
		usage: "usage: take <id> --as <sid> [--origin <host:agent>]",
	},
	release: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--as"],
		usage: "usage: release <id> --as <sid>",
	},
	start: { flags: ITEM_FLAGS, minPos: 0, reqFlags: [], usage: "" },
	summary: {
		flags: ["--json"],
		switches: ["--json"],
		minPos: 1,
		reqFlags: [],
		usage: "usage: summary <id> [--json]",
	},
	done: {
		flags: [...ITEM_FLAGS, "--summary"],
		minPos: 1,
		reqFlags: [],
		usage: "usage: done <id> [--as sid] --sha <sha> [--summary paragraph]",
	},
	fail: { flags: ITEM_FLAGS, minPos: 0, reqFlags: [], usage: "" },
	cancel: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--note"],
		usage: `usage: cancel <id> --note "reason"`,
	},
	supersede: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--by"],
		usage: "usage: supersede <id> --by <new-id>",
	},
	block: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--on"],
		usage: "usage: block <id> --on <other-id>",
	},
	unblock: {
		flags: ITEM_FLAGS,
		minPos: 1,
		reqFlags: ["--on"],
		usage: "usage: unblock <id> --on <id2>",
	},
	split: {
		flags: ["--reason", "--keep", "--plan"],
		minPos: 3,
		reqFlags: ["--reason"],
		usage: `usage: split <id> "title1" "title2" ... --reason independent-scopes [--keep N] [--plan <itemId>]`,
	},
	orphaned: {
		flags: ["--item", "--json"],
		switches: ["--json"],
		minPos: 0,
		reqFlags: [],
		usage: "usage: orphaned [--item <id>] [--json]",
	},
	lanes: { flags: ["--json", "--fleet"], minPos: 0, reqFlags: [], usage: "" },
	reclaim: {
		flags: [...ITEM_FLAGS, "--expect-owner", "--expect-updated-at", "--json"],
		switches: ["--json"],
		minPos: 1,
		reqFlags: [],
		usage:
			"usage: reclaim <id> [--expect-owner sid] [--expect-updated-at revision] [--json] | reclaim all",
	},
	"migrate-ledger": {
		flags: [],
		minPos: 1,
		reqFlags: [],
		usage: "usage: migrate-ledger <path>",
	},
};

// generic parse + validate: known flags consume their value (first occurrence
// wins, a trailing flag yields null), everything non-flag is a positional.
// Violations die with the command's usage line — before any state is touched.
export function parseArgs(
	rest: string[],
	spec: Spec,
	die: (m: string) => never,
): {
	pos: string[];
	flag: (name: string) => string | null;
} {
	const pos: string[] = [];
	const vals = new Map<string, string | null>();
	for (let i = 0; i < rest.length; i++) {
		if (spec.switches?.includes(rest[i])) {
			vals.set(rest[i], "true");
			continue;
		}
		if (spec.flags.includes(rest[i])) {
			if (!vals.has(rest[i])) vals.set(rest[i], rest[i + 1] ?? null);
			i++;
			continue;
		}
		if (rest[i].startsWith("--")) {
			if (spec.lax) continue;
			die(`unknown option: ${rest[i]}`);
		}
		pos.push(rest[i]);
	}
	if (
		pos.length < spec.minPos ||
		spec.reqFlags.some((f) => !vals.has(f) || vals.get(f) === null)
	)
		die(spec.usage);
	return { pos, flag: (name: string): string | null => vals.get(name) ?? null };
}
