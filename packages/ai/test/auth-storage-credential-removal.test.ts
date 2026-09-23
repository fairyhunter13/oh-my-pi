import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AuthStorage,
	type CredentialRemovedEvent,
	type CredentialSummary,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-removal";
const OAUTH_PROVIDER = "unit-removal-oauth";

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

describe("AuthStorage credential removal", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-removal-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("removing the row this session pins clears only this session's pin", async () => {
		const rowA = auth.addApiKey(PROVIDER, "sk-a");
		auth.addApiKey(PROVIDER, "sk-b");

		expect(auth.pinSessionCredential(PROVIDER, "s1", rowA)).toBe(true);
		expect(auth.pinSessionCredential(PROVIDER, "s2", rowA)).toBe(true);

		expect(await auth.removeCredential(PROVIDER, rowA, { sessionId: "s1" })).toBe(true);

		// s1's pin was cleared by the removal, so it falls through to the pool
		// instead of throwing.
		await expect(auth.keys.get(PROVIDER, "s1")).resolves.toBe("sk-b");
		// s2 never removed anything; its pin still names the now-gone row, so it
		// still throws the stale-pin error.
		await expect(auth.keys.get(PROVIDER, "s2")).rejects.toThrow(/is pinned to credential/);
	});

	test("removeCredential fires onCredentialRemoved once with the removed row's pre-removal summary", async () => {
		const events: CredentialRemovedEvent[] = [];
		auth.credentials.onRemoved(event => {
			events.push(event);
		});
		const kept = auth.addApiKey(PROVIDER, "sk-kept");
		const removed = auth.addApiKey(PROVIDER, "sk-removed", "named");

		expect(await auth.removeCredential(PROVIDER, removed)).toBe(true);

		expect(events).toHaveLength(1);
		expect(events[0]?.provider).toBe(PROVIDER);
		expect(events[0]?.credentials.map(row => row.id)).toEqual([removed]);
		expect(events[0]?.credentials[0]?.label).toBe("named");
		// The kept row never appears, and removeCredential fires exactly once —
		// not once per remaining row.
		expect(events[0]?.credentials.some(row => row.id === kept)).toBe(false);
	});

	test("remove(provider) fires onCredentialRemoved once with every row of the provider", async () => {
		const events: CredentialRemovedEvent[] = [];
		auth.credentials.onRemoved(event => {
			events.push(event);
		});
		const first = auth.addApiKey(PROVIDER, "sk-first");
		const second = auth.addApiKey(PROVIDER, "sk-second");
		expect(await auth.disableCredentialById(second, "disabled by user")).toBe(true);

		await auth.remove(PROVIDER);

		expect(events).toHaveLength(1);
		expect(events[0]?.provider).toBe(PROVIDER);
		expect(events[0]?.credentials.map(row => row.id).sort()).toEqual([first, second].sort());
	});

	test("getOAuthAccountIdentity follows the session's pin to OAuth row 2 before any getApiKey call", async () => {
		await auth.credentials.set(OAUTH_PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows: CredentialSummary[] = auth.listCredentials(OAUTH_PROVIDER);
		expect(rows).toHaveLength(2);
		const secondRowId = rows[1]?.id;
		if (secondRowId === undefined) throw new Error("expected a second oauth row");

		expect(auth.pinSessionCredential(OAUTH_PROVIDER, "s-pin", secondRowId)).toBe(true);

		// No getApiKey/getOAuthAccessAt call has run yet for this session — the
		// old #resolveActiveOAuthCredential fell back to oauthCredentials[0] here.
		const identity = auth.oauth.identity(OAUTH_PROVIDER, "s-pin");
		expect(identity?.email).toBe("b@example.com");
	});
});

describe("AuthStorage OAuth login keeps an existing API key row enabled", () => {
	let tempDir = "";
	const SOURCE_ID = "auth-storage-credential-removal-test";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-credential-removal-login-"));
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("an enabled api_key row stays enabled after an OAuth login for the same provider", async () => {
		registerOAuthProvider({
			id: "unit-removal-login",
			name: "Unit Removal Login",
			sourceId: SOURCE_ID,
			login: async () => oauthCredential("login"),
			refreshToken: async () => oauthCredential("login"),
		});

		const authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		try {
			const apiKeyId = authStorage.addApiKey("unit-removal-login", "sk-existing");
			expect(authStorage.listCredentials("unit-removal-login").find(row => row.id === apiKeyId)?.disabled).toBeNull();

			await authStorage.oauth.login("unit-removal-login", {
				onAuth: () => {},
				onPrompt: async () => "",
			});

			const rows = authStorage.listCredentials("unit-removal-login");
			const apiKeyRow = rows.find(row => row.id === apiKeyId);
			expect(apiKeyRow?.disabled).toBeNull();
			expect(rows.some(row => row.kind === "oauth" && row.identity === "login@example.com")).toBe(true);
		} finally {
			authStorage.close();
		}
	});
});
