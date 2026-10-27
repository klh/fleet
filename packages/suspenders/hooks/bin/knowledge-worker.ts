// knowledge-worker.ts — W91: the knowledge ingest DAEMON (#8): a long-running
// drain loop over the knowledge_queue table spine (SQLite/WAL = the durable,
// inspectable broker — producers INSERT even when this process is down).
// p-queue, concurrency 1 (the distill model is single-instance — queue, never
// parallel-stomp it). SIGTERM: finish the current job, then exit.
//
// It consumes ONLY the ports (#9/#9b): KnowledgeStore + DistillClient via
// makeStore()/makeDistillClient() — the SQLite adapter is the only thing that
// touches governor.db. Policy layers live HERE (the loop), not in the store:
// mechanical secrets pass (redactSecrets) before any insert, near-duplicate
// gate via store.dedupeCheck (older fact kept, skip noted in the ledger).
// W103 adds the substitution contract's mechanical layer: doc-covered facts
// become POINTER rows (source_ref → the doc, fact → the non-obvious residue)
// or are rejected — never restatements of what one file already teaches.
// env:   SUSPENDERS_BUCKLE_URL / SUSPENDERS_BUCKLE_TOKEN — scoped proxy key
//        for the Buckle front. The default client sends W96's exact hint to
//        local-swarm. Alternatively provision a mode-0600
//        ~/.claude/local-llm/knowledge-buckle.json with {url,token}.
//        W1229: every distill call rides the ONE lifecycle transport
//        (hooks/lib/knowledge-inference.ts) — explicit budget admission
//        (SUSPENDERS_MEMORY_RPM/CONCURRENCY/WAIT_MS/MAX_TOKENS), a W3C
//        traceparent so failures join Buckle's route_audit by trace_id, and
//        row saves behind the MemoryWrites barrier: saves run async, and the
//        flush before complete/optimize is wait-before-recall.
//        INGEST_LLM_URL is rejected: it bypasses Buckle's audit.
//        KNOWLEDGE_STORE_URL — reserved for a remote store adapter.
//        KNOWLEDGE_DOCS_ROOT — repo root for the substitution test; unset →
//        the mechanical check is OFF (prompt layer still applies).
// usage: bun hooks/bin/knowledge-worker.ts          (daemon: 5s poll loop)
//        bun hooks/bin/knowledge-worker.ts --once   (drain queued, exit)

import { createHash } from "node:crypto";
import PQueue from "p-queue";
import {
	type DistillItem,
	makeDistillClient,
} from "../lib/knowledge/distill-clients.ts";
import {
	docForRef,
	loadDocs,
	loadRootDocs,
	pointerFromText,
	redactSecrets,
	substitutionCheck,
} from "../lib/knowledge/knowledge.ts";
import { MemoryWrites } from "../lib/knowledge/knowledge-inference.ts";
import { currentPromptHash } from "../lib/knowledge/prompt-policy.ts";
import { makeStore } from "../lib/knowledge/sqlite-store.ts";
import type {
	KnowledgeStore,
	NearDupProposal,
} from "../lib/knowledge/store-schema.ts";

const MAX_ATTEMPTS = 3;
const store: KnowledgeStore = makeStore();
const distill = makeDistillClient();

// W103: docs root for the substitution test. Unset → the check is OFF (logged
// once); the prompt layer (knowledgeworker.md) still applies. A pointer row's
// source_hash is the DOC's hash so knowledge-verify drift-checks the doc.
const DOCS_ROOT = process.env.KNOWLEDGE_DOCS_ROOT ?? null;
if (!DOCS_ROOT)
	console.error(
		"knowledge-worker: KNOWLEDGE_DOCS_ROOT unset — substitution check OFF (prompt layer still applies)",
	);
let draining = true;
const stop = (): void => {
	draining = false;
	console.error("knowledge-worker: SIGTERM — finishing current job, then exit");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

// one job: claim → distill → secrets pass → dedupe gate → substitution → rows
async function processRow(rowId: number): Promise<void> {
	const job = await store.claim(rowId);
	if (!job) return; // claimed or purged meanwhile
	try {
		const items = await distill.distill(job.payload, {
			domain: job.domain,
			area: job.area,
			codeOrigin: job.codeOrigin,
			originSid: job.originSid,
		});
		const written: number[] = [];
		const skipped: string[] = [];
		const proposals: NearDupProposal[] = [];
		let converted = 0;
		// W1229: row saves ride write-behind (async, concurrency 1); the flush
		// barrier before complete/optimize is the wait-before-recall discipline —
		// the ledger and the FTS index never race a pending save.
		const writes = new MemoryWrites();
		for (const it of items) {
			// mechanical secrets pass BEFORE anything: redact in place; a
			// private-key block rejects the candidate (LLM layer is not trusted)
			const top = redactSecrets(it.topic);
			const fac = redactSecrets(it.fact);
			if (top.rejected || fac.rejected) {
				skipped.push(
					`"${it.topic}" rejected: secret pattern (${[...top.hits, ...fac.hits].join(", ")})`,
				);
				continue;
			}
			const dup = await store.dedupeCheck({
				topic: top.text,
				fact: fac.text,
			});
			if (dup) {
				skipped.push(
					`"${it.topic}" near-duplicate of knowledge #${dup.id} ("${dup.topic}") — older kept`,
				);
				// W246 propose-dispose: the skip stands (older kept), but the
				// candidate is not silently dropped — a supersession proposal
				// rides the job ledger + one event row; a human disposes.
				const proposal: NearDupProposal = {
					y: dup.id,
					yTopic: dup.topic,
					xTopic: top.text,
					xFact: fac.text,
					action: `retire #${dup.id} superseded-by candidate "${top.text}" if it is the correction`,
				};
				proposals.push(proposal);
				await store.proposeSupersession(proposal, job.id, job.originSid);
				continue;
			}
			// W103 substitution contract: covered+residue → POINTER row
			// (ref → the doc, fact → residue, hash → the doc); covered without
			// residue → reject with the doc named in the ledger.
			const sub = substitutionGate(job.codeOrigin, job.sourceHash, {
				...it,
				fact: fac.text,
			});
			if (sub.skip) {
				skipped.push(sub.skip);
				continue;
			}
			if (sub.converted) converted++;
			await writes.push(() =>
				store
					.upsert({
						topic: top.text,
						fact: sub.fact,
						confidence: it.confidence,
						domain: job.domain ?? it.domain,
						area: job.area ?? it.area,
						originKind: it.originKind,
						originSystem: it.originSystem,
						sourceRef: sub.sourceRef,
						sourceHash: sub.sourceHash,
						originSid: job.originSid,
						hubEligible: job.hubEligible,
						supersedesId: it.supersedesId,
					})
					.then((id) => {
						written.push(id);
					}),
			);
		}
		// wait-before-recall: settle every pending save before the ledger write
		// and the FTS optimize — a recall face reading concurrently never sees
		// the job half-landed; a failed save fails the job before complete.
		const writeErrs = await writes.flush();
		if (writeErrs.length)
			throw new Error(
				`write-behind save failed: ${String(writeErrs[0]?.message ?? "unknown")}`,
			);
		await store.complete(
			job.id,
			{ written, skipped, proposals },
			job.domain,
			job.originSid,
		);
		// W166 (design §4): FTS5 optimize after every job that wrote rows —
		// 70 ms measured against an LLM-paced job is noise; bounds segments.
		if (written.length > 0) {
			const t0 = performance.now();
			await store.optimize();
			console.log(
				`knowledge-ingest: fts optimize ${Math.round(performance.now() - t0)}ms`,
			);
		}
		console.log(
			`knowledge-ingest: #${job.id} "${job.source.slice(0, 40)}" → ${written.length} written, ${skipped.length} skipped${converted ? `, ${converted} converted to pointer rows` : ""}`,
		);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		console.error(`knowledge-ingest: #${job.id} failed: ${msg}`);
		await store.fail(job.id, msg, job.attempts >= MAX_ATTEMPTS);
	}
}

// substitution gate (mechanical layer): corpus = docs under DOCS_ROOT + root
// README/AGENTS/CLAUDE + the job's code_origin file. Covered with residue →
// pointer row; covered without → reject; a model-declared source_ref is
// honored only when the file resolves (and is hashed) under DOCS_ROOT.
interface SubOut {
	fact: string;
	sourceRef: string | null;
	sourceHash: string;
	converted?: boolean;
	skip?: string;
}

function substitutionGate(
	codeOrigin: string | null,
	fallbackHash: string,
	it: DistillItem,
): SubOut {
	if (!DOCS_ROOT)
		return { fact: it.fact, sourceRef: codeOrigin, sourceHash: fallbackHash };
	return gateScan(codeOrigin, fallbackHash, it);
}

// corpus + verdict → SubOut (gate part 2)
function gateScan(
	codeOrigin: string | null,
	fallbackHash: string,
	it: DistillItem,
): SubOut {
	const root = DOCS_ROOT ?? ".";
	const docs = [...loadDocs(root), ...loadRootDocs(root)];
	const own = docForRef(root, codeOrigin);
	const v = substitutionCheck(it.fact, own ? [...docs, own] : docs);
	if (!v.covered) {
		// not doc-covered: honor a model-declared pointer ref when resolvable —
		// kept verbatim, never rewritten by the mechanical layer (W112 test)
		if (it.sourceRef) {
			const d = docForRef(root, it.sourceRef);
			if (d)
				return {
					fact: it.fact,
					sourceRef: it.sourceRef,
					sourceHash: sha256Hex(d.text),
				};
		}
		// W112 mechanical fallback: the model left source_ref empty (or named a
		// file that does not resolve) — extract doc paths from the fact text
		// and anchor to the first that EXISTS under DOCS_ROOT; hash = the file
		// content. Nothing resolves → the codeOrigin default below keeps the
		// trust marker honest.
		const p = pointerFromText(it.fact, root);
		if (p) return { fact: it.fact, sourceRef: p.ref, sourceHash: p.hash };
		return { fact: it.fact, sourceRef: codeOrigin, sourceHash: fallbackHash };
	}
	if (!v.residue)
		return {
			fact: it.fact,
			sourceRef: codeOrigin,
			sourceHash: fallbackHash,
			skip: `"${it.topic}" rejected: fully derivable from ${v.doc} (substitution contract)`,
		};
	return {
		fact: v.residue,
		sourceRef: v.doc,
		sourceHash: sha256Hex(v.docText ?? ""),
		converted: true,
	};
}

const sha256Hex = (text: string): string =>
	createHash("sha256").update(text).digest("hex");

// oldest first (ts, id); p-queue serializes distill calls. W244: the parser-
// change checkpoint rides every tick — a live knowledgeworker.md edit applies
// to the next queued job AND re-enqueues its older-parser work exactly once
// (short-circuits to one SELECT while the prompt is unchanged).
async function tick(): Promise<void> {
	const rep = await store.reprocessCheck(currentPromptHash(), true);
	if (rep.advanced)
		console.log(
			`knowledge-ingest: reprocess — ${rep.requeued} requeued, ${rep.marked} archived rows marked (${rep.skippedNoPayload} payload-less, skipped)`,
		);
	const next = await store.peekNext();
	if (next) await work.add(() => processRow(next.id));
}

const work = new PQueue({ concurrency: 1 });
await store.recoverOrphans(600_000); // dead worker's orphans requeue (#8)

if (process.argv.includes("--once")) {
	// manual/test mode: drain what is queued NOW, then exit. The launchd
	// daemon form runs the 5s poll loop below instead. W244: the checkpoint
	// pass runs BEFORE the empty-gate — a prompt change requeues archived
	// sources even when the queue reads empty at entry.
	await tick();
	if (!(await store.queuedCount()))
		console.log("knowledge-ingest: queue empty");
	for (;;) {
		if (!(await store.queuedCount())) break;
		await tick();
	}
	await work.onIdle();
	process.exit(0);
}

console.error("knowledge-worker daemon: poll 5s, p-queue concurrency 1");
setInterval(() => {
	if (draining) void tick();
}, 5000);
void tick();
work.on("idle", () => {
	if (!draining) process.exit(0);
});
