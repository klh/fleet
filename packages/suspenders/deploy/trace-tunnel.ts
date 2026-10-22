// deploy/trace-tunnel.ts — W1097 managed ssh tunnel: the trusted transport
// between THIS device and a hub's trace-receipt plane. The hub gate is plain
// HTTP on the LAN; direct HTTP would carry the read key in the clear and the
// hub's TLS front carries an untrusted certificate — so the connector never
// points at the hub directly. The tunnel is configured by stack.yaml
// (hubs.<label>.trace_tunnel: listen_port / target_port / read_key) and the
// read key rides the ssh channel, never plain LAN HTTP; the connector sees
// only a loopback URL on this device (the one non-https form its URL law
// admits). hubctl trace-tunnel <hub> sub-verbs are the managed face: up
// spawns ssh with an argument array (BatchMode + ExitOnForwardFailure),
// banks a 0600 state file, and waits for the forward to answer; peer renders
// the connector peer row into the private 0600 peers file, validating the
// merged bytes with the connector's own law (parsePeers) before they land.
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { parsePeers } from "../../telemetry/src/remote-traces.ts";
import type { HubProfile } from "../hooks/lib/stack-config.ts";
import { DEFAULT_CONNECT_TIMEOUT } from "./hub-remote.ts";

/** The resolved trace-tunnel config for one hub. */
export interface TraceTunnelPlan {
	hub: string;
	/** Loopback port bound on THIS device. */
	listenPort: number;
	/** Port on the HUB the forward targets (default = buckle_port). */
	targetPort: number;
	sshTarget: string;
	connectTimeoutS: number;
	/** PATH on this device to the 0600 read key (the connector's tokenFile). */
	readKeyPath: string;
}

const PORT_MIN = 1024;
const PORT_MAX = 65535;
/** Bounded bring-up: BatchMode + ConnectTimeout make an unreachable hub fail
 *  in seconds; this wait is only the local-forward answer on top. */
const LISTEN_WAIT_MS = 8_000;
const LISTEN_POLL_MS = 200;
/** ssh stderr ring — bounded tail kept for failure diagnostics. */
const ERR_TAIL_BYTES = 2048;
/** The private peers-file cap mirrors the connector's own MAX_PEERS. */
const PEER_CAP = 8;

/** One declared port: bounds + integer law (1024–65535), fail closed. */
function portOf(value: unknown, name: string): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < PORT_MIN ||
		value > PORT_MAX
	) {
		throw new Error(
			`hub ${name}: trace_tunnel port must be an integer ${PORT_MIN}-${PORT_MAX}`,
		);
	}
	return value;
}

/** The hub-side forward target — never inferred from anything but config. */
function targetPortOf(
	declared: { target_port?: number },
	hub: HubProfile,
	name: string,
): number {
	if (declared.target_port !== undefined) return declared.target_port;
	if (hub.buckle_port === undefined) {
		throw new Error(
			`hub ${name}: trace_tunnel target port unset — declare trace_tunnel.target_port or buckle_port`,
		);
	}
	return hub.buckle_port;
}

/** deploy.connect_timeout (seconds) — the same knob the deploy path uses. */
function connectTimeoutOf(hub: HubProfile): number {
	const t = hub.deploy?.connect_timeout;
	return typeof t === "number" && Number.isFinite(t) && t > 0
		? Math.ceil(t)
		: DEFAULT_CONNECT_TIMEOUT;
}

/** Parse the knobs, fail closed on a partial/invalid declaration. Returns
 *  null when the hub declares NO trace_tunnel (undeclared = not configured,
 *  never an error). */
export function traceTunnelPlan(
	hub: HubProfile,
	name: string,
): TraceTunnelPlan | null {
	const declared = hub.trace_tunnel;
	if (!declared) return null;
	if (!hub.deploy?.ssh) {
		throw new Error(
			`hub ${name}: trace_tunnel needs hubs.${name}.deploy.ssh — the tunnel IS the trusted transport`,
		);
	}
	const readKey = declared.read_key;
	if (typeof readKey !== "string" || !readKey || !isAbsolute(readKey)) {
		throw new Error(
			`hub ${name}: trace_tunnel.read_key must be an absolute PATH on this device`,
		);
	}
	return {
		hub: name,
		listenPort: portOf(declared.listen_port, name),
		targetPort: targetPortOf(declared, hub, name),
		sshTarget: hub.deploy.ssh,
		connectTimeoutS: connectTimeoutOf(hub),
		readKeyPath: readKey,
	};
}

/** The ssh argv — one array, never a shell string. -N = no remote command;
 *  ExitOnForwardFailure makes a failed local bind kill the tunnel instead of
 *  leaving a half-open ssh; BatchMode + ConnectTimeout come from the same
 *  deploy knobs every other ssh leg uses (hub-remote.ts). */
export function tunnelArgv(plan: TraceTunnelPlan): string[] {
	return [
		"ssh",
		"-N",
		"-o",
		`ConnectTimeout=${plan.connectTimeoutS}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ExitOnForwardFailure=yes",
		"-L",
		`127.0.0.1:${plan.listenPort}:127.0.0.1:${plan.targetPort}`,
		plan.sshTarget,
	];
}

/** The connector peer row this tunnel serves — the loopback URL is the one
 *  non-https form the connector's URL law admits, and the tokenFile is the
 *  0600 read key PATH from stack.yaml. */
export function tracePeerEntry(plan: TraceTunnelPlan): TracePeerEntry {
	return {
		hubId: plan.hub,
		url: `http://127.0.0.1:${plan.listenPort}/`,
		tokenFile: plan.readKeyPath,
	};
}

/** The tunnel state file: KLH_TUNNEL_STATE overrides; default under
 *  ~/.local/state/klh (XDG state home), one file per hub label. */
export function tunnelStatePath(hub: string): string {
	const override = process.env.KLH_TUNNEL_STATE;
	if (override) return join(dirname(override), `tunnel-${hub}.json`);
	return join(homedir(), ".local", "state", "klh", `tunnel-${hub}.json`);
}

function readStateFile(path: string): TunnelState | null {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return null;
	}
	try {
		const v = JSON.parse(text) as TunnelState;
		if (
			typeof v.pid !== "number" ||
			typeof v.hub !== "string" ||
			typeof v.listen_port !== "number" ||
			typeof v.target_port !== "number" ||
			typeof v.started_at !== "string"
		)
			return null;
		return v;
	} catch {
		return null;
	}
}

/** pid liveness the boring way — signal 0 asks, never kills. */
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Read the banked state; null when absent or stale (pid not alive). */
export function readTunnelState(
	hub: string,
	alive: (pid: number) => boolean = pidAlive,
): TunnelState | null {
	const raw = readStateFile(tunnelStatePath(hub));
	if (raw === null) return null;
	if (!alive(raw.pid)) return null;
	return raw;
}

/** ChildRun — the seam tests inject instead of a real ssh. */
export interface ChildRun {
	pid: number;
	stderr: () => string;
	exit: number | null | undefined;
}

/** Is the banked forward the SAME forward the plan declares? */
function sameForward(state: TunnelState, plan: TraceTunnelPlan): boolean {
	return (
		state.listen_port === plan.listenPort &&
		state.target_port === plan.targetPort
	);
}

/** The tunnel probe URL — the hub gate's /status through the local forward. */
function forwardProbeUrl(plan: TraceTunnelPlan): string {
	return `http://127.0.0.1:${plan.listenPort}/status`;
}

/** The forward answers when the hub gate's /status replies 200. */
async function forwardAnswering(url: string): Promise<boolean> {
	try {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(1000),
			redirect: "error",
			cache: "no-store",
		});
		return res.status === 200;
	} catch {
		return false;
	}
}

/** Bounded stderr tail for failure lines — never the whole pipe. */
function errTail(stderr: () => string): string {
	const text = stderr().trim();
	return text.length > 0 ? text.slice(-ERR_TAIL_BYTES) : "no ssh stderr";
}

/** Bank the 0600 state file (atomic temp+rename in the state dir). */
function bankState(hub: string, state: TunnelState): void {
	const dir = dirname(tunnelStatePath(hub));
	mkdirSync(dir, { recursive: true });
	const tmp = `${tunnelStatePath(hub)}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
	renameSync(tmp, tunnelStatePath(hub));
}

/** Stop the tunnel for a hub: SIGTERM the banked pid, reap the state file.
 *  Idempotent — no state = already down. */
export function stopTunnel(hub: string): void {
	const state = readStateFile(tunnelStatePath(hub));
	if (state === null) return;
	if (pidAlive(state.pid)) {
		try {
			process.kill(state.pid, "SIGTERM");
		} catch {
			// died between the liveness check and the kill — already down
		}
	}
	rmSync(tunnelStatePath(hub), { force: true });
}

/** Build the banked state row from the plan + the spawned child. */
function stateOf(plan: TraceTunnelPlan, child: ChildRun): TunnelState {
	return {
		pid: child.pid,
		hub: plan.hub,
		listen_port: plan.listenPort,
		target_port: plan.targetPort,
		started_at: new Date().toISOString(),
	};
}

/** Bounded wait until the forward answers or the ssh child dies first.
 *  Deadline hit = stop the half-open tunnel and throw with the ssh tail. */
async function awaitForward(
	child: ChildRun,
	plan: TraceTunnelPlan,
	waitMs: number,
	pollMs: number,
	probe: (url: string) => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		if (child.exit !== null && child.exit !== undefined) {
			throw new Error(
				`ssh tunnel exited early (code ${child.exit}) — ${errTail(child.stderr)}`,
			);
		}
		if (await probe(forwardProbeUrl(plan))) return;
		if (Date.now() >= deadline) {
			stopTunnel(plan.hub);
			throw new Error(
				`ssh tunnel forward never answered within ${waitMs}ms — ${errTail(child.stderr)}`,
			);
		}
		await Bun.sleep(pollMs);
	}
}

/** Bring the tunnel up: reuse a live one serving the same forward, stop a
 *  stale/different one, spawn ssh with the argument array, bank 0600 state,
 *  then wait (bounded) for the forward to answer. */
export async function tunnelUp(
	plan: TraceTunnelPlan,
	run: (argv: string[]) => ChildRun = spawnSsh,
	waitMs = LISTEN_WAIT_MS,
	pollMs = LISTEN_POLL_MS,
	probe: (url: string) => Promise<boolean> = forwardAnswering,
): Promise<TunnelState> {
	const existing = readTunnelState(plan.hub);
	if (existing !== null && sameForward(existing, plan)) return existing;
	if (existing !== null) stopTunnel(plan.hub);
	const child = run(tunnelArgv(plan));
	const state = stateOf(plan, child);
	bankState(plan.hub, state);
	await awaitForward(child, plan, waitMs, pollMs, probe);
	return state;
}

/** The real spawn: Bun.spawn argument array, stdin/stdout ignored, stderr
 *  banked in a bounded ring so failure lines carry the ssh diagnostic. */
function spawnSsh(argv: string[]): ChildRun {
	const child = Bun.spawn(argv, {
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	let tail = "";
	void (async () => {
		const reader = child.stderr.getReader();
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			tail = `${tail}${new TextDecoder().decode(part.value)}`.slice(
				-ERR_TAIL_BYTES,
			);
		}
	})();
	let exitCode: number | null = null;
	void child.exited.then((code) => {
		exitCode = code;
	});
	return {
		pid: child.pid,
		stderr: () => tail,
		get exit() {
			return exitCode;
		},
	};
}

/** Render the connector peers file with THIS tunnel's row merged in. The
 *  merged bytes are validated with the connector's OWN law (parsePeers)
 *  BEFORE they land — hubctl never writes a peers file the reader would
 *  reject. Land atomically at 0600. */
export function writePeersFile(peersPath: string, plan: TraceTunnelPlan): void {
	if (!isAbsolute(peersPath)) {
		throw new Error(`peers path must be absolute: ${peersPath}`);
	}
	const entry = tracePeerEntry(plan);
	const existing = readPeersEntries(peersPath);
	const merged = [
		...existing.filter((row) => row.hubId !== entry.hubId),
		entry,
	];
	if (merged.length > PEER_CAP) {
		throw new Error(
			`peers file would hold ${merged.length} peers — the connector reads at most ${PEER_CAP}`,
		);
	}
	writePeersPayload(peersPath, merged);
}

/** Read the peers file's current rows (missing file = none). */
function readPeersEntries(peersPath: string): TracePeerEntry[] {
	let text: string;
	try {
		text = readFileSync(peersPath, "utf8");
	} catch {
		return [];
	}
	const parsed = JSON.parse(text) as { peers?: TracePeerEntry[] };
	if (!Array.isArray(parsed.peers)) return [];
	return parsed.peers;
}

/** Validate the merged rows with the connector's law, then land atomically
 *  at 0600 (the peers file is a credential-adjacent private file). */
function writePeersPayload(peersPath: string, merged: TracePeerEntry[]): void {
	const payload = JSON.stringify({ peers: merged }, null, "\t");
	parsePeers(payload);
	const dir = dirname(peersPath);
	mkdirSync(dir, { recursive: true });
	const tmp = `${peersPath}.${process.pid}.tmp`;
	writeFileSync(tmp, `${payload}\n`, { mode: 0o600 });
	renameSync(tmp, peersPath);
}

const TRACE_TUNNEL_USAGE =
	"usage: hubctl trace-tunnel <hub> up|status|down|peer [--file <0600 peers file>]";

/** The hubctl verb face — resolve the plan, then run the sub-verb.
 *  Exits: 0 ok · 1 down/failed · 2 usage. */
export async function traceTunnelVerb(
	hub: HubProfile,
	name: string,
	flags: string[],
): Promise<void> {
	const sub = flags[0];
	if (sub === undefined || flags.includes("--help")) {
		console.log(TRACE_TUNNEL_USAGE);
		process.exit(sub === undefined ? 2 : 0);
	}
	let plan: TraceTunnelPlan | null;
	try {
		plan = traceTunnelPlan(hub, name);
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e);
		console.log(`hubctl trace-tunnel: ${text}`);
		process.exit(2);
	}
	if (plan === null) {
		console.log(`hub ${name} declares no trace_tunnel in stack.yaml`);
		process.exit(2);
	}
	await runTunnelSub(plan, name, sub, flags);
	process.exit(0);
}

/** The sub-verb dispatch — up/status/down drive the tunnel; peer renders the
 *  connector peers row into the private 0600 peers file. */
async function runTunnelSub(
	plan: TraceTunnelPlan,
	name: string,
	sub: string,
	flags: string[],
): Promise<void> {
	try {
		if (sub === "up") return await tunnelSubUp(plan, name);
		if (sub === "status") return await tunnelSubStatus(name);
		if (sub === "down") return tunnelSubDown(name);
		if (sub === "peer") return tunnelSubPeer(plan, flags);
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e);
		console.log(`hubctl trace-tunnel ${sub}: failed — ${text}`);
		process.exit(1);
	}
	console.log(TRACE_TUNNEL_USAGE);
	process.exit(2);
}

/** up: bring the tunnel up and print the forward line. */
async function tunnelSubUp(plan: TraceTunnelPlan, name: string): Promise<void> {
	const state = await tunnelUp(plan);
	console.log(
		`✓ tunnel ${name} up — http://127.0.0.1:${state.listen_port}/ → 127.0.0.1:${state.target_port} via ${plan.sshTarget} (pid ${state.pid})`,
	);
}

/** status: print the banked verdict; exit 1 when down. */
async function tunnelSubStatus(name: string): Promise<void> {
	const state = readTunnelState(name);
	if (state === null) {
		console.log(`tunnel ${name}: down`);
		process.exit(1);
	}
	console.log(
		`tunnel ${name}: up (pid ${state.pid}) — http://127.0.0.1:${state.listen_port}/ → 127.0.0.1:${state.target_port} (since ${state.started_at})`,
	);
}

/** down: stop the tunnel and reap the state file (idempotent). */
function tunnelSubDown(name: string): void {
	stopTunnel(name);
	console.log(`tunnel ${name}: down`);
}

/** peer: render the connector row into the private peers file (--file). */
function tunnelSubPeer(plan: TraceTunnelPlan, flags: string[]): void {
	const file = flagOf(flags, "--file");
	if (file === null || !isAbsolute(file)) {
		console.log(`${TRACE_TUNNEL_USAGE} — peer needs --file <absolute path>`);
		process.exit(2);
	}
	writePeersFile(file, plan);
	const entry = tracePeerEntry(plan);
	console.log(
		`✓ peers file ${file} carries ${entry.hubId} → ${entry.url} (read key at ${entry.tokenFile})`,
	);
}

/** One --flag <value> from the flag tail (null when absent). */
function flagOf(flags: string[], flag: string): string | null {
	const i = flags.indexOf(flag);
	if (i === -1) return null;
	return flags[i + 1] ?? null;
}
