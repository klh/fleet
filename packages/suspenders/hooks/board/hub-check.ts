// hooks/board/hub-check.ts — W858.7.21: the Setup tab's hub reachability
// check, extracted from data.ts (1500-line decompose). One bounded probe per
// configured hub (first candidate — the registry is precedence-ordered);
// hubs inside a stack.json dark window are EXPECTED down (NAS nightly
// poweroff, W483) and skip the probe. No registry = trivially ok.
//
// Failure UX (this item): the detail names the hub AND the measured probe
// URL; the fix is a SAFE concrete command — hubctl's read-only status verb
// (read subcommands: status|list|checkupdate|version), never a restart/mint
// verb. Grouping ("Local wiring" / "Remote reachability") is presentation —
// it lives in the client chunk (board-html/setup.ts).
import { readRegistry } from "../lib/hub/hub-locate.ts";
import { darkHubNow } from "../lib/stack-config.ts";

const probeHub = async (base: string): Promise<boolean> => {
	try {
		await fetch(`${base.replace(/\/$/, "")}/api/health`, {
			signal: AbortSignal.timeout(1200),
		});
		return true;
	} catch {
		return false;
	}
};

export interface HubCheckResult {
	ok: boolean;
	detail: string;
	fix: string | null;
}

export async function hubCheck(): Promise<HubCheckResult> {
	const reg = readRegistry();
	const entries = Object.entries(reg).filter(([label]) => label.trim());
	if (!entries.length)
		return { ok: true, detail: "no hubs configured", fix: null };
	return probeHubRows(entries);
}

interface HubProbeRow {
	label: string;
	url: string | null;
	ok: boolean;
	detail: string;
}

async function probeRow(
	label: string,
	entry: { candidates?: string[] },
): Promise<HubProbeRow> {
	const url = entry?.candidates?.[0];
	if (!url)
		return {
			label,
			url: null,
			ok: true,
			detail: `${label}: no candidates listed`,
		};
	if (darkHubNow(label))
		return {
			label,
			url: null,
			ok: true,
			detail: `${label}: dark window (expected down)`,
		};
	const up = await probeHub(url);
	return {
		label,
		url,
		ok: up,
		detail: up ? `${label} answers` : `${label} no answer at ${url}`,
	};
}

async function probeHubRows(
	entries: [string, { candidates?: string[] }][],
): Promise<{ ok: boolean; detail: string; fix: string | null }> {
	const rows = await Promise.all(
		entries.map(([label, entry]) => probeRow(label, entry)),
	);
	const down = rows.filter((r) => !r.ok);
	// detail = hub identity + measured probe URL; fix = the safe read-only
	// status verb for the first down hub.
	const firstDown = down.find((r) => r.label && r.url);
	return {
		ok: down.length === 0,
		detail:
			down.map((r) => r.detail).join("; ") ||
			rows.map((r) => r.detail).join("; "),
		fix: firstDown ? `bun deploy/hubctl.ts status ${firstDown.label}` : null,
	};
}
