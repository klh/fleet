// W503 (re-integrated W695.8.2): `fleet-loop posture [steady|plaid]` — the
// owner's runtime dispatch-posture flip. steady = fixed --target width; plaid
// (owner keywords ultrawork/plaid/rw) = work-driven width: every READY/
// resumable item dispatches until flipped back. State lives in the repo-local
// `.fleet/posture` file — no plist edit, no restart; dispatch-next reads it
// per cycle. Lives in its own module because fleet-loop.ts rides the
// 1500-line hard limit (W157).
import {
	parsePosture,
	readPosture,
	writePosture,
	POSTURES,
} from "./posture.ts";
export { readPosture };

export function postureVerb(opts: {
	argv: string[];
	repo: string;
	log: (msg: string) => void;
}): void {
	const { argv, repo, log } = opts;
	// positional mode rides IMMEDIATELY after the verb (`posture plaid`); any
	// dash-prefixed token there is a flag, not the mode — `posture --repo X`
	// is a SHOW, never a set of "--repo"
	const arg = argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
	const to = arg ? parsePosture(arg) : "show";
	if (!to) {
		console.error(
			`posture: unknown mode "${arg}" — use ${POSTURES.join(" | ")}`,
		);
		process.exit(1);
	}
	if (to !== "show") {
		writePosture(`${repo}/.fleet`, to);
		log(`POSTURE ${to}`);
	}
	console.log(`posture: ${readPosture(`${repo}/.fleet`)}`);
	process.exit(0);
}
