import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-relogin-check";
const SOURCE_ID = "auth-storage-oauth-relogin-check-test";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage OAuth re-login identity check", () => {
	let tempDir = "";
	let nextLoginSuffix = "a";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-oauth-relogin-check-"));
		registerOAuthProvider({
			id: PROVIDER,
			name: "Unit Relogin Check",
			sourceId: SOURCE_ID,
			login: async () => oauthCredential(nextLoginSuffix),
			refreshToken: async () => oauthCredential(nextLoginSuffix),
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("replaceCredentialId with a token for the same identity updates that row and returns its id", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			nextLoginSuffix = "a";
			const first = await authStorage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
			const idA = first?.credentialId;
			if (idA === undefined) throw new Error("login returned no row id");

			const again = await authStorage.oauth.login(PROVIDER, {
				onAuth: () => {},
				onPrompt: async () => "",
				replaceCredentialId: idA,
			});

			expect(again?.credentialId).toBe(idA);
			const rows = authStorage.credentials.list(PROVIDER);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(idA);
		} finally {
			authStorage.close();
		}
	});

	test("replaceCredentialId with a token for another identity refuses the login and stores nothing", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			nextLoginSuffix = "a";
			const first = await authStorage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
			const idA = first?.credentialId;
			if (idA === undefined) throw new Error("login returned no row id for A");

			// A second, distinct identity so the store now holds two rows.
			nextLoginSuffix = "b";
			const second = await authStorage.oauth.login(PROVIDER, { onAuth: () => {}, onPrompt: async () => "" });
			const idB = second?.credentialId;
			if (idB === undefined) throw new Error("login returned no row id for B");

			const before = authStorage.credentials.list(PROVIDER);
			expect(before).toHaveLength(2);

			// Log in again as A's row, but the OAuth flow actually authenticates B.
			await expect(
				authStorage.oauth.login(PROVIDER, {
					onAuth: () => {},
					onPrompt: async () => "",
					replaceCredentialId: idA,
				}),
			).rejects.toThrow("Signed in as b@example.com, not a@example.com. Nothing was saved.");

			const after = authStorage.credentials.list(PROVIDER);
			expect(after).toHaveLength(2);
			expect(after.map(row => row.id).sort()).toEqual([idA, idB].sort());
		} finally {
			authStorage.close();
		}
	});

	test("replaceCredentialId of an unknown row throws before any login attempt is stored", async () => {
		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			nextLoginSuffix = "a";
			await expect(
				authStorage.oauth.login(PROVIDER, {
					onAuth: () => {},
					onPrompt: async () => "",
					replaceCredentialId: 999_999,
				}),
			).rejects.toThrow(`${PROVIDER} has no subscription #999999 to log in again as.`);

			expect(authStorage.credentials.list(PROVIDER)).toHaveLength(0);
		} finally {
			authStorage.close();
		}
	});
});
