import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { boardFixture } from "./helpers/board-fixture.ts";

const f = await boardFixture(0, afterAll);
test("completion feed bounds by recency before truncating lexical work IDs", async () => {
	const db = new Database(join(f.HOME, ".cache/claude-governor/governor.db"));
	try {
		for (let i = 1; i <= 40; i++)
			db.query(
				"INSERT INTO work_items(project,id,title,state,priority,created_at,updated_at) VALUES(?, ?, 'completed', 'DONE', 0, 1, ?)",
			).run(f.MY_PROJ, `W${i}`, 1_000 + i);
		db.query(
			"INSERT INTO work_items(project,id,title,state,priority,created_at,updated_at) VALUES(?, 'W473', 'latest', 'DONE', 0, 1, 9000)",
		).run(f.MY_PROJ);
		const p = await f.myProject();
		expect(p.done).toHaveLength(30);
		expect(p.done[0].id).toBe("W473");
		expect(p.done[1].id).toBe("W40");
		expect(p.done.some((r: { id: string }) => r.id === "W1")).toBe(false);
	} finally {
		db.close();
	}
});
