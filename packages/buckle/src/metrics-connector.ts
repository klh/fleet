// One private metrics read: Buckle servicemon plus native LiteLLM Prometheus.
// The upstream URL and key path are machine-owned. Never proxy prompts,
// follow redirects, or put key material in the response or metric labels.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 2_000;

export interface MetricsConnectorOpts {
	url?: string;
	keyFile?: string;
	/** Narrow test seam; production uses fetch. */
	fetcher?: (url: URL, init: RequestInit) => Promise<Response>;
	timeoutMs?: number;
	maxBytes?: number;
}

type SourceStatus =
	| "ok"
	| "not_configured"
	| "invalid_config"
	| "key_unavailable"
	| "http_error"
	| "timeout"
	| "unavailable"
	| "too_large"
	| "wrong_content_type"
	| "empty";

interface UpstreamResult {
	status: SourceStatus;
	text: string;
	httpStatus?: number;
}

function validatedUrl(raw: string): URL | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
	if (
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		(url.pathname !== "/metrics" && url.pathname !== "/metrics/")
	)
		return null;
	return url;
}

function readPrivateKey(path: string): string | null {
	if (!isAbsolute(path)) return null;
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size < 1 ||
			stat.size > 4096 ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid())
		)
			return null;
		const key = readFileSync(path, "utf8").trim();
		return key && !/[\r\n]/.test(key) ? key : null;
	} catch {
		return null;
	}
}

async function boundedText(
	response: Response,
	limit: number,
): Promise<string | null> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) return null;
	const reader = response.body?.getReader();
	if (!reader) return "";
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > limit) {
				void reader.cancel();
				return null;
			}
			chunks.push(part.value);
		}
	} finally {
		reader.releaseLock();
	}
	const out = new Uint8Array(bytes);
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(out);
}

/** The only place Buckle fetches external metrics and combines them. */
export class MetricsConnector {
	private readonly opts: MetricsConnectorOpts;

	constructor(opts: MetricsConnectorOpts = {}) {
		this.opts = opts;
	}

	private async upstream(): Promise<UpstreamResult> {
		const raw = this.opts.url?.trim();
		const path = this.opts.keyFile?.trim();
		if (!raw && !path) return { status: "not_configured", text: "" };
		const url = raw ? validatedUrl(raw) : null;
		if (!url || !path) return { status: "invalid_config", text: "" };
		const key = readPrivateKey(path);
		if (!key) return { status: "key_unavailable", text: "" };
		const timeout = Math.min(
			Math.max(this.opts.timeoutMs ?? TIMEOUT_MS, 1),
			10_000,
		);
		const maxBytes = Math.min(
			Math.max(this.opts.maxBytes ?? MAX_BYTES, 1),
			MAX_BYTES,
		);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		try {
			const response = await (this.opts.fetcher ?? fetch)(url, {
				method: "GET",
				headers: { authorization: `Bearer ${key}` },
				redirect: "error",
				cache: "no-store",
				signal: controller.signal,
			});
			if (!response.ok)
				return { status: "http_error", text: "", httpStatus: response.status };
			const contentType = response.headers.get("content-type") ?? "";
			if (
				!contentType.startsWith("text/plain") &&
				!contentType.startsWith("application/openmetrics-text")
			)
				return { status: "wrong_content_type", text: "" };
			const text = await boundedText(response, maxBytes);
			if (text === null) return { status: "too_large", text: "" };
			if (!text.trim()) return { status: "empty", text: "" };
			return { status: "ok", text };
		} catch {
			return {
				status: controller.signal.aborted ? "timeout" : "unavailable",
				text: "",
			};
		} finally {
			clearTimeout(timer);
		}
	}

	async expose(buckleMetrics: string): Promise<Response> {
		const upstream = await this.upstream();
		const litellmUp = upstream.status === "ok" ? 1 : 0;
		const source =
			"# HELP buckle_metrics_source_up Metrics source fetched successfully.\n" +
			"# TYPE buckle_metrics_source_up gauge\n" +
			'buckle_metrics_source_up{source="buckle"} 1\n' +
			`buckle_metrics_source_up{source="litellm"} ${litellmUp}\n`;
		const body = `${source}\n${buckleMetrics.trimEnd()}\n${upstream.text.trimEnd()}\n`;
		return new Response(body, {
			headers: {
				"content-type": "text/plain; version=0.0.4; charset=utf-8",
				"cache-control": "no-store",
				"x-buckle-litellm-metrics-status": upstream.status,
				...(upstream.httpStatus
					? {
							"x-buckle-litellm-metrics-http-status": String(
								upstream.httpStatus,
							),
						}
					: {}),
			},
		});
	}
}
