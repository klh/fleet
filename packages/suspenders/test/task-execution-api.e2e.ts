import { Database } from "bun:sqlite";
import { expect, test } from "@playwright/test";
import { boardFixture } from "./helpers/board-fixture.ts";

const { BASE, REPO, HOME } = await boardFixture(0, test.afterAll);
test("actual tasks API separates a coordinator claim from execution, served board labels claims honestly", async () => {
	const now = Date.now();
	const db = new Database(`${HOME}/.cache/claude-governor/governor.db`);
	db.query(
		"INSERT INTO work_items(project,id,title,state,owner_sid,created_at,updated_at) VALUES (?,'WEXEC','unregistered coordinator claim','CLAIMED','coordinator',?,?)",
	).run(REPO, now, now);
	db.close();
	const response = await fetch(`${BASE}/api/tasks?done=all`);
	expect(response.status).toBe(200);
	const body = await response.json();
	const row = body.tasks.find((t: { id: string }) => t.id === "WEXEC");
	expect(row).toMatchObject({
		state: "CLAIMED",
		owner_sid: "coordinator",
		execution: { state: "unknown", source: "work-claim-only", progress: null },
	});
	expect(row.execution.observed_at).toBeGreaterThanOrEqual(now);
	const page = await (await fetch(BASE)).text();
	expect(page).toContain("label: 'claimed'");
	expect(page).toContain("Harness presence is not productive output");
});
