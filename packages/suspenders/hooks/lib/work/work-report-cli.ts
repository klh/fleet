// hooks/lib/work-report-cli.ts — W1199: the two work-CLI report faces over
// emitReportFromMd. The close face (done --report) never fails the closure —
// a broken artifact is printed, not thrown; the post-close face (report
// verb) is strict. The markdown stays the record; the .html is the view.
import { emitReportFromMd } from "./report-html.ts";

type ReportStore = {
	query: (sql: string) => { run: (...p: unknown[]) => unknown };
};

export async function attachCloseReport(args: {
	db: ReportStore;
	project: string;
	item: string;
	title: string;
	mdPath: string;
	sha?: string | null;
}): Promise<void> {
	try {
		const artifact = await emitReportFromMd(args);
		console.log(`▸ report → ${artifact.path}`);
	} catch (error) {
		console.error(
			`report artifact failed (closure stands): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

export async function regenReport(args: {
	db: ReportStore;
	project: string;
	item: string;
	title: string;
	mdPath: string;
	sha?: string | null;
}): Promise<{ path: string; bytes: number; sha256: string }> {
	return emitReportFromMd(args);
}
