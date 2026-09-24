import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getRecentRequests, initDb, insertMessageStats } from "@oh-my-pi/omp-stats/db";
import type { StatsCredential } from "@oh-my-pi/omp-stats/types";
import { parseSessionFile } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-model-usage-");

const ANTHROPIC_CREDENTIAL: StatsCredential = { provider: "anthropic", credentialId: null };

describe("model usage session entries", () => {
	it("parses and aggregates non-transcript model calls", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--model-usage");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "model_usage",
				id: "classifier-1",
				parentId: null,
				timestamp: "2026-08-31T10:00:00.000Z",
				purpose: "auto-thinking",
				role: "smol",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "error",
				errorMessage: "Internal Server Error",
				usage: {
					input: 11,
					output: 2,
					cacheRead: 3,
					cacheWrite: 0,
					totalTokens: 16,
					cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 0, total: 6 },
				},
			})}\n`,
		);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		expect(getRecentRequests(ANTHROPIC_CREDENTIAL, 1)[0]).toMatchObject({
			entryId: "classifier-1",
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-4-5",
			stopReason: "error",
			errorMessage: "Internal Server Error",
			usage: { totalTokens: 16, cost: { total: 6 } },
			credentialId: null,
		});
	});

	it("D-1: a model_usage entry's own credentialId is attributed, not always unattributed", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--model-usage-credential-attributed");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		await Bun.write(
			file,
			`${JSON.stringify({
				type: "model_usage",
				id: "judge-1",
				parentId: null,
				timestamp: "2026-08-31T10:00:00.000Z",
				purpose: "ttsr",
				role: "judge",
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-4-5",
				stopReason: "stop",
				credentialId: 5,
				usage: {
					input: 4,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 5,
					cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
				},
			})}\n`,
		);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(1);
		const attributed: StatsCredential = { provider: "anthropic", credentialId: 5 };
		expect(getRecentRequests(attributed, 1)[0]).toMatchObject({ entryId: "judge-1", credentialId: 5 });
		expect(getRecentRequests(ANTHROPIC_CREDENTIAL, 1)[0]).toBeUndefined();
	});

	it("records the message's stored credential id, and null when the message carries none", async () => {
		const dir = path.join(getSessionsDir(), "--tmp--model-usage-credential");
		await fs.mkdir(dir, { recursive: true });
		const file = path.join(dir, "session.jsonl");
		const entry = (id: string, credentialId: number | undefined) =>
			JSON.stringify({
				type: "message",
				id,
				parentId: null,
				timestamp: "2026-08-31T10:00:00.000Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-haiku-4-5",
					stopReason: "stop",
					timestamp: Date.parse("2026-08-31T10:00:00.000Z"),
					...(credentialId !== undefined ? { credentialId } : {}),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 15,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
		await Bun.write(file, `${entry("with-credential", 7)}\n${entry("without-credential", undefined)}\n`);

		const result = await parseSessionFile(file);
		await initDb();
		expect(insertMessageStats(result.stats)).toBe(2);
		const withCredential = getRecentRequests({ provider: "anthropic", credentialId: 7 }, 1)[0];
		const withoutCredential = getRecentRequests(ANTHROPIC_CREDENTIAL, 1)[0];
		expect(withCredential?.entryId).toBe("with-credential");
		expect(withCredential?.credentialId).toBe(7);
		expect(withoutCredential?.entryId).toBe("without-credential");
		expect(withoutCredential?.credentialId).toBeNull();
	});
});
