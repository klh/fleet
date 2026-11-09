// test/runner-overview@unit.e2e.ts — W2869.2.1: the Fleet runner card's
// read model is honest-absent (no live control-plane listener merged yet)
// and never reaches the durable/executor code directly — fetch is the ONE
// seam, gated by both the control URL and the credential file knobs.
import { expect, test } from "@playwright/test";
import {
	resolveRunnerControlUrl,
	runnerPayload,
} from "../hooks/board/runner-overview.ts";

test.describe("@unit", () => {
	test("resolveRunnerControlUrl is absent until the knob is set", () => {
		expect(resolveRunnerControlUrl({})).toBeNull();
		expect(
			resolveRunnerControlUrl({ RUNNER_CONTROL_URL: "http://127.0.0.1:1" }),
		).toBe("http://127.0.0.1:1");
	});

	test("unset control URL is an honest ok:false, never a fake empty list", async () => {
		const p = await runnerPayload({});
		expect(p.ok).toBe(true);
		expect(p.runner).toEqual({
			ok: false,
			reason: "runner.control_url_unset",
		});
		expect(p.control).toBeNull();
	});

	test("configured URL without a credential file refuses before any fetch", async () => {
		const p = await runnerPayload({
			RUNNER_CONTROL_URL: "http://127.0.0.1:1",
		});
		expect(p.runner).toEqual({
			ok: false,
			reason: "runner.private_credential_required",
		});
	});
});
