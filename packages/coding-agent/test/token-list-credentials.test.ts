import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import Token from "../src/commands/token";
import * as sdk from "../src/sdk";

const PROVIDER = "unit-token-list";
const config = { bin: "omp", version: "0.0.0", commands: new Map() };

describe("omp token --list", () => {
	let tempDir = "";
	let dbPath = "";
	let stdout: string[];
	let stderr: string[];

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-token-list-"));
		dbPath = path.join(tempDir, "agent.db");
		// The command closes its storage, so every run opens its own, loaded as discovery loads it.
		spyOn(sdk, "discoverAuthStorage").mockImplementation(async () => {
			const storage = await AuthStorage.create(dbPath);
			await storage.credentials.reload();
			return storage;
		});
		stdout = [];
		stderr = [];
		spyOn(process.stdout, "write").mockImplementation(chunk => {
			stdout.push(String(chunk));
			return true;
		});
		spyOn(process.stderr, "write").mockImplementation(chunk => {
			stderr.push(String(chunk));
			return true;
		});
	});

	afterEach(async () => {
		spyOn(sdk, "discoverAuthStorage").mockRestore();
		spyOn(process.stdout, "write").mockRestore();
		spyOn(process.stderr, "write").mockRestore();
		process.exitCode = 0;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	async function seed(withOAuth: boolean): Promise<{ oauth?: number; work: number; spare: number; old: number }> {
		const storage = await AuthStorage.create(dbPath);
		try {
			if (withOAuth) {
				await storage.credentials.upsert(PROVIDER, {
					type: "oauth",
					access: "access-a",
					refresh: "refresh-a",
					expires: Date.now() + 3_600_000,
					email: "a@example.com",
				});
			}
			const oauth = storage.oauth.accounts(PROVIDER)[0]?.credentialId;
			const work = storage.addApiKey(PROVIDER, "sk-work-1111", "work");
			const spare = storage.addApiKey(PROVIDER, "sk-spare-2222", null);
			const old = storage.addApiKey(PROVIDER, "sk-old-3333", "old");
			storage.setDefaultCredential(PROVIDER, work);
			expect(await storage.disableCredentialById(old, "disabled by user")).toBe(true);
			const gone = storage.addApiKey(PROVIDER, "sk-gone-4444", "gone");
			expect(await storage.removeCredential(PROVIDER, gone)).toBe(true);
			return { oauth, work, spare, old };
		} finally {
			storage.close();
		}
	}

	it("lists stored API keys with marks and never prints a key", async () => {
		const { work, spare, old } = await seed(false);

		await new Token([PROVIDER, "--list"], config).run();

		expect(stderr.join("")).toBe("");
		expect(process.exitCode || 0).toBe(0);
		expect(stdout.join("")).toBe(
			[
				`1. #${work} work · api_key · default`,
				`2. #${spare} …2222 · api_key`,
				`3. #${old} old · api_key · disabled: disabled by user`,
				"",
			].join("\n"),
		);
		expect(stdout.join("")).not.toContain("sk-");
	});

	it("numbers OAuth accounts first in --list, and --credential selects any row by id", async () => {
		const { oauth, work, old } = await seed(true);

		await new Token([PROVIDER, "--list"], config).run();
		expect(stdout.join("").split("\n").slice(0, 2)).toEqual([
			`1. #${oauth} a@example.com · oauth`,
			`2. #${work} work · api_key · default`,
		]);

		stdout = [];
		await new Token([PROVIDER, "--credential", `${work}`], config).run();
		expect(stdout.join("")).toBe("sk-work-1111\n");
		expect(stderr.join("")).toBe("");
		expect(process.exitCode || 0).toBe(0);

		stdout = [];
		stderr = [];
		await new Token([PROVIDER, "--credential", `${old}`], config).run();
		expect(stdout.join("")).toBe("");
		expect(stderr.join("")).toContain(`#${old} is disabled: disabled by user`);
		expect(process.exitCode).toBe(1);
	});
});
