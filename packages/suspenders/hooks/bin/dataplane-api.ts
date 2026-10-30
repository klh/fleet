// dataplane-api.ts — W2327 v0 read-only: the dataplane's HTTP door
// (knowledge-api precedent: a Bun HTTP server, no framework). One shape:
// POST /{package}.{Service}/{Method} with a JSON body; Bearer bksk_ auth
// (buckle:dataplane:READ_); problem+json errors; host-guarded (W264).
// The dispatch table lives in lib/dataplane/methods.ts — this file owns
// routing, auth, body parsing, and error mapping only.
//   run: bun hooks/bin/dataplane-api.ts [--port N]
//   env: SUSPENDERS_DATAPLANE_PORT/BIND/VERIFY_URL/VERIFY_TOKEN
import {
	dataplaneAuthConf,
	verifyDataplaneKey,
} from "../lib/dataplane/auth.ts";
import { methodNames, resolveMethod } from "../lib/dataplane/methods.ts";
import {
	DataplaneProblem,
	problemFromError,
	problemResponse,
} from "../lib/dataplane/problems.ts";
import { openStore } from "../lib/govdb/govdb.ts";
import { projectIdentity } from "../lib/govdb/govdb-project.ts";
import { hostGuard } from "../lib/host-guard.ts";
import { servicemon } from "../lib/servicemon.ts";

const port = Number(
	process.env.SUSPENDERS_DATAPLANE_PORT ??
		(process.argv.includes("--port")
			? process.argv[process.argv.indexOf("--port") + 1]
			: 7804),
);
const BIND = process.env.SUSPENDERS_DATAPLANE_BIND ?? "127.0.0.1";
const authConf = dataplaneAuthConf();
const db = openStore();
// the graph this door serves: the repo it runs from (install = that repo's
// prefix; tests point SUSPENDERS_DATAPLANE_FLEET_ROOT at a scratch world)
const fleetRoot = process.env.SUSPENDERS_DATAPLANE_FLEET_ROOT ?? process.cwd();
const project = projectIdentity(fleetRoot);

const sm = servicemon({ service: "dataplane-api", port });

Bun.serve(
	sm.wrapped({
		port,
		hostname: BIND,
		async fetch(req) {
			const u = new URL(req.url);
			const path = u.pathname.replace(/\/$/, "") || "/";
			if (path === "/") {
				if (req.method === "GET")
					return Response.json(
						{
							ok: true,
							service: "suspenders-dataplane-api",
							methods: methodNames(),
						},
						{ headers: { "cache-control": "no-store" } },
					);
				return problemResponse("not_found", `unsupported path: ${path}`);
			}
			const denied = hostGuard(req, { bind: BIND, write: false });
			if (denied) return denied;
			if (req.method !== "POST")
				return problemResponse(
					"invalid_argument",
					`method not allowed: ${req.method} (POST only)`,
				);
			// /{pkg}.{Service}/{Method} — the method name is the path minus
			// the leading slash (AIP uniform resource face)
			const methodName = path.slice(1);
			const info = resolveMethod(methodName);
			if (!info)
				return problemResponse("not_found", `unknown method: ${methodName}`);
			const key =
				(req.headers.get("authorization") ?? "")
					.replace(/^Bearer\s+/i, "")
					.trim() || null;
			const verdict = await verifyDataplaneKey(key, info.scope, authConf);
			if (!verdict.ok) return problemResponse(verdict.code, verdict.detail);
			try {
				const body = await req.json().catch(() => ({}));
				const out = await info.handler({ db, fleetRoot, project }, body);
				return Response.json(out ?? {});
			} catch (e) {
				if (e instanceof DataplaneProblem)
					return problemFromError(e, methodName);
				console.error(`dataplane ${methodName}:`, e);
				return problemFromError(e, methodName);
			}
		},
	}),
);
console.error(`suspenders-dataplane-api: ${BIND}:${port} project=${project}`);
