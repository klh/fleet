// hooks/lib/doctor.ts — W842 clean-machine onboarding doctor. Pure checks +
// live smoke helpers; the bin door (hooks/bin/doctor.ts) owns argv and exit
// codes. Checks verify the supported onboarding components from their FINAL
// locations: bun, agent CLIs, gateway credentials, scoped keys, repository
// rules, project identity. Machine conf is read at runtime (config-over-code)
// — values never printed, only presence/shape.
import { existsSync, readFileSync } from "node:fs";

export type CheckStatus = "pass" | "warn" | "fail";

export type CheckResult = {
	id: string;
	label: string;
	status: CheckStatus;
	detail: string;
};

export type SpawnResult = { code: number; out: string };

export type DoctorContext = {
	/** target repo whose rules + identity are verified */
	repo: string;
	/** HOME used to resolve machine conf (~/.claude/local-llm, ~/.config/klh) */
	home: string;
	/** import.meta.path of the running doctor (run-origin check) */
	modulePath: string;
	/** installed work.ts used for the identity smoke */
	workBin: string;
	/** spawn door (injectable for tests) */
	run: (argv: string[]) => SpawnResult;
};

export const checkStatusRank: Record<CheckStatus, number> = {
	pass: 0,
	warn: 1,
	fail: 2,
};

export const worstStatus = (
	results: { status: CheckStatus }[],
): CheckStatus => {
	let worst: CheckStatus = "pass";
	for (const r of results)
		if (checkStatusRank[r.status] > checkStatusRank[worst])
			worst = r.status;
	return worst;
};

const filePresent = (p: string): boolean => {
	try {
		return existsSync(p);
	} catch {
		return false;
	}
};

// Presence/shape of gateway credentials — NAMES only, never values. belt.env
// is the Mac spoke conf (upstream keys + BUCKLE_ADMIN_KEY); buckle-spoke.env
// holds the gate root key. Hubs carry their own env files, so a missing spoke
// root key degrades to warn.
export const beltEnvPath = (home: string): string =>
	`${home}/.claude/local-llm/belt.env`;

export const spokeEnvPath = (home: string): string =>
	`${home}/.claude/local-llm/buckle-spoke.env`;

/** extract the VALUE of NAME= from dotenv-style text — never logged */
export const readEnvValue = (text: string, name: string): string | null => {
	for (const line of text.split("\n")) {
		const m = line.match(new RegExp(`^${name}=(.*)$`));
		if (m) return m[1].trim();
	}
	return null;
};

export const readAdminKey = (beltEnv: string): string | null => {
	if (!filePresent(beltEnv)) return null;
	try {
		return readEnvValue(readFileSync(beltEnv, "utf8"), "BUCKLE_ADMIN_KEY");
	} catch {
		return null;
	}
};

export const checkBun = (ctx: DoctorContext): CheckResult => {
	const version = typeof Bun !== "undefined" ? Bun.version : null;
	const major = version ? Number(version.split(".")[0]) : 0;
	return {
		id: "bun-runtime",
		label: "bun runtime",
		status: major >= 1 ? "pass" : "fail",
		detail: version ? `bun ${version}` : "bun version unreadable",
	};
};

const AGENT_CLIS = ["claude", "codex", "copilot"];

export const checkAgentClis = (ctx: DoctorContext): CheckResult => {
	const found = AGENT_CLIS.filter((c) => Bun.which(c) !== null);
	return {
		id: "agent-cli",
		label: "agent CLI on PATH",
		status: found.length > 0 ? "pass" : "warn",
		detail:
			found.length > 0
				? `found: ${found.join(", ")}`
				: "no agent CLI found (claude/codex/copilot)",
	};
};

export const checkGatewayCredentials = (ctx: DoctorContext): CheckResult => {
	const belt = beltEnvPath(ctx.home);
	const spoke = spokeEnvPath(ctx.home);
	const hasBelt = filePresent(belt);
	const hasSpoke = filePresent(spoke);
	if (!hasBelt)
		return {
			id: "gateway-credentials",
			label: "gateway credentials",
			status: "fail",
			detail: `missing ${belt} (upstream keys + BUCKLE_ADMIN_KEY)`,
		};
	return {
		id: "gateway-credentials",
		label: "gateway credentials",
		status: hasSpoke ? "pass" : "warn",
		detail: hasSpoke
			? "belt.env + buckle-spoke.env present (values unread)"
			: "belt.env present; buckle-spoke.env missing (hubs carry their own)",
	};
};

export const checkMachineConf = (ctx: DoctorContext): CheckResult => {
	const stack = `${ctx.home}/.config/klh/stack.yaml`;
	const has = filePresent(stack);
	return {
		id: "machine-conf",
		label: "machine conf (stack.yaml)",
		status: has ? "pass" : "warn",
		detail: has
			? "stack.yaml present"
			: "stack.yaml missing — hub deploys disabled until created",
	};
};

export const checkRepoRules = (ctx: DoctorContext): CheckResult => {
	const hasAgents = filePresent(`${ctx.repo}/AGENTS.md`);
	const hasQlty = filePresent(`${ctx.repo}/.qlty/qlty.toml`);
	const git = ctx.run(["git", "-C", ctx.repo, "config", "core.hooksPath"]);
	const hooks = git.code === 0 ? git.out.trim() : "";
	const ok = hasAgents && hasQlty && hooks === ".githooks";
	return {
		id: "repo-rules",
		label: "repository rules (AGENTS.md, qlty, hooksPath)",
		status: ok ? "pass" : "fail",
		detail: `AGENTS.md=${hasAgents} .qlty/qlty.toml=${hasQlty} core.hooksPath=${hooks || "unset"}`,
	};
};

export const checkProjectIdentity = (ctx: DoctorContext): CheckResult => {
	const r = ctx.run([ctx.workBin, "ready"]);
	const first = r.out.split("\n")[0].trim();
	return {
		id: "project-identity",
		label: "project identity (work graph)",
		status: r.code === 0 ? "pass" : "fail",
		detail:
			r.code === 0
				? `work ready ok: ${first || "(empty READY pool)"}`
				: `work ready exited ${r.code}: ${first}`,
	};
};

export const checkPrefixOrigin = (ctx: DoctorContext): CheckResult => {
	const installed = ctx.modulePath.includes("/.harness/");
	return {
		id: "prefix-origin",
		label: "run origin",
		status: installed ? "pass" : "warn",
		detail: installed
			? "running from the installed prefix"
			: "running from a repo checkout — install.sh syncs the installed prefix",
	};
};

export const runChecks = (ctx: DoctorContext): CheckResult[] => [
	checkBun(ctx),
	checkAgentClis(ctx),
	checkGatewayCredentials(ctx),
	checkMachineConf(ctx),
	checkRepoRules(ctx),
	checkProjectIdentity(ctx),
	checkPrefixOrigin(ctx),
];

// ---- live smoke (separate `smoke` verb — touches the running control plane)

export type SmokeResult = { id: string; status: CheckStatus; detail: string };

/** GET <base>/api/data — the board read face answers with JSON */
export const smokeBoard = async (base: string): Promise<SmokeResult> => {
	try {
		const res = await fetch(`${base}/api/data`, {
			headers: { accept: "application/json" },
		});
		if (!res.ok)
			return { id: "board", status: "warn", detail: `board HTTP ${res.status}` };
		const body = (await res.json()) as { items?: unknown[] };
		return {
			id: "board",
			status: "pass",
			detail: `GET /api/data 200 (${Array.isArray(body.items) ? body.items.length : 0} items)`,
		};
	} catch (e) {
		return {
			id: "board",
			status: "warn",
			detail: `board unreachable at ${base}: ${(e as Error).message}`,
		};
	}
};

/**
 * Scoped-key roundtrip against the buckle gate: mint a doctor-tagged key,
 * verify it, revoke it. Proves the admin→scoped chain end to end. Never
 * prints the admin key; the minted test key is revoked before returning
 * (AGENTS.md: test keys get revoked, never left behind).
 */
export const smokeGateRoundtrip = async (
	base: string,
	adminKey: string,
): Promise<SmokeResult> => {
	const name = `doctor-smoke-${Date.now()}`;
	const auth = { authorization: `Bearer ${adminKey}` };
	try {
		const mint = await fetch(`${base}/v1/admin/keys`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ name, scopes: ["buckle:proxy:WRITE_"] }),
		});
		if (!mint.ok)
			return {
				id: "scoped-keys",
				status: "fail",
				detail: `mint HTTP ${mint.status}`,
			};
		const { key, key_id } = (await mint.json()) as {
			key?: string;
			key_id?: string;
		};
		const verify = await fetch(`${base}/v1/admin/keys/verify`, {
			method: "POST",
			headers: { ...auth, "content-type": "application/json" },
			body: JSON.stringify({ key }),
		});
		const verifyOk = verify.ok
			? ((await verify.json()) as { valid?: boolean }).valid === true
			: false;
		const revoke = await fetch(`${base}/v1/admin/keys/${key_id}/revoke`, {
			method: "POST",
			headers: auth,
		});
		if (revoke.ok && verifyOk)
			return {
				id: "scoped-keys",
				status: "pass",
				detail: `minted + verified + revoked scoped key "${name}"`,
			};
		return {
			id: "scoped-keys",
			status: "fail",
			detail: `verify=${verifyOk} revoke=${revoke.ok} (minted key ${key_id ?? "?"})`,
		};
	} catch (e) {
		return {
			id: "scoped-keys",
			status: "warn",
			detail: `gate unreachable at ${base}: ${(e as Error).message}`,
		};
	}
};
