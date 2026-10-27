import type { HubProfile } from "../stack-config.ts";

/** Explicit fronts win; otherwise the deploy profile identifies Buckle. */
export function hubBuckleUrl(profile: HubProfile): string | null {
	const explicit = profile.url?.trim().replace(/\/+$/, "");
	if (explicit) return explicit;
	const host = profile.host.trim().replace(/^[^@]+@/, "");
	const port = profile.buckle_port;
	if (!host || port === undefined) return null;
	if (/[/?#\s]/.test(host))
		throw new Error("hub host must be a hostname or IP address");
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
		throw new Error("hub buckle_port must be an integer from 1 to 65535");
	const authority =
		host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
	return new URL(`http://${authority}:${port}`).origin;
}
