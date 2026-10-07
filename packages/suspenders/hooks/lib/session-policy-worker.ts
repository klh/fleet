import { evaluateSessionPolicy } from "./session-policy.ts";
self.onmessage = (event: MessageEvent<{ repo: string; rows: unknown }>) => {
	try {
		self.postMessage({
			gaps: evaluateSessionPolicy(event.data.repo, event.data.rows),
		});
	} catch (error) {
		self.postMessage({
			error:
				error instanceof Error ? error.message : "policy evaluation failed",
		});
	}
};
