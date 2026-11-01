// Buckle model catalog renderer; live data comes from Belt's read-only feeds.
// W2269.1.2: rewritten as a lit-html leaf — one render() into the host page's
// existing light-DOM #modelaccess container (the suspenders console owns the
// .access-seats/.access-vendor CSS there; shadow DOM would orphan it). Text
// strings are byte-stable with the retired createElement version: the
// belt-dashboard parity spec asserts them verbatim.
import { html, render } from "./vendor/lit.js";
import { dualStamp as dual } from "./dashboard-wallclock.js"; // W902: one stamp vocabulary

const DATA_BASE = globalThis.KLH_GATEWAY_READ_BASE ?? "";
function age(iso, now) {
	if (!iso) return "—";
	var t = Math.max(0, (now - Date.parse(iso)) / 1000);
	if (t < 3600) return `${Math.max(1, Math.round(t / 60))}m`;
	if (t < 86400) return `${Math.round(t / 3600)}h`;
	return `${Math.round(t / 86400)}d`;
}

function tickAccess() {
	Promise.all(
		["/api/model-access", "/api/model-capabilities"].map((path) =>
			fetch(DATA_BASE + path).then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`);
				return r.json();
			}),
		),
	)
		.then(([s, feed]) => {
			var c = s.copilot || {};
			var models = c.models || [];
			var o = s.openrouter || {};
			var routerModels = o.models || [];
			var z = s.zaiPricing || {};
			var zModels = z.models || [];
			var zAccount = s.zaiAccount || {};
			var zAccountIds = zAccount.modelIds || [];
			var capabilityRows = feed.records || [];
			var capabilityById = new Map(
				capabilityRows.map((row) => [
					JSON.stringify([row.provider, row.modelId]),
					row,
				]),
			);
			const fact = (field, formatter) =>
				field?.value === null || field?.value === undefined
					? "unknown"
					: formatter(field.value);
			const capabilityText = (row) => {
				if (!row)
					return "context unknown · max output unknown · input unknown · output unknown · tools unknown · structured output unknown";
				var context = fact(
					row.contextTokens,
					(n) => `${Number(n).toLocaleString("en-US")} tokens`,
				);
				var output = fact(
					row.maxOutputTokens,
					(n) => `${Number(n).toLocaleString("en-US")} tokens`,
				);
				return (
					"context " +
					context +
					" · max output " +
					output +
					" · input " +
					fact(row.inputModalities, (v) => v.join(", ")) +
					" · output " +
					fact(row.outputModalities, (v) => v.join(", ")) +
					" · tools " +
					fact(row.tools, (v) => (v ? "yes" : "no")) +
					" · structured " +
					fact(row.structuredOutput, (v) => (v ? "yes" : "no"))
				);
			};
			const evidenceText = (row) => {
				if (!row) return "Capability source unavailable";
				var field = row.contextTokens?.source
					? row.contextTokens
					: row.locality;
				return (
					"Capability: " +
					(field?.source || "unreported") +
					" · checked " +
					(field?.observedAt ? dual(field.observedAt) : "never") +
					" · price: " +
					(row.cost?.source || "unreported") +
					" · checked " +
					(row.cost?.observedAt ? dual(row.cost.observedAt) : "never")
				);
			};
			const shortEvidenceText = (row) => {
				if (!row) return "source unreported";
				var field = row.contextTokens?.source
					? row.contextTokens
					: row.locality;
				var source = field?.source || "unreported";
				try {
					source = new URL(source).host;
				} catch (_) {}
				return (
					"source " +
					source +
					" · capabilities " +
					(field?.observedAt
						? age(field.observedAt, Date.now())
						: "unobserved") +
					" · price " +
					(row.cost?.observedAt
						? age(row.cost.observedAt, Date.now())
						: "unreported")
				);
			};
			// one capability cell: summary line + provenance small (title = full evidence)
			const capabilityCell = (row) =>
				html`<td>
					<div>${capabilityText(row)}</div>
					<small title=${evidenceText(row)}>${shortEvidenceText(row)}</small>
				</td>`;
			const usd = (value) => {
				if (value === null || value === undefined) return "unreported";
				return (
					"$" +
					Number(value).toLocaleString("en-US", {
						maximumFractionDigits: 4,
					})
				);
			};
			const rate = (price) => {
				if (!price || price.status === "unknown")
					return price?.note || "token price unreported";
				if (price.status === "included-unreported")
					return "subscription access · token price unreported";
				if (price.status === "local-unpriced")
					return "local runtime · no posted API token price";
				if (price.status === "free")
					return "FREE · $0 in / $0 out per 1M tokens";
				return (
					usd(price.inputUsdPerMillion) +
					" in / " +
					usd(price.outputUsdPerMillion) +
					" out per 1M tokens" +
					(price.requestUsd > 0
						? ` · ${usd(price.requestUsd)} per request`
						: "") +
					(price.note ? ` · ${price.note}` : "")
				);
			};
			var byVendor = {};
			models.forEach((m) => {
				byVendor[m.vendor] ??= [];
				byVendor[m.vendor].push(m);
			});
			var copilotVia = (m) => {
				var responseOnly =
					m.endpoints.includes("/responses") &&
					!m.endpoints.includes("/chat/completions") &&
					!m.endpoints.includes("/v1/messages");
				return m.routes?.length
					? m.routes.map((route) => `local/Copilot/${route}`).join(", ")
					: responseOnly
						? "Copilot CLI · Buckle Responses needed"
						: "Copilot CLI · Buckle route not configured";
			};
			var zIds = [...new Set(zAccountIds.concat(zModels.map((m) => m.id)))];
			zIds.sort(
				(a, b) =>
					Number(zAccountIds.includes(b)) - Number(zAccountIds.includes(a)) ||
					a.localeCompare(b),
			);
			// the template mirrors the retired DOM shape node-for-node:
			// seats line, copilot reason, two standing notes, catalog note,
			// OpenRouter groups, Z.ai note + group, per-vendor copilot groups,
			// belt-local group. All text byte-stable with the old renderer.
			render(
				html`<div class="access-seats">
						<span>IKEA Copilot · ${c.state || "unobserved"} · ${models.length}
							selectable models</span
						>
						<span>Personal Claude CLI · ${s.personal?.claude || "unobserved"}</span>
						<span>
							Personal ChatGPT/Codex CLI · ${
								s.personal?.chatgpt || "unobserved"
							}</span
						>
					</div>
					${c.reason ? html`<p>Copilot catalog: ${c.reason}</p>` : ""}
					<p>
						Copilot models: subscription access; per-token price unreported.
						Local models: no posted API token price. These are not zero-cost
						claims.
					</p>
					<p>
						Capabilities · ${feed.state || "unavailable"} · OpenRouter ${
							feed.sources?.openrouter || "unavailable"
						} · snapshot ${
							feed.sources?.persistence || "unavailable"
						} · checked ${dual(feed.observedAt)}
					</p>
					<p>
						OpenRouter public catalog · ${o.state || "unavailable"} · checked
						${o.fetchedAt ? dual(o.fetchedAt) : "never"}${
							o.reason ? ` · ${o.reason}` : ""
						}. Rates apply only when routed through OpenRouter.
					</p>
					${[
						["FREE", routerModels.filter((m) => m.price?.status === "free")],
						[
							"Priced or unreported",
							routerModels.filter((m) => m.price?.status !== "free"),
						],
					].map(
						([label, section]) =>
							html`<details class="access-vendor">
								<summary>
									OpenRouter ${label} · ${section.length} models
								</summary>
								<table>
									${section.map(
										(m) =>
											html`<tr>
												<td>${m.name} · ${m.id}</td>
												<td>${rate(m.price)}</td>
												${capabilityCell(
													capabilityById.get(
														JSON.stringify(["openrouter", m.id]),
													),
												)}
											</tr>`,
									)}
								</table>
							</details>`,
					)}
					<p>
						Z.ai published USD/1M token rates · ${z.state || "unavailable"} ·
						checked ${z.fetchedAt ? dual(z.fetchedAt) : "never"} · source ${
							z.source || "unreported"
						} · account models ${
							zAccount.state === "available" ? zAccountIds.length : "unobserved"
						}${z.reason ? ` · ${z.reason}` : ""}
					</p>
					<details class="access-vendor">
						<summary>
							Z.ai model prices · ${zModels.length} published${
								zAccountIds.length
									? ` · ${
											zAccountIds.filter(
												(id) => !zModels.some((m) => m.id === id),
											).length
										} unreported account rates`
									: ""
							}
						</summary>
						<table>
							${zIds.map((id) => {
								const m = zModels.find((item) => item.id === id);
								return html`<tr>
									<td>
										${m?.name || id}${
											zAccountIds.includes(id)
												? " · account visible"
												: " · published price only"
										}
									</td>
									<td>${rate(m?.price)}</td>
									${capabilityCell(
										capabilityById.get(JSON.stringify(["zai", id])),
									)}
								</tr>`;
							})}
						</table>
					</details>
					${Object.keys(byVendor)
						.sort()
						.map(
							(v) =>
								html`<details class="access-vendor">
									<summary>
										${v} · ${byVendor[v].length} model${
											byVendor[v].length === 1 ? "" : "s"
										}
									</summary>
									<table>
										${byVendor[v].map(
											(m) =>
												html`<tr>
													<td>${m.name}</td>
													<td>${copilotVia(m)} · ${rate(m.price)}</td>
													${capabilityCell(
														capabilityById.get(
															JSON.stringify(["copilot", m.id]),
														),
													)}
												</tr>`,
										)}
									</table>
								</details>`,
						)}
					${html`<details class="access-vendor">
						<summary>Belt local models · ${
							capabilityRows.filter((row) => row.provider === "belt-local")
								.length
						}</summary>
						<table>
							${capabilityRows
								.filter((row) => row.provider === "belt-local")
								.map(
									(m) =>
										html`<tr>
											<td>${m.modelId}</td>
											<td>${rate(m.cost?.value)}</td>
											${capabilityCell(m)}
										</tr>`,
								)}
						</table>
					</details>`}`,
				document.getElementById("modelaccess"),
			);
		})
		.catch((e) => {
			document.getElementById("modelaccess").textContent =
				`Model access unavailable · ${String(e.message || e)}`;
		});
}
tickAccess();
setInterval(tickAccess, 300000);
