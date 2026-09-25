import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { removeWithRetries } from "../../utils/src/temp";

// The v8 shape is upstream v18.3.1's `#createAuthCredentialsTable`: the fork's V9 adds `label`
// and `is_default`, so a database an upstream omp wrote must open with its rows intact.
function writeV8Database(dbPath: string): void {
	const db = new Database(dbPath);
	try {
		db.run(`
			CREATE TABLE auth_schema_version (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				version INTEGER NOT NULL
			);
			INSERT INTO auth_schema_version(id, version) VALUES (1, 8);
			CREATE TABLE auth_credentials (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				provider TEXT NOT NULL,
				credential_type TEXT NOT NULL,
				data TEXT NOT NULL,
				disabled_cause TEXT DEFAULT NULL,
				identity_key TEXT DEFAULT NULL,
				created_at INTEGER NOT NULL DEFAULT (unixepoch()),
				updated_at INTEGER NOT NULL DEFAULT (unixepoch())
			);
		`);
		const insert = db.prepare(
			"INSERT INTO auth_credentials (provider, credential_type, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		);
		insert.run("anthropic", "api_key", JSON.stringify({ key: "sk-ant-first" }), 1_700_000_000, 1_700_000_000);
		insert.run("anthropic", "api_key", JSON.stringify({ key: "sk-ant-second" }), 1_700_000_001, 1_700_000_001);
	} finally {
		db.close();
	}
}

interface StoredRow {
	id: number;
	data: string;
	label: string | null;
	is_default: number;
}

function inspect(dbPath: string): { version: number | undefined; columns: string[]; rows: StoredRow[] } {
	const db = new Database(dbPath, { readonly: true });
	try {
		const versionRow: unknown = db.prepare("SELECT version FROM auth_schema_version WHERE id = 1").get();
		const version =
			versionRow && typeof versionRow === "object" && "version" in versionRow && typeof versionRow.version === "number"
				? versionRow.version
				: undefined;
		// The columns and rows were written above or by the store; the casts name their shape.
		const columns = (db.prepare("PRAGMA table_info(auth_credentials)").all() as Array<{ name: string }>).map(
			column => column.name,
		);
		const rows = db
			.prepare("SELECT id, data, label, is_default FROM auth_credentials ORDER BY id ASC")
			.all() as StoredRow[];
		return { version, columns, rows };
	} finally {
		db.close();
	}
}

describe("auth schema V8 to V9", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-schema-v9-"));
		dbPath = path.join(tempDir, "agent.db");
		writeV8Database(dbPath);
	});

	afterEach(async () => {
		if (tempDir) await removeWithRetries(tempDir);
		tempDir = "";
	});

	it("adds label and is_default, records version 9 and keeps every row", async () => {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		try {
			expect(store.listAuthCredentials("anthropic")).toHaveLength(2);
		} finally {
			store.close();
		}

		const after = inspect(dbPath);
		expect(after.version).toBe(9);
		expect(after.columns).toContain("label");
		expect(after.columns).toContain("is_default");
		expect(after.rows.map(row => JSON.parse(row.data).key)).toEqual(["sk-ant-first", "sk-ant-second"]);
		expect(after.rows.map(row => [row.label, row.is_default])).toEqual([
			[null, 0],
			[null, 0],
		]);
	});

	it("opens a migrated database again without changing it", async () => {
		(await SqliteAuthCredentialStore.open(dbPath)).close();
		const first = inspect(dbPath);
		(await SqliteAuthCredentialStore.open(dbPath)).close();
		expect(inspect(dbPath)).toEqual(first);
	});
});
