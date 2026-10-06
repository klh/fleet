#!/usr/bin/env bun
import { openGovernorDb } from "../lib/govdb.ts";
import { relayConsultOutbox } from "../lib/consult-outbox-relay.ts";
import { ensureConsultOutbox } from "../lib/consult-outbox.ts";

const db = openGovernorDb();
ensureConsultOutbox(db);
if (process.argv.includes("--status")) {
	console.log(
		JSON.stringify(
			{
				counts: db
					.query(
						"SELECT status,count(*) AS count FROM consult_outbox GROUP BY status",
					)
					.all(),
				recent: db
					.query(
						"SELECT delivery_id,local_consult_id,remote_consult_id,status,attempts,next_at,last_error FROM consult_outbox ORDER BY created_at DESC LIMIT 20",
					)
					.all(),
			},
			null,
			2,
		),
	);
	process.exit(0);
}
let busy = false;
async function tick(): Promise<void> {
	if (busy) return;
	busy = true;
	try {
		await relayConsultOutbox(db);
	} catch {
		console.error("Consult relay tick failed; pending deliveries retained");
	} finally {
		busy = false;
	}
}
await tick();
if (!process.argv.includes("--once")) {
	const timer = setInterval(() => void tick(), 5000);
	const stop = () => {
		clearInterval(timer);
		process.exit(0);
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
}
