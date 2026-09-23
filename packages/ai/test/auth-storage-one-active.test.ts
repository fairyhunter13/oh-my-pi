import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, type CredentialSummary, SqliteAuthCredentialStore, suggestCredentialLabel } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";

const PROVIDER = "unit-one-active";

function oauthCredential(suffix: string, expires: number) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires,
		accountId: `acc-${suffix}`,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage: one active credential per session", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-one-active-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("a sole api-key row is active for a session and served", async () => {
		auth.addApiKey(PROVIDER, "sk-sole");
		const rows = auth.listCredentials(PROVIDER, "s1");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.active).toBe(true);
		expect(await auth.keys.get(PROVIDER, "s1")).toBe("sk-sole");
	});

	test("sessions.adopt is a no-op before any resolve — nothing to adopt yet", async () => {
		auth.addApiKey(PROVIDER, "sk-a");
		auth.addApiKey(PROVIDER, "sk-b");
		expect(auth.sessions.adopt(PROVIDER, "s1")).toBeUndefined();
		expect(auth.listCredentials(PROVIDER, "s1").some(row => row.pinned)).toBe(false);
	});

	test("before adoption a usage-limit rotation still rotates; sessions.adopt pins the served row so a later rotation does not move it; clearSessionCredential lets it re-adopt", async () => {
		auth.addApiKey(PROVIDER, "sk-a");
		auth.addApiKey(PROVIDER, "sk-b");

		const firstKey = await auth.keys.get(PROVIDER, "s1");
		expect(firstKey).toBe("sk-a");
		// keys.get alone never pins — only sessions.adopt does.
		expect(auth.listCredentials(PROVIDER, "s1").some(row => row.pinned)).toBe(false);

		// Before adoption, a 429 still rotates the session to the sibling — upstream
		// ranking/rotation semantics are unchanged by the new pin feature.
		const beforeAdoption = await auth.limits.markReached(PROVIDER, "s1", { retryAfterMs: 60_000 });
		expect(beforeAdoption.switched).toBe(true);
		const secondKey = await auth.keys.get(PROVIDER, "s1");
		expect(secondKey).toBe("sk-b");

		// Adopting the session's current routing pins it to the row currently serving it.
		const adoptedId = auth.sessions.adopt(PROVIDER, "s1");
		expect(adoptedId).toBeDefined();
		expect(auth.listCredentials(PROVIDER, "s1").filter(row => row.pinned)).toHaveLength(1);
		// A second adoption is a no-op: the session already has a pin.
		expect(auth.sessions.adopt(PROVIDER, "s1")).toBeUndefined();

		// After adoption, a usage-limit rotation no longer moves the session.
		const afterAdoption = await auth.limits.markReached(PROVIDER, "s1", { retryAfterMs: 60_000 });
		expect(afterAdoption.switched).toBe(false);
		expect(await auth.keys.get(PROVIDER, "s1")).toBe(secondKey);

		auth.clearSessionCredential(PROVIDER, "s1");
		expect(auth.listCredentials(PROVIDER, "s1").some(row => row.pinned)).toBe(false);
		await expect(auth.keys.get(PROVIDER, "s1")).resolves.toEqual(expect.any(String));
	});

	test("keys.get never writes a session pin by itself, with or without a sessionId", async () => {
		auth.addApiKey(PROVIDER, "sk-a");
		auth.addApiKey(PROVIDER, "sk-b");
		const setCacheSpy = vi.spyOn(store!, "setCache");

		await auth.keys.get(PROVIDER);
		await auth.keys.get(PROVIDER);
		await auth.keys.get(PROVIDER, "s1");
		await auth.keys.get(PROVIDER, "s1");

		const pinWrites = setCacheSpy.mock.calls.filter(([key]) => key.startsWith("session:pin:"));
		expect(pinWrites).toHaveLength(0);
	});
});

describe("AuthStorage.oauth.refreshCredentials", () => {
	const FAKE_PROVIDER = "unit-refresh-fake";
	const UNREGISTERED_PROVIDER = "unit-refresh-unregistered";
	const SOURCE_ID = "auth-storage-one-active-test";

	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage;
	let refreshCalls: string[] = [];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-refresh-credentials-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
		refreshCalls = [];
		registerOAuthProvider({
			id: FAKE_PROVIDER,
			name: "Fake",
			sourceId: SOURCE_ID,
			login: async () => {
				throw new Error("login is not exercised by this test");
			},
			refreshToken: async credentials => {
				refreshCalls.push(credentials.access);
				return {
					...credentials,
					access: `${credentials.access}-refreshed`,
					refresh: `${credentials.refresh}-refreshed`,
					expires: Date.now() + 60 * 60_000,
				};
			},
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE_ID);
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("refreshes only the expiring row of a registered provider, force refreshes both, and skips an unregistered provider's row", async () => {
		await auth.credentials.set(FAKE_PROVIDER, [
			oauthCredential("expiring", Date.now() + 60_000),
			oauthCredential("fresh", Date.now() + 2 * 60 * 60_000),
		]);
		await auth.credentials.set(UNREGISTERED_PROVIDER, [oauthCredential("unregistered", Date.now() + 60_000)]);

		const fakeRows = auth.listCredentials(FAKE_PROVIDER);
		const expiringId = fakeRows.find(row => row.identity === "expiring@example.com")?.id;
		const freshId = fakeRows.find(row => row.identity === "fresh@example.com")?.id;
		const unregisteredId = auth.listCredentials(UNREGISTERED_PROVIDER)[0]?.id;
		if (expiringId === undefined || freshId === undefined || unregisteredId === undefined) {
			throw new Error("expected all three rows to be present");
		}

		const result = await auth.oauth.refreshCredentials({ skewMs: 5 * 60_000 });

		expect(result.refreshed).toEqual([expiringId]);
		expect(result.skipped).toEqual([unregisteredId]);
		expect(result.failed).toEqual([]);
		expect(refreshCalls).toEqual(["access-expiring"]);

		// The unregistered row was neither refreshed nor disabled.
		const unregisteredRows = store!.listAuthCredentials(UNREGISTERED_PROVIDER);
		expect(unregisteredRows).toHaveLength(1);
		expect(unregisteredRows[0]?.credential.type).toBe("oauth");
		if (unregisteredRows[0]?.credential.type === "oauth") {
			expect(unregisteredRows[0].credential.access).toBe("access-unregistered");
		}

		refreshCalls = [];
		const forced = await auth.oauth.refreshCredentials({ provider: FAKE_PROVIDER, force: true });
		expect(forced.refreshed.sort()).toEqual([expiringId, freshId].sort());
		expect(refreshCalls.sort()).toEqual(["access-expiring-refreshed", "access-fresh"].sort());
	});
});

describe("AuthStorage.oauth.login returns the stored row id", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-login-credential-id-"));
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

	test("an api-key login returns the row id it upserted", async () => {
		const controller = { onAuth: () => {}, onPrompt: async () => "sk-login-key" };
		const identity = await auth.oauth.login("kagi", controller);
		expect(identity?.type).toBe("api_key");
		expect(identity?.credentialId).toBeDefined();

		const rows = store!.listAuthCredentials("kagi");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(identity?.credentialId ?? -1);
	});
});

function credentialSummary(overrides: Partial<CredentialSummary> & Pick<CredentialSummary, "id">): CredentialSummary {
	return {
		provider: "acme",
		kind: "oauth",
		label: null,
		identity: null,
		org: null,
		hint: null,
		disabled: null,
		isDefault: false,
		active: false,
		pinned: false,
		...overrides,
	};
}

describe("suggestCredentialLabel", () => {
	test("an explicit label always wins", () => {
		const row = credentialSummary({ id: 1, identity: "a@example.com", label: "work" });
		expect(suggestCredentialLabel([row], row)).toBe("work");
	});

	test("api_key rows use '<provider> key <hint>'", () => {
		const row = credentialSummary({ id: 1, kind: "api_key", provider: "kagi", hint: "…a1b2" });
		expect(suggestCredentialLabel([row], row)).toBe("kagi key …a1b2");
	});

	test("the same identity in two orgs gets the org; a genuine collision gets a number", () => {
		const orgA = credentialSummary({ id: 1, identity: "a@example.com", org: "Org One" });
		const orgB = credentialSummary({ id: 2, identity: "a@example.com", org: "Org Two" });
		const rowsWithOrgs = [orgA, orgB];
		expect(suggestCredentialLabel(rowsWithOrgs, orgA)).toBe("a@example.com (Org One)");
		expect(suggestCredentialLabel(rowsWithOrgs, orgB)).toBe("a@example.com (Org Two)");

		const noOrgFirst = credentialSummary({ id: 3, identity: "b@example.com" });
		const noOrgSecond = credentialSummary({ id: 4, identity: "b@example.com" });
		const rowsWithoutOrgs = [noOrgFirst, noOrgSecond];
		expect(suggestCredentialLabel(rowsWithoutOrgs, noOrgFirst)).toBe("b@example.com");
		expect(suggestCredentialLabel(rowsWithoutOrgs, noOrgSecond)).toBe("b@example.com 2");
	});
});
