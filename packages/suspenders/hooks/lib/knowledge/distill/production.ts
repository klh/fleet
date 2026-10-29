// distill/production.ts — the hub wiring: knowledge.db, the governor (idle
// signals + the bus), Kev, the knowledge store, decant (read-only), the
// buckle/specialist clients. Tests never come here — they build DistillDeps
// from scratch dbs and serveStub upstreams.
import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
	type GovernorStore,
	openKnowledgeDb,
	openStore,
} from "../../govdb/govdb.ts";
import { suggestKnowledge } from "../kev-curation.ts";
import { SqliteKnowledgeStore } from "../sqlite-store.ts";
import { type DistillClients, productionClients } from "./clients.ts";
import { distillSettings, type LoadedDistillConfig } from "./config.ts";
import { openDecant } from "./decant.ts";
import { productionSignals } from "./idle.ts";
import type { DistillDeps } from "./runner.ts";
import { storeSink } from "./sink.ts";

export interface ProductionHandles {
	loaded: LoadedDistillConfig;
	kb: Database;
	decant: Database | null;
	pausePath: string;
	/** build the full run deps (resolves the buckle route — may throw) */
	deps(): DistillDeps;
	close(): void;
}

export function productionHandles(): ProductionHandles {
	const loaded = distillSettings();
	const cfg = loaded.config;
	const kb = openKnowledgeDb();
	const decant = openDecant(cfg.decant_db);
	const pausePath = resolve(cfg.pause_file);
	let gov: GovernorStore | null = null;
	const governor = (): GovernorStore => {
		gov ??= openStore();
		return gov;
	};
	let clients: DistillClients | null = null;
	return {
		loaded,
		kb,
		decant,
		pausePath,
		deps: () => {
			clients ??= productionClients(cfg);
			return {
				db: kb,
				cfg: loaded.issue ? { ...cfg, enabled: false } : cfg,
				clients,
				sink: storeSink(kb, new SqliteKnowledgeStore(kb), suggestKnowledge),
				decant,
				signals: productionSignals(cfg, governor),
				emit: (kind, payload) => {
					governor()
						.query(
							"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, 'knowledge-distill', ?, 'knowledge', ?, NULL)",
						)
						.run(Date.now(), kind, JSON.stringify(payload));
				},
				logPath:
					cfg.log_path ??
					join(homedir(), ".cache/claude-governor/distill-runs.jsonl"),
				pausePath,
				nonce: crypto.randomUUID(),
			};
		},
		close: () => {
			decant?.close();
			kb.close();
			gov?.close();
		},
	};
}
