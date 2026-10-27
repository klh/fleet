// hooks/lib/lane-guard-proxy.ts — W1141 proxy faces of the lane guard. Both
// servers are LIB functions (thin bins wrap them; tests start them in-process
// — a spawned child serving a parent-hitting client hangs on this macOS).
//
//   startLaneEgressProxy — raw-TCP CONNECT/forward proxy: every destination
//     hostname is matched against the machine-conf allowlist; anything else
//     is answered 403 and logged (NDJSON). Non-proxy-aware processes can
//     still reach the wire directly — this is defense-in-depth at the env
//     layer, not a sandbox.
//
//   startLanePushProxy — the git smart-HTTP push front: Basic sid:token →
//     the lane's ONE scoped branch; anything else is refused BEFORE any byte
//     moves (403, credential layer). Allowed pushes are relayed statelessly
//     to the real origin — local-path origins via `git receive-pack
//     --stateless-rpc`, ssh origins via `ssh <host> "git-receive-pack
//     --stateless-rpc '<path>'"`.
import { appendFileSync, mkdirSync } from "node:fs";
import {
	egressAuthorityHost,
	egressHostAllowed,
	egressLogLine,
	parseReceivePackCommands,
	pushRefVerdict,
	verifyPushCredential,
} from "./lane-guard.ts";

const HTTP_EOH = "\r\n\r\n";
const MAX_HEADER_BYTES = 16 * 1024;

export interface LaneEgressProxyOpts {
	port: number;
	allow: string[];
	logFile: string;
}

interface EgressState {
	buf: string;
	tunnel: boolean;
	peer?: Bun.TCPSocket;
}

const dirnameSafe = (f: string): string =>
	f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";

/** The CONNECT/forward proxy listener. `.port` resolves a :0 bind. */
export function startLaneEgressProxy(
	opts: LaneEgressProxyOpts,
): Bun.TCPSocketListener<EgressState> {
	mkdirSync(dirnameSafe(opts.logFile), { recursive: true });
	const log = (line: string): void => {
		try {
			appendFileSync(opts.logFile, line);
		} catch {
			// a log write failure never flips a verdict
		}
	};
	return Bun.listen<EgressState>({
		hostname: "127.0.0.1",
		port: opts.port,
		socket: {
			// Bun leaves socket.data undefined per connection — seed the state
			// here or the first data event throws and the lane hangs.
			open: (sock) => {
				sock.data = { buf: "", tunnel: false };
			},
			data: (sock, data) => egressData(sock, data, opts, log),
			close() {},
			error: (sock) => sock.end(),
		},
	});
}

/** The per-connection state machine: accumulate the request head, verdict the
 *  destination, then either tunnel CONNECT bytes or relay the HTTP call. */
function egressData(
	sock: Bun.TCPSocket<EgressState>,
	data: Uint8Array,
	opts: LaneEgressProxyOpts,
	log: (line: string) => void,
): void {
	if (sock.data.tunnel) {
		sock.data.peer?.write(data);
		return;
	}
	sock.data.buf += new TextDecoder().decode(data);
	if (!sock.data.buf.includes(HTTP_EOH)) {
		if (sock.data.buf.length > MAX_HEADER_BYTES) sock.end();
		return;
	}
	const head = sock.data.buf.slice(0, sock.data.buf.indexOf(HTTP_EOH));
	sock.data.buf = "";
	const [reqLine, ...hdrLines] = head.split("\r\n");
	const m = /^([A-Z]+) (\S+) HTTP\/\d\.\d$/.exec(reqLine);
	if (!m) {
		sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
		sock.end();
		return;
	}
	const [, method, target] = m;
	if (method === "CONNECT") verdictConnect(sock, target, opts, log);
	else verdictForward(sock, method, target, hdrLines, opts, log);
}

/** CONNECT host:port — allowlist verdict, then a byte tunnel or a 403. */
function verdictConnect(
	sock: Bun.TCPSocket<EgressState>,
	authority: string,
	opts: LaneEgressProxyOpts,
	log: (line: string) => void,
): void {
	const host = egressAuthorityHost(authority);
	const port = authority.includes(":") ? authority.split(":")[1] : "443";
	const ok = egressHostAllowed(host, opts.allow);
	log(
		egressLogLine({
			host,
			port,
			verdict: ok ? "allow" : "deny",
			via: "connect",
		}),
	);
	if (!ok) {
		sock.write(
			`HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nlane-guard egress: ${host} is outside the allowlist`,
		);
		sock.end();
		return;
	}
	tunnelConnect(sock, host, Number(port));
}

/** Open the upstream leg; on success flip the lane socket into tunnel mode. */
function tunnelConnect(
	sock: Bun.TCPSocket<EgressState>,
	host: string,
	port: number,
): void {
	Bun.connect({
		hostname: host,
		port,
		socket: {
			open(up) {
				sock.write("HTTP/1.1 200 Connection established\r\n\r\n");
				sock.data.tunnel = true;
				sock.data.peer = up;
			},
			data: (_up, data) => sock.write(data),
			close() {
				sock.end();
			},
			error: () => sock.end(),
		},
	}).catch(() => {
		sock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
		sock.end();
	});
}

const parseTarget = (target: string): URL | null => {
	try {
		return new URL(target);
	} catch {
		return null;
	}
};

const deny403 = (sock: Bun.TCPSocket<EgressState>): void => {
	sock.write(
		`HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
	);
	sock.end();
};

/** Absolute-form HTTP request — allowlist verdict on the URL authority, then
 *  a relay or a 403 (this leg keeps plain-http:// clients under the same
 *  allowlist; https CONNECTs dominate in practice). */
function verdictForward(
	sock: Bun.TCPSocket<EgressState>,
	method: string,
	target: string,
	hdrLines: string[],
	opts: LaneEgressProxyOpts,
	log: (line: string) => void,
): void {
	const u = parseTarget(target);
	if (!u) {
		sock.write("HTTP/1.1 400 Bad Request\r\n\r\n");
		sock.end();
		return;
	}
	if (!forwardAllowed(u, opts, log)) {
		deny403(sock);
		return;
	}
	relayForward(sock, method, u, hdrLines);
}

/** The forward verdict: log the decision, allow only allowlisted hosts. */
function forwardAllowed(
	u: URL,
	opts: LaneEgressProxyOpts,
	log: (line: string) => void,
): boolean {
	const host = egressAuthorityHost(u.host);
	const ok = egressHostAllowed(host, opts.allow);
	log(
		egressLogLine({
			host,
			port: u.port || "80",
			verdict: ok ? "allow" : "deny",
			via: "forward",
		}),
	);
	return ok;
}

/** The allowed-forward relay: rebuild headers (hop-by-hop stripped), fetch
 *  upstream, write one bounded response back, close. */
function relayForward(
	sock: Bun.TCPSocket<EgressState>,
	method: string,
	u: URL,
	hdrLines: string[],
): void {
	const headers = new Headers();
	for (const h of hdrLines) {
		const i = h.indexOf(":");
		if (i > 0) headers.set(h.slice(0, i).trim(), h.slice(i + 1).trim());
	}
	headers.delete("proxy-authorization");
	headers.delete("proxy-connection");
	relayFetch(sock, method, u, headers);
}

/** One fetch upstream, the response written back with an explicit length. */
function relayFetch(
	sock: Bun.TCPSocket<EgressState>,
	method: string,
	u: URL,
	headers: Headers,
): void {
	const hasBody = method !== "GET" && method !== "HEAD";
	fetch(`${u.origin}${u.pathname}${u.search}`, {
		method,
		headers,
		body: hasBody ? method : undefined,
	})
		.then(async (up) => {
			const body = await up.text();
			const head = `HTTP/1.1 ${up.status} ${up.statusText}\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n`;
			sock.write(head + body);
			sock.end();
		})
		.catch(() => {
			sock.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			sock.end();
		});
}

// ---- push proxy ------------------------------------------------------------

export interface LanePushProxyOpts {
	port: number;
	/** The machine repo root — holds .fleet/lane-guard/<sid>.json identities. */
	repoRoot: string;
	/** The real origin push URL (local path or ssh). */
	originUrl: string;
}

/** The git smart-HTTP push front. `.port` resolves a :0 bind. */
export function startLanePushProxy(opts: LanePushProxyOpts): {
	port: number;
	stop: (all?: boolean) => void;
} {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: opts.port,
		fetch: (req) => pushServe(req, opts),
	});
	return { port: server.port, stop: (all?: boolean) => server.stop(all) };
}

/** The one request handler: auth every call, then advertisement or push. */
async function pushServe(
	req: Request,
	opts: LanePushProxyOpts,
): Promise<Response> {
	const url = new URL(req.url);
	const ident = verifyPushCredential(
		req.headers.get("authorization"),
		opts.repoRoot,
	);
	if (!ident) return pushAuthRequired();
	const isAdv =
		url.pathname.endsWith("/info/refs") &&
		url.searchParams.get("service") === "git-receive-pack";
	const isPush = url.pathname.endsWith("/git-receive-pack");
	if (!isAdv && !isPush)
		return json(404, { error: "lane-guard: push-only front" });
	if (isAdv) return pushAdvertisement(opts.originUrl);
	return pushReceive(req, opts, ident);
}

const json = (status: number, body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const pushAuthRequired = (): Response =>
	new Response("lane-guard: credential required\n", {
		status: 401,
		headers: {
			"www-authenticate": 'Basic realm="lane-guard push"',
		},
	});

/** The relay command for one origin URL: local path → direct receive-pack,
 *  ssh → `ssh <host> "git-receive-pack --stateless-rpc '<path>'"`. https
 *  origins are refused — the proxy never holds an http credential store. */
export function relayCommand(
	originUrl: string,
	advertise: boolean,
): string[] | null {
	const mode = advertise ? "--http-backend-info-refs" : "--stateless-rpc";
	if (originUrl.startsWith("/") || originUrl.startsWith("file://")) {
		const path = originUrl.replace(/^file:\/\//, "");
		return ["git", "receive-pack", mode, path];
	}
	const scpLike = /^([^@/]+@[^:/]+):(.+)$/.exec(originUrl);
	const sshUrl = /^ssh:\/\/([^@/]+@)?([^/]+)\/(.+?)$/.exec(originUrl);
	if (scpLike)
		return ["ssh", scpLike[1], `git-receive-pack ${mode} '${scpLike[2]}'`];
	if (sshUrl) {
		const user = sshUrl[1] ?? "";
		return [
			"ssh",
			`${user}${sshUrl[2]}`,
			`git-receive-pack ${mode} '${sshUrl[3]}'`,
		];
	}
	return null;
}

/** GET info/refs — relay the origin's ref advertisement verbatim. */
function pushAdvertisement(originUrl: string): Response {
	const cmd = relayCommand(originUrl, true);
	if (!cmd)
		return json(502, {
			error:
				"lane-guard: origin transport unsupported (local-path or ssh only)",
		});
	const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
	if (p.exitCode !== 0)
		return json(502, {
			error: `lane-guard: advertisement failed: ${p.stderr.toString().slice(0, 200)}`,
		});
	// smart-http REQUIRES the `# service=` preamble before the ref advertisement
	const svc = "# service=git-receive-pack\n";
	const pktLine = (s: string): string =>
		`${(s.length + 4).toString(16).padStart(4, "0")}${s}`;
	const pre = new TextEncoder().encode(`${pktLine(svc)}0000`);
	const out = new Uint8Array(pre.length + p.stdout.byteLength);
	out.set(pre);
	out.set(p.stdout, pre.length);
	return new Response(out, {
		headers: {
			"content-type": "application/x-git-receive-pack-advertisement",
			"cache-control": "no-cache",
		},
	});
}

/** POST git-receive-pack — the credential-layer verdict, then the stateless
 *  relay. The body is buffered (lane pushes are bounded, MBs) because the
 *  ref-update commands sit at its head and must be judged BEFORE any byte
 *  moves toward the origin. */
async function pushReceive(
	req: Request,
	opts: LanePushProxyOpts,
	ident: { sid: string; branch: string },
): Promise<Response> {
	const body = new Uint8Array(await req.arrayBuffer());
	const cmds = parseReceivePackCommands(body);
	if (!cmds) return json(400, { error: "lane-guard: unparseable push body" });
	const verdict = pushRefVerdict(cmds, ident.branch);
	if (!verdict.ok) {
		console.log(
			`lane-guard push DENY ${ident.sid} ${verdict.denied?.refname}: ${verdict.why}`,
		);
		return json(403, { error: verdict.why });
	}
	return relayPush(body, opts, ident.sid);
}

/** The stateless relay: the lane's pack bytes piped at the real origin with
 *  the MACHINE's credential — origin's report-status streams back verbatim. */
async function relayPush(
	body: Uint8Array,
	opts: LanePushProxyOpts,
	sid: string,
): Promise<Response> {
	const cmd = relayCommand(opts.originUrl, false);
	if (!cmd)
		return json(502, {
			error:
				"lane-guard: origin transport unsupported (local-path or ssh only)",
		});
	const proc = Bun.spawn(cmd, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	proc.stdin.write(body);
	proc.stdin.end();
	const report = await new Response(proc.stdout).text();
	const exit = await proc.exited;
	if (exit !== 0) {
		console.log(`lane-guard push relay FAIL ${sid}: exit ${exit}`);
		return json(502, {
			error: `lane-guard: origin refused the relay (exit ${exit})`,
		});
	}
	console.log(`lane-guard push OK ${sid} ${body.length}B relayed`);
	return new Response(report, {
		headers: {
			"content-type": "application/x-git-receive-pack-result",
			"cache-control": "no-cache",
		},
	});
}
