import { describe, expect, it } from "bun:test";
import type { CredentialSummary, UsageReport } from "@oh-my-pi/pi-ai";
import { buildUsageReportText, usageReportLines } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/usage-report";

describe("usageReportLines extraction", () => {
	it("keeps buildUsageReportText's fenced report byte-identical when passed the same identity and model selectors", async () => {
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

		// buildUsageReportText resolves no OAuth identity for an api_key row
		// (identityOfStoredCredential returns undefined for kind !== "oauth"),
		// so the extracted call carries the same undefined identity.
		const lines = usageReportLines(row, report, {
			identity: undefined,
			usageModelSelectors: ["test-provider/coding-plan-model"],
		});
		expect(lines.join("\n")).toBe(text);
	});

	it("returns the same 'No usage data' line buildUsageReportText returns for a missing report", () => {
		const row: CredentialSummary = {
			id: 42,
			provider: "test-provider",
			kind: "api_key",
			label: "prod",
			identity: null,
			org: null,
			hint: null,
			disabled: null,
			isDefault: false,
			active: false,
			pinned: false,
		};
		expect(usageReportLines(row, null)).toEqual([`No usage data for prod (#42).`]);
	});

	it("omits the in-use marker and model-selector list when called with no options, as the Credentials tab's Usage… action does", () => {
		const report: UsageReport = {
			provider: "test-provider",
			fetchedAt: Date.now(),
			limits: [
				{
					id: "daily",
					label: "Daily",
					scope: { provider: "test-provider", accountId: "scoped-account" },
					amount: { used: 1, usedFraction: 0.1, unit: "requests" },
				},
			],
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
		const lines = usageReportLines(row, report);
		expect(lines.join("\n")).not.toContain("Models with usage data");
		expect(lines[0]).toBe("```");
		expect(lines.at(-1)).toBe("```");
	});
});
