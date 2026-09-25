import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { CredentialSummary, OAuthCredential } from "@oh-my-pi/pi-ai";
import {
	accountPolicyFor,
	forgetCredentialSettings,
	saveAccountPolicy,
} from "@oh-my-pi/pi-coding-agent/auth/credential-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { cfgAuthAccountPolicies } from "@oh-my-pi/pi-coding-agent/config/model-settings";
import {
	cfgClaudeResetsAutoRedeemByCredential,
	cfgCodexResetsAutoRedeemByCredential,
} from "@oh-my-pi/pi-coding-agent/session/settings";

let authStorage: AuthStorage;

beforeEach(async () => {
	authStorage = await AuthStorage.create(":memory:");
});

afterEach(() => {
	authStorage.close();
});

async function oauthRow(overrides: Partial<OAuthCredential> = {}): Promise<CredentialSummary> {
	const credential: OAuthCredential = {
		type: "oauth",
		access: "token",
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		accountId: "acct-1",
		email: "user@example.com",
		orgId: "org-1",
		...overrides,
	};
	await authStorage.credentials.set("anthropic", [credential]);
	const row = authStorage.listCredentials("anthropic")[0];
	if (!row) throw new Error("expected a stored anthropic row");
	return row;
}

describe("credential-settings: accountPolicyFor / saveAccountPolicy", () => {
	it("saves a new entry with the credential's email and orgId", async () => {
		const row = await oauthRow();
		const settings = Settings.isolated({});
		const error = saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		expect(error).toBeUndefined();
		const policies = cfgAuthAccountPolicies.get(settings);
		expect(policies).toEqual([
			{ provider: "anthropic", account: { email: "user@example.com", orgId: "org-1" }, priority: 5 },
		]);
		expect(accountPolicyFor(settings, authStorage, row)).toEqual({ priority: 5 });
	});

	it("saving again replaces the same entry in place", async () => {
		const row = await oauthRow();
		const settings = Settings.isolated({});
		saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		const error = saveAccountPolicy(settings, authStorage, row, { priority: 9, reservePct: 10 });
		expect(error).toBeUndefined();
		const policies = cfgAuthAccountPolicies.get(settings);
		expect(policies).toHaveLength(1);
		expect(policies[0]).toEqual({
			provider: "anthropic",
			account: { email: "user@example.com", orgId: "org-1" },
			priority: 9,
			reservePct: 10,
		});
	});

	it("saving undefined removes the entry", async () => {
		const row = await oauthRow();
		const settings = Settings.isolated({});
		saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		const error = saveAccountPolicy(settings, authStorage, row, undefined);
		expect(error).toBeUndefined();
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
		expect(accountPolicyFor(settings, authStorage, row)).toBeUndefined();
	});

	it("leaves every other entry byte-for-byte unchanged", async () => {
		const row = await oauthRow();
		const other = { provider: "openai-codex", account: { email: "other@example.com" }, priority: 3 };
		const settings = Settings.isolated({});
		cfgAuthAccountPolicies.set(settings, [other]);
		saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		const policies = cfgAuthAccountPolicies.get(settings);
		expect(policies).toHaveLength(2);
		expect(policies[0]).toBe(other);
	});

	it("refuses an api_key row: the routing policy applies to subscriptions only", async () => {
		const id = authStorage.addApiKey("anthropic", "sk-test", "work key");
		const row = authStorage.listCredentials("anthropic").find(entry => entry.id === id);
		if (!row) throw new Error("expected a stored api_key row");
		const settings = Settings.isolated({});
		const error = saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		expect(error).toMatch(/API key/);
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
		expect(accountPolicyFor(settings, authStorage, row)).toBeUndefined();
	});

	it("refuses a selector matching no stored OAuth row and keeps the previous entries", async () => {
		const row = await oauthRow();
		const settings = Settings.isolated({});
		saveAccountPolicy(settings, authStorage, row, { priority: 5 });
		// Remove the credential the saved entry matches, so the next save's
		// validation (AccountPolicies.replace → validateFor) has nothing to bind to.
		await authStorage.credentials.set("anthropic", []);
		const error = saveAccountPolicy(settings, authStorage, row, { priority: 9 });
		expect(error).toBeDefined();
		expect(cfgAuthAccountPolicies.get(settings)).toEqual([
			{ provider: "anthropic", account: { email: "user@example.com", orgId: "org-1" }, priority: 5 },
		]);
	});
});

describe("credential-settings: forgetCredentialSettings", () => {
	it("clears the credential's policy entry and its key from both auto-redeem maps, leaving other keys", async () => {
		const row = await oauthRow();
		const settings = Settings.isolated({});
		cfgClaudeResetsAutoRedeemByCredential.set(settings, { [String(row.id)]: "yes", "999": "no" });
		cfgCodexResetsAutoRedeemByCredential.set(settings, { [String(row.id)]: "no", "888": "yes" });
		saveAccountPolicy(settings, authStorage, row, { priority: 5 });

		forgetCredentialSettings(settings, authStorage, row);

		expect(cfgAuthAccountPolicies.get(settings)).toEqual([]);
		expect(cfgClaudeResetsAutoRedeemByCredential.get(settings)).toEqual({ "999": "no" });
		expect(cfgCodexResetsAutoRedeemByCredential.get(settings)).toEqual({ "888": "yes" });
	});
});
