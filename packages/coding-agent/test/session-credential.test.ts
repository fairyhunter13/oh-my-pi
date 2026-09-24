import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import {
	resolveSessionCredentialArg,
	resolveSessionCredentials,
} from "@oh-my-pi/pi-coding-agent/cli/session-credential";

async function makeStorage(): Promise<AuthStorage> {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const storage = new AuthStorage(store);
	await storage.credentials.reload();
	return storage;
}

async function addOAuth(storage: AuthStorage, provider: string, email: string): Promise<number> {
	await storage.credentials.upsert(provider, {
		type: "oauth",
		access: `access-${email}`,
		refresh: `refresh-${email}`,
		expires: Date.now() + 60_000,
		email,
	});
	await storage.credentials.reload();
	const row = storage.listCredentials(provider).find(entry => entry.identity === email);
	if (!row) throw new Error(`seed row for ${email} not found`);
	return row.id;
}

describe("resolveSessionCredentialArg", () => {
	it("rejects a malformed value", async () => {
		const storage = await makeStorage();
		expect(resolveSessionCredentialArg(storage, "anthropic")).toBe(
			'"anthropic" is not "<provider>/<credential id>".',
		);
		expect(resolveSessionCredentialArg(storage, "anthropic/5abc")).toBe(
			'"anthropic/5abc" is not "<provider>/<credential id>".',
		);
	});

	it("resolves an enabled stored row", async () => {
		const storage = await makeStorage();
		const id = await addOAuth(storage, "anthropic", "a@example.test");
		const resolved = resolveSessionCredentialArg(storage, `anthropic/${id}`);
		if (typeof resolved === "string") throw new Error(`expected a resolved credential, got: ${resolved}`);
		expect(resolved.provider).toBe("anthropic");
		expect(resolved.row.id).toBe(id);
	});

	it("lists the enabled choices for an unknown id", async () => {
		const storage = await makeStorage();
		await addOAuth(storage, "anthropic", "a@example.test");
		const resolved = resolveSessionCredentialArg(storage, "anthropic/999999");
		expect(typeof resolved).toBe("string");
		expect(resolved as string).toContain("matches no stored row");
		expect(resolved as string).toContain("Pick a credential with --credential <provider>/<id>:");
		expect(resolved as string).toContain("anthropic/");
	});

	it("refuses a disabled row and still lists the enabled ones", async () => {
		const storage = await makeStorage();
		const disabledId = await addOAuth(storage, "anthropic", "a@example.test");
		const enabledId = await addOAuth(storage, "anthropic", "b@example.test");
		await storage.credentials.disable(disabledId, "test-disabled");
		const resolved = resolveSessionCredentialArg(storage, `anthropic/${disabledId}`);
		expect(typeof resolved).toBe("string");
		expect(resolved as string).toContain("is disabled");
		expect(resolved as string).toContain(`anthropic/${enabledId}`);
	});
});

describe("resolveSessionCredentials", () => {
	it("resolves one value per provider", async () => {
		const storage = await makeStorage();
		const anthropicId = await addOAuth(storage, "anthropic", "a@example.test");
		const openaiId = await addOAuth(storage, "openai", "b@example.test");
		const resolved = resolveSessionCredentials(
			storage,
			[`anthropic/${anthropicId}`, `openai/${openaiId}`],
			undefined,
		);
		if (typeof resolved === "string") throw new Error(`expected resolved targets, got: ${resolved}`);
		expect(resolved.map(target => `${target.provider}/${target.row.id}`).sort()).toEqual(
			[`anthropic/${anthropicId}`, `openai/${openaiId}`].sort(),
		);
	});

	it("refuses two values for one provider", async () => {
		const storage = await makeStorage();
		const first = await addOAuth(storage, "anthropic", "a@example.test");
		const second = await addOAuth(storage, "anthropic", "b@example.test");
		const resolved = resolveSessionCredentials(storage, [`anthropic/${first}`, `anthropic/${second}`], undefined);
		expect(typeof resolved).toBe("string");
		expect(resolved as string).toContain("only one credential per provider");
	});

	it("refuses a value for the same provider --api-key targets", async () => {
		const storage = await makeStorage();
		const id = await addOAuth(storage, "anthropic", "a@example.test");
		const resolved = resolveSessionCredentials(storage, [`anthropic/${id}`], "anthropic");
		expect(typeof resolved).toBe("string");
		expect(resolved as string).toContain("conflicts with --api-key");
	});

	it("allows --credential and --api-key together for different providers", async () => {
		const storage = await makeStorage();
		const id = await addOAuth(storage, "anthropic", "a@example.test");
		const resolved = resolveSessionCredentials(storage, [`anthropic/${id}`], "openai");
		if (typeof resolved === "string") throw new Error(`expected resolved targets, got: ${resolved}`);
		expect(resolved).toHaveLength(1);
	});
});
