// hooks/board-html/usage-panels.ts — W652.3.1: the usage-dashboard bundle
// entry. W1298 decomposition: the panel components live verbatim in
// per-component modules (usage-header/-tiles/-actors/-aids/-activity/-spokes/
// -crosshub/-drilldown/-charts over usage-shared.ts); this entry only imports
// and registers them. Built by `bun run build:vendor` into
// hooks/board-html/vendor/ (one shared lit runtime chunk) and served at
// /vendor/usage-panels.js by the board's /vendor/ allowlist.
import { KlhUsageHeader } from "./usage-header.ts";
import { KlhUsageTiles } from "./usage-tiles.ts";
import { KlhUsageActors } from "./usage-actors.ts";
import { KlhUsageAids } from "./usage-aids.ts";
import { KlhUsageActivity } from "./usage-activity.ts";
import { KlhUsageSpokes } from "./usage-spokes.ts";
import { KlhUsageCrossHub } from "./usage-crosshub.ts";
import { KlhUsageDrilldown } from "./usage-drilldown.ts";
import { KlhUsageCharts } from "./usage-charts.ts";
// W695.3.5: the page head rides the same bundle (side-effect registers it)
import "./klh-usage-head.ts";
// W825: the cache drilldown rides the same bundle (side-effect registers it)
import "./usage-cache-drill.ts";
// W858.11: the coverage/freshness evidence panel rides the same bundle
import "./usage-coverage.ts";
// W995: the drilldown monitor rides the same bundle (side-effect registers it)
import "./usage-monitor.ts";

customElements.define("klh-usage-header", KlhUsageHeader);
customElements.define("klh-usage-tiles", KlhUsageTiles);
customElements.define("klh-usage-actors", KlhUsageActors);
customElements.define("klh-usage-aids", KlhUsageAids);
customElements.define("klh-usage-activity", KlhUsageActivity);
customElements.define("klh-usage-spokes", KlhUsageSpokes);
customElements.define("klh-usage-crosshub", KlhUsageCrossHub);
customElements.define("klh-usage-drilldown", KlhUsageDrilldown);
customElements.define("klh-usage-charts", KlhUsageCharts);

declare global {
	interface HTMLElementTagNameMap {
		"klh-usage-header": KlhUsageHeader;
		"klh-usage-tiles": KlhUsageTiles;
		"klh-usage-actors": KlhUsageActors;
		"klh-usage-aids": KlhUsageAids;
		"klh-usage-activity": KlhUsageActivity;
		"klh-usage-spokes": KlhUsageSpokes;
		"klh-usage-crosshub": KlhUsageCrossHub;
		"klh-usage-drilldown": KlhUsageDrilldown;
		"klh-usage-charts": KlhUsageCharts;
	}
}
