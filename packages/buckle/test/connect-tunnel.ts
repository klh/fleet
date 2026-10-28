// test/connect-tunnel.ts — W2173.7 shared raw-CONNECT client helpers for the
// egress test files (single definition, imported — helpers live in modules,
// not duplicated inline).
import type { EgressSocket } from "../src/connect-egress.ts";

export interface TunnelResult {
	status: string;
	sock: EgressSocket | null;
}

/** Raw CONNECT client: sends the request, resolves with the answer head the
 *  moment "\r\n\r\n" arrives (tunnel stays open for the data phase). */
export const openTunnel = (
	port: number,
	authority: string,
	auth: string | null,
	onData?: (d: Uint8Array) => void,
): Promise<TunnelResult> =>
	new Promise((res) => {
		let buf = "";
		let settled = false;
		const settle = (r: TunnelResult): void => {
			if (settled) return;
			settled = true;
			res(r);
		};
		void Bun.connect({
			hostname: "127.0.0.1",
			port,
			socket: {
				data: (s, d) => {
					if (settled) {
						onData?.(d);
						return;
					}
					buf += new TextDecoder().decode(d);
					const i = buf.indexOf("\r\n\r\n");
					if (i >= 0) {
						settled = true;
						res({ status: buf.slice(0, i), sock: s as EgressSocket });
					}
				},
				close: () => settle({ status: buf, sock: null }),
				error: () => settle({ status: buf, sock: null }),
			},
		}).then(
			(s) => {
				const head = [
					`CONNECT ${authority} HTTP/1.1`,
					...(auth ? [`Proxy-Authorization: ${auth}`] : []),
				].join("\r\n");
				s.write(`${head}\r\n\r\n`);
			},
			() => settle({ status: "", sock: null }),
		);
	});

/** Poll until f() holds; throws on deadline (bounded test waits). */
export const until = async (f: () => boolean, ms = 2000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!f()) {
		if (Date.now() > deadline) throw new Error("until: timeout");
		await new Promise((r) => setTimeout(r, 20));
	}
};
