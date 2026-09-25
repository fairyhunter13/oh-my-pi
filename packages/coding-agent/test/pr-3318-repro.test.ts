import { describe, expect, it } from "bun:test";
import type { CredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

describe("PR 3318 repro", () => {
	it("falls back to scoped account when metadata identities are empty strings", async () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider", accountId: "scoped-account", projectId: "scoped-project" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
			metadata: { email: "", accountId: "", projectId: "" },
		};
		const row: CredentialSummary = {
			id: 1,
			provider: "test-provider",
			kind: "api_key",
			label: null,
			identity: null,
			org: null,
			hint: null,
			disabled: null,
			isDefault: false,
			active: false,
			pinned: false,
		};
		const text = await buildUsageReportText(
			{
				session: {
					model: undefined,
					sessionId: undefined,
					fetchUsageReports: async () => [report],
					getUsageReportingModelSelectors: () => ["test-provider/coding-plan-model"],
					modelRegistry: {
						getProviderBaseUrl: () => undefined,
						authStorage: {
							listCredentials: () => [row],
							credentials: {
								list: () => [{ id: row.id, provider: row.provider, credential: { type: "api_key", key: "x" } }],
							},
							usage: {
								providerFor: () => ({}),
								report: async () => report,
							},
						},
					},
				},
			} as never,
			"test-provider/1",
		);

		expect(text).toContain("scoped-account: 1.00 requests used");
		expect(text).not.toContain("account 1: 1.00 requests used");
		expect(text).toContain("Models with usage data");
		expect(text).toContain("test-provider/coding-plan-model");
	});
	it("keeps Codex account and reset labels consistent with the live sanitized plan", async () => {
		const report: UsageReport = {
			provider: "openai-codex",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "weekly",
					label: "Weekly",
					scope: { provider: "openai-codex", accountId: "workspace-id" },
					amount: { usedFraction: 0.2, unit: "percent" },
				},
			],
			metadata: { email: "user@example.test", orgName: "free", orgId: "workspace-id", planType: "prolite\nforged" },
			resetCredits: { availableCount: 1 },
		};
		// ccw: /usage shows one credential at a time, so the report is reached through its row.
		const row: CredentialSummary = {
			id: 1,
			provider: "openai-codex",
			kind: "oauth",
			label: null,
			identity: "user@example.test",
			org: null,
			hint: null,
			disabled: null,
			isDefault: false,
			active: false,
			pinned: false,
		};
		const credential = { type: "oauth", access: "a", refresh: "r", expires: 0, email: "user@example.test" };
		const text = await buildUsageReportText(
			{
				session: {
					model: undefined,
					sessionId: undefined,
					fetchUsageReports: async () => [report],
					modelRegistry: {
						getProviderBaseUrl: () => undefined,
						authStorage: {
							listCredentials: () => [row],
							credentials: { list: () => [{ id: row.id, provider: row.provider, credential }] },
							usage: { providerFor: () => ({}), report: async () => report },
						},
					},
				},
			} as never,
			"openai-codex/1",
		);
		expect(text).toContain("user@example.test · plan: prolite forged: 1 saved rate-limit reset");
		expect(text).toContain("user@example.test · plan: prolite forged: 20.00% used");
		expect(text).not.toContain("prolite\nforged");
		expect(text).not.toContain("(free)");
		expect(text).not.toContain("workspace-id");
	});
});
