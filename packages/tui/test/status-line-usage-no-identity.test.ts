import { beforeAll, describe, expect, it } from "bun:test";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line";
import type { StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function fakeHost(reports: unknown): StatusLineHost {
	return {
		getSettings: () => ({ preset: "custom", leftSegments: [], rightSegments: ["usage"], sessionAccent: false }),
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		// No stored identity is active: the guard under test must decide from report count alone.
		activeAccount: () => undefined,
		activeCredential: () => null,
		canFetchUsageReports: () => true,
		fetchUsageReports: async () => reports,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 0 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};
}

function fakeSession(provider: string): StatusLineSession {
	return {
		state: { messages: [], model: { id: "m1", provider, contextWindow: 1000 } as never },
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "s1",
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
		modelRegistry: { isUsingOAuth: () => false },
		isStreaming: false,
		isAutoThinking: false,
		getContextUsage: () => undefined,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getGoalModeState: () => undefined,
	};
}

// StatusLineComponent schedules its usage fetch on a real setTimeout with a
// 0ms delay (STATUS_USAGE_START_DELAY_MS in status-line/component.ts), so a
// deterministic fake clock cannot observe it without mocking that private
// internal. Flushing one real macrotask tick matches the coding-agent
// package's own status-line-usage.test.ts helper of the same name.
async function flushUsageRefresh(): Promise<void> {
	const timer = Promise.withResolvers<void>();
	setTimeout(timer.resolve, 0);
	await timer.promise;
	await Promise.resolve();
	await Promise.resolve();
}

describe("status line usage segment with no active identity", () => {
	it("shows nothing when several reports of the same provider have no identity to pick between", async () => {
		const reports = [
			{
				provider: "anthropic",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } }],
			},
			{
				provider: "anthropic",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.9 } }],
			},
		];
		const session = fakeSession("anthropic");
		const component = new StatusLineComponent(session, fakeHost(reports));
		try {
			component.refreshUsageInBackground();
			await flushUsageRefresh();
			const content = Bun.stripANSI(component.getTopBorder(200).content);
			expect(content).not.toContain("24%");
			expect(content).not.toContain("90%");
		} finally {
			component.dispose();
		}
	});

	it("still renders the one report of the provider when there is no identity", async () => {
		const reports = [
			{
				provider: "anthropic",
				limits: [{ scope: { windowId: "5h" }, amount: { usedFraction: 0.24 } }],
			},
		];
		const session = fakeSession("anthropic");
		const component = new StatusLineComponent(session, fakeHost(reports));
		try {
			component.refreshUsageInBackground();
			await flushUsageRefresh();
			const content = Bun.stripANSI(component.getTopBorder(200).content);
			expect(content).toContain("24%");
		} finally {
			component.dispose();
		}
	});
});
