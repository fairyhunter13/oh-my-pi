import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";

const PROVIDER = "unit-precedence";
const UNSET_ENV = "OMP_UNIT_PRECEDENCE_UNSET_KEY";
const SET_ENV = "OMP_UNIT_PRECEDENCE_SET_KEY";

describe("AuthStorage key precedence with a models.yml apiKey", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let keyA = 0;
	let keyB = 0;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-precedence-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
		keyA = storage.addApiKey(PROVIDER, "sk-a", "Key A");
		keyB = storage.addApiKey(PROVIDER, "sk-b", "Key B");
		delete process.env[UNSET_ENV];
		process.env[SET_ENV] = "sk-config";
	});

	afterEach(async () => {
		delete process.env[SET_ENV];
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const marks = (sessionId: string) =>
		storage.listCredentials(PROVIDER, sessionId).map(row => ({ id: row.id, active: row.active, pinned: row.pinned }));

	test("a config key naming an unset env var is ignored: stored rows serve and a pin takes", async () => {
		storage.keys.setConfig(PROVIDER, UNSET_ENV);

		expect(await storage.keys.get(PROVIDER, "s1")).toBe("sk-a");
		expect(await storage.keys.peek(PROVIDER)).toBe("sk-a");
		expect(storage.pinSessionCredential(PROVIDER, "s1", keyB)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "s1")).toBe("sk-b");
		expect(marks("s1")).toEqual([
			{ id: keyA, active: false, pinned: false },
			{ id: keyB, active: true, pinned: true },
		]);
	});

	test("a resolvable config key beats the default, and a session pin beats the config key", async () => {
		storage.keys.setConfig(PROVIDER, SET_ENV);
		storage.setDefaultCredential(PROVIDER, keyA);

		expect(await storage.keys.get(PROVIDER, "free")).toBe("sk-config");
		expect(await storage.keys.peek(PROVIDER)).toBe("sk-config");
		// The config key wins over the default, so no row is marked for an unpinned session.
		expect(marks("free").some(row => row.active || row.pinned)).toBe(false);

		expect(storage.pinSessionCredential(PROVIDER, "pinned", keyB)).toBe(true);
		expect(await storage.keys.get(PROVIDER, "pinned")).toBe("sk-b");
		expect(await storage.keys.get(PROVIDER, "free")).toBe("sk-config");
		expect(marks("pinned")).toEqual([
			{ id: keyA, active: false, pinned: false },
			{ id: keyB, active: true, pinned: true },
		]);
	});

	test("a runtime override beats a session pin and refuses a new pin", async () => {
		expect(storage.pinSessionCredential(PROVIDER, "s1", keyB)).toBe(true);
		storage.keys.setRuntime(PROVIDER, "sk-runtime");

		expect(await storage.keys.get(PROVIDER, "s1")).toBe("sk-runtime");
		expect(storage.pinSessionCredential(PROVIDER, "s2", keyA)).toBe(false);
	});

	test("with no stored rows, a config key that does not count still resolves as before", async () => {
		const bare = "unit-precedence-bare";
		storage.keys.setConfig(bare, UNSET_ENV);

		expect(await storage.keys.get(bare, "s1")).toBe(UNSET_ENV);
		expect(await storage.keys.peek(bare)).toBe(UNSET_ENV);
	});
});

describe("AuthStorage.removeCredential", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-remove-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		storage = new AuthStorage(store);
	});

	afterEach(async () => {
		store.close();
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	test("removed rows, active or disabled, leave the list and act as missing", async () => {
		const keep = storage.addApiKey(PROVIDER, "sk-keep", "Keep");
		const active = storage.addApiKey(PROVIDER, "sk-active", "Active");
		const drop = storage.addApiKey(PROVIDER, "sk-drop", "Drop");
		const other = storage.addApiKey("unit-other", "sk-other", null);
		expect(await storage.disableCredentialById(drop, "disabled by user")).toBe(true);

		expect(await storage.removeCredential(PROVIDER, active)).toBe(true);
		expect(await storage.removeCredential(PROVIDER, drop)).toBe(true);
		expect(storage.listCredentials(PROVIDER).map(row => [row.id, row.disabled])).toEqual([[keep, null]]);
		expect(storage.listCredentials().some(row => row.id === active || row.id === drop)).toBe(false);

		for (const id of [active, drop]) {
			expect(await storage.removeCredential(PROVIDER, id)).toBe(false);
			expect(storage.enableCredential(id)).toBe(false);
			expect(() => storage.renameCredential(id, "again")).toThrow(`No credential with id ${id}`);
			expect(() => storage.setDefaultCredential(PROVIDER, id)).toThrow(`No ${PROVIDER} credential with id ${id}`);
		}
		// A removed row's name is free again.
		expect(storage.addApiKey(PROVIDER, "sk-new", "Drop")).toBeGreaterThan(drop);
		expect(await storage.removeCredential(PROVIDER, other)).toBe(false);
		expect(await storage.removeCredential(PROVIDER, 999_999)).toBe(false);
		expect(await storage.keys.get(PROVIDER, "s1")).toBe("sk-keep");
	});
});
