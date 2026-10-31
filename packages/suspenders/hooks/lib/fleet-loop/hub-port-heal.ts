// fleet-loop/hub-port-heal.ts — W2309: detect and auto-heal hub
// port-publishing loss. A host restart can leave containers restored by
// docker's restart policy Up/(healthy) with NO published ports
// (NetworkSettings.Ports = {}) — health sidecars answer inside docker while
// every published face is dead from outside. Two remedies by shape:
//   (a) remote docker (deploy.ssh): reconcile — hubctl up <hub>
//   (b) local Docker Desktop after daemon-down: `up -d` does NOT recreate
//       (config unchanged) — compose up -d --force-recreate per hub project
// Signature, all three required (lesson.hub-reboot-needs-compose-up):
//   published health face red (on-hub curl non-200)
//   + container running and healthy
//   + published ports empty ({} or all-null).
// Docker Desktop itself down is a DISTINCT degraded state: reported, never
// auto-launched. One bounded remedy attempt per hub per fire, never a
// blanket recreate; re-probe after, BROADCAST + lesson update on the
// heal/no-heal verdict. Dry-run is the default (the bin is the face).
import { sshOpts } from "../../../deploy/hub-remote.ts";

/** The profile slice the heal walks — flattened from a stack.json hub
 *  profile (deploy.ssh/docker/dir + the published health sidecar ports). */
export interface HubHealTarget {
	name: string;
	/** remote docker target; unset = local docker (Docker Desktop shape) */
	ssh?: string;
	/** docker binary on the hub host (hub.deploy.docker, default "docker") */
	docker: string;
	/** compose project dir on the hub host (hub.deploy.dir) */
	dir: string;
	/** connect timeout seconds for the ssh leg */
	connectTimeout?: number;
	/** published health faces probed on the hub host (127.0.0.1:<port>) */
	probePorts: number[];
}

/** One docker inspect line for a compose-project container. */
export interface PortRow {
	name: string;
	status: string;
	health: string;
	/** raw NetworkSettings.Ports json — "{}" or {"222/tcp":null} = dead */
	ports: string;
}

export interface RunOut {
	code: number;
	out: string;
}

/** Run a shell script ON the hub host (ssh argv when remote, /bin/sh -c
 *  locally — the hubctl runOnHub shape). */
export type HubExec = (target: HubHealTarget, script: string) => RunOut;

/** Spawn a local process (the remote remedy: bun deploy/hubctl.ts up <hub>). */
export type LocalSpawn = (cmd: string[], timeoutMs: number) => RunOut;

export type HubHealVerdict =
	| "ok"
	| "port-loss"
	| "docker-down"
	| "unreachable"
	| "no-containers";

export interface HubHealReport {
	hub: string;
	verdict: HubHealVerdict;
	detail: string;
	/** a remedy ran (act mode + exact signature) */
	remedied: boolean;
	/** post-remedy re-probe: faces answer again */
	healed: boolean;
}

// ---- exec faces -----------------------------------------------------------

/** The real exec face: one script string per hub host, bounded. */
export function realHubExec(timeoutMs: number): HubExec {
	return (target, script) => {
		const argv = target.ssh
			? [
					"ssh",
					...sshOpts({
						deploy: { ssh: target.ssh, connect_timeout: target.connectTimeout },
					}),
					target.ssh,
					script,
				]
			: ["/bin/sh", "-c", script];
		return runLocal(argv, timeoutMs);
	};
}

/** Spawn a local argv (bun scripts, docker info, ssh). */
export function runLocal(cmd: string[], timeoutMs: number): RunOut {
	const p = Bun.spawnSync(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});
	const out = `${p.stdout ? new TextDecoder().decode(p.stdout) : ""}${p.stderr ? new TextDecoder().decode(p.stderr) : ""}`;
	return { code: p.exitCode ?? 1, out };
}

// ---- the probe scripts (run ON the hub host) -------------------------------

const shQuote = (s: string): string => JSON.stringify(s);

/** Per-container line: name|state|health|NetworkSettings.Ports json. */
export const inspectScript = (t: HubHealTarget): string =>
	[
		`ids=$(${t.docker} compose -f ${shQuote(`${t.dir}/hub-compose.yaml`)} --project-directory ${shQuote(t.dir)} ps -q)`,
		'[ -z "$ids" ] && exit 3',
		`${t.docker} inspect --format '{{.Name}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{json .NetworkSettings.Ports}}' $ids`,
	].join("\n");

/** One `code` line per published face probed on the hub host. */
export const probeScript = (t: HubHealTarget): string =>
	t.probePorts
		.map(
			(p) =>
				`printf '%s\\n' "${p}:$(curl --max-time 3 -so /dev/null -w '%{http_code}' http://127.0.0.1:${p}/healthz || true)"`,
		)
		.join("\n");

export const forceRecreateScript = (t: HubHealTarget): string =>
	`${t.docker} compose -f ${shQuote(`${t.dir}/hub-compose.yaml`)} --project-directory ${shQuote(t.dir)} up -d --force-recreate`;

/** Local docker daemon alive? (Docker Desktop down is its own verdict —
 *  reported, never auto-launched.) */
export const dockerInfoScript = (t: HubHealTarget): string =>
	`${t.docker} info >/dev/null 2>&1`;

// ---- pure classification ----------------------------------------------------

export function parseInspect(out: string): PortRow[] {
	const rows: PortRow[] = [];
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t.startsWith("/")) continue;
		const [name, status, health, ports] = t.split("|");
		if (!name || !status) continue;
		rows.push({
			name: name.replace(/^\//, ""),
			status,
			health: health ?? "none",
			ports: ports ?? "{}",
		});
	}
	return rows;
}

/** Ports json counts as DEAD when it publishes nothing: "{}" or every
 *  mapping null ({"222/tcp":null}). */
export function publishesNothing(ports: string): boolean {
	try {
		const parsed = JSON.parse(ports) as Record<string, unknown>;
		const vals = Object.values(parsed);
		return vals.length === 0 || vals.every((v) => v === null);
	} catch {
		return false;
	}
}

/** Containers up + healthy with no published ports — the restart-policy
 *  restored-without-ports shape. */
export function healthyWithoutPorts(rows: PortRow[]): PortRow[] {
	return rows.filter(
		(r) =>
			r.status === "running" &&
			(r.health === "healthy" || r.health === "none") &&
			publishesNothing(r.ports),
	);
}

/** `port:code` probe lines → the faces that did not answer 200. */
export function deadProbes(out: string): number[] {
	const dead: number[] = [];
	for (const line of out.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		const i = t.indexOf(":");
		if (i < 1) continue;
		const port = Number(t.slice(0, i));
		const code = t.slice(i + 1).trim();
		if (Number.isInteger(port) && port > 0 && code !== "200") dead.push(port);
	}
	return dead;
}

/** The EXACT signature: ≥1 healthy container with no publishes AND ≥1
 *  configured health face dead. Both or nothing — a sidecar-only red with
 *  ports published is a different outage and never triggers a recreate. */
export function signatureMatch(rows: PortRow[], deadFaces: number[]): boolean {
	return healthyWithoutPorts(rows).length > 0 && deadFaces.length > 0;
}

// ---- the fire ----------------------------------------------------------------

/** Assess one hub; when `act` and the signature matches, run the matching
 *  remedy (remote = hubctl up, local = compose force-recreate) once, then
 *  re-probe. hubctlPath lets the bin pass its own deploy/ face (tests). */
export function healHub(
	target: HubHealTarget,
	opts: {
		act: boolean;
		exec: HubExec;
		spawn: LocalSpawn;
		bun: string;
		hubctlPath: string;
	},
): HubHealReport {
	const base: HubHealReport = {
		hub: target.name,
		verdict: "ok",
		detail: "",
		remedied: false,
		healed: false,
	};
	// local docker: the daemon IS the precondition — Docker Desktop down is
	// a distinct degraded state, reported only
	if (!target.ssh) {
		const info = opts.exec(target, dockerInfoScript(target));
		if (info.code !== 0)
			return {
				...base,
				verdict: "docker-down",
				detail:
					"docker daemon unreachable (Docker Desktop down?) — not auto-launched",
			};
	}
	const ins = opts.exec(target, inspectScript(target));
	if (ins.code === 3)
		return {
			...base,
			verdict: "no-containers",
			detail: "compose project has no containers (not deployed?)",
		};
	if (ins.code !== 0)
		return { ...base, verdict: "unreachable", detail: legFail(ins.out) };
	const rows = parseInspect(ins.out);
	const dead = deadProbes(opts.exec(target, probeScript(target)).out);
	if (!signatureMatch(rows, dead))
		return {
			...base,
			verdict: "ok",
			detail: `${rows.length} container(s), ${dead.length} dead face(s)`,
		};
	const loss = healthyWithoutPorts(rows)
		.map((r) => r.name)
		.join(",");
	const detail = `port-publishing loss on ${loss}; dead faces ${dead.join(",")}`;
	if (!opts.act)
		return {
			...base,
			verdict: "port-loss",
			detail: `${detail} (dry-run — no remedy)`,
		};
	// ONE bounded remedy by shape
	const remedy = target.ssh
		? opts.spawn([opts.bun, opts.hubctlPath, "up", target.name], 180_000)
		: opts.exec(target, forceRecreateScript(target));
	if (remedy.code !== 0)
		return {
			...base,
			verdict: "port-loss",
			remedied: true,
			detail: `${detail} — remedy FAILED (${legFail(remedy.out)})`,
		};
	// re-probe: signature gone = healed
	const reIns = opts.exec(target, inspectScript(target));
	const reRows = reIns.code === 0 ? parseInspect(reIns.out) : [];
	const reDead =
		reIns.code === 0
			? deadProbes(opts.exec(target, probeScript(target)).out)
			: dead;
	const healed = !signatureMatch(reRows, reDead);
	return {
		hub: target.name,
		verdict: "port-loss",
		detail: `${detail} — ${healed ? "HEALED" : "STILL RED after remedy"}`,
		remedied: true,
		healed,
	};
}

const legFail = (out: string): string =>
	out.trim().split("\n").filter(Boolean).slice(-1)[0] || "hub leg failed";

/** Assess/heal a target list (bin face): quiet-hours filtering happens
 *  before this — every target here is probed. */
export function healTargets(
	targets: HubHealTarget[],
	opts: Parameters<typeof healHub>[1],
): HubHealReport[] {
	return targets.map((t) => healHub(t, opts));
}
