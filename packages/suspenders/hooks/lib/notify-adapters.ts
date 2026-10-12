// hooks/lib/notify-adapters.ts — W695.2: channel adapters for notify.ts.
// desktop = osascript (argv array, never shell-interpolated), slack =
// incoming-webhook POST, email = a minimal SMTP submission client (EHLO →
// STARTTLS → AUTH PLAIN → MAIL/RCPT/DATA) so there is no mail dependency.
// Credentials come from runtime config only: ~/.gmail.env (mode 600) paths
// and var names from notify.yaml — the repo carries none.
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";
import type {
	ChannelName,
	Notification,
	NotifyConfig,
	Sender,
} from "./notify.ts";

// ---- desktop --------------------------------------------------------------
export const osascriptArgv = (n: Notification): string[] => [
	"osascript",
	"-e",
	"on run argv",
	"-e",
	"display notification (item 2 of argv) with title (item 1 of argv)",
	"-e",
	"end run",
	n.title,
	n.body.slice(0, 240),
];

export const desktopSender =
	(run: (argv: string[]) => Promise<number> = spawnArgv): Sender =>
	async (n) => {
		const code = await run(osascriptArgv(n));
		if (code !== 0) throw new Error(`osascript exit ${code}`);
	};

async function spawnArgv(argv: string[]): Promise<number> {
	const p = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
	return await p.exited;
}

// ---- slack ----------------------------------------------------------------
export const slackSender =
	(
		url: string,
		post: typeof fetch = fetch,
		timeoutMs = 10_000,
	): Sender =>
	async (n) => {
		const res = await post(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: `*${n.title}*\n${n.body}` }),
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!res.ok) throw new Error(`slack HTTP ${res.status}`);
	};

// ---- email (SMTP) ---------------------------------------------------------
export interface SmtpOpts {
	host: string;
	port: number;
	user: string;
	pass: string;
	from: string;
	to: string[];
	/** false only for the local fake-server tests */
	starttls?: boolean;
	timeoutMs?: number;
}

/** `KEY=value` lines (optional `export`, optional quotes). Mode 600 enforced. */
export function readEnvFile(path: string): Record<string, string> {
	const st = statSync(path);
	if ((st.mode & 0o077) !== 0)
		throw new Error(`${path} must be mode 600 (credentials file)`);
	const out: Record<string, string> = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
		if (!m) continue;
		out[m[1] as string] = (m[2] as string)
			.trim()
			.replace(/^(['"])(.*)\1$/, "$2");
	}
	return out;
}

class SmtpConn {
	private buf = "";
	private waiters: (() => void)[] = [];
	constructor(
		public sock: net.Socket,
		private timeoutMs: number,
	) {
		this.attach(sock);
	}
	private attach(s: net.Socket): void {
		s.on("data", (d) => {
			this.buf += d.toString("utf8");
			for (const w of this.waiters.splice(0)) w();
		});
		s.on("error", () => {
			for (const w of this.waiters.splice(0)) w();
		});
	}
	upgrade(host: string): Promise<void> {
		const t = tls.connect({ socket: this.sock, servername: host });
		this.sock = t;
		this.attach(t);
		return new Promise((res, rej) => {
			t.once("secureConnect", () => res());
			t.once("error", rej);
		});
	}
	/** one full reply (multi-line `250-…` ends at `250 …`) → [code, text] */
	async reply(): Promise<[number, string]> {
		const deadline = Date.now() + this.timeoutMs;
		for (;;) {
			const lines = this.buf.split("\r\n");
			const done = lines.findIndex((l) => /^\d{3} /.test(l));
			if (done >= 0) {
				const text = lines.slice(0, done + 1).join("\n");
				this.buf = lines.slice(done + 1).join("\r\n");
				return [Number(text.slice(0, 3)), text];
			}
			if (this.sock.destroyed) throw new Error("smtp: connection closed");
			const left = deadline - Date.now();
			if (left <= 0) throw new Error("smtp: timeout");
			await new Promise<void>((r) => {
				this.waiters.push(r);
				setTimeout(r, Math.min(left, 250));
			});
		}
	}
	async cmd(line: string, ok: number[]): Promise<string> {
		this.sock.write(`${line}\r\n`);
		const [code, text] = await this.reply();
		if (!ok.includes(code)) throw new Error(`smtp ${code}: ${line.split(" ")[0]}`);
		return text;
	}
}

const header = (s: string): string => s.replace(/[\r\n]+/g, " ");

export function buildMessage(o: SmtpOpts, n: Notification): string {
	const body = n.body
		.replace(/\r?\n/g, "\r\n")
		.replace(/^\./gm, "..");
	return [
		`From: ${header(o.from)}`,
		`To: ${o.to.map(header).join(", ")}`,
		`Subject: ${header(n.title)}`,
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
		"",
	].join("\r\n");
}

export async function sendSmtp(o: SmtpOpts, n: Notification): Promise<void> {
	const timeoutMs = o.timeoutMs ?? 15_000;
	const conn = new SmtpConn(net.connect(o.port, o.host), timeoutMs);
	try {
		const [greet] = await conn.reply();
		if (greet !== 220) throw new Error(`smtp greeting ${greet}`);
		await conn.cmd("EHLO suspenders", [250]);
		if (o.starttls !== false) {
			await conn.cmd("STARTTLS", [220]);
			await conn.upgrade(o.host);
			await conn.cmd("EHLO suspenders", [250]);
		}
		const plain = Buffer.from(`\0${o.user}\0${o.pass}`).toString("base64");
		await conn.cmd(`AUTH PLAIN ${plain}`, [235]);
		await conn.cmd(`MAIL FROM:<${o.from}>`, [250]);
		for (const r of o.to) await conn.cmd(`RCPT TO:<${r}>`, [250, 251]);
		await conn.cmd("DATA", [354]);
		await conn.cmd(`${buildMessage(o, n)}\r\n.`, [250]);
		await conn.cmd("QUIT", [221]).catch(() => "");
	} finally {
		conn.sock.destroy();
	}
}

export const emailSender =
	(
		cfg: NonNullable<NotifyConfig["channels"]["email"]>,
		send: typeof sendSmtp = sendSmtp,
	): Sender =>
	async (n) => {
		// credentials are read at send time: rotation needs no restart
		const env = readEnvFile(cfg.env_file ?? "");
		const user = env[cfg.user_var ?? "GMAIL_USER"];
		const pass = env[cfg.pass_var ?? "GMAIL_APP_PASSWORD"];
		if (!user || !pass) throw new Error("email credentials absent in env_file");
		const to = cfg.to?.length ? cfg.to : [user];
		await send(
			{
				host: cfg.host ?? "smtp.gmail.com",
				port: cfg.port ?? 587,
				user,
				pass,
				from: cfg.from ?? user,
				to,
			},
			n,
		);
	};

/** Build only the senders the config actually enables; the rest are simply
 *  absent (the notifier counts them as skipped, never an error). */
export function sendersFor(
	cfg: NotifyConfig,
	home: string,
): Partial<Record<ChannelName, Sender>> {
	const out: Partial<Record<ChannelName, Sender>> = {};
	if (cfg.channels.desktop?.enabled && process.platform === "darwin")
		out.desktop = desktopSender();
	const hook = cfg.channels.slack;
	let url = hook?.webhook_url;
	if (!url && hook?.webhook_url_file) {
		try {
			url = readFileSync(hook.webhook_url_file, "utf8").trim();
		} catch {}
	}
	if (url) out.slack = slackSender(url);
	const em = cfg.channels.email;
	if (em?.env_file) {
		out.email = emailSender({
			...em,
			env_file: em.env_file.replace(/^~(?=\/)/, home),
		});
	}
	return out;
}
