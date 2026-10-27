// hooks/lib/govdb/identity-registry.ts — W459.5 identity stage 3
// (docs/identity-enrollment-pilot.md): the managed-project REGISTRY in the
// authority store — id_tenants / id_projects / id_repositories / id_checkouts
// — plus the fail-closed enrollment helpers and the local binding writer.
// IDs are opaque `<prefix>_<UUIDv4>`, minted ONCE on the authority inside one
// registry transaction, never derived from paths, URLs or display names;
// locator changes (SSH/HTTPS re-spells, mirrors, transfers) are interpreted
// by the registry, never identity events. Stage 3 migrates no graph rows:
// legacy local-keyed graphs keep running untouched, and every minted project
// starts writes_enabled=0 — the gate is the stage's central control and only
// the operator flips it (G5) after the verification gates pass.
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";

// structural twin of GovernorStore (govdb.ts) so this module carries NO
// runtime import of govdb (govdb imports the migration below — a value import
// here would close a cycle). bun:sqlite's Database satisfies it.
export interface RegistryStore {
	query(sql: string): {
		get(...params: unknown[]): unknown;
		all(...params: unknown[]): unknown[];
	};
	run(sql: string, ...params: unknown[]): unknown;
	transaction<T>(fn: () => T): () => T;
}

export const ID_SCHEMA_VERSION = 15;

// v15 (W459.5) — the identity registry, additive DDL in one transaction.
// DDL runs EVERY open (IF NOT EXISTS, v11 activity_rollup pattern) so a
// restored pre-v15 backup self-heals; only the version bump is guarded.
// id_repositories carries tenant_id (the doc's partial index
// (tenant_id, provider, provider_repo_id) demands the column) so a source
// enrolled to one tenant can never mint a second project under another.
export function migrateIdentityRegistry(db: RegistryStore): void {
	const uv = (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
	db.run("BEGIN IMMEDIATE");
	try {
		db.run(
			"CREATE TABLE IF NOT EXISTS id_tenants (tenant_id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL)",
		);
		db.run(
			"CREATE TABLE IF NOT EXISTS id_projects (project_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES id_tenants(tenant_id), display_name TEXT NOT NULL, authority_epoch INTEGER NOT NULL DEFAULT 1, authority_url TEXT, writes_enabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)",
		);
		db.run(
			"CREATE TABLE IF NOT EXISTS id_repositories (repository_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES id_projects(project_id), tenant_id TEXT NOT NULL REFERENCES id_tenants(tenant_id), provider TEXT NOT NULL, provider_repo_id INTEGER NOT NULL, canonical_url TEXT, created_at INTEGER NOT NULL, UNIQUE (provider, provider_repo_id))",
		);
		db.run(
			"CREATE TABLE IF NOT EXISTS id_checkouts (checkout_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL REFERENCES id_repositories(repository_id), project_id TEXT NOT NULL REFERENCES id_projects(project_id), tenant_id TEXT NOT NULL REFERENCES id_tenants(tenant_id), executor_id TEXT NOT NULL, common_git_dir TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (repository_id, common_git_dir))",
		);
		db.run(
			"CREATE UNIQUE INDEX IF NOT EXISTS id_repositories_tenant_source ON id_repositories (tenant_id, provider, provider_repo_id) WHERE provider_repo_id IS NOT NULL",
		);
		db.run(
			"CREATE INDEX IF NOT EXISTS id_projects_tenant ON id_projects (tenant_id)",
		);
		db.run(
			"CREATE INDEX IF NOT EXISTS id_checkouts_project ON id_checkouts (project_id)",
		);
		if (uv < ID_SCHEMA_VERSION)
			db.run(`PRAGMA user_version = ${ID_SCHEMA_VERSION}`);
		db.run("PRAGMA foreign_keys=ON");
		db.run("COMMIT");
	} catch (e) {
		try {
			db.run("PRAGMA foreign_keys=ON");
			db.run("ROLLBACK");
		} catch {}
		throw e instanceof Error
			? new Error(`identity registry migration (v15) failed: ${e.message}`, {
					cause: e,
				})
			: e;
	}
}

// ─── events — the audit trail is the store's, not a side log ────────────────
// Same wire shape as coord emit (bus.ts): the events table with the shred
// trigger free to extract nothing (identity events carry project_id, not
// $.project — they do not belong to any local graph partition).
function insertEvent(
	db: RegistryStore,
	kind: string,
	scope: string | null,
	payload: Record<string, unknown>,
): void {
	db.run(
		"INSERT INTO events (ts, source, kind, scope, payload, target) VALUES (?, ?, ?, ?, ?, ?)",
		Date.now(),
		"enrollment",
		kind,
		scope,
		JSON.stringify(payload),
		null,
	);
}

export const mintId = (prefix: string): string =>
	`${prefix}_${crypto.randomUUID()}`;

// ─── enrollment (G1): one transaction on the authority ──────────────────────
// Minted once per enrolled source: the (tenant, provider, provider_repo_id)
// uniqueness refuses a second id_repositories row and the existing
// project_id is returned instead. A different tenant for the same source
// REFUSES (one repo = one project, ever).
export interface EnrollOpts {
	tenant: string;
	provider: string;
	providerRepoId: number;
	canonicalUrl: string | null;
	displayName: string;
	authorityUrl: string | null;
	source: string;
	now?: number;
}

export interface EnrollResult {
	tenantId: string;
	projectId: string;
	repositoryId: string;
	writesEnabled: boolean;
	created: boolean;
}

export function enrollRegistry(db: RegistryStore, o: EnrollOpts): EnrollResult {
	const now = o.now ?? Date.now();
	return db.transaction(() => {
		let tenantId = (
			db
				.query("SELECT tenant_id FROM id_tenants WHERE name = ?")
				.get(o.tenant) as { tenant_id: string } | null
		)?.tenant_id;
		if (!tenantId) {
			tenantId = mintId("tnt");
			db.run(
				"INSERT INTO id_tenants (tenant_id, name, created_at) VALUES (?, ?, ?)",
				tenantId,
				o.tenant,
				now,
			);
		}
		const existing = db
			.query(
				"SELECT repository_id, project_id, tenant_id FROM id_repositories WHERE provider = ? AND provider_repo_id = ?",
			)
			.get(o.provider, o.providerRepoId) as {
			repository_id: string;
			project_id: string;
			tenant_id: string;
		} | null;
		if (existing) {
			if (existing.tenant_id !== tenantId)
				throw new Error(
					`${o.provider} source ${o.providerRepoId} is already enrolled to a different tenant — one repo = one project, ever`,
				);
			return {
				tenantId,
				projectId: existing.project_id,
				repositoryId: existing.repository_id,
				writesEnabled:
					(
						db
							.query(
								"SELECT writes_enabled FROM id_projects WHERE project_id = ?",
							)
							.get(existing.project_id) as {
							writes_enabled: number;
						} | null
					)?.writes_enabled === 1,
				created: false,
			};
		}
		const projectId = mintId("prj");
		db.run(
			"INSERT INTO id_projects (project_id, tenant_id, display_name, authority_epoch, authority_url, writes_enabled, created_at) VALUES (?, ?, ?, 1, ?, 0, ?)",
			projectId,
			tenantId,
			o.displayName,
			o.authorityUrl,
			now,
		);
		const repositoryId = mintId("rep");
		db.run(
			"INSERT INTO id_repositories (repository_id, project_id, tenant_id, provider, provider_repo_id, canonical_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			repositoryId,
			projectId,
			tenantId,
			o.provider,
			o.providerRepoId,
			o.canonicalUrl,
			now,
		);
		insertEvent(db, "identity.enrolled", projectId, {
			tenant_id: tenantId,
			project_id: projectId,
			repository_id: repositoryId,
			provider: o.provider,
			provider_repo_id: o.providerRepoId,
			canonical_url: o.canonicalUrl,
			display_name: o.displayName,
		});
		return {
			tenantId,
			projectId,
			repositoryId,
			writesEnabled: false,
			created: true,
		};
	})();
}

// ─── registry reads ──────────────────────────────────────────────────────────
export interface RegisteredSource {
	repository_id: string;
	project_id: string;
	tenant_id: string;
	provider: string;
	provider_repo_id: number;
	canonical_url: string | null;
	display_name: string;
	tenant_name: string;
	authority_epoch: number;
	authority_url: string | null;
	writes_enabled: number;
}

export function lookupRegisteredSource(
	db: RegistryStore,
	provider: string,
	providerRepoId: number,
): RegisteredSource | null {
	return (
		(db
			.query(
				"SELECT r.repository_id, r.project_id, r.tenant_id, r.provider, r.provider_repo_id, r.canonical_url, p.display_name, t.name AS tenant_name, p.authority_epoch, p.authority_url, p.writes_enabled FROM id_repositories r JOIN id_projects p ON p.project_id = r.project_id JOIN id_tenants t ON t.tenant_id = r.tenant_id WHERE r.provider = ? AND r.provider_repo_id = ?",
			)
			.get(provider, providerRepoId) as RegisteredSource | null) ?? null
	);
}

export function lookupProject(
	db: RegistryStore,
	projectId: string,
): {
	project_id: string;
	tenant_id: string;
	tenant_name: string;
	display_name: string;
	writes_enabled: number;
	authority_epoch: number;
	authority_url: string | null;
} | null {
	return (
		(db
			.query(
				"SELECT p.project_id, p.tenant_id, t.name AS tenant_name, p.display_name, p.writes_enabled, p.authority_epoch, p.authority_url FROM id_projects p JOIN id_tenants t ON t.tenant_id = p.tenant_id WHERE p.project_id = ?",
			)
			.get(projectId) as {
			project_id: string;
			tenant_id: string;
			tenant_name: string;
			display_name: string;
			writes_enabled: number;
			authority_epoch: number;
			authority_url: string | null;
		} | null) ?? null
	);
}

// ─── checkout binding (G2/G3): verified read-only access ────────────────────
// One id_checkouts row per (repository, common git dir) — linked worktrees
// share the checkout's common dir, so they resolve to the SAME chk_ (G4);
// re-binding an already-bound checkout returns the same id, never a second
// row. write ENABLEMENT is a separate, later flip (G5) — binding never
// touches writes_enabled.
export function bindCheckout(
	db: RegistryStore,
	o: {
		repositoryId: string;
		projectId: string;
		tenantId: string;
		executorId: string;
		commonGitDir: string;
	},
): { checkoutId: string; created: boolean } {
	return db.transaction(() => {
		const existing = db
			.query(
				"SELECT checkout_id FROM id_checkouts WHERE repository_id = ? AND common_git_dir = ?",
			)
			.get(o.repositoryId, o.commonGitDir) as { checkout_id: string } | null;
		if (existing) return { checkoutId: existing.checkout_id, created: false };
		const checkoutId = mintId("chk");
		db.run(
			"INSERT INTO id_checkouts (checkout_id, repository_id, project_id, tenant_id, executor_id, common_git_dir, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
			checkoutId,
			o.repositoryId,
			o.projectId,
			o.tenantId,
			o.executorId,
			o.commonGitDir,
			Date.now(),
		);
		insertEvent(db, "identity.binding_set", o.projectId, {
			checkout_id: checkoutId,
			executor_id: o.executorId,
			repository_id: o.repositoryId,
			project_id: o.projectId,
			common_git_dir: o.commonGitDir,
		});
		return { checkoutId, created: true };
	})();
}

export function lookupCheckout(
	db: RegistryStore,
	checkoutId: string,
): {
	checkout_id: string;
	repository_id: string;
	project_id: string;
	tenant_id: string;
	executor_id: string;
	common_git_dir: string;
} | null {
	return (
		(db
			.query(
				"SELECT checkout_id, repository_id, project_id, tenant_id, executor_id, common_git_dir FROM id_checkouts WHERE checkout_id = ?",
			)
			.get(checkoutId) as {
			checkout_id: string;
			repository_id: string;
			project_id: string;
			tenant_id: string;
			executor_id: string;
			common_git_dir: string;
		} | null) ?? null
	);
}

// ─── the writes_enabled gate (G5) ────────────────────────────────────────────
// null = unknown project; the flip is idempotent-safe (no change = no event,
// so G5's "one event row" holds per actual flip) and never moves the epoch.
export function setWritesEnabled(
	db: RegistryStore,
	projectId: string,
	enabled: boolean,
	source: string,
): boolean {
	return db.transaction(() => {
		const p = db
			.query(
				"SELECT writes_enabled, authority_epoch FROM id_projects WHERE project_id = ?",
			)
			.get(projectId) as {
			writes_enabled: number;
			authority_epoch: number;
		} | null;
		if (!p) throw new Error(`unknown enrolled project ${projectId}`);
		if ((p.writes_enabled === 1) === enabled) return false;
		db.run(
			"UPDATE id_projects SET writes_enabled = ? WHERE project_id = ?",
			enabled ? 1 : 0,
			projectId,
		);
		insertEvent(db, "identity.writes_enabled", projectId, {
			project_id: projectId,
			enabled,
			authority_epoch: p.authority_epoch,
			source,
		});
		return true;
	})();
}

export function writesEnabled(
	db: RegistryStore,
	projectId: string,
): boolean | null {
	const r = db
		.query("SELECT writes_enabled FROM id_projects WHERE project_id = ?")
		.get(projectId) as { writes_enabled: number } | null;
	return r ? r.writes_enabled === 1 : null;
}

// the gate managed writers call (stage 4 consumes this from work.ts): a
// denial emits identity.denied to the store's audit trail BEFORE throwing —
// the refusal itself is fleet-visible evidence.
export function assertWritesEnabled(
	db: RegistryStore,
	projectId: string,
): void {
	const state = writesEnabled(db, projectId);
	if (state === null) throw new Error(`unknown enrolled project ${projectId}`);
	if (!state) {
		insertEvent(db, "identity.denied", projectId, {
			project_id: projectId,
			reason: "writes_disabled",
		});
		throw new Error(
			`writes are DISABLED for ${projectId} — the operator flips it: coord project enroll --enable-writes --tenant <tenant> --project ${projectId}`,
		);
	}
}

// ─── provider source resolution (GitHub) ─────────────────────────────────────
export interface ProviderRepoInfo {
	id: number;
	fullName: string;
	fork: boolean;
	parent: string | null;
}

export type ProviderResolver = (slug: string) => Promise<ProviderRepoInfo>;

export function githubResolver(token: string | null): ProviderResolver {
	return async (slug) => {
		const headers: Record<string, string> = {
			"user-agent": "klh-fleet-enrollment",
			accept: "application/vnd.github+json",
		};
		if (token) headers.authorization = `Bearer ${token}`;
		const res = await fetch(`https://api.github.com/repos/${slug}`, {
			headers,
		});
		if (!res.ok)
			throw new Error(
				`github ${res.status} for ${slug} — source identity unverifiable (fail-closed)`,
			);
		const j = (await res.json()) as {
			id: number;
			full_name: string;
			fork: boolean;
			parent?: { full_name: string } | null;
		};
		return {
			id: j.id,
			fullName: j.full_name,
			fork: !!j.fork,
			parent: j.parent?.full_name ?? null,
		};
	};
}

// locator → owner/name slug. URL/ssh/mirror spellings are locators; the
// numeric provider id (resolved server-side) is what the registry keys on.
export function parseRepoRef(ref: string): string {
	const t = ref
		.trim()
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
	const m =
		/^https?:\/\/[^/]+\/(.+)$/.exec(t) ?? // https://host/owner/name
		/^git@[^:]+:(.+)$/.exec(t) ?? // git@host:owner/name
		/^ssh:\/\/[^/]+\/(.+)$/.exec(t); // ssh://host/owner/name
	const slug = m?.[1] ?? t;
	if (!/^[^/\s]+\/[^/\s]+$/.test(slug))
		throw new Error(`cannot parse repository reference: ${ref}`);
	return slug;
}

// ─── local binding + executor identity (machine config, never the repo) ─────
// Real paths live under the machine's HOME; the binding file is mode 600 and
// its committed sibling (.klh/repo-hint.json) supplies a CANDIDATE, never
// membership — enrollment always authenticates and verifies first.
export function identityConfigDir(): string {
	const home = process.env.HOME;
	if (!home) throw new Error("HOME unset — cannot resolve identity config dir");
	return `${home}/.config/klh/identity`;
}

export const bindingPath = (): string => `${identityConfigDir()}/binding.json`;
export const executorIdPath = (): string =>
	`${identityConfigDir()}/executor.json`;

export interface IdentityBinding {
	schema: 1;
	tenant_id: string;
	project_id: string;
	repository_id: string;
	executor_id: string;
	checkout_id: string;
	authority: { url: string; epoch: number };
	local: { repo_root: string; common_git_dir: string; resolved_at: number };
	verified: {
		provider: string;
		provider_repo_id: number;
		verified_at: number;
		verified_by: string;
	};
}

// minted once per machine, 0600, never re-derived: exe_ survives re-clones
export function ensureExecutorId(): string {
	mkdirSync(identityConfigDir(), { recursive: true });
	const p = executorIdPath();
	if (existsSync(p)) {
		try {
			const j = JSON.parse(readFileSync(p, "utf8")) as {
				executor_id?: unknown;
			};
			if (typeof j.executor_id === "string" && j.executor_id.startsWith("exe_"))
				return j.executor_id;
		} catch {}
	}
	const id = mintId("exe");
	writeFileSync(
		p,
		`${JSON.stringify({ schema: 1, executor_id: id, created_at: Date.now() })}\n`,
		{ mode: 0o600 },
	);
	chmodSync(p, 0o600);
	return id;
}

export function readBinding(): IdentityBinding | null {
	try {
		const p = bindingPath();
		if (!existsSync(p)) return null;
		const stat = statSync(p);
		if (!stat.isFile() || stat.size > 4096) return null;
		const j = JSON.parse(readFileSync(p, "utf8")) as IdentityBinding;
		return j.schema === 1 && typeof j.project_id === "string" ? j : null;
	} catch {
		return null;
	}
}

export function writeBinding(b: IdentityBinding): void {
	mkdirSync(identityConfigDir(), { recursive: true });
	const p = bindingPath();
	writeFileSync(p, `${JSON.stringify(b, null, "\t")}\n`, { mode: 0o600 });
	chmodSync(p, 0o600);
}
