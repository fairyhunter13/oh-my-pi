/**
 * `AccountPolicies.replace` is the live-update seam `AuthStorage.setAccountPolicies`
 * calls when `auth.accountPolicies` changes (see
 * `coding-agent/src/session/auth-broker-config.ts`'s `createAuthStorageSettingsSync`
 * and `coding-agent/src/auth/credential-settings.ts`'s `saveAccountPolicy`). Both
 * validate the NEW configuration against the currently stored credentials before
 * committing, so a bad edit never displaces a working policy.
 */
import { describe, expect, it } from "bun:test";
import type { AuthCredential, OAuthCredential } from "@oh-my-pi/pi-ai";
import { AccountPolicies } from "@oh-my-pi/pi-ai/auth/policy";

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
	return {
		type: "oauth",
		access: "token",
		refresh: "refresh",
		expires: Date.now() + 3_600_000,
		accountId: "acct-1",
		email: "user@example.com",
		...overrides,
	};
}

describe("AccountPolicies.replace (live settings update)", () => {
	it("keeps the previous policy in effect when the replacement fails validation", () => {
		const credential = oauthCredential();
		const policies = new AccountPolicies(
			[{ provider: "anthropic", account: { email: "user@example.com" }, priority: 5 }],
			10,
		);
		const stored = new Map<string, readonly AuthCredential[]>([["anthropic", [credential]]]);

		expect(policies.forCredential("anthropic", credential)?.priority).toBe(5);

		// A selector matching no stored OAuth row is refused by `validateFor`,
		// which `replace` runs against `stored` before it commits.
		expect(() =>
			policies.replace([{ provider: "anthropic", account: { email: "nope@example.com" }, priority: 9 }], 10, stored),
		).toThrow();

		expect(policies.forCredential("anthropic", credential)?.priority).toBe(5);
		expect(policies.defaultReservePct).toBe(10);
	});

	it("takes effect live when the new configuration validates", () => {
		const credential = oauthCredential();
		const policies = new AccountPolicies(
			[{ provider: "anthropic", account: { email: "user@example.com" }, priority: 5 }],
			10,
		);
		const stored = new Map<string, readonly AuthCredential[]>([["anthropic", [credential]]]);

		policies.replace(
			[{ provider: "anthropic", account: { email: "user@example.com" }, priority: 9, reservePct: 20 }],
			15,
			stored,
		);

		const found = policies.forCredential("anthropic", credential);
		expect(found?.priority).toBe(9);
		expect(found?.reservePct).toBe(20);
		expect(policies.defaultReservePct).toBe(15);
	});

	it("refuses two entries that match the same stored OAuth account", () => {
		const credential = oauthCredential();
		const policies = new AccountPolicies([], undefined);
		const stored = new Map<string, readonly AuthCredential[]>([["anthropic", [credential]]]);

		expect(() =>
			policies.replace(
				[
					{ provider: "anthropic", account: { email: "user@example.com" }, priority: 1 },
					{ provider: "anthropic", account: { accountId: "acct-1" }, priority: 2 },
				],
				undefined,
				stored,
			),
		).toThrow();
		expect(policies.forCredential("anthropic", credential)).toBeUndefined();
	});
});
