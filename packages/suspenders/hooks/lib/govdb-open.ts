// hooks/lib/govdb-open.ts — openGovernorDb: the governor.db schema and
// its explicit migration ladder (v1→v18), plus the legacy JSON→SQL
// registry migration. W624 split: knowledge steps live in
// govdb-knowledge.ts, the delta-trigger template in govdb-deltas.ts.
import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { migrateEventsShred } from "./events-shred.ts";
import { createDeltasTriggers } from "./govdb-deltas.ts";
import {
	migrateKnowledgeLayer,
	migrateKnowledgeSplit,
} from "./govdb-knowledge.ts";
import { columnNames, openWALDb, REG } from "./govdb-util.ts";
import {
	CONFIDENCE_HISTORY_DDL,
	CONFIDENCE_HISTORY_INDEX_DDL,
} from "./confidence.ts";
import { migrateIdentitySplit } from "./identity-db.ts";
import { migrateIdentityRegistry } from "./identity-registry.ts";

export function openGovernorDb(): Database {
	mkdirSync(REG(), { recursive: true });
	const db = openWALDb(`${REG()}/governor.db`, "governor.db");
	db.run("PRAGMA foreign_keys=ON"); // composite FKs guard work_deps against cross-project/orphan edges
	// schema versioning via PRAGMA user_version: baseline 1 = composite-PK work
	// graph. Future migrations must be explicit steps (v1→v2), never inferred.
	const uv = (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
	if (uv < 1) db.run("PRAGMA user_version = 1");
	db.run(
		"CREATE TABLE IF NOT EXISTS claims (sid TEXT NOT NULL, scope TEXT NOT NULL, intent TEXT, hot INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL, tp TEXT, PRIMARY KEY (sid, scope))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS locks (path TEXT PRIMARY KEY, sid TEXT NOT NULL, tool TEXT, ts INTEGER NOT NULL, tp TEXT, hash TEXT, seen TEXT)",
	);
	// event bus (coord.ts): append-only events, per-agent cursors, canonical facts.
	// target = directed inbox (null = broadcast); added by migration on older DBs.
	db.run(
		"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, source TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT, payload TEXT, target TEXT)",
	);
	const evCols = columnNames(db, "events");
	if (!evCols.includes("target"))
		db.run("ALTER TABLE events ADD COLUMN target TEXT");
	db.run(
		"CREATE TABLE IF NOT EXISTS cursors (sid TEXT PRIMARY KEY, event_id INTEGER NOT NULL)",
	);
	// W957: a cursor means an event was displayed, not that a direct NOTE was
	// accepted. New messages get a receipt at emission; historical messages
	// without one retain their unknown delivery state rather than backfilling
	// a false acknowledgment.
	db.run(
		"CREATE TABLE IF NOT EXISTS direct_message_receipts (event_id INTEGER PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE, sid TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'QUEUED', queued_at INTEGER NOT NULL, seen_at INTEGER, accepted_at INTEGER)",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS direct_message_receipts_sid_state ON direct_message_receipts(sid, state, event_id)",
	);
	// Every producer, including hub relays, uses the same events table. Keep
	// the delivery obligation atomic with the event insert rather than asking
	// each writer to remember a second receipt write.
	db.run(`CREATE TRIGGER IF NOT EXISTS directed_event_receipt_ai
		AFTER INSERT ON events
		WHEN NEW.target IS NOT NULL AND NEW.kind IN ('NOTE', 'consult', 'consult.answer', 'NEED_DECISION')
		BEGIN
			INSERT INTO direct_message_receipts (event_id, sid, queued_at)
			VALUES (NEW.id, NEW.target, NEW.ts);
		END`);
	// W451 hub longevity: measured hot-path indexes — the bus had NO index
	// beyond the rowid PK, so every kind/target-filtered tail read (coord
	// events --kinds, the board's per-second /api/data scans, inbox polling)
	// walked the whole table. EXPLAIN QUERY PLAN evidence lives in
	// test/w451-event-indexes.test.ts (SCAN→SEARCH asserted per read shape).
	db.run("CREATE INDEX IF NOT EXISTS events_kind_id ON events(kind, id)");
	db.run("CREATE INDEX IF NOT EXISTS events_kind_ts ON events(kind, ts)");
	db.run("CREATE INDEX IF NOT EXISTS events_target_id ON events(target, id)");
	// work graph: hierarchical, claimable, shatterable work items (bin/work.ts).
	// project = repo root realpath — partitions the graph per project so
	// sessions in different repos never see (or steal) each other's work.
	// CREATE TABLE IF NOT EXISTS cannot upgrade a live table, so legacy
	// (single-PK, pre-partition) shapes are migrated in one transaction:
	// empty tables are recreated; tables holding rows are renamed to
	// <name>_legacy_<ts> — rows survive verbatim, nothing is ever dropped
	// while non-empty. A failed rename aborts the whole migration (throw),
	// never a silent loss. FKs off during the shape swap per the documented
	// alter-table procedure (sqlite.org/lang_altertable.html).
	db.run("PRAGMA foreign_keys=OFF");
	try {
		// pre-check with plain reads — BEGIN IMMEDIATE on every open raced
		// the store-server's write lock (SQLITE_BUSY boot crash; the board
		// logged 57 restart banners on 2026-10-12). The write tx opens only
		// when a legacy shape actually needs the swap; shapes are re-checked
		// inside the tx so two racing openers cannot double-swap.
		const legacy = ["work_deps", "work_items"].filter((name) => {
			const row = db
				.query(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(name) as { sql?: string } | undefined;
			return (
				Boolean(row?.sql) && !/PRIMARY KEY\s*\(\s*project/.test(row.sql ?? "")
			);
		});
		const swapped = legacy.length > 0;
		if (swapped) db.run("BEGIN IMMEDIATE");
		for (const name of legacy) {
			const row = db
				.query(
					"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
				)
				.get(name) as { sql?: string } | undefined;
			if (!row?.sql || /PRIMARY KEY\s*\(\s*project/.test(row.sql)) continue; // absent or current shape
			const n = (
				db.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }
			).n;
			if (n === 0) db.run(`DROP TABLE "${name}"`);
			else {
				const backup = `${name}_legacy_${Date.now()}`;
				db.run(`ALTER TABLE "${name}" RENAME TO "${backup}"`);
				console.error(
					`[govdb] legacy ${name} held ${n} rows — preserved in ${backup} (project mapping ambiguous, not auto-converted)`,
				);
			}
		}
		if (swapped) db.run("COMMIT");
	} catch (e) {
		try {
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(
					`govdb work-graph migration refused (no data touched): ${e.message}`,
					{ cause: e },
				)
			: e;
	} finally {
		db.run("PRAGMA foreign_keys=ON");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS work_items (project TEXT NOT NULL, id TEXT NOT NULL, parent_id TEXT, title TEXT NOT NULL, description TEXT, state TEXT NOT NULL DEFAULT 'READY', priority INTEGER NOT NULL DEFAULT 0, owner_sid TEXT, created_by TEXT, scope TEXT, why_parallel TEXT, result_sha TEXT, required INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (project, id))",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS work_deps (project TEXT NOT NULL, work_id TEXT NOT NULL, depends_on TEXT NOT NULL, PRIMARY KEY (project, work_id, depends_on), FOREIGN KEY (project, work_id) REFERENCES work_items(project, id) ON DELETE CASCADE, FOREIGN KEY (project, depends_on) REFERENCES work_items(project, id) ON DELETE CASCADE)",
	);
	db.run(
		"CREATE TABLE IF NOT EXISTS work_sequences (project TEXT PRIMARY KEY, next_id INTEGER NOT NULL)",
	);
	// consults: quick questions between sessions — never claims, ownership, or
	// lane state. WORK = implement, CONSULT = answer, HANDOFF = take ownership.
	db.run(
		"CREATE TABLE IF NOT EXISTS consults (id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL, asker_sid TEXT NOT NULL, expert_sid TEXT NOT NULL, question TEXT NOT NULL, scope TEXT, state TEXT NOT NULL DEFAULT 'OPEN', answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER)",
	);
	// W611: consults carry an explicit deadline — an OPEN consult undelivered
	// past it expires (consult-expiry.ts) and emits consult.expired at its
	// asker. NULL = pre-W611 row: expiry falls back to created_at + TTL.
	const consultCols = columnNames(db, "consults");
	if (!consultCols.includes("deadline_at"))
		db.run("ALTER TABLE consults ADD COLUMN deadline_at INTEGER");
	// session registry (coord bootstrap): who exists, where, doing what role
	db.run(
		"CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, project TEXT, role TEXT, parent_sid TEXT, worktree TEXT, started_at INTEGER NOT NULL, hb INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'RUNNING')",
	);
	// v2 — capability-aware dispatch: work declares requires (csv), sessions
	// advertise capabilities (csv); work take refuses requires ⊄ capabilities.
	// NULL on either side = legacy = no constraint. Explicit migration step.
	const sessCols = columnNames(db, "sessions");
	if (!sessCols.includes("capabilities"))
		db.run("ALTER TABLE sessions ADD COLUMN capabilities TEXT");
	if (!sessCols.includes("transcript_path"))
		db.run("ALTER TABLE sessions ADD COLUMN transcript_path TEXT");
	const wiCols = columnNames(db, "work_items");
	if (!wiCols.includes("requires"))
		db.run("ALTER TABLE work_items ADD COLUMN requires TEXT");
	// origin (multi-machine readiness, owner 2026-09-28): "<host>:<agent>"
	// stamped at dispatch via `work take --origin` — which machine and which
	// agent backend claimed the item; surfaced on board cards. COALESCE at
	// take keeps the first dispatch's stamp across resume re-takes.
	if (!wiCols.includes("origin"))
		db.run("ALTER TABLE work_items ADD COLUMN origin TEXT");
	// W517 — .prefer tree tag (lib/prefer.ts): stamped at insert by every
	// creation path (add/split/migrate funnel through work.ts insertItem);
	// display + board fall back to a live resolve for rows added before
	// coverage, so the tag rides regardless of origin.
	if (!wiCols.includes("tags"))
		db.run("ALTER TABLE work_items ADD COLUMN tags TEXT");
	// W515 — allocation_reason: the why behind every assignment, stamped by
	// assignTask() (the sole assignment gateway): "manual take" for explicit
	// takes, the scored reason ("allocate: score=…") for allocate --apply.
	if (!wiCols.includes("alloc_reason"))
		db.run("ALTER TABLE work_items ADD COLUMN alloc_reason TEXT");
	// W248 — per-item effort budget (simple | complex): stamped at add,
	// inherited by split children; the brief composes the EFFORT BUDGET line
	// from it (hooks/lib/work-effort.ts owns the vocabulary + text).
	if (!wiCols.includes("effort"))
		db.run("ALTER TABLE work_items ADD COLUMN effort TEXT");
	// W643 columns dropped by the W624.2 govdb split — restored (W686): the
	// claim-token fence and the evidence gate INSERT/UPDATE these on fresh
	// dbs, so a ladder without them breaks every fresh-clone/test fixture.
	// W643 — claim-token fence: take mints a random token and stores ONLY its
	// sha256 here; done must present a matching token. NULL = legacy claim
	// (pre-W643 take, non-graph writers) - closes ungated.
	if (!wiCols.includes("claim_token_hash"))
		db.run("ALTER TABLE work_items ADD COLUMN claim_token_hash TEXT");
	// W643 — evidence-gated terminal transition: JSON array of regex sources
	// the closing evidence (summary / product paths / added diff lines) must
	// each match, else done refuses. NULL = no required evidence.
	if (!wiCols.includes("evidence"))
		db.run("ALTER TABLE work_items ADD COLUMN evidence TEXT");
	// WAITING is an explicit external prerequisite, never an allocator candidate.
	if (!wiCols.includes("wait_kind"))
		db.run("ALTER TABLE work_items ADD COLUMN wait_kind TEXT");
	if (!wiCols.includes("wait_reason"))
		db.run("ALTER TABLE work_items ADD COLUMN wait_reason TEXT");
	if (!wiCols.includes("wait_until"))
		db.run("ALTER TABLE work_items ADD COLUMN wait_until INTEGER");
	if (uv < 2) db.run("PRAGMA user_version = 2");
	// v4 — consult knowledge base: (problem → solution) pairs harvested from
	// answered consults; new consults resolve against it before routing to a
	// live expert. Standalone FTS5 index (rowid = consult_kb.id), all-trees
	// scope by design — a fix learned in one repo answers the same question
	// in another. (v3 was spent by the decisions schema.)
	if (uv < 4) {
		db.run(
			"CREATE TABLE IF NOT EXISTS consult_kb (id INTEGER PRIMARY KEY AUTOINCREMENT, problem TEXT NOT NULL, solution TEXT NOT NULL, project TEXT NOT NULL, asked_by TEXT NOT NULL, answered_by TEXT NOT NULL, consult_id INTEGER, hits INTEGER NOT NULL DEFAULT 0, last_hit_at INTEGER, created_at INTEGER NOT NULL)",
		);
		db.run(
			"CREATE VIRTUAL TABLE IF NOT EXISTS consult_kb_fts USING fts5(problem)",
		);
		db.run("PRAGMA user_version = 4");
	}
	db.run(
		"CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT, source TEXT, version INTEGER NOT NULL DEFAULT 1, ts INTEGER NOT NULL)",
	);
	// v5 — row-image delta log (W33): sessions, claims, locks, facts, and
	// work_items all mutate IN PLACE with no event trail, so "what actually
	// changed between two points" (coord diff --since) was unreconstructable.
	// AFTER triggers append row images to `deltas`; before is NULL on insert,
	// after NULL on delete. events/cursors stay untracked — the bus already is
	// its own trail. CREATEs run every open (IF NOT EXISTS, so a dropped table
	// or trigger self-heals) and DDL never fires row triggers.
	db.run(
		"CREATE TABLE IF NOT EXISTS deltas (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, pk TEXT NOT NULL, before TEXT, after TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS deltas_ts ON deltas(ts, seq)"); // --since <event-id> resolves ts → seq
	if (uv < 5) db.run("PRAGMA user_version = 5");
	// v6/W91 — knowledge layer (govdb-knowledge.ts owns the step)
	migrateKnowledgeLayer(db, uv);
	// v7 — usage analytics (W127): sessions.actor/tags give Copilot-style
	// per-user/license drill-down (actor = user or license id; tags = JSON
	// {team, department, ...}), usage_rollup is the hourly token ledger the
	// board's /api/usage serves: one row per (hour_bucket, actor, model),
	// UPSERT-ADD semantics so harvesters never overwrite — they add. Adds ride
	// the established idempotent pattern (table_info-guarded ALTER, guarded
	// CREATE every open).
	if (!sessCols.includes("actor"))
		db.run("ALTER TABLE sessions ADD COLUMN actor TEXT");
	if (!sessCols.includes("tags"))
		db.run("ALTER TABLE sessions ADD COLUMN tags TEXT");
	db.run(
		"CREATE TABLE IF NOT EXISTS usage_rollup (hour_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model TEXT NOT NULL, model_group TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, actor, model))",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS usage_rollup_actor ON usage_rollup(actor, hour_bucket)",
	);
	if (uv < 7) db.run("PRAGMA user_version = 7");
	// v8 — buckle router governance (W132): the tables the native router's
	// governance layer writes to — W141 virtual keys (api_keys, teams), W136
	// audit rows (route_audit), W137 aid metering (aid_events, aid_rollup),
	// W135 O(1) budgets (budget_state) — declared HERE so the deltas trigger
	// loop (below, after the last CREATE) covers them automatically. The
	// audit trail IS the deltas log: one mechanism, zero per-table wiring.
	// All-new tables, no backfill, so plain guarded CREATEs every open (the
	// idempotent house pattern).
	// api_keys/teams/auth_events are NOT created here anymore — W156 moved the
	// identity plane to identity.db (v17, hooks/lib/identity-db.ts): hub-plane
	// data out of the spoke-plane file. The schemas live in IDENTITY_DDL
	// (single source); token mechanics documentation stays with it there.
	// route_audit (W136 §6): one row per request — INSERTed at dispatch
	// (target already known), UPDATEd in place with the outcome joined by
	// rid; the deltas insert+update trigger pair captures both writes.
	// candidates = ordered top candidate ids (comma-joined); resolved_target
	// = kind:host:port/model; actor + dialect are the W127 /usage join keys
	// the doc pins. Denied requests audit too (belt doctrine, unchanged).
	db.run(
		"CREATE TABLE IF NOT EXISTS route_audit (rid TEXT PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT, dialect TEXT, hint TEXT NOT NULL DEFAULT '', candidates TEXT, resolved_target TEXT, decision TEXT NOT NULL, latency_class TEXT, error_code TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS route_audit_ts ON route_audit(ts, rid)"); // window scans for panels
	// aid_events: one row per aid decision; est_tok_saved stays NULL at
	// event time (W137 honesty rule — savings are A/B-derived at dashboard
	// time, never fabricated per-request). aid_rollup: the W137 §6 SQL
	// verbatim — composite PK (hour_bucket, aid, domain, model_group),
	// UPSERT-ADD semantics so hourly flushers never overwrite, they add.
	// usage_rollup (v7) is reused as-is for token outcomes; the ROI join is
	// aid_events(sid, work_item) ⋈ usage_rollup(actor, hour).
	db.run(
		"CREATE TABLE IF NOT EXISTS aid_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, sid TEXT, work_item TEXT, aid TEXT NOT NULL, packet_id TEXT, tokens_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER)",
	);
	db.run("CREATE INDEX IF NOT EXISTS aid_events_ts ON aid_events(ts)"); // W451: aids window scans + usage ROI join
	db.run(
		"CREATE TABLE IF NOT EXISTS aid_rollup (hour_bucket INTEGER NOT NULL, aid TEXT NOT NULL, domain TEXT NOT NULL, model_group TEXT NOT NULL, injected INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, tok_injected INTEGER NOT NULL DEFAULT 0, est_tok_saved INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hour_bucket, aid, domain, model_group))",
	);
	// budget_state (W135): the O(1) counters' durable half — (key_id, window)
	// rows the router flushes async. Flush = upsert-ADD so a retried batch
	// can never lose counts; window_start moves to the flusher's value so a
	// rolled window restarts the count honestly.
	db.run(
		"CREATE TABLE IF NOT EXISTS budget_state (key_id TEXT NOT NULL, window TEXT NOT NULL, used_rpm INTEGER NOT NULL DEFAULT 0, used_tpm INTEGER NOT NULL DEFAULT 0, window_start INTEGER NOT NULL, PRIMARY KEY (key_id, window))",
	);
	// admin_audit (W174): the who/when trail for admin mutations the deltas
	// log alone cannot attribute — console settings applies, policy edits,
	// key revocations. actor = the human/lane that DROVE the action (the
	// JWT sub on /auth/revoke, the console actor on settings applies).
	db.run(
		"CREATE TABLE IF NOT EXISTS admin_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, detail TEXT)",
	);
	db.run("CREATE INDEX IF NOT EXISTS admin_audit_ts ON admin_audit(ts)");
	if (uv < 8) db.run("PRAGMA user_version = 8");
	// trigger loop after the last CREATE — template lives in govdb-deltas.ts
	createDeltasTriggers(db);
	// v9 — W159 provenance sort: sessions.data_domain carries the W154
	// domain label (hub | private). NULL = nothing routed through yet (never
	// assume); recorded sticky most-restrictive by the routing plane via
	// recordSessionDomain. knowledge.hub_eligible / knowledge_queue.hub_eligible
	// carry the settle's sort (NULL = unsettled; 1 = hub session → the
	// hub-ward feed filters hub only; 0 = private/mixed → local shelf only).
	// Additive columns; pre-W159 rows stay NULL = unsettled, honestly.
	if (uv < 9) {
		const sessCols9 = columnNames(db, "sessions");
		if (!sessCols9.includes("data_domain"))
			db.run("ALTER TABLE sessions ADD COLUMN data_domain TEXT");
		const kqCols9 = columnNames(db, "knowledge_queue");
		if (!kqCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge_queue ADD COLUMN hub_eligible INTEGER");
		const knCols9 = columnNames(db, "knowledge");
		if (!knCols9.includes("hub_eligible"))
			db.run("ALTER TABLE knowledge ADD COLUMN hub_eligible INTEGER");
		db.run("PRAGMA user_version = 9");
	}
	// v10 (W166) — knowledge.db split; see migrateKnowledgeSplit above.
	if (uv < 10) migrateKnowledgeSplit(db);
	// v11 (W243) — the decant-shape activity meter: weekly (week_bucket =
	// Monday-00:00-UTC) token ledger by activity bucket
	// (context|planning|code|communicating), classified by
	// hooks/bin/activity-harvest.ts off the same transcript tail discipline
	// as usage_rollup. UPSERT-ADD semantics: harvesters add, never overwrite.
	// searches = search-class tool_use count (Grep/Glob/WebSearch/ToolSearch/
	// rg-like shell); cost shape (in 1x / cacheC 1.25x / cacheR 0.1x / out 5x)
	// is applied at report time, never stored — pricing moves, history must
	// not. Not in deltaTables: rollup churn is audit noise (usage_rollup
	// precedent).
	db.run(
		"CREATE TABLE IF NOT EXISTS activity_rollup (week_bucket INTEGER NOT NULL, actor TEXT NOT NULL, model_group TEXT NOT NULL, activity TEXT NOT NULL, in_tok INTEGER NOT NULL DEFAULT 0, out_tok INTEGER NOT NULL DEFAULT 0, cache_r INTEGER NOT NULL DEFAULT 0, cache_c INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, searches INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (week_bucket, actor, model_group, activity))",
	);
	db.run(
		"CREATE INDEX IF NOT EXISTS activity_rollup_actor ON activity_rollup(actor, week_bucket)",
	);
	if (uv < 11) db.run("PRAGMA user_version = 11");
	// v12 (W466) — machine cursor keyspace: transcript-tail bookkeeping
	// (activity.tp.*/usage.tp.*/usage.v2.tp.* — one row per transcript file)
	// leaves the knowledge facts table. Cursor rows flooded `coord fact list`
	// and the facts_fts index (openai-review reliability 1 + arch): the facts
	// table is the human/knowledge surface, harvest offsets are machine
	// state. The migration moves every cursor row once; the writers
	// (transcript-cursor.ts, usage-harvest.ts) read/write machine_cursors
	// directly. facts_fts cleans up via its AFTER DELETE trigger.
	db.run(
		"CREATE TABLE IF NOT EXISTS machine_cursors (key TEXT PRIMARY KEY, value TEXT NOT NULL, source TEXT NOT NULL, ts INTEGER NOT NULL)",
	);
	if (uv < 12) {
		const cursorPrefixes = ["activity.tp.", "usage.tp.", "usage.v2.tp."];
		const where = cursorPrefixes.map(() => "key LIKE ?").join(" OR ");
		db.run(
			`INSERT OR IGNORE INTO machine_cursors (key, value, source, ts) SELECT key, value, source, ts FROM facts WHERE ${where}`,
			cursorPrefixes.map((p) => `${p}%`),
		);
		db.run(
			`DELETE FROM facts WHERE ${where}`,
			cursorPrefixes.map((p) => `${p}%`),
		);
		db.run("PRAGMA user_version = 12");
	}
	// v13 (W210) — team entitlement ceilings (the v9→v11-era promise): the
	// W141 buckle teams shape (rpm_ceiling/tpm_ceiling) verbatim + tok_ceiling
	// (the api_keys max_tokens budget at team grain). NULL = no ceiling.
	// Guarded ALTERs heal pre-v13 DBs; on the heal path the teams deltas
	// triggers drop and re-create via the loop above so the audit images
	// carry the ceilings (the audit trail IS the deltas log — an entitlement
	// change is exactly what it must show).
	if (uv < 13) {
		// W156: a fresh post-split DB never holds teams (the v8 CREATEs left
		// with the identity split) — the heal only applies to pre-W210 files
		// that still carry the table. PRAGMA table_info returns [] for a
		// missing table, so the probe doubles as the existence check.
		const teamCols13 = columnNames(db, "teams");
		if (teamCols13.length > 0) {
			let healed = false;
			for (const col of ["rpm_ceiling", "tpm_ceiling", "tok_ceiling"])
				if (!teamCols13.includes(col)) {
					db.run(`ALTER TABLE teams ADD COLUMN ${col} INTEGER`);
					healed = true;
				}
			if (healed) {
				for (const op of ["insert", "update", "delete"] as const)
					db.run(`DROP TRIGGER IF EXISTS deltas_teams_${op}`);
				createDeltasTriggers(db);
			}
		}
		db.run("PRAGMA user_version = 13");
	}
	// W603 v14 — LAST: every `if (uv < N)` block above bumps user_version from
	// the uv captured at open, so a bump made before them gets clobbered on a
	// fresh DB. Payload $.project/$.work shredded to indexed columns here: the
	// per-row json_extract the DuckDB-2.0 finding measured (board 1s poll,
	// timing/token replays) rides columns now.
	migrateEventsShred(db);
	// v15 (W459.5) — identity registry: additive DDL after the shred (nothing
	// order-dependent; the registry mints rows, never rewrites existing ones).
	migrateIdentityRegistry(db);
	// v16 (W266.1 via W276 re-land) — the supervision plane: one row per
	// ensured launchd agent. repo = realpath of the repo's COMMON git dir
	// (the projectIdentity derivation), so any worktree of one repo converges
	// onto the same row; plist records where the rendered agent installed.
	if (uv < 16) {
		db.run(
			"CREATE TABLE IF NOT EXISTS supervisors (label TEXT PRIMARY KEY, repo TEXT NOT NULL, plist TEXT NOT NULL, service TEXT NOT NULL, ts INTEGER NOT NULL)",
		);
		db.run("PRAGMA user_version = 16");
	}
	// v17 (W156 via W359) — identity.db split; see migrateIdentitySplit
	// (identity-db.ts): the v8 identity tables leave governor.db per the
	// federation doc's Identity plane separation (hub-plane data out of the
	// spoke-plane file). LAST, so every step above runs on the pre-split
	// shapes it was written against (the v13 teams heal reads teams).
	if (uv < 17) migrateIdentitySplit(db, REG());
	// v18 — Board request traces: bounded, content-free model/service hops.
	// Work ids are scoped by project, and children inherit the parent trace.
	if (uv < 18) {
		db.run(
			"CREATE TABLE IF NOT EXISTS orchestrate_traces (trace_id TEXT NOT NULL, seq INTEGER NOT NULL, project TEXT NOT NULL, work_id TEXT, at INTEGER NOT NULL, phase TEXT NOT NULL, service TEXT NOT NULL, status TEXT NOT NULL, model TEXT, endpoint TEXT, duration_ms INTEGER, input_tokens INTEGER, output_tokens INTEGER, PRIMARY KEY(trace_id,seq))",
		);
		db.run(
			"CREATE INDEX IF NOT EXISTS orchestrate_traces_work ON orchestrate_traces(project,work_id,at)",
		);
		db.run("PRAGMA user_version = 18");
	}
	// v19 — durable, one-minute work spend histogram. The board refreshes
	// recent buckets from Buckle audit with absolute totals, so repeated polls
	// cannot double-count and older buckets survive board restarts.
	if (uv < 19) {
		db.run(
			"CREATE TABLE IF NOT EXISTS work_spend_histogram (project TEXT NOT NULL, work_id TEXT NOT NULL, bucket_ms INTEGER NOT NULL, fresh INTEGER NOT NULL, cached INTEGER NOT NULL, out_tok INTEGER NOT NULL, PRIMARY KEY(project,work_id,bucket_ms))",
		);
		db.run(
			"CREATE INDEX IF NOT EXISTS work_spend_histogram_bucket ON work_spend_histogram(bucket_ms)",
		);
		db.run("PRAGMA user_version = 19");
	}
	// W953 confidence doctrine: guarded ALTERs heal every open (the additive
	// house pattern — no user_version bump; consults.deadline_at precedent).
	// facts + consult_kb carry confidence REAL (fast filter) + the LATEST
	// stamp JSON (value/setter/ts/evidence/verdict/ref/prior/hash — the
	// provenance record). The append-only confidence_history ledger rides
	// CONFIDENCE_HISTORY_DDL (one source in hooks/lib/confidence.ts) in BOTH
	// this file and knowledge.db — every stamp event lands there, incl. low
	// bands (the 0.4→0.9 upgrade path is the attack vector; the ledger is
	// the audit trail).
	const factsCols = columnNames(db, "facts");
	if (factsCols.length) {
		if (!factsCols.includes("confidence"))
			db.run("ALTER TABLE facts ADD COLUMN confidence REAL");
		if (!factsCols.includes("confidence_stamp"))
			db.run("ALTER TABLE facts ADD COLUMN confidence_stamp TEXT");
		// W1226 fact provenance: trigger/explanation/procedure/verification/
		// source-commit/applicability ride ONE JSON record — evidence kept
		// separate from the value (the interpretation). repo+branch inside the
		// record are session-derived at write time, never a flag.
		if (!factsCols.includes("provenance"))
			db.run("ALTER TABLE facts ADD COLUMN provenance TEXT");
	}
	const ckCols = columnNames(db, "consult_kb");
	if (ckCols.length) {
		if (!ckCols.includes("confidence"))
			db.run("ALTER TABLE consult_kb ADD COLUMN confidence REAL");
		if (!ckCols.includes("confidence_stamp"))
			db.run("ALTER TABLE consult_kb ADD COLUMN confidence_stamp TEXT");
	}
	db.run(CONFIDENCE_HISTORY_DDL);
	db.run(CONFIDENCE_HISTORY_INDEX_DDL);
	migrateJSON(db);
	return db;
}

// JSON registries → SQL, once, idempotently (whoever runs first migrates; the
// second process sees the .migrated rename and skips). INSERT OR REPLACE keeps
// double-import harmless if two gates race before either renames.
function migrateJSON(db: Database): void {
	const CJ = `${REG()}/claims.json`;
	if (existsSync(CJ)) {
		try {
			const legacy = JSON.parse(readFileSync(CJ, "utf8")) as Record<
				string,
				{
					sid?: string;
					scopes?: string[];
					intent?: string;
					ts?: number;
					tp?: string;
					hot?: boolean;
				}
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO claims (sid, scope, intent, hot, ts, tp) VALUES (?, ?, ?, ?, ?, ?)",
			);
			for (const [cid, c] of Object.entries(legacy)) {
				for (const s of c?.scopes ?? [])
					ins.run(
						c?.sid ?? cid,
						s,
						c?.intent ?? null,
						c?.hot ? 1 : 0,
						c?.ts ?? Date.now(),
						c?.tp ?? null,
					);
			}
			renameSync(CJ, `${CJ}.migrated`);
		} catch {}
	}
	const LJ = `${REG()}/locks.json`;
	if (existsSync(LJ)) {
		try {
			const locks = JSON.parse(readFileSync(LJ, "utf8")) as Record<
				string,
				{
					sid: string;
					tool?: string;
					ts: number;
					tp?: string;
					hash?: string;
					seen?: string[];
				}
			>;
			const ins = db.query(
				"INSERT OR REPLACE INTO locks (path, sid, tool, ts, tp, hash, seen) VALUES (?, ?, ?, ?, ?, ?, ?)",
			);
			for (const [p, l] of Object.entries(locks)) {
				ins.run(
					p,
					l.sid,
					l.tool ?? null,
					l.ts ?? 0,
					l.tp ?? null,
					l.hash ?? null,
					l.seen ? JSON.stringify(l.seen) : null,
				);
			}
			renameSync(LJ, `${LJ}.migrated`);
		} catch {}
	}
}
