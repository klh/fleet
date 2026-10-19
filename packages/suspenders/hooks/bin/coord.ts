// coord.ts — the coordination event bus over governor.db: agents share state
// BY REFERENCE (short structured events + canonical facts), never by retelling
// it in prose. Direct SendMessage stays reserved for interrupts.
//
// usage: GENERATED from the verb registry — `coord --help`, `coord <verb> --help`.
// (W651: the hand-maintained block never listed wisdom/broadcast/executor-cv —
//  drift this migration retires for good.)

import { setRest } from "../coord/shared.ts";
import { defineVerb, runCli, type VerbSpec } from "../lib/verb-kit.ts";
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
} from "../coord/bus.ts";
import { cmdTargets, cmdMessage } from "../coord/addressing.ts";
import { cmdExecutorCv } from "../coord/executor-cv.ts";
import { cmdWisdom } from "../coord/wisdom.ts";
import {
	cmdFact,
	cmdCapsule,
	cmdLeaseRelease,
	cmdKb,
	cmdGc,
} from "../coord/facts.ts";
import {
	cmdConsult,
	cmdConsultReply,
	cmdConsults,
	cmdWhoKnows,
} from "../coord/consult.ts";
import { cmdGovernance } from "../coord/governance.ts";
import {
	cmdKnowledge,
	cmdKnowledgeEnqueue,
	cmdKnowledgePromote,
	cmdKnowledgeRetire,
	cmdKnowledgeGrade,
	cmdKnowledgeGraveyard,
	cmdKnowledgeNote,
	cmdKnowledgeVerify,
	cmdKnowledgeCurate,
	cmdKnowledgePropose,
	cmdKnowledgeProposals,
	cmdKnowledgeDispose,
} from "../coord/knowledge.ts";
import {
	cmdBootstrap,
	cmdFleet,
	cmdMetrics,
	cmdDoctorSession,
	cmdDiff,
	cmdEvents,
	cmdProject,
} from "../coord/fleet.ts";
import { cmdHubs } from "../coord/hubs.ts";
import { cmdSupervisor } from "../coord/supervisor.ts";

// W157/W651: handler bodies live verbatim in hooks/coord/*.ts; the kit
// resolves the verb, intercepts --help, parses (lax — handlers own their
// validation), and pins `rest` for arg()'s closure via onVerb. CLI surface
// byte-compatible; help + the unknown-command try-list are registry-generated.
const VERBS: VerbSpec[] = [
	defineVerb({
		name: "emit",
		usage:
			'usage: emit <kind> [--to sid] [--scope s] [--sha x] [--note "..."] [--field=value ...] [--as sid]',
		lax: true,
		run: (p) => cmdEmit(p.rest),
	}),
	defineVerb({
		name: "broadcast",
		usage: 'usage: broadcast --note "..." [--as sid]',
		lax: true,
		run: (p) => cmdBroadcast(p.rest),
	}),
	defineVerb({
		name: "poll",
		usage: "usage: poll [--as sid] [--scope s] [--kinds a,b] [--limit n]",
		lax: true,
		run: (p) => cmdPoll(p.rest),
	}),
	defineVerb({
		name: "wait",
		usage:
			"usage: wait --as <sid> [--scope s] [--kinds a,b] [--max-seconds 30] [--forever]",
		lax: true,
		run: (p) => cmdWait(p.rest),
	}),
	defineVerb({
		name: "subscribe",
		usage: "usage: subscribe --as <sid> [--scope s] [--kinds a,b]",
		lax: true,
		run: (p) => cmdSubscribe(p.rest),
	}),
	defineVerb({
		name: "state",
		usage: "usage: state --as <sid>",
		lax: true,
		run: (p) => cmdState(p.rest),
	}),
	defineVerb({
		name: "inbox",
		usage: "usage: inbox --as <sid> [--ack]",
		lax: true,
		run: (p) => cmdInbox(p.rest),
	}),
	defineVerb({
		name: "pause",
		usage:
			'usage: pause <sid> --reason "why" [--scope s] [--intervention "what is coming"]',
		lax: true,
		run: (p) => cmdPause(p.rest),
	}),
	defineVerb({
		name: "paused",
		usage: "usage: paused --as <sid> --sha <checkpoint-sha> [--step s]",
		lax: true,
		run: (p) => cmdPaused(p.rest),
	}),
	defineVerb({
		name: "resume",
		usage:
			'usage: resume <sid> --onto <sha> [--diff-from <pause-base>] [--note "delta summary"]',
		lax: true,
		run: (p) => cmdResume(p.rest),
	}),
	defineVerb({
		name: "resumed",
		usage: "usage: resumed --as <sid>",
		lax: true,
		run: (p) => cmdResumed(p.rest),
	}),
	defineVerb({
		name: "resume-session",
		usage: "usage: resume-session --as <new-sid> --from <old-sid>",
		lax: true,
		run: (p) => cmdResumeSession(p.rest),
	}),
	defineVerb({
		name: "fact",
		usage:
			"usage: fact set <key> <value> [--if-version n] | fact get <key> | fact rm <key> | fact list [--prefix p] [--limit n] [--all]",
		lax: true,
		run: (p) => cmdFact(p.rest),
	}),
	defineVerb({
		name: "governance",
		usage: "usage: governance | governance strict|solo [--source s]",
		lax: true,
		run: (p) => cmdGovernance(p.rest),
	}),
	defineVerb({
		name: "capsule",
		usage:
			"usage: capsule set --as <sid> [--item <id>] [--checkpoint <sha|none>] --done <t> --next <t>",
		lax: true,
		run: (p) => cmdCapsule(p.rest),
	}),
	defineVerb({
		name: "lease-release",
		usage: "usage: lease-release <path...> --as <sid>",
		lax: true,
		run: (p) => cmdLeaseRelease(p.rest),
	}),
	defineVerb({
		name: "kb",
		usage:
			'usage: kb search "<query words>" | kb list | kb stats | kb add "<problem>" --solution "<solution>"',
		lax: true,
		run: (p) => cmdKb(p.rest),
	}),
	defineVerb({
		name: "gc",
		usage: "usage: gc — governor.db housekeeping (archives audit/usage tables)",
		lax: true,
		run: (p) => cmdGc(p.rest),
	}),
	defineVerb({
		name: "consult",
		usage:
			'usage: consult [--best] "<question>" | consult <sid> <question> [--scope s] --as <asker>',
		lax: true,
		run: (p) => cmdConsult(p.rest),
	}),
	defineVerb({
		name: "consult-reply",
		usage:
			'usage: consult-reply <C##> "<answer>" [--decline] [--version ref] --as <expert-sid> | consult-reply <C##> --feedback resolved|failed|unused [--evidence result] [--version ref] --as <asker-sid>',
		lax: true,
		run: (p) => cmdConsultReply(p.rest),
	}),
	defineVerb({
		name: "consults",
		usage: "usage: consults --as <sid>",
		lax: true,
		run: (p) => cmdConsults(p.rest),
	}),
	defineVerb({
		name: "who-knows",
		usage: 'usage: who-knows "query words" [--scope src/x]',
		lax: true,
		run: (p) => cmdWhoKnows(p.rest),
	}),
	defineVerb({
		name: "knowledge",
		lax: true,
		run: (p) => cmdKnowledge(p.rest),
	}),
	defineVerb({
		name: "knowledge-enqueue",
		usage:
			'usage: knowledge-enqueue --source <why> --payload "<text>" [--domain d] [--area a] [--code-origin repo/path] [--as sid]',
		lax: true,
		run: (p) => cmdKnowledgeEnqueue(p.rest),
	}),
	defineVerb({
		name: "knowledge-promote",
		usage: "usage: knowledge-promote <id>",
		lax: true,
		run: (p) => cmdKnowledgePromote(p.rest),
	}),
	defineVerb({
		name: "knowledge-retire",
		usage: "usage: knowledge-retire <id> [--superseded-by <id>]",
		lax: true,
		run: (p) => cmdKnowledgeRetire(p.rest),
	}),
	defineVerb({
		name: "knowledge-grade",
		usage:
			'usage: knowledge-grade <id> --rating <s> [--evidence <file:line|URL>] [--researched <date|ms>] --as <sid>',
		lax: true,
		run: (p) => cmdKnowledgeGrade(p.rest),
	}),
	defineVerb({
		name: "knowledge-graveyard",
		usage: 'usage: knowledge-graveyard <id> --reason "<why>" [--as sid]',
		lax: true,
		run: (p) => cmdKnowledgeGraveyard(p.rest),
	}),
	defineVerb({
		name: "knowledge-note",
		usage: 'usage: knowledge-note <id> --what "what changed" --as <sid>',
		lax: true,
		run: (p) => cmdKnowledgeNote(p.rest),
	}),
	defineVerb({
		name: "knowledge-verify",
		lax: true,
		run: (p) => cmdKnowledgeVerify(p.rest),
	}),
	defineVerb({
		name: "knowledge-curate",
		lax: true,
		run: (p) => cmdKnowledgeCurate(p.rest),
	}),
	defineVerb({
		name: "knowledge-propose",
		usage:
			"usage: knowledge-propose [--half-life n] [--threshold n] [--cooldown-days n] [--as sid]",
		flags: ["--half-life", "--threshold", "--cooldown-days", "--as"],
		run: (p) => cmdKnowledgePropose(p.rest),
	}),
	defineVerb({
		name: "knowledge-proposals",
		usage: "usage: knowledge-proposals [state]",
		run: (p) => cmdKnowledgeProposals(p.rest),
	}),
	defineVerb({
		name: "knowledge-dispose",
		usage:
			'usage: knowledge-dispose <proposalId> approve|dismiss [--as sid] [--note "why"] [--superseded-by <id>]',
		flags: ["--as", "--note", "--superseded-by"],
		run: (p) => cmdKnowledgeDispose(p.rest),
	}),
	defineVerb({
		name: "bootstrap",
		usage:
			"usage: bootstrap --as <sid> [--role r] [--parent sid] [--worktree w] [--caps shell,fs,...] [--actor id] [--tags json] [--name label]",
		lax: true,
		run: (p) => cmdBootstrap(p.rest),
	}),
	defineVerb({
		name: "fleet",
		lax: true,
		run: (p) => cmdFleet(p.rest),
	}),
	defineVerb({
		name: "hubs",
		usage: "usage: hubs [--label name] [--json]",
		lax: true,
		run: (p) => cmdHubs(p.rest),
	}),
	defineVerb({
		name: "supervisor",
		usage: "usage: supervisor ensure [service...] | status [--json]",
		lax: true,
		run: (p) => cmdSupervisor(p.rest),
	}),
	defineVerb({
		name: "project",
		usage:
			"usage: project identity | project rekey <old> <new> | project enroll|bind|verify",
		lax: true,
		run: (p) => cmdProject(p.rest),
	}),
	defineVerb({
		name: "metrics",
		usage: "usage: metrics [project] [--days N]",
		lax: true,
		run: (p) => cmdMetrics(p.rest),
	}),
	defineVerb({
		name: "doctor-session",
		usage: "usage: doctor-session <sid>",
		lax: true,
		run: (p) => cmdDoctorSession(p.rest),
	}),
	defineVerb({
		name: "diff",
		usage:
			"usage: diff [--since <seq|event-id>] [--last N] [--table t] [--json]",
		lax: true,
		run: (p) => cmdDiff(p.rest),
	}),
	defineVerb({
		name: "events",
		usage: "usage: events [--kinds a,b] [--last N] [--json]",
		lax: true,
		run: (p) => cmdEvents(p.rest),
	}),
	defineVerb({
		name: "targets",
		usage: "usage: targets [--filter text] [--cap <c>] [--json]",
		lax: true,
		run: (p) => cmdTargets(p.rest),
	}),
	defineVerb({
		name: "message",
		usage:
			'usage: message <target-label-or-sid-or-substring> "text" [--as sid] | message --all "text" [--as sid]',
		lax: true,
		run: (p) => cmdMessage(p.rest),
	}),
	defineVerb({
		name: "wisdom",
		usage: "usage: wisdom — manual fleet-correction pass (read-only)",
		lax: true,
		run: (p) => cmdWisdom(p.rest),
	}),
	defineVerb({
		name: "executor-cv",
		usage: "usage: executor-cv [--apply]",
		lax: true,
		run: (p) => cmdExecutorCv(p.rest),
	}),
];

await runCli({
	prog: "coord",
	about: "coord — control plane.",
	verbs: VERBS,
	epilog: [
		"  bootstrap --as <sid> --name <label> stamps a user-facing lane name (coord fleet + the board show it)",
		"  executor-cv [--apply] — the executor trust tally folded from work events (W620)",
		"  project identity | project rekey <old> <new> — graph identity migration (W428)",
		"  project enroll|bind|verify — managed-project enrollment pilot (W459.5, docs/identity-enrollment-pilot.md)",
	].join("\n"),
	onVerb: (_name, p) => {
		setRest(p.rest);
	},
});
