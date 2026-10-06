import { expect, test } from "bun:test";
import { modelFromProcess } from "../bin/inventory-probe.ts";

test("optional missing process tools never fail a dashboard observation", () => {
	expect(
		modelFromProcess(8912, () => {
			throw new Error("Executable not found");
		}),
	).toBeNull();
	expect(modelFromProcess(8912, () => "")).toBeNull();
});

test("launchd process diagnostics use absolute paths and parse model arguments", () => {
	const commands: string[][] = [];
	const model = modelFromProcess(8912, (command) => {
		commands.push(command);
		return commands.length === 1
			? "123\n"
			: "python serve --model mlx-community/model";
	});
	expect(model).toBe("mlx-community/model");
	expect(commands.map((c) => c[0])).toEqual(["/usr/sbin/lsof", "/bin/ps"]);
});
