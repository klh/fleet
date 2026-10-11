// hooks/bin/usage-harvest.ts — W127 usage data layer. Library + thin CLI.
// Mines THIS host's ~/.claude/projects/**/*.jsonl transcripts for assistant
// usage rows (tokenUsage precedent in govdb.ts), aggregates them into hourly
// (hour_bucket, actor, model) buckets, and UPSERT-ADDS them into
// governor.db's usage_rollup. Idempotent per transcript via a machine_cursors
// {offset, mtime, v:2} cursor: an unchanged transcript is skipped (no double
// count); a grown one is read as an append-only tail. Durable assistant
// message identities charge one request and only growth across blocks. Runs
// as a board-API subroutine (TTL-gated maybeHarvest) — never a daemon.
// W652.3: discovery/cursor/tail ride the shared harvest engine.
import type { GovernorStore } from "../lib/govdb.ts";
import { readBoardSettings } from "../lib/board-config.ts";
import { harvestAids } from "./aid-harvest.ts";
import {
	gatedHarvest,
	num,
	scanTranscriptTails,
	sessionActorMap,
} from "../lib/harvest-engine.ts";
import { saveCursor } from "../lib/transcript-cursor.ts";
import { usageMessageLedger } from "../lib/usage-message-ledger.ts";
import { usageRollupSource, verifiedUsageActive } from "../lib/usage-source.ts";

// routing-doctrine classes (belt routing-policy.yaml ladder: flash → local →
// cloud full models); the raw model string is kept alongside the group.
export type ModelGroup = "flash" | "full" | "luna" | "local" | "other";

export function modelGroup(model: string): ModelGroup {
	const m = model.toLowerCase().replace(/^[a-z0-9]+\//, ""); // strip anthropic/ etc.
	if (m.includes("flash")) return "flash";
	if (m.includes("luna")) return "luna";
	if (/(local|swarm|ollama|llama|gguf|hermes)/.test(m)) return "local";
	if (/^(claude|gpt|o[0-9]|gemini|grok|deepseek)/.test(m)) return "full";
	return "other";
}

export interface HarvestStats {
	files: number; // transcripts seen
	harvested: number; // transcripts whose tail was read
	skipped: number; // unchanged (cursor hit) — the idempotency fast path
	requests: number; // assistant usage rows aggregated
	inTok: number;
	outTok: number;
	cacheR: number;
	cacheC: number;
}

// ledger keys stay `usage.tp.<sha1>` in BOTH provenance modes — only the
// cursor namespace shifts to usage.v2.tp when the verified source is active
const tpKey = (p: string): string => {
	const h = new Bun.CryptoHasher("sha1");
	h.update(p);
	return `usage.tp.${h.digest("hex")}`;
};

export function harvestUsage(
	db: GovernorStore,
	opts: { root?: string } = {},
): HarvestStats {
	const verified = verifiedUsageActive(db);
	if (
		!verified &&
		db
			.query("SELECT 1 FROM sqlite_master WHERE name='usage_migration_state'")
			.get()
	)
		throw new Error(
			"usage migration deactivated: metering paused until verified source is reactivated",
		);
	const rollup = usageRollupSource(db);
	const out: HarvestStats = {
		files: 0,
		harvested: 0,
		skipped: 0,
		requests: 0,
		inTok: 0,
		outTok: 0,
		cacheR: 0,
		cacheC: 0,
	};
	// actor attribution: transcript basename → sessions.sid → actor. No
	// session row (or NULL actor) ⇒ "unassigned" — honest, never guessed.
	const actorOf = sessionActorMap(db);
	const defaultActor =
		readBoardSettings().settings.default_actor ?? "unassigned";
	const upsert = db.query(
		`INSERT INTO ${rollup} (hour_bucket, actor, model, model_group, in_tok, out_tok, cache_r, cache_c, requests) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hour_bucket, actor, model) DO UPDATE SET in_tok = in_tok + excluded.in_tok, out_tok = out_tok + excluded.out_tok, cache_r = cache_r + excluded.cache_r, cache_c = cache_c + excluded.cache_c, requests = requests + excluded.requests`,
	);
	const add = new Map<
		string,
		{
			h: number;
			actor: string;
			model: string;
			group: ModelGroup;
			in: number;
			out: number;
			cr: number;
			cc: number;
			req: number;
		}
	>();
	const meter = usageMessageLedger(
		db,
		verified ? "usage_verified_message_ledger" : "usage_message_ledger",
	);
	const bump = (
		h: number,
		actor: string,
		model: string,
		requests: number,
		u: {
			input_tokens?: unknown;
			output_tokens?: unknown;
			cache_read_input_tokens?: unknown;
			cache_creation_input_tokens?: unknown;
		},
	) => {
		const key = `${h}\u0000${actor}\u0000${model}`;
		let r = add.get(key);
		if (!r) {
			r = {
				h,
				actor,
				model,
				group: modelGroup(model),
				in: 0,
				out: 0,
				cr: 0,
				cc: 0,
				req: 0,
			};
		}
		r.in += num(u.input_tokens);
		r.out += num(u.output_tokens);
		r.cr += num(u.cache_read_input_tokens);
		r.cc += num(u.cache_creation_input_tokens);
		r.req += requests;
		add.set(key, r);
	};
	db.run("BEGIN IMMEDIATE");
	try {
		const stats = scanTranscriptTails(
			db,
			{
				root: opts.root,
				prefix: verified ? "usage.v2.tp" : "usage.tp",
				// W466 legacy-cursor refusal rides the engine guard hook
				guard: ({ key, cur }) => {
					if (cur && cur.o > 0 && cur.v !== 2)
						throw new Error(
							"usage source requires reviewed provenance rebuild before metering: " +
								key,
						);
				},
			},
			(scan) => {
				if (scan.kind === "skip") {
					out.skipped++;
					return;
				}
				if (scan.kind === "empty") {
					// no complete line in the tail — advance nothing, retry next pass
					saveCursor(
						db,
						scan.key,
						{ o: scan.start, m: scan.mtimeMs, v: 2 },
						"usage-harvest",
						Date.now(),
					);
					return;
				}
				// attribution fallback: the settings default_actor (config-over-code)
				// — "unassigned" only when no default is configured
				const actor = actorOf.get(scan.sid)?.actor ?? defaultActor;
				for (const { text: line, offset: lineOffset } of scan.lines) {
					let o:
						| {
								timestamp?: string;
								uuid?: string;
								type?: string;
								message?: {
									id?: string;
									model?: string;
									usage?: Record<string, unknown>;
								};
						  }
						| undefined;
					try {
						o = JSON.parse(line);
					} catch {
						continue;
					}
					const ts = Date.parse(o?.timestamp ?? "");
					const u = o?.message?.usage;
					if (o?.type !== "assistant" || !u || !Number.isFinite(ts)) continue;
					const model = o?.message?.model ?? "";
					const delta = meter(
						tpKey(scan.abs),
						o.message?.id
							? `message:${o.message.id}`
							: o.uuid
								? `uuid:${o.uuid}`
								: `offset:${lineOffset}`,
						Math.floor(ts / 3_600_000) * 3_600_000,
						actor,
						model,
						u,
					);
					bump(
						delta.hour,
						delta.actor,
						delta.model,
						delta.requests,
						delta.usage,
					);
					out.requests += delta.requests;
					out.inTok += num(delta.usage.input_tokens);
					out.outTok += num(delta.usage.output_tokens);
					out.cacheR += num(delta.usage.cache_read_input_tokens);
					out.cacheC += num(delta.usage.cache_creation_input_tokens);
				}
				saveCursor(
					db,
					scan.key,
					{ o: scan.next, m: scan.mtimeMs, v: 2 },
					"usage-harvest",
					Date.now(),
				);
				out.harvested++;
			},
		);
		out.files = stats.files;
		if (add.size) {
			for (const r of add.values())
				upsert.run(
					r.h,
					r.actor,
					r.model,
					r.group,
					r.in,
					r.out,
					r.cr,
					r.cc,
					r.req,
				);
		}
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e;
	}
	return out;
}

// board-API entry: harvest at most once per TTL; concurrent/reentrant calls
// (same process or overlapping board requests) fold into the running one.
export function maybeHarvest(
	db: GovernorStore,
	ttlMs?: number,
): HarvestStats | null {
	return gatedHarvest(
		db,
		"usage",
		"usage-harvest",
		() => {
			const s = harvestUsage(db);
			// W142: aid metering rides the same TTL gate (fire-and-forget — the
			// report built this tick may lag one cycle; aids are garnish).
			void harvestAids(db).catch((e: unknown) =>
				console.error(
					`[aid-harvest] soft: ${e instanceof Error ? e.message : e}`,
				),
			);
			return s;
		},
		ttlMs,
	);
}

if (import.meta.main) {
	// CLI-only, lazy: the library must not bind an un-busted govdb module
	// entry at import time (shared with un-busted consumers like settle.ts).
	const { openStore } = await import("../lib/govdb.ts");
	const db = openStore();
	const force = process.argv.includes("--force");
	const s = maybeHarvest(db, force ? 0 : undefined);
	console.log(JSON.stringify(s ?? { skipped: "ttl-fresh" }));
}
