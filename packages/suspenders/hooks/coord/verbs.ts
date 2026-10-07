// verbs.ts — the coord CLI surface as one declarative table (W421): verb →
// handler wiring + the per-verb arg/cmd spec from the shared toolkit
// (hooks/lib/cli.ts). Before this table the verb list lived in two copy-pasted
// strings (overview + unknown-command die) and per-verb flags lived nowhere.
// Defs are lax by design: flag validation stays handler-side (`arg()` reads
// raw rest) until the handler migration lands — the dispatcher owns routing,
// per-verb help and the verb list, all generated from this one table.
import { cmdTargets, cmdMessage } from "./addressing.ts";
import type { CliDef, CommandDef } from "../lib/cli.ts";
import {
	cmdConsult,
	cmdConsultReply,
	cmdConsults,
	cmdWhoKnows,
} from "./consult.ts";
import {
	cmdFact,
	cmdCapsule,
	cmdLeaseRelease,
	cmdKb,
	cmdGc,
} from "./facts.ts";
import {
	cmdBootstrap,
	cmdFleet,
	cmdMetrics,
	cmdDoctorSession,
	cmdDiff,
	cmdEvents,
	cmdProject,
} from "./fleet.ts";
import { cmdGovernance } from "./governance.ts";
import { cmdHubs } from "./hubs.ts";
import {
	cmdKnowledge,
	cmdKnowledgeEnqueue,
	cmdKnowledgePromote,
	cmdKnowledgeRetire,
	cmdKnowledgeNote,
	cmdKnowledgeVerify,
	cmdKnowledgeCurate,
} from "./knowledge.ts";
import {
	cmdEmit,
	cmdBroadcast,
	cmdPoll,
	cmdWait,
	cmdSubscribe,
	cmdState,
	cmdInbox,
	cmdPause,
	cmdPaused,
	cmdResume,
	cmdResumed,
	cmdResumeSession,
} from "./bus.ts";
import { cmdWisdom } from "./wisdom.ts";

// the fleet's standard flag vocabulary, shared across the specs below
const AS = { "--as": {} };
const JSON_SW = { "--json": { type: "switch" } };

export interface Verb {
	def: CommandDef;
	run: (rest: string[]) => Promise<void>;
}

export const VERBS: Record<string, Verb> = {
	emit: {
		def: {
			name: "coord emit",
			posHint: "<kind>",
			flags: { ...AS, "--scope": {}, "--sha": {}, "--note": {}, "--to": {} },
			lax: true,
		},
		run: cmdEmit,
	},
	broadcast: {
		def: {
			name: "coord broadcast",
			posHint: "<kind>",
			flags: { ...AS, "--note": {} },
			lax: true,
		},
		run: cmdBroadcast,
	},
	poll: {
		def: {
			name: "coord poll",
			flags: { ...AS, "--scope": {}, "--kinds": {}, "--limit": {} },
			lax: true,
		},
		run: cmdPoll,
	},
	wait: {
		def: {
			name: "coord wait",
			flags: { ...AS, "--scope": {}, "--kinds": {}, "--max-seconds": {} },
			lax: true,
		},
		run: cmdWait,
	},
	fact: {
		def: {
			name: "coord fact",
			posHint: "<set|get|list> <key> [value]",
			flags: {
				...AS,
				"--text": {},
				"--source": {},
				"--prefix": {},
				"--limit": {},
				"--all": { type: "switch" },
			},
			lax: true,
		},
		run: cmdFact,
	},
	governance: {
		def: {
			name: "coord governance",
			flags: { ...AS, "--source": {} },
			lax: true,
		},
		run: cmdGovernance,
	},
	bootstrap: {
		def: {
			name: "coord bootstrap",
			posHint: "--as <sid>",
			flags: {
				...AS,
				"--parent": {},
				"--worktree": {},
				"--role": {},
				"--caps": {},
				"--actor": {},
				"--tags": {},
				"--name": {},
			},
			lax: true,
		},
		run: cmdBootstrap,
	},
	state: {
		def: { name: "coord state", posHint: "--as <sid>", flags: AS, lax: true },
		run: cmdState,
	},
	inbox: {
		def: {
			name: "coord inbox",
			posHint: "--as <sid>",
			flags: { ...AS, "--ack": { type: "switch" } },
			lax: true,
		},
		run: cmdInbox,
	},
	capsule: {
		def: {
			name: "coord capsule",
			posHint: "set --as <sid> | get <sid>",
			flags: AS,
			lax: true,
		},
		run: cmdCapsule,
	},
	pause: {
		def: {
			name: "coord pause --as <sid>",
			flags: { ...AS, "--reason": {}, "--scope": {}, "--intervention": {} },
			lax: true,
		},
		run: cmdPause,
	},
	paused: {
		def: {
			name: "coord paused",
			posHint: "<kind> <note>",
			flags: { ...AS, "--sha": {}, "--scope": {}, "--step": {} },
			lax: true,
		},
		run: cmdPaused,
	},
	resume: {
		def: {
			name: "coord resume",
			posHint: "<scope>",
			flags: { ...AS, "--onto": {}, "--diff-from": {}, "--note": {} },
			lax: true,
		},
		run: cmdResume,
	},
	resumed: {
		def: {
			name: "coord resumed",
			posHint: "--as <sid>",
			flags: AS,
			lax: true,
		},
		run: cmdResumed,
	},
	"resume-session": {
		def: {
			name: "coord resume-session",
			posHint: "<sid>",
			flags: { ...AS, "--from": {} },
			lax: true,
		},
		run: cmdResumeSession,
	},
	"doctor-session": {
		def: { name: "coord doctor-session", posHint: "<sid>", lax: true },
		run: cmdDoctorSession,
	},
	"who-knows": {
		def: {
			name: "coord who-knows",
			posHint: "<question>",
			flags: { "--scope": {} },
			lax: true,
		},
		run: cmdWhoKnows,
	},
	consult: {
		def: {
			name: "coord consult",
			posHint: '[--best] "<question>" | <sid> <question>',
			flags: {
				...AS,
				"--scope": {},
				"--version": {},
				"--best": { type: "switch" },
				"--no-kb": { type: "switch" },
			},
			lax: true,
		},
		run: cmdConsult,
	},
	"consult-reply": {
		def: {
			name: "coord consult-reply",
			posHint: '<consult-id> "<answer>"',
			flags: {
				...AS,
				"--feedback": {},
				"--evidence": {},
				"--version": {},
				"--decline": { type: "switch" },
			},
			lax: true,
		},
		run: cmdConsultReply,
	},
	consults: {
		def: { name: "coord consults", posHint: "[open|all]", flags: AS, lax: true },
		run: cmdConsults,
	},
	kb: {
		def: {
			name: "coord kb",
			posHint: 'add "<problem>" --solution "<solution>"',
			lax: true,
		},
		run: cmdKb,
	},
	knowledge: {
		def: {
			name: "coord knowledge",
			posHint: "<query>",
			flags: {
				"--domain": {},
				"--area": {},
				"--origin-kind": {},
				"--origin-system": {},
				"--limit": {},
			},
			lax: true,
		},
		run: cmdKnowledge,
	},
	"knowledge-enqueue": {
		def: {
			name: "coord knowledge-enqueue",
			posHint: "<topic>",
			flags: {
				...AS,
				"--source": {},
				"--payload": {},
				"--domain": {},
				"--area": {},
				"--code-origin": {},
			},
			lax: true,
		},
		run: cmdKnowledgeEnqueue,
	},
	"knowledge-promote": {
		def: { name: "coord knowledge-promote", posHint: "<id>", lax: true },
		run: cmdKnowledgePromote,
	},
	"knowledge-retire": {
		def: {
			name: "coord knowledge-retire",
			posHint: "<id>",
			flags: { "--superseded-by": {} },
			lax: true,
		},
		run: cmdKnowledgeRetire,
	},
	"knowledge-note": {
		def: {
			name: "coord knowledge-note",
			posHint: "<id>",
			flags: { ...AS, "--what": {} },
			lax: true,
		},
		run: cmdKnowledgeNote,
	},
	"knowledge-verify": {
		def: { name: "coord knowledge-verify", posHint: "[id]", lax: true },
		run: cmdKnowledgeVerify,
	},
	"knowledge-curate": {
		def: {
			name: "coord knowledge-curate",
			flags: { ...AS, "--repo": {} },
			lax: true,
		},
		run: cmdKnowledgeCurate,
	},
	"lease-release": {
		def: {
			name: "coord lease-release",
			posHint: "<scope>",
			flags: AS,
			lax: true,
		},
		run: cmdLeaseRelease,
	},
	gc: {
		def: {
			name: "coord gc",
			flags: { "--days": {}, "--audit-days": {}, "--usage-days": {} },
			lax: true,
		},
		run: cmdGc,
	},
	fleet: {
		def: { name: "coord fleet", lax: true },
		run: cmdFleet,
	},
	hubs: {
		def: {
			name: "coord hubs",
			flags: { "--label": {}, ...JSON_SW },
			lax: true,
		},
		run: cmdHubs,
	},
	metrics: {
		def: {
			name: "coord metrics",
			posHint: "[project]",
			flags: { "--days": {} },
			lax: true,
		},
		run: cmdMetrics,
	},
	diff: {
		def: {
			name: "coord diff",
			flags: { "--since": {}, "--table": {}, "--last": {}, ...JSON_SW },
			lax: true,
		},
		run: cmdDiff,
	},
	events: {
		def: {
			name: "coord events",
			flags: { "--kinds": {}, "--last": {}, ...JSON_SW },
			lax: true,
		},
		run: cmdEvents,
	},
	project: {
		def: {
			name: "coord project",
			posHint: "identity | rekey <old> <new>",
			lax: true,
		},
		run: cmdProject,
	},
	targets: {
		def: {
			name: "coord targets",
			flags: { "--filter": {}, ...JSON_SW },
			lax: true,
		},
		run: cmdTargets,
	},
	message: {
		def: {
			name: "coord message",
			posHint: '<target|--all> "text"',
			flags: { ...AS, "--all": { type: "switch" } },
			lax: true,
		},
		run: cmdMessage,
	},
	subscribe: {
		def: {
			name: "coord subscribe",
			posHint: "--as <sid>",
			flags: { ...AS, "--scope": {}, "--kinds": {} },
			lax: true,
		},
		run: cmdSubscribe,
	},
	wisdom: {
		def: { name: "coord wisdom", lax: true },
		run: cmdWisdom,
	},
};

export const cli: CliDef = {
	name: "coord",
	about: "control plane",
	commands: Object.fromEntries(
		Object.entries(VERBS).map(([verb, v]) => [verb, v.def]),
	),
	notes: [
		"  bootstrap --as <sid> --name <label> stamps a user-facing lane name (coord fleet + the board show it)",
		"  project identity | project rekey <old> <new> — graph identity migration (W428)",
	],
};
