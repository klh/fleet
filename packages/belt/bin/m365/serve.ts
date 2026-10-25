// bin/m365/serve.ts — standalone M365 custom-engine agent endpoint (W261).
//   bun packages/belt/bin/m365/serve.ts [--port 4180]
// Activity in → grounded reply out; grounding via Graph Retrieval with
// delegated Entra auth. Not launchd-wired yet: activation (real tenant app)
// gates that — see docs/m365-agent.md.
import { defaultDeps, m365AgentFetch } from "./agent-endpoint.ts";

const portFlag = process.argv.indexOf("--port");
const port = portFlag >= 0 ? Number(process.argv[portFlag + 1]) : 4180;

Bun.serve({
	port,
	hostname: "127.0.0.1",
	fetch: m365AgentFetch(defaultDeps(process.env)),
});
console.log(`belt m365 agent on http://127.0.0.1:${port}/api/m365/agent`);
