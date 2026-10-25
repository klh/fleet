// hooks/coord/identity.ts — W459.5 enrollment-pilot verbs: coord project
// enroll|bind|verify (docs/identity-enrollment-pilot.md). Fail-closed by
// construction: a refused flow writes NO registry row, NO binding file and
// NO event — a failed resolution must never leave anything masquerading as
// the managed project. identity.* events are emitted only for things that
// actually happened (enrolled, binding_set, writes_enabled flips, gate
// denials); the audit trail is the store's, not a side log.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveProject, resolveStoreHttpBase } from "../lib/govdb/govdb.ts";
import {
	bindCheckout,
	enrollRegistry,
	ensureExecutorId,
	githubResolver,
	lookupCheckout,
	lookupProject,
	lookupRegisteredSource,
	parseRepoRef,
	readBinding,
	setWritesEnabled,
	writeBinding,
	writesEnabled,
	type IdentityBinding,
	type ProviderRepoInfo,
	type ProviderResolver,
} from "../lib/govdb/identity-registry.ts";
import { arg, db, die, dim, green } from "./shared.ts";

const msg = (e: unknown): string =>
	e instanceof Error ? e.message : String(e);

const defaultResolver = (): ProviderResolver =>
	githubResolver(process.env.GITHUB_TOKEN ?? null);

// stage 3 speaks one provider; the committed hint names it and anything else
// refuses. A hint supplies a CANDIDATE, never membership.
const readHint = (): string | null => {
	const p = resolve(process.cwd(), ".klh", "repo-hint.json");
	if (!existsSync(p)) return null;
	try {
		const j = JSON.parse(readFileSync(p, "utf8")) as {
			provider?: unknown;
			repo?: unknown;
		};
		if (typeof j.repo !== "string" || !j.repo) return null;
		if (j.provider !== undefined && j.provider !== "github") return null;
		return j.repo;
	} catch {
		return null;
	}
};

const registryRow = (
	provider: string,
	providerRepoId: number,
): ReturnType<typeof lookupRegisteredSource> => {
	try {
		return lookupRegisteredSource(db, provider, providerRepoId);
	} catch (e) {
		die(
			`registry unreadable (${msg(e)}) — the authority store may predate the stage-3 registry (restart store-server)`,
		);
	}
};

// the one fail-closed resolution every verb shares: parse the locator,
// resolve the numeric provider id, refuse forks outright
async function resolveVerified(
	repoRef: string,
	resolveProvider: ProviderResolver,
	verb: string,
): Promise<ProviderRepoInfo> {
	let slug: string;
	try {
		slug = parseRepoRef(repoRef);
	} catch (e) {
		die(`${verb} refused: ${msg(e)}`);
	}
	let info: ProviderRepoInfo;
	try {
		info = await resolveProvider(slug);
	} catch (e) {
		die(`${verb} refused: ${msg(e)}`);
	}
	if (info.fork)
		die(
			`${verb} refused: ${slug} is a fork${info.parent ? ` of ${info.parent}` : ""} — forks never inherit enrollment`,
		);
	return info;
}

// coord project enroll — G1 mint (operator, on the authority) and the G5
// writes flip (the stage's ONE control). Mint is idempotent per source:
// re-running returns the SAME project_id, never a second mint.
export async function cmdEnroll(
	rest: string[],
	resolveProvider: ProviderResolver = defaultResolver(),
): Promise<void> {
	const source = arg("--as") ?? "enrollment";
	const enable = rest.includes("--enable-writes");
	const disable = rest.includes("--disable-writes");
	if (enable || disable) {
		const tenant = arg("--tenant");
		if (!tenant)
			die(
				"usage: coord project enroll --enable-writes|--disable-writes --tenant <name> (--project <prj_…> | --repo <url|owner/name>)",
			);
		let projectId = arg("--project");
		if (!projectId) {
			const repoRef = arg("--repo");
			if (!repoRef)
				die(
					"the writes flip needs --project <prj_…> or --repo <url|owner/name>",
				);
			const info = await resolveVerified(repoRef, resolveProvider, "enroll");
			const row = registryRow("github", info.id);
			if (!row)
				die(
					`enroll refused: ${info.fullName} (github id ${info.id}) is not enrolled`,
				);
			projectId = row.project_id;
		}
		let proj: ReturnType<typeof lookupProject>;
		try {
			proj = lookupProject(db, projectId);
		} catch (e) {
			die(
				`registry unreadable (${msg(e)}) — the authority store may predate the stage-3 registry (restart store-server)`,
			);
		}
		if (!proj) die(`enroll refused: unknown enrolled project ${projectId}`);
		if (proj.tenant_name !== tenant)
			die(
				`enroll refused: ${projectId} belongs to tenant '${proj.tenant_name}', not '${tenant}'`,
			);
		let changed: boolean;
		try {
			changed = setWritesEnabled(db, projectId, enable, source);
		} catch (e) {
			die(`enroll refused: ${msg(e)}`);
		}
		if (changed)
			console.log(
				green(
					`✓ writes_enabled=${enable ? 1 : 0} for ${projectId} (authority_epoch unchanged)`,
				),
			);
		else
			console.log(
				`${projectId} already writes_enabled=${enable ? 1 : 0} — no change, no event`,
			);
		return;
	}
	const tenant = arg("--tenant");
	const repoRef = arg("--repo");
	if (!tenant || !repoRef)
		die(
			"usage: coord project enroll --tenant <name> --repo <url|owner/name> --display <name> [--authority <url>]\n       coord project enroll --enable-writes --tenant <name> (--project <prj_…> | --repo <url|owner/name>)",
		);
	const info = await resolveVerified(repoRef, resolveProvider, "enroll");
	let r: ReturnType<typeof enrollRegistry>;
	try {
		r = enrollRegistry(db, {
			tenant,
			provider: "github",
			providerRepoId: info.id,
			canonicalUrl: `https://github.com/${info.fullName}`,
			displayName: arg("--display") ?? tenant,
			authorityUrl: arg("--authority"),
			source,
		});
	} catch (e) {
		die(`enroll refused: ${msg(e)}`);
	}
	if (r.created)
		console.log(
			green(
				`✓ enrolled tenant=${r.tenantId} project=${r.projectId} repository=${r.repositoryId}`,
			),
		);
	else
		console.log(
			`${green("✓")} already enrolled — same project ${r.projectId} (idempotent, no second mint)`,
		);
	console.log(
		dim(
			`  github id=${info.id} canonical=${info.fullName}  writes_enabled=0 (the G5 flip opens it)`,
		),
	);
}

// coord project bind — G2/G3: authenticate (the store binding), read the
// hint (or --repo), verify hint vs provider API vs registry, then record the
// id_checkouts row + the 0600 binding file. Binding is verified READ-ONLY
// access — it NEVER touches writes_enabled.
export async function cmdBind(
	_rest: string[],
	resolveProvider: ProviderResolver = defaultResolver(),
): Promise<void> {
	const tenantFilter = arg("--tenant");
	const repoRef = arg("--repo") ?? readHint();
	if (!repoRef)
		die(
			"bind refused: no .klh/repo-hint.json in this checkout and no --repo — a candidate source is required (fail-closed)",
		);
	const info = await resolveVerified(repoRef, resolveProvider, "bind");
	const row = registryRow("github", info.id);
	if (!row)
		die(
			`bind refused: ${info.fullName} (github id ${info.id}) is not enrolled — coord project enroll runs on the authority first`,
		);
	if (tenantFilter && row.tenant_name !== tenantFilter)
		die(
			`bind refused: ${info.fullName} is enrolled to tenant '${row.tenant_name}', not '${tenantFilter}'`,
		);
	const proj = resolveProject();
	const executorId = ensureExecutorId();
	let checkout: ReturnType<typeof bindCheckout>;
	try {
		checkout = bindCheckout(db, {
			repositoryId: row.repository_id,
			projectId: row.project_id,
			tenantId: row.tenant_id,
			executorId,
			commonGitDir: proj.commonDir,
		});
	} catch (e) {
		die(`bind refused: ${msg(e)}`);
	}
	const binding: IdentityBinding = {
		schema: 1,
		tenant_id: row.tenant_id,
		project_id: row.project_id,
		repository_id: row.repository_id,
		executor_id: executorId,
		checkout_id: checkout.checkoutId,
		authority: {
			url: row.authority_url ?? resolveStoreHttpBase()?.base ?? "local",
			epoch: row.authority_epoch,
		},
		local: {
			repo_root: proj.root,
			common_git_dir: proj.commonDir,
			resolved_at: Date.now(),
		},
		verified: {
			provider: "github",
			provider_repo_id: info.id,
			verified_at: Date.now(),
			verified_by: "enrollment-v1",
		},
	};
	writeBinding(binding);
	console.log(green(`✓ bound ${checkout.checkoutId} → ${row.project_id}`));
	console.log(
		dim(
			`  project=${row.project_id} tenant=${row.tenant_name} repository=${row.repository_id}`,
		),
	);
	console.log(dim(`  executor=${executorId} common_dir=${proj.commonDir}`));
	console.log(
		dim(
			`  writes=${row.writes_enabled ? "enabled" : "disabled"} — binding is verified READ-ONLY access; the operator flips G5`,
		),
	);
}

// coord project verify — G4's read-only proof: identical project_id across
// clones, distinct checkout/executor bindings. Reads the binding file and
// re-checks it against the registry and (unless --cached) the provider API;
// writes nothing anywhere.
export async function cmdVerify(
	rest: string[],
	resolveProvider: ProviderResolver = defaultResolver(),
): Promise<void> {
	const b = readBinding();
	if (!b)
		die(
			"verify refused: no binding on this machine — coord project bind runs first",
		);
	const proj = resolveProject();
	if (proj.commonDir !== b.local.common_git_dir)
		die(
			`verify refused: this checkout's common dir (${proj.commonDir}) is not the bound one (${b.local.common_git_dir})`,
		);
	const row = registryRow(b.verified.provider, b.verified.provider_repo_id);
	if (!row)
		die(
			"verify refused: the binding's repository row is gone from the registry",
		);
	if (row.project_id !== b.project_id || row.tenant_id !== b.tenant_id)
		die("verify refused: registry project/tenant no longer match the binding");
	let checkout: ReturnType<typeof lookupCheckout>;
	try {
		checkout = lookupCheckout(db, b.checkout_id);
	} catch (e) {
		die(
			`registry unreadable (${msg(e)}) — the authority store may predate the stage-3 registry (restart store-server)`,
		);
	}
	if (
		!checkout ||
		checkout.common_git_dir !== b.local.common_git_dir ||
		checkout.executor_id !== b.executor_id
	)
		die("verify refused: checkout row no longer matches the binding");
	const cached = rest.includes("--cached");
	let providerChecked = false;
	if (!cached && row.canonical_url) {
		try {
			const slug = parseRepoRef(row.canonical_url);
			const info = await resolveProvider(slug);
			providerChecked = true;
			if (info.id !== b.verified.provider_repo_id)
				die(
					"verify refused: the provider now reports a different source id — re-bind",
				);
		} catch (e) {
			die(`verify refused: provider re-check failed: ${msg(e)}`);
		}
	}
	const writes = writesEnabled(db, b.project_id);
	if (rest.includes("--json")) {
		console.log(
			JSON.stringify(
				{ ...b, writes_enabled: writes, provider_checked: providerChecked },
				null,
				"\t",
			),
		);
		return;
	}
	console.log(
		`project_id=${b.project_id}  checkout=${b.checkout_id}  executor=${b.executor_id}  common_dir=${b.local.common_git_dir}  writes=${writes === null ? "unknown" : writes ? "enabled" : "disabled"}`,
	);
}
