/**
 * Credential catalog: user labels, a per-provider default, and explicit
 * session pins over the `auth_credentials` rows.
 *
 * Kept apart from sqlite-credential-store.ts and auth-storage.ts so the
 * upstream files carry only small hooks into this module.
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
	/** api_key: last 4 characters, e.g. "…a1b2". oauth: null. */
	hint: string | null;
	/** disabled_cause, or null when usable. */
	disabled: string | null;
	/** The provider's default for new sessions. */
	isDefault: boolean;
	/** The row this session resolves to right now (false without a session id). */
	active: boolean;
}

/** Raw catalog row: every column the summary needs, disabled rows included. */
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
}

/** Cause upstream `login()` writes on api_key rows when an OAuth subscription lands. */
export const OAUTH_LOGIN_REPLACED_CAUSE = "replaced by oauth login";

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
		this.#listAll = db.prepare(`SELECT ${CATALOG_COLUMNS} FROM auth_credentials ORDER BY provider ASC, id ASC`);
		this.#listByProvider = db.prepare(
			`SELECT ${CATALOG_COLUMNS} FROM auth_credentials WHERE provider = ? ORDER BY id ASC`,
		);
		this.#getById = db.prepare(`SELECT ${CATALOG_COLUMNS} FROM auth_credentials WHERE id = ?`);
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
			`UPDATE auth_credentials SET disabled_cause = NULL, updated_at = ${SQLITE_NOW_EPOCH} WHERE id = ? AND disabled_cause IS NOT NULL`,
			[id],
		);
		return row.provider;
	}
}

/** Build the summary for one row; `activeId` comes from the session's resolution state. */
export function summarizeCredentialRow(row: CredentialCatalogRow, activeId: number | undefined): CredentialSummary {
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
		hint: key ? `…${key.slice(-4)}` : null,
		disabled: row.disabled_cause,
		isDefault: row.is_default === 1,
		active: activeId !== undefined && activeId === row.id,
	};
}

/** Short human name for a row in messages: `#12 "work"` or `#12 a@b.c`. */
export function describeCredential(summary: CredentialSummary | undefined, id: number): string {
	if (!summary) return `#${id}`;
	const name = summary.label ? `"${summary.label}"` : (summary.identity ?? summary.hint ?? summary.kind);
	return `#${id} ${name}`;
}

/** Minimal cache surface of AuthCredentialStore the pins persist through. */
export interface PinCacheStore {
	getCache(key: string): string | null;
	setCache(key: string, value: string, expiresAtSec: number): void;
}

const SESSION_PIN_CACHE_PREFIX = "session:pin:";
/** A pin lives as long as a session can plausibly resume. */
const SESSION_PIN_TTL_SEC = 365 * 24 * 60 * 60;

/**
 * Explicit session pins. Separate from the upstream session sticky, which
 * every resolve rewrites: a pin is only written by a user choice, so usage
 * ranking and anthropic idle warmth never move it.
 */
export class SessionCredentialPins {
	/** provider → sessionId → credential id, or null for a cached absence. */
	readonly #pins = new Map<string, Map<string, number | null>>();

	get(store: PinCacheStore, provider: string, sessionId: string | undefined): number | undefined {
		if (!sessionId) return undefined;
		const bySession = this.#pins.get(provider);
		const cached = bySession?.get(sessionId);
		if (cached !== undefined) return cached ?? undefined;
		let id: number | null = null;
		try {
			const raw = store.getCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`);
			const parsed = raw ? (JSON.parse(raw) as { credentialId?: unknown }) : undefined;
			if (typeof parsed?.credentialId === "number") id = parsed.credentialId;
		} catch {
			id = null;
		}
		this.#remember(provider, sessionId, id);
		return id ?? undefined;
	}

	set(store: PinCacheStore, provider: string, sessionId: string, credentialId: number): void {
		const nowSec = Math.floor(Date.now() / 1000);
		store.setCache(
			`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`,
			JSON.stringify({ credentialId }),
			nowSec + SESSION_PIN_TTL_SEC,
		);
		this.#remember(provider, sessionId, credentialId);
	}

	clear(store: PinCacheStore, provider: string, sessionId: string): void {
		store.setCache(`${SESSION_PIN_CACHE_PREFIX}${provider}:${sessionId}`, "", 0);
		this.#remember(provider, sessionId, null);
	}

	/** Copy every pin of `source` to `target` (subagents keep their parent's account separation). */
	inherit(store: PinCacheStore, providers: Iterable<string>, source: string, target: string): void {
		for (const provider of providers) {
			const id = this.get(store, provider, source);
			if (id !== undefined) this.set(store, provider, target, id);
		}
	}

	#remember(provider: string, sessionId: string, id: number | null): void {
		let bySession = this.#pins.get(provider);
		if (!bySession) {
			bySession = new Map();
			this.#pins.set(provider, bySession);
		}
		bySession.set(sessionId, id);
	}
}
