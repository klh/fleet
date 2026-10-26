// deploy/hub-ref-preflight.ts — W1302.3: the hub deploy ref-existence
// preflight. renderEnv validates pin SHAPE only — a well-formed pin to a
// nonexistent tag rendered fine and died at fleet-repo exit 128 (A11,
// 2026-10-25: both stack.json `version` and hubs.zai.repos.ref named tag
// fleet-2026-10-25-64cf184c, which the selected private overlay never
// carried). The activation verbs (up, deploy) now resolve every pin against
// the origins the hub actually pulls from (git ls-remote) BEFORE any mint,
// push or up; fail closed: a dead pin or an unreachable origin refuses
// activation — the hub's own fleet-repo fetch needs the same network leg,
// so refusal matches runtime reality. No bypass flag: the remedy is a
// corrected pin, exactly the A11 recovery.
import { spawnSync } from "node:child_process";
import type { HubProfile } from "../hooks/lib/stack-config.ts";

/** The public Fleet monorepo — the stack version's home even for an overlay
 *  hub (the overlay fetches the public base through its git-dep pins at the
 *  version), and the deploy origin itself for a public-origin hub. */
export const FLEET_ORIGIN = "https://github.com/klh/fleet.git";

export type RefProbe = (argv: string[]) => {
	status: number | null;
	stdout: string;
	stderr: string;
	error?: Error;
};

/** Inline git userinfo (the private origin carries creds in stack.json)
 *  never appears in a preflight message — redactedRender's posture, applied
 *  to git's stderr too (git echoes the URL on transport failures). */
function redactCreds(text: string): string {
	return text.replace(/\/\/[^@/\s]*@/g, "//***@");
}

/** The one-line reason for an unreachable verdict (git's stderr head). */
function firstLine(text: string): string {
	return text.trim().split("\n")[0] ?? "";
}

/** The origin/ref facts renderEnv and the preflight share — ONE shape gate:
 *  a pinned non-branch version; one shared monorepo origin; no archived
 *  package origin; an overlay needs repos.ref; a public repos.ref must
 *  equal the version. Throws on violation. `ref` = the ref the hub's
 *  fleet-repo will fetch (the overlay's own deployable, else the version). */
export function resolveHubOrigin(
	hub: HubProfile,
	version: string | undefined,
): { origin: string; overlay: boolean; ref: string } {
	if (!version || version === "main" || version === "master")
		throw new Error(
			"hub deploy requires a pinned stack version (reviewed SHA or release tag)",
		);
	const origins = [
		...new Set(
			[hub.repos?.buckle, hub.repos?.suspenders, hub.repos?.belt].filter(
				Boolean,
			),
		),
	];
	if (origins.length > 1)
		throw new Error("hub packages must share one Fleet monorepo origin");
	const origin = origins[0] ?? FLEET_ORIGIN;
	if (/github\.com[:/]klh\/(?:buckle|suspenders|belt)(?:\.git)?$/.test(origin))
		throw new Error(
			"archived package origin cannot deploy Fleet; configure the monorepo origin",
		);
	const overlay = origin !== FLEET_ORIGIN;
	const overlayRef = hub.repos?.ref;
	if (overlay && !overlayRef)
		throw new Error(
			"overlay origin needs repos.ref — the hub's own deployable ref (the stack version cannot be a ref in a private origin: GH002)",
		);
	if (!overlay && overlayRef && overlayRef !== version)
		throw new Error("hub repo ref must match the shared stack version");
	return { origin, overlay, ref: overlay ? overlayRef : version };
}

/** One pin a hub activation depends on: which ref, against which origin. */
interface RefLeg {
	label: string;
	origin: string;
	ref: string;
}

/** The pins behind an activation: the stack version always resolves in the
 *  public monorepo, and an overlay's repos.ref additionally resolves in its
 *  private origin (the same tag can be public-alive and mirror-dead — the
 *  A11 shape). */
function deployRefLegs(hub: HubProfile, version: string | undefined): RefLeg[] {
	const { origin, overlay, ref } = resolveHubOrigin(hub, version);
	// the resolver guarantees a pinned non-branch version before returning
	const versionRef = version ?? ref;
	const legs: RefLeg[] = [
		{ label: "stack version", origin: FLEET_ORIGIN, ref: versionRef },
	];
	if (overlay) legs.push({ label: "overlay repos.ref", origin, ref });
	return legs;
}

/** One ls-remote probe's verdict: the ref is served, definitively absent
 *  (git exit 2 with --exit-code / exit 0 with an empty answer), or the
 *  origin could not be consulted at all (transport/auth/timeout) — the
 *  unreachable case carries git's own evidence for the refusal message. */
interface LegVerdict {
	verdict: "served" | "absent" | "unreachable";
	status: number | null;
	stderr: string;
}

/** ls-remote patterns match ref NAMES, never commits — a 40-hex version pin
 *  (the renderEnv shape allows a reviewed SHA) resolves via full-list
 *  membership instead. */
function probeLeg(leg: RefLeg, probe: RefProbe): LegVerdict {
	const isSha = /^[0-9a-f]{40}$/.test(leg.ref);
	const r = isSha
		? probe(["git", "ls-remote", leg.origin])
		: probe(["git", "ls-remote", "--exit-code", leg.origin, leg.ref]);
	const served: LegVerdict = {
		verdict: "served",
		status: r.status,
		stderr: r.stderr,
	};
	if (r.status === 0 && r.stdout.trim().length > 0) {
		if (!isSha) return served;
		if (
			r.stdout
				.split("\n")
				.some((line) => line.split("\t")[0]?.trim() === leg.ref)
		)
			return served;
	}
	// empty answer + clean exit (no --exit-code) reads as definitive absence
	if (r.status === 0 || r.status === 2)
		return { verdict: "absent", status: r.status, stderr: r.stderr };
	return { verdict: "unreachable", status: r.status, stderr: r.stderr };
}

/** W1302.3 gate: every pin the activation depends on must exist on its
 *  origin before hubctl touches the hub (probe-injectable for tests). */
export function assertDeployRefsExist(
	hub: HubProfile,
	name: string,
	version: string | undefined,
	probe: RefProbe = (argv) => {
		const r = spawnSync(argv[0], argv.slice(1), {
			encoding: "utf8",
			timeout: 30_000,
		});
		return {
			status: r.status,
			stdout: r.stdout ?? "",
			stderr: r.stderr ?? "",
			error: r.error,
		};
	},
): void {
	for (const leg of deployRefLegs(hub, version)) {
		const v = probeLeg(leg, probe);
		if (v.verdict === "served") continue;
		const where = redactCreds(leg.origin);
		const detail =
			v.verdict === "absent"
				? `repin stack.json (${leg.label === "stack version" ? "version" : "repos.ref"}) to a ref the origin serves, then re-run`
				: `the origin could not be consulted (${firstLine(redactCreds(v.stderr)) || `git exit ${v.status ?? "?"}`}) — the hub's fleet-repo fetch needs the same network leg; fix connectivity, then re-run`;
		throw new Error(
			`hubctl ${name} refused: ${leg.label} "${leg.ref}" ${v.verdict === "absent" ? "does not exist in" : "could not be resolved against"} ${where} — ${detail}`,
		);
	}
}
