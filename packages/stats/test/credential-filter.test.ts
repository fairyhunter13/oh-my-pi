import { describe, expect, it } from "bun:test";
import { getDailyActivity, getOverallStats, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import { formatStatsCredential, parseStatsCredential } from "@oh-my-pi/omp-stats/shared-types";
import type { MessageStats, StatsCredential } from "@oh-my-pi/omp-stats/types";
import { handleApi } from "../src/server";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-credential-filter-");

function makeMessage(entryId: string, credentialId: number | null, tokens: number): MessageStats {
	return {
		sessionFile: `/tmp/${entryId}.jsonl`,
		entryId,
		folder: "/tmp/project",
		model: "claude-sonnet-4-6",
		provider: "anthropic",
		api: "anthropic-messages",
		timestamp: Date.now(),
		duration: 1000,
		ttft: 100,
		stopReason: "stop",
		errorMessage: null,
		usage: {
			input: tokens,
			output: tokens,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: tokens * 2,
			cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
		},
		agentType: "main",
		credentialId,
	};
}

const CRED_1: StatsCredential = { provider: "anthropic", credentialId: 1 };
const CRED_2: StatsCredential = { provider: "anthropic", credentialId: 2 };
const CRED_NONE: StatsCredential = { provider: "anthropic", credentialId: null };

describe("per-credential filtering", () => {
	it("getOverallStats returns only the rows of the asked credential", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("c1-a", 1, 100),
			makeMessage("c1-b", 1, 100),
			makeMessage("c2-a", 2, 50),
			makeMessage("none-a", null, 10),
		]);

		expect(getOverallStats(CRED_1)).toMatchObject({ totalRequests: 2, totalInputTokens: 200 });
		expect(getOverallStats(CRED_2)).toMatchObject({ totalRequests: 1, totalInputTokens: 50 });
		expect(getOverallStats(CRED_NONE)).toMatchObject({ totalRequests: 1, totalInputTokens: 10 });
	});

	it("getDailyActivity returns only the rows of the asked credential", async () => {
		await initDb();
		insertMessageStats([
			makeMessage("day-c1", 1, 100),
			makeMessage("day-c2", 2, 40),
			makeMessage("day-none", null, 5),
		]);

		const cred1Activity = await getDailyActivity(CRED_1, 7);
		const cred2Activity = await getDailyActivity(CRED_2, 7);
		const noneActivity = await getDailyActivity(CRED_NONE, 7);

		expect(cred1Activity.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
		expect(cred2Activity.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
		expect(noneActivity.reduce((sum, day) => sum + day.requests, 0)).toBe(1);
	});

	it("round-trips parseStatsCredential and formatStatsCredential", () => {
		expect(parseStatsCredential("anthropic:1")).toEqual({ provider: "anthropic", credentialId: 1 });
		expect(parseStatsCredential("anthropic:none")).toEqual({ provider: "anthropic", credentialId: null });
		expect(parseStatsCredential(undefined)).toBeUndefined();
		expect(parseStatsCredential(null)).toBeUndefined();
		expect(parseStatsCredential("garbage")).toBeUndefined();
		for (const credential of [CRED_1, CRED_2, CRED_NONE]) {
			expect(parseStatsCredential(formatStatsCredential(credential))).toEqual(credential);
		}
	});

	it("answers 400 on /api/stats/overview with no credential", async () => {
		await initDb();
		const missing = await handleApi(new Request("http://stats.test/api/stats/overview?range=24h"));
		expect(missing.status).toBe(400);
		expect(await missing.json()).toEqual({ error: "credential required" });

		const present = await handleApi(
			new Request("http://stats.test/api/stats/overview?range=24h&credential=anthropic:1"),
		);
		expect(present.status).toBe(200);
	});
});
