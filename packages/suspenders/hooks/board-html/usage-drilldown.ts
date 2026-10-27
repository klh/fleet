// hooks/board-html/usage-drilldown.ts — <klh-usage-drilldown>, moved
// verbatim from usage-panels.ts in the W1298 decomposition: one real hourly
// bucket (day/hour pickers, actors × models table) over /api/usage/hour.
import { css, html, LitElement, nothing, type TemplateResult } from "lit";
import type { UsageReport } from "../lib/usage/usage.ts";
import { fmtTok, panelCss, readPayload } from "./usage-shared.ts";

// ─── <klh-usage-drilldown> — one real hourly bucket, actor and model ───────
export class KlhUsageDrilldown extends LitElement {
	static properties = {
		bucket: { type: Number, state: true },
		hours: { type: Array, state: true },
		report: { type: Object, state: true },
		error: { type: String, state: true },
		loading: { type: Boolean, state: true },
	};

	declare bucket: number;
	declare hours: number[];
	declare report: UsageReport | null;
	declare error: string;
	declare loading: boolean;
	private dayKey(hour: number): string {
		const d = new Date(hour);
		const p = (n: number): string => String(n).padStart(2, "0");
		return `${String(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
	}

	private dayLabel(day: string): string {
		const [year, month, date] = day.split("-");
		return `${date}.${month}.${year?.slice(-2)}`;
	}

	private hourLabel(hour: number): string {
		return `${String(new Date(hour).getHours()).padStart(2, "0")}:00`;
	}
	private requestId = 0;

	constructor() {
		super();
		this.bucket = 0;
		this.hours = [];
		this.report = null;
		this.error = "";
		this.loading = false;
	}

	protected connectedCallback(): void {
		super.connectedCallback();
		const timeline = readPayload()?.timeline ?? [];
		const x = timeline[0] ?? [];
		this.hours = x
			.map((seconds, i) => ({
				bucket: seconds * 1000,
				tokens: timeline
					.slice(1)
					.reduce((n, series) => n + (series[i] ?? 0), 0),
			}))
			.filter((p) => p.tokens > 0)
			.map((p) => p.bucket)
			.reverse();
		const requested = Number(new URLSearchParams(location.search).get("hour"));
		this.bucket = this.hours.includes(requested)
			? requested
			: (this.hours[0] ?? 0);
		if (this.bucket) this.refresh();
	}

	private refresh(): void {
		const requestId = ++this.requestId;
		const params = new URLSearchParams(location.search);
		params.set("bucket", String(this.bucket));
		params.delete("hour");
		this.loading = true;
		this.error = "";
		fetch(`/api/usage/hour?${params.toString()}`, {
			signal: AbortSignal.timeout(15_000),
		})
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${String(r.status)}`);
				return r.json() as Promise<{ report: UsageReport }>;
			})
			.then((body) => {
				if (requestId !== this.requestId) return;
				this.report = body.report;
				this.loading = false;
			})
			.catch((e) => {
				if (requestId !== this.requestId) return;
				this.error = String((e as Error).message ?? e);
				this.loading = false;
			});
	}

	private selectHour(hour: number): void {
		this.bucket = hour;
		const url = new URL(location.href);
		url.searchParams.set("hour", String(hour));
		history.replaceState(null, "", url);
		this.refresh();
	}

	protected render(): TemplateResult {
		if (!this.hours.length) return html``;
		const days = [...new Set(this.hours.map((hour) => this.dayKey(hour)))];
		const selectedDay = this.dayKey(this.bucket);
		const dayHours = this.hours.filter(
			(hour) => this.dayKey(hour) === selectedDay,
		);
		const rows =
			this.report?.actors.flatMap((actor) =>
				actor.byModel.map((model) => ({ actor: actor.actor, ...model })),
			) ?? [];
		return html`<div class="upanel" id="usage-hour">
			<div class="uhead">
				<h2>HOUR DETAIL</h2>
				<p class="ufoot">Select a day and hour to inspect its actors and models.</p>
			</div>
			<label class="hour-picker">day
				<select
					@change=${(e: Event) => {
						const day = (e.target as HTMLSelectElement).value;
						const hour = this.hours.find((h) => this.dayKey(h) === day);
						if (hour !== undefined) this.selectHour(hour);
					}}
				>
					${days.map((day) => html`<option value=${day} ?selected=${day === selectedDay}>${this.dayLabel(day)}</option>`)}
				</select>
			</label>
			<label class="hour-picker">hour
				<select
					@change=${(e: Event) => this.selectHour(Number((e.target as HTMLSelectElement).value))}
					title=${new Date(this.bucket).toISOString()}
				>
					${dayHours.map((hour) => html`<option value=${String(hour)} ?selected=${hour === this.bucket} title=${new Date(hour).toISOString()}>${this.hourLabel(hour)}</option>`)}
				</select>
			</label>
			${this.loading ? html`<p class="uempty">Loading hour…</p>` : nothing}
			${this.error ? html`<p class="uempty" role="alert">Hour detail unavailable: ${this.error}</p>` : nothing}
			${!this.loading && !this.error && rows.length === 0 ? html`<p class="uempty">No attributed usage in this hour.</p>` : nothing}
			${
				!this.loading && !this.error && rows.length > 0
					? html`<div class="hour-scroll"><table class="uacts">
				<thead><tr><th>actor</th><th>model</th><th>group</th><th>input</th><th>cache read</th><th>cache write</th><th>output</th><th>requests</th></tr></thead>
				<tbody>${rows.map((row) => html`<tr><td>${row.actor}</td><td>${row.model}</td><td>${row.group}</td><td>${fmtTok(row.i)}</td><td>${fmtTok(row.cr)}</td><td>${fmtTok(row.cc)}</td><td>${fmtTok(row.o)}</td><td>${String(row.rq)}</td></tr>`)}</tbody>
			</table></div>`
					: nothing
			}
		</div>`;
	}
}

KlhUsageDrilldown.styles = [
	panelCss,
	css`
	.hour-picker { display: flex; align-items: center; gap: 8px; margin: 10px 0; color: var(--klh-dim); font-size: 11px; }
	.hour-picker select { background: var(--klh-surface); color: var(--klh-ink); border: 1px solid var(--klh-edge); padding: 5px; }
	.hour-scroll { overflow-x: auto; }
`,
];
