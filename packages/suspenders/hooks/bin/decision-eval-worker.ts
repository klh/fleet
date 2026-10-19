// One detached board evaluation. The board may restart while a model works;
// the result and terminal status are written to the governor facts ledger.
import { evaluateDecision, finishDecisionEval } from "../board/decide-eval.ts";

const id = Number(process.argv[2]);
const runId = process.argv[3] ?? "";
if (!Number.isSafeInteger(id) || id <= 0 || !runId) {
	console.error("usage: decision-eval-worker <decision-id> <run-id>");
	process.exit(2);
}

try {
	await evaluateDecision(id);
	finishDecisionEval(id, runId, null);
} catch (error) {
	finishDecisionEval(
		id,
		runId,
		error instanceof Error ? error.message : String(error),
	);
	process.exitCode = 1;
}
