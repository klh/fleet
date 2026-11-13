// Buckle-owned installation console. The static shell is public; its network
// snapshot rides the existing proxy READ_ gate in server.ts.
import type { AppDeps } from "./app-deps.ts";
import { resolveNetworkDbPaths } from "./network-read-model.ts";
import { topologySnapshot } from "./topology-read-model.ts";

const ENTRY = new URL("../console/app.ts", import.meta.url).pathname;
const BUILT = new URL("../console/app.js", import.meta.url).pathname;
let bundle: Promise<string> | undefined;

const script = (): Promise<string> =>
	(bundle ??= (async () => {
		const built = Bun.file(BUILT);
		if (await built.exists()) return built.text();
		const result = await Bun.build({
			entrypoints: [ENTRY],
			target: "browser",
			format: "esm",
			minify: true,
		});
		const output = result.outputs[0];
		if (!result.success || result.outputs.length !== 1 || !output)
			throw new Error("Buckle console bundle failed");
		return output.text();
	})());

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Buckle</title>
  <style>html,body{margin:0;min-height:100%;background:#131313;color:#eee}</style>
  <script type="module" src="/console/app.js"></script>
</head>
<body><buckle-console></buckle-console></body>
</html>`;

const headers = {
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"content-security-policy":
		"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
};

export async function consoleRoute(
	req: Request,
	deps: AppDeps,
): Promise<Response | null> {
	const path = new URL(req.url).pathname;
	if (
		path !== "/console" &&
		path !== "/console/" &&
		path !== "/console/app.js" &&
		path !== "/console/data"
	)
		return null;
	if (req.method !== "GET" && req.method !== "HEAD")
		return new Response("method not allowed", {
			status: 405,
			headers: { allow: "GET, HEAD" },
		});
	if (path === "/console" || path === "/console/")
		return new Response(req.method === "HEAD" ? null : page, {
			headers: { ...headers, "content-type": "text/html; charset=utf-8" },
		});
	if (path === "/console/app.js")
		return new Response(req.method === "HEAD" ? null : await script(), {
			headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
		});

	const paths = resolveNetworkDbPaths(process.env);
	const topology = topologySnapshot(paths, Date.now, deps.hubId ?? "local");
	const snapshot = {
		hub: deps.hubId ?? "local",
		observedAt: topology.ok ? topology.observedAt : null,
		topology: topology.ok
			? {
					hubs: topology.hubs,
					targets: topology.targets,
					edges: topology.edges.map(
						({ id, from, to, requests, failed, active }) => ({
							id,
							from,
							to,
							requests,
							failed,
							active,
						}),
					),
					totals: topology.totals,
					coverage: {
						projectionAvailable: topology.coverage.projectionAvailable,
						ledgerAvailable: topology.coverage.ledgerAvailable,
					},
				}
			: null,
	};
	return new Response(req.method === "HEAD" ? null : JSON.stringify(snapshot), {
		headers: { ...headers, "content-type": "application/json; charset=utf-8" },
	});
}
