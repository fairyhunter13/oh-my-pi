/**
 * Credential catalog: user labels and a per-provider default over the
 * `auth_credentials` rows. Strict session pins live in ./affinity.ts.
 *
 * Kept apart from sqlite-credential-store.ts so the upstream store carries
 * only small hooks into this module.
 */
import type { Database, Statement } from "bun:sqlite";

/** One stored credential as `/providers` → Credentials shows it. */
export interface CredentialSummary {
	/** auth_credentials.id, durable for the row's life. */
	id: number;
	provider: string;
	kind: "oauth" | "api_key";
	/** The user's name, unique per provider (case-insensitive). */
	label: string | null;
	/** oauth: email, else account/org id. api_key: null. */
	identity: string | null;
	/** oauth: org name, else org id, when distinct from `identity`. api_key: null. */
	org: string | null;
	/** api_key: last 4 characters, e.g. "…a1b2". oauth: null. */
	hint: string | null;
	/** disabled_cause, or null when usable. */
	disabled: string | null;
	/** The provider's default for new sessions. */
	isDefault: boolean;
	/**
	 * The row this session uses by choice: its pin, else the provider's default.
	 * A row that usage ranking picked for an unpinned session is not active.
	 * False without a session id.
	 */
	active: boolean;
	/** This session has an explicit pin on this row. */
	pinned: boolean;
}

/** Raw catalog row: every column the summary needs, disabled rows included, tombstones left out. */
export interface CredentialCatalogRow {
	id: number;
	provider: string;
	credential_type: string;
	data: string;
	disabled_cause: string | null;
	label: string | null;
	is_default: number;
}

/** Store capability that {@link AuthStorage} uses for labels, defaults and re-enabling. */
export interface CredentialCatalog {
	list(provider?: string): CredentialCatalogRow[];
	get(id: number): CredentialCatalogRow | undefined;
	/** Insert one api_key row next to the provider's other rows; an identical active key returns its id. */
	insertApiKey(provider: string, key: string, label: string | null): number;
	rename(id: number, label: string | null): void;
	setDefault(provider: string, id: number | null): void;
	/** The provider's default row id, only while that row is enabled. */
	defaultId(provider: string): number | undefined;
	/** Clear disabled_cause; returns the row's provider, or undefined when no disabled row matched. */
	enable(id: number): string | undefined;
	/** Set a disabled row's cause to `cause`; false when no disabled row has this id. */
	markDeleted(id: number, cause: string): boolean;
}

/** Cause upstream `login()` writes on api_key rows when an OAuth subscription lands. */
export const OAUTH_LOGIN_REPLACED_CAUSE = "replaced by oauth login";

/** Cause of a removed row. The catalog treats such a tombstone as missing. */
export const DELETED_BY_USER_CAUSE = "deleted by user";

/** Cause the store writes when a login re-uploads an identical API key. */
const REPLACED_BY_NEWER_CAUSE = "replaced by newer credential";

/**
 * The store hard-deletes disabled API-key rows on every upsert of a provider that has an
 * active key. Only a removal tombstone or a replaced duplicate may go that way: a key the user
 * or a login disabled is still the user's key and stays listed until the user removes it.
 */
export function isPurgeableApiKeyCause(cause: string | null): boolean {
	return cause === DELETED_BY_USER_CAUSE || cause === REPLACED_BY_NEWER_CAUSE;
}

/**
 * Schema V8 → V9: `label` and `is_default`. Idempotent, because a fresh database
 * and every upstream rebuild of the table reach this through the same call.
 */
export function ensureCredentialCatalogColumns(db: Database): void {
	const stmt = db.prepare("PRAGMA table_info(auth_credentials)");
	let columns: Array<{ name: string }>;
	try {
		columns = stmt.all() as Array<{ name: string }>;
	} finally {
		stmt.finalize();
	}
	if (!columns.some(column => column.name === "label")) {
		db.run("ALTER TABLE auth_credentials ADD COLUMN label TEXT NULL");
	}
	if (!columns.some(column => column.name === "is_default")) {
		db.run("ALTER TABLE auth_credentials ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0");
	}
}

/** Migration step in the upstream chain: add the columns and record version 9 in one transaction. */
export function migrateAuthSchemaV8ToV9(db: Database, writeVersion: (version: number) => void): void {
	db.transaction(() => {
		ensureCredentialCatalogColumns(db);
		writeVersion(9);
	}).immediate();
}

function normalizeLabel(label: string | null | undefined): string | null {
	const trimmed = label?.trim();
	return trimmed ? trimmed : null;
}

const CATALOG_COLUMNS = "id, provider, credential_type, data, disabled_cause, label, is_default";
const NOT_TOMBSTONE = `disabled_cause IS NOT '${DELETED_BY_USER_CAUSE}'`;
const SQLITE_NOW_EPOCH = "CAST(strftime('%s','now') AS INTEGER)";

/** SQLite implementation over the store's own connection. */
export class SqliteCredentialCatalog implements CredentialCatalog {
	readonly #db: Database;
	readonly #listAll: Statement;
	readonly #listByProvider: Statement;
	readonly #getById: Statement;
	readonly #defaultByProvider: Statement;
	readonly #insertApiKey: Statement;

	constructor(db: Database) {
		this.#db = db;
		this.#listAll = db.prepare(
			`SELECT ${CATALOG_COLUMNS} FROM auth_credentials WHERE ${NOT_TOMBSTONE} ORDER BY provider ASC, id ASC`,
		);
		this.#listByProvider = db.prepare(
			`SELECT ${CATALOG_COLUMNS} FROM auth_credentials WHERE provider = ? AND ${NOT_TOMBSTONE} ORDER BY id ASC`,
		);
		this.#getById = db.prepare(`SELECT ${CATALOG_COLUMNS} FROM auth_credentials WHERE id = ? AND ${NOT_TOMBSTONE}`);
		this.#defaultByProvider = db.prepare(
			"SELECT id FROM auth_credentials WHERE provider = ? AND is_default = 1 AND disabled_cause IS NULL ORDER BY id ASC LIMIT 1",
		);
		this.#insertApiKey = db.prepare(
			`INSERT INTO auth_credentials (provider, credential_type, data, identity_key, label, created_at, updated_at) VALUES (?, 'api_key', ?, NULL, ?, ${SQLITE_NOW_EPOCH}, ${SQLITE_NOW_EPOCH}) RETURNING id`,
		);
	}

	/** Finalize the prepared statements; the store calls this before it closes the connection. */
	close(): void {
		this.#listAll.finalize();
		this.#listByProvider.finalize();
		this.#getById.finalize();
		this.#defaultByProvider.finalize();
		this.#insertApiKey.finalize();
	}

	list(provider?: string): CredentialCatalogRow[] {
		const rows = provider === undefined ? this.#listAll.all() : this.#listByProvider.all(provider);
		return rows as CredentialCatalogRow[];
	}

	get(id: number): CredentialCatalogRow | undefined {
		return (this.#getById.get(id) as CredentialCatalogRow | null) ?? undefined;
	}

	insertApiKey(provider: string, key: string, label: string | null): number {
		const trimmedKey = key.trim();
		if (!trimmedKey) throw new Error("API key is empty");
		const name = normalizeLabel(label);
		return this.#db.transaction(() => {
			const existing = this.list(provider).find(row => {
				if (row.credential_type !== "api_key" || row.disabled_cause !== null) return false;
				try {
					return (JSON.parse(row.data) as { key?: unknown }).key === trimmedKey;
				} catch {
					return false;
				}
			});
			if (existing) {
				if (name !== null) this.#rename(existing.id, name);
				return existing.id;
			}
			if (name !== null) this.#assertLabelFree(provider, name, undefined);
			const row = this.#insertApiKey.get(provider, JSON.stringify({ key: trimmedKey, source: "login" }), name) as {
				id: number;
			};
			return row.id;
		})();
	}

	rename(id: number, label: string | null): void {
		this.#db.transaction(() => this.#rename(id, normalizeLabel(label)))();
	}

	#rename(id: number, label: string | null): void {
		const row = this.get(id);
		if (!row) throw new Error(`No credential with id ${id}`);
		if (label !== null) this.#assertLabelFree(row.provider, label, id);
		this.#db.run("UPDATE auth_credentials SET label = ? WHERE id = ?", [label, id]);
	}

	#assertLabelFree(provider: string, label: string, exceptId: number | undefined): void {
		const wanted = label.toLowerCase();
		const clash = this.list(provider).find(row => row.id !== exceptId && row.label?.toLowerCase() === wanted);
		if (clash) throw new Error(`${provider} already has a credential named "${clash.label}" (id ${clash.id})`);
	}

	setDefault(provider: string, id: number | null): void {
		this.#db.transaction(() => {
			if (id !== null) {
				const row = this.get(id);
				if (!row || row.provider !== provider) throw new Error(`No ${provider} credential with id ${id}`);
				if (row.disabled_cause !== null) throw new Error(`Credential ${id} is disabled: ${row.disabled_cause}`);
			}
			this.#db.run("UPDATE auth_credentials SET is_default = 0 WHERE provider = ? AND is_default != 0", [provider]);
			if (id !== null) this.#db.run("UPDATE auth_credentials SET is_default = 1 WHERE id = ?", [id]);
		})();
	}

	defaultId(provider: string): number | undefined {
		return (this.#defaultByProvider.get(provider) as { id: number } | null)?.id;
	}

	enable(id: number): string | undefined {
		const row = this.get(id);
		if (!row || row.disabled_cause === null) return undefined;
		this.#db.run(
			`UPDATE auth_credentials SET disabled_cause = NULL, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND disabled_cause IS NOT NULL AND ${NOT_TOMBSTONE}`,
			[id],
		);
		return row.provider;
	}

	markDeleted(id: number, cause: string): boolean {
		const result = this.#db.run(
			`UPDATE auth_credentials SET disabled_cause = ?, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND disabled_cause IS NOT NULL AND ${NOT_TOMBSTONE}`,
			[cause, id],
		);
		return result.changes > 0;
	}
}

/** Build the summary for one row; the marks come from the session's pin and the provider's default. */
export function summarizeCredentialRow(
	row: CredentialCatalogRow,
	marks: { activeId?: number; pinnedId?: number },
): CredentialSummary {
	let data: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(row.data) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
	} catch {
		// An unparsable payload still lists, without identity or hint.
	}
	const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
	const kind = row.credential_type === "api_key" ? "api_key" : "oauth";
	const key = kind === "api_key" ? text(data.key) : null;
	return {
		id: row.id,
		provider: row.provider,
		kind,
		label: row.label,
		identity:
			kind === "oauth"
				? (text(data.email) ?? text(data.accountId) ?? text(data.orgName) ?? text(data.orgId) ?? text(data.projectId))
				: null,
		org: (() => {
			if (kind !== "oauth") return null;
			const org = text(data.orgName) ?? text(data.orgId);
			const identity =
				text(data.email) ?? text(data.accountId) ?? text(data.orgName) ?? text(data.orgId) ?? text(data.projectId);
			return org && org !== identity ? org : null;
		})(),
		hint: key ? `…${key.slice(-4)}` : null,
		disabled: row.disabled_cause,
		isDefault: row.is_default === 1,
		active: marks.activeId === row.id,
		pinned: marks.pinnedId === row.id,
	};
}

/** Short human name for a row in messages: `#12 "work"` or `#12 a@b.c`. */
export function describeCredential(summary: CredentialSummary | undefined, id: number): string {
	if (!summary) return `#${id}`;
	const name = summary.label ? `"${summary.label}"` : (summary.identity ?? summary.hint ?? summary.kind);
	return `#${id} ${name}`;
}

/**
 * Un-suffixed candidate name for a row that has no explicit label: an oauth
 * row's identity, with the org appended when a sibling row of the same
 * provider shares that identity; an api_key row's `<provider> key <hint>`.
 */
function baseCredentialLabel(row: CredentialSummary, rows: readonly CredentialSummary[]): string {
	if (row.kind !== "oauth") return `${row.provider} key ${row.hint ?? ""}`.trim();
	const identity = row.identity ?? row.hint ?? row.kind;
	const sameIdentityElsewhere = rows.some(
		other =>
			other.id !== row.id && other.provider === row.provider && other.kind === "oauth" && other.identity === identity,
	);
	return sameIdentityElsewhere && row.org ? `${identity} (${row.org})` : identity;
}

/**
 * A name for a row with no explicit label: the existing label wins outright;
 * otherwise {@link baseCredentialLabel}, suffixed ` 2`, ` 3`, … until it is
 * unique (case-insensitive) among the provider's other rows' effective names.
 */
export function suggestCredentialLabel(rows: CredentialSummary[], row: CredentialSummary): string {
	if (row.label) return row.label;
	const base = baseCredentialLabel(row, rows);
	// Only earlier rows (by array order) count as "taken": with no other tiebreaker,
	// two rows computing the same base must not both defer to each other.
	const rowPosition = rows.findIndex(other => other.id === row.id);
	const taken = new Set(
		rows
			.filter(
				(other, index) => other.id !== row.id && other.provider === row.provider && (rowPosition === -1 || index < rowPosition),
			)
			.map(other => (other.label ?? baseCredentialLabel(other, rows)).toLowerCase()),
	);
	if (!taken.has(base.toLowerCase())) return base;
	let suffix = 2;
	while (taken.has(`${base} ${suffix}`.toLowerCase())) suffix += 1;
	return `${base} ${suffix}`;
}
