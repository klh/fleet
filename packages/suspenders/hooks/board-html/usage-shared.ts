// hooks/board-html/usage-shared.ts — the usage bundle's shared payload
// read + client-side formatting ramp + shadow-scoped panel chrome, moved
// verbatim from usage-panels.ts (W1238.6.5 decompose). The panel file and
// the extracted usage-charts.ts import from here; PanelRoot/readPayload are
// exported so the chart host can read the same #usage-data payload.
import { type CSSResultGroup, css } from "lit";
import type { UsagePanels } from "../bin/usage-chrome.ts";

// ─── shared payload read ──────────────────────────────────────────────────
export interface PanelRoot {
	slot: Record<string, string>;
	groups?: string[];
	timeline?: number[][];
	byHour?: number[][];
	panels?: UsagePanels;
}
export const readPayload = (): Partial<PanelRoot> | null => {
	const el = document.getElementById("usage-data");
	if (!el) return null;
	try {
		return JSON.parse(el.textContent ?? "") as Partial<PanelRoot>;
	} catch {
		return null;
	}
};
export const readPanels = (): UsagePanels | null =>
	readPayload()?.panels ?? null;
export const readSlot = (): Record<string, string> => readPayload()?.slot ?? {};

// ─── client-side formatting (payload carries honest numbers) ──────────────
// exported for the sibling client components (usage-cache-drill) — one
// formatting ramp across the usage bundle
export const fmtTok = (n: number): string =>
	n >= 1e9
		? `${(n / 1e9).toFixed(1)}B`
		: n >= 1e6
			? `${(n / 1e6).toFixed(1)}M`
			: n >= 1e3
				? `${(n / 1e3).toFixed(1)}K`
				: String(Math.round(n));
export const fmtChartValue = (n: number | null | undefined): string =>
	n == null || !Number.isFinite(n) ? "—" : fmtTok(n);
export const pct1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

// ─── shadow-scoped panel chrome (the u* classes each panel needs) ─────────
export const panelCss: CSSResultGroup = css`
	.upanel {
		display: block;
		background: var(--klh-surface, #1c1b19);
		border: 1px solid var(--klh-edge-soft, rgba(255, 255, 255, 0.08));
		border-radius: 3px;
		padding: 12px 14px 10px;
		margin-bottom: 14px;
	}
	.upanel h2 {
		margin: 0 0 6px;
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		color: var(--klh-dim, #98958e);
	}
	.uhead {
		display: flex;
		align-items: baseline;
		gap: 12px;
	}
	.uhead .ufoot {
		margin: 0;
	}
	.uempty {
		color: var(--klh-dim, #98958e);
		font-size: 12px;
	}
	.ufoot {
		font-size: 10.5px;
		color: var(--klh-dim, #98958e);
		margin: 2px 0 8px;
	}
	table.uacts {
		width: 100%;
		border-collapse: collapse;
		font-size: 12px;
	}
	table.uacts td,
	table.uacts th {
		padding: 6px 8px;
		border-bottom: 1px solid var(--klh-rule, rgba(255, 255, 255, 0.06));
		text-align: left;
	}
	.unum {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--klh-ink-2, #c9c6bf);
		white-space: nowrap;
	}
	.uchip {
		font-size: 10px;
		color: var(--klh-dim, #98958e);
		border: 1px solid var(--klh-edge, rgba(255, 255, 255, 0.12));
		border-radius: 2px;
		padding: 1px 6px;
		margin-left: 6px;
	}
	.ubar {
		display: flex;
		height: 12px;
		border-radius: 3px;
		overflow: hidden;
		min-width: 2px;
	}
	.ubar i {
		display: block;
		height: 100%;
	}
	.udot {
		display: inline-block;
		width: 8px;
		height: 8px;
		border-radius: 2px;
		margin-right: 6px;
	}
`;

export const slotColor = (slot: Record<string, string>, g: string): string =>
	slot[g] ?? "#888";
