// Buckle model catalog renderer; live data comes from Belt's read-only feeds.
const DATA_BASE = globalThis.KLH_GATEWAY_READ_BASE ?? "";
function age(iso, now) {
	if (!iso) return "—";
	var t = Math.max(0, (now - Date.parse(iso)) / 1000);
	if (t < 3600) return `${Math.max(1, Math.round(t / 60))}m`;
	if (t < 86400) return `${Math.round(t / 3600)}h`;
	return `${Math.round(t / 86400)}d`;
}
function dual(ts) {
	var d = new Date(ts);
	if (Number.isNaN(d)) return String(ts);
	var p = (n) => (n < 10 ? "0" : "") + n;
	return (
		d.toISOString().replace(/\\.\\d{3}Z$/, "Z") +
		"  (" +
		p(d.getHours()) +
		":" +
		p(d.getMinutes()) +
		":" +
		p(d.getSeconds()) +
		" local)"
	);
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
		.then((results) => {
			var s = results[0],
				feed = results[1];
			var box = document.getElementById("modelaccess");
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
			function fact(field, formatter) {
				return field?.value === null || field?.value === undefined
					? "unknown"
					: formatter(field.value);
			}
			function capability(provider, id) {
				var row = capabilityById.get(JSON.stringify([provider, id]));
				if (!row)
					return "context unknown · max output unknown · input unknown · output unknown · tools unknown · structured output unknown";
				var context = fact(
					row.contextTokens,
					(n) => `${Number(n).toLocaleString()} tokens`,
				);
				var output = fact(
					row.maxOutputTokens,
					(n) => `${Number(n).toLocaleString()} tokens`,
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
			}
			function evidence(provider, id) {
				var row = capabilityById.get(JSON.stringify([provider, id]));
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
			}
			function shortEvidence(provider, id) {
				var row = capabilityById.get(JSON.stringify([provider, id]));
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
			}
			function appendCapability(cell, provider, id) {
				var summary = document.createElement("div");
				summary.textContent = capability(provider, id);
				var provenance = document.createElement("small");
				provenance.textContent = shortEvidence(provider, id);
				provenance.title = evidence(provider, id);
				cell.append(summary, provenance);
			}
			box.replaceChildren();
			var seats = document.createElement("div");
			seats.className = "access-seats";
			[
				"IKEA Copilot · " +
					(c.state || "unobserved") +
					" · " +
					models.length +
					" selectable models",
				`Personal Claude CLI · ${s.personal?.claude || "unobserved"}`,
				`Personal ChatGPT/Codex CLI · ${s.personal?.chatgpt || "unobserved"}`,
			].forEach((t) => {
				var span = document.createElement("span");
				span.textContent = t;
				seats.append(span);
			});
			box.append(seats);
			if (c.reason) {
				const error = document.createElement("p");
				error.textContent = `Copilot catalog: ${c.reason}`;
				box.append(error);
			}
			var note = document.createElement("p");
			note.textContent =
				"Copilot models: subscription access; per-token price unreported. Local models: no posted API token price. These are not zero-cost claims.";
			box.append(note);
			var capabilityNote = document.createElement("p");
			capabilityNote.textContent =
				"Capabilities · " +
				(feed.state || "unavailable") +
				" · OpenRouter " +
				(feed.sources?.openrouter || "unavailable") +
				" · snapshot " +
				(feed.sources?.persistence || "unavailable") +
				" · checked " +
				dual(feed.observedAt);
			box.append(capabilityNote);
			function usd(value) {
				if (value === null || value === undefined) return "unreported";
				return (
					"$" +
					Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })
				);
			}
			function rate(price) {
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
			}
			var catalog = document.createElement("p");
			catalog.textContent =
				"OpenRouter public catalog · " +
				(o.state || "unavailable") +
				" · checked " +
				(o.fetchedAt ? dual(o.fetchedAt) : "never") +
				(o.reason ? ` · ${o.reason}` : "") +
				". Rates apply only when routed through OpenRouter.";
			box.append(catalog);
			[
				["FREE", routerModels.filter((m) => m.price?.status === "free")],
				[
					"Priced or unreported",
					routerModels.filter((m) => m.price?.status !== "free"),
				],
			].forEach((section) => {
				var group = document.createElement("details");
				group.className = "access-vendor";
				var heading = document.createElement("summary");
				heading.textContent = `OpenRouter ${section[0]} · ${section[1].length} models`;
				group.append(heading);
				var table = document.createElement("table");
				section[1].forEach((m) => {
					var row = document.createElement("tr");
					var name = document.createElement("td");
					var price = document.createElement("td");
					name.textContent = `${m.name} · ${m.id}`;
					price.textContent = rate(m.price);
					var detail = document.createElement("td");
					appendCapability(detail, "openrouter", m.id);
					row.append(name, price, detail);
					table.append(row);
				});
				group.append(table);
				box.append(group);
			});
			var zNote = document.createElement("p");
			zNote.textContent =
				"Z.ai published USD/1M token rates · " +
				(z.state || "unavailable") +
				" · checked " +
				(z.fetchedAt ? dual(z.fetchedAt) : "never") +
				" · source " +
				(z.source || "unreported") +
				" · account models " +
				(zAccount.state === "available" ? zAccountIds.length : "unobserved") +
				(z.reason ? ` · ${z.reason}` : "");
			box.append(zNote);
			var zGroup = document.createElement("details");
			zGroup.className = "access-vendor";
			var zHeading = document.createElement("summary");
			zHeading.textContent =
				"Z.ai model prices · " +
				zModels.length +
				" published" +
				(zAccountIds.length
					? " · " +
						zAccountIds.filter((id) => !zModels.some((m) => m.id === id))
							.length +
						" unreported account rates"
					: "");
			zGroup.append(zHeading);
			var zTable = document.createElement("table");
			var zIds = [...new Set(zAccountIds.concat(zModels.map((m) => m.id)))];
			zIds.sort(
				(a, b) =>
					Number(zAccountIds.includes(b)) - Number(zAccountIds.includes(a)) ||
					a.localeCompare(b),
			);
			zIds.forEach((id) => {
				var m = zModels.find((item) => item.id === id);
				var row = document.createElement("tr");
				var name = document.createElement("td");
				var price = document.createElement("td");
				name.textContent =
					(m?.name || id) +
					(zAccountIds.includes(id)
						? " · account visible"
						: " · published price only");
				price.textContent = rate(m?.price);
				var detail = document.createElement("td");
				appendCapability(detail, "zai", id);
				row.append(name, price, detail);
				zTable.append(row);
			});
			zGroup.append(zTable);
			box.append(zGroup);
			var byVendor = {};
			models.forEach((m) => {
				byVendor[m.vendor] ??= [];
				byVendor[m.vendor].push(m);
			});
			Object.keys(byVendor)
				.sort()
				.forEach((v) => {
					var group = document.createElement("details");
					group.className = "access-vendor";
					var heading = document.createElement("summary");
					var count = byVendor[v].length;
					heading.textContent = `${v} · ${count} model${count === 1 ? "" : "s"}`;
					group.append(heading);
					var table = document.createElement("table");
					byVendor[v].forEach((m) => {
						var row = document.createElement("tr");
						var name = document.createElement("td");
						var access = document.createElement("td");
						name.textContent = m.name;
						var responseOnly =
							m.endpoints.includes("/responses") &&
							!m.endpoints.includes("/chat/completions") &&
							!m.endpoints.includes("/v1/messages");
						var via = m.routes?.length
							? m.routes.map((route) => `local/Copilot/${route}`).join(", ")
							: responseOnly
								? "Copilot CLI · Buckle Responses needed"
								: "Copilot CLI · Buckle route not configured";
						access.textContent = `${via} · ${rate(m.price)}`;
						var detail = document.createElement("td");
						appendCapability(detail, "copilot", m.id);
						row.append(name, access, detail);
						table.append(row);
					});
					group.append(table);
					box.append(group);
				});
			var localRows = capabilityRows.filter(
				(row) => row.provider === "belt-local",
			);
			var localGroup = document.createElement("details");
			localGroup.className = "access-vendor";
			var localHeading = document.createElement("summary");
			localHeading.textContent = `Belt local models · ${localRows.length}`;
			localGroup.append(localHeading);
			var localTable = document.createElement("table");
			localRows.forEach((m) => {
				var row = document.createElement("tr");
				var name = document.createElement("td");
				var price = document.createElement("td");
				var detail = document.createElement("td");
				name.textContent = m.modelId;
				price.textContent = rate(m.cost?.value);
				appendCapability(detail, m.provider, m.modelId);
				row.append(name, price, detail);
				localTable.append(row);
			});
			localGroup.append(localTable);
			box.append(localGroup);
		})
		.catch((e) => {
			document.getElementById("modelaccess").textContent =
				`Model access unavailable · ${String(e.message || e)}`;
		});
}
tickAccess();
setInterval(tickAccess, 300000);
