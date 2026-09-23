/**
 * Credential storage for API keys and OAuth tokens.
 *
 * {@link AuthStorage} composes the credential modules under `./auth/` over one
 * {@link AuthCredentialStore} and exposes them as namespaces:
 * - `credentials` — stored rows, reload/poll, change and disable events, broker snapshot
 * - `keys` — the provider auth cascade (runtime → config → OAuth → login key → env → stored key)
 * - `oauth` — login, per-account access resolution, account listings, refresh
 * - `sessions` — session → account pins
 * - `usage` — usage reports, header ingestion, history
 * - `health` — model pool health and per-credential auth probes
 * - `limits` — usage-limit marking and credential rotation
 * - `resets` — saved rate-limit resets
 * - `blocks` — persisted rate-limit blocks (auth-broker server seam)
 *
 * @example
 * const auth = await AuthStorage.create(getAgentDbPath());
 * await auth.credentials.reload();
 * const apiKey = await auth.keys.get("anthropic", sessionId, { modelId });
 */
import { logger } from "@oh-my-pi/pi-utils";
import { SessionAffinity } from "./auth/affinity";
import { BlockStoreHealth, CredentialBlocks } from "./auth/blocks";
import { KeyCascade, KeyOverrides } from "./auth/cascade";
import { type CredentialCatalog, type CredentialSummary, summarizeCredentialRow } from "./auth/credential-catalog";
import { CredentialHealth } from "./auth/health";
import { OAuthAccounts } from "./auth/oauth";
import { AccountPolicies } from "./auth/policy";
import { CredentialPool } from "./auth/pool";
import { OAuthRefresher } from "./auth/refresh";
import { ResetCredits } from "./auth/resets";
import { RateLimits } from "./auth/rotation";
import { CredentialSelector } from "./auth/select";
import { SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
import type { AuthCredentialStore } from "./auth/store";
import type {
	AuthAccountPolicies,
	AuthApiKeyOptions,
	AuthCredential,
	AuthStorageOptions,
	BlocksApi,
	CredentialsApi,
	HealthApi,
	KeysApi,
	LimitsApi,
	OAuthApi,
	ResetsApi,
	SessionsApi,
	UsageApi,
} from "./auth/types";
import { UsageService } from "./auth/usage";
import { DEFAULT_USAGE_REQUEST_TIMEOUT_MS, UsageCache } from "./auth/usage-cache";
import * as AIError from "./error";
import type { UsageLogger } from "./usage";
import { defaultRankingStrategy, defaultUsageProvider } from "./usage/registry";

export { isSqliteBusyError, isSqliteCorruptionError, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
export type { CredentialSummary } from "./auth/credential-catalog";
export * from "./auth/store";
export * from "./auth/types";

/** Store-bound credential modules; rebuilt as a unit by {@link AuthStorage.replaceStore}. */
interface AuthStorageModules {
	store: AuthCredentialStore;
	pool: CredentialPool;
	keys: KeyCascade;
	oauth: OAuthAccounts;
	sessions: SessionAffinity;
	usage: UsageService;
	health: CredentialHealth;
	limits: RateLimits;
	resets: ResetCredits;
	blocks: CredentialBlocks;
}

/**
 * Credential management over an {@link AuthCredentialStore}: multi-account
 * selection with usage-aware ranking, rate-limit blocks, OAuth refresh, and
 * usage reporting. See the module doc for the namespace layout.
 *
 * Namespaces resolve against the current store on every access, so holders of
 * this instance follow {@link AuthStorage.replaceStore} without re-wiring.
 */
export class AuthStorage {
	readonly #options: AuthStorageOptions;
	readonly #overrides: KeyOverrides;
	readonly #policies: AccountPolicies;
	#modules: AuthStorageModules;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		this.#options = options;
		this.#overrides = new KeyOverrides(options.configValueResolver);
		this.#policies = new AccountPolicies(options.accountPolicies ?? [], options.defaultReservePct);
		this.#modules = this.#compose(store, options.sourceLabel);
		if (options.onCredentialDisabled) this.#modules.pool.onDisabled(options.onCredentialDisabled);
	}

	/** Stored credential rows, change/disable events, broker snapshot. */
	get credentials(): CredentialsApi {
		return this.#modules.pool;
	}
	/** Provider auth cascade and key overrides. */
	get keys(): KeysApi {
		return this.#modules.keys;
	}
	/** OAuth login, account access, listings, refresh. */
	get oauth(): OAuthApi {
		return this.#modules.oauth;
	}
	/** Session → account pins. */
	get sessions(): SessionsApi {
		return this.#modules.sessions;
	}
	/** Usage reports, header ingestion, history. */
	get usage(): UsageApi {
		return this.#modules.usage;
	}
	/** Model pool health and per-credential probes. */
	get health(): HealthApi {
		return this.#modules.health;
	}
	/** Usage-limit marking and credential rotation. */
	get limits(): LimitsApi {
		return this.#modules.limits;
	}
	/** Saved rate-limit resets. */
	get resets(): ResetsApi {
		return this.#modules.resets;
	}
	/** Persisted rate-limit blocks (auth-broker server seam). */
	get blocks(): BlocksApi {
		return this.#modules.blocks;
	}

	// The credential catalog methods below follow {@link AuthStorage.replaceStore} through these.
	get #store(): AuthCredentialStore {
		return this.#modules.store;
	}
	get #pool(): CredentialPool {
		return this.#modules.pool;
	}
	get #affinity(): SessionAffinity {
		return this.#modules.sessions;
	}

	/**
	 * Apply new account routing policy (live `auth.accountPolicies` /
	 * `retry.usageReservePct` change). Throws a configuration error, leaving the
	 * active policy untouched, when the policy is malformed or does not match the
	 * stored OAuth accounts.
	 */
	setAccountPolicies(config: { accountPolicies: AuthAccountPolicies; defaultReservePct: number }): void {
		const pool = this.#modules.pool;
		const stored = new Map<string, AuthCredential[]>();
		for (const provider of pool.providers()) stored.set(provider, pool.credentials(provider));
		this.#policies.replace(config.accountPolicies, config.defaultReservePct, stored);
	}

	/**
	 * Swap the backing credential store in place (live `auth.broker.url` change).
	 * Loads `store` into fresh store-bound state — pins, blocks, and usage caches are
	 * keyed by the old store's row ids — then closes the previous store. Runtime key
	 * overrides, account policies, usage-provider overrides, and credential event
	 * subscribers carry over. On a load failure `store` is closed and the current
	 * store stays active.
	 */
	async replaceStore(store: AuthCredentialStore, options: { sourceLabel?: string } = {}): Promise<void> {
		const next = this.#compose(store, options.sourceLabel ?? this.#options.sourceLabel);
		try {
			await next.pool.reload();
		} catch (error) {
			next.pool.close();
			throw error;
		}
		const previous = this.#modules;
		next.pool.adoptSubscribers(previous.pool);
		next.usage.adoptRuntimeProviders(previous.usage);
		this.#modules = next;
		previous.pool.close();
		next.pool.bump("store-replaced");
	}

	#compose(store: AuthCredentialStore, sourceLabel: string | undefined): AuthStorageModules {
		const options = this.#options;
		const overrides = this.#overrides;
		const policies = this.#policies;
		const blockHealth = new BlockStoreHealth(sourceLabel);
		const strategies = options.rankingStrategyResolver ?? defaultRankingStrategy;
		const pool = new CredentialPool(store, {
			policies,
			blockHealth,
			onReset: provider => {
				selector.resetRoundRobin(provider);
				affinity.clearProvider(provider);
			},
		});
		const refresher = new OAuthRefresher({ store, pool, policies, override: options.refreshOAuthCredential });
		const usageProviders = options.usageProviderResolver ?? defaultUsageProvider;
		const usageCache = new UsageCache(store, pool, usageProviders);
		const blocks = new CredentialBlocks({ store, pool, health: blockHealth, usageCache, strategies });
		const affinity = new SessionAffinity(store, pool, overrides);
		const usage = new UsageService({
			store,
			pool,
			overrides,
			refresher,
			cache: usageCache,
			blocks,
			affinity,
			strategies,
			usageProviders,
			fetch: options.usageFetch ?? fetch,
			requestTimeoutMs: options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS,
			logger:
				options.usageLogger ??
				({
					debug: (message, meta) => logger.debug(message, meta),
					warn: (message, meta) => logger.warn(message, meta),
				} satisfies UsageLogger),
		});
		const selector = new CredentialSelector({
			store,
			pool,
			policies,
			blocks,
			affinity,
			usage,
			refresher,
			strategies,
		});
		const limits = new RateLimits({ store, pool, overrides, blocks, affinity, usage, strategies });
		const keys = new KeyCascade({
			pool,
			overrides,
			selector,
			affinity,
			rotate: (provider, sessionId, rotateOptions) => limits.rotate(provider, sessionId, rotateOptions),
			sourceLabel,
		});
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher });

		return {
			store,
			pool,
			keys,
			oauth,
			sessions: affinity,
			usage,
			health: new CredentialHealth({
				store,
				pool,
				keys,
				policies,
				blocks,
				affinity,
				usage,
				refresher,
				overrides,
				strategies,
			}),
			limits,
			resets: new ResetCredits({ store, pool, oauth, usage, usageCache, blocks }),
			blocks,
		};
	}

	/** Open the SQLite store at `dbPath` and wrap it (standalone use, e.g. the pi-ai CLI). */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/** Close the underlying credential store; the instance must not be reused. */
	close(): void {
		this.#modules.pool.close();
	}

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.keys}`.get`.
	 */
	getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		return this.keys.get(provider, sessionId, options);
	}

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.credentials}`.reload`.
	 */
	reload(): Promise<void> {
		return this.credentials.reload();
	}

	// ─── Credential catalog: /providers → Credentials (see ./auth/credential-catalog.ts) ───

	/** Every stored credential, disabled rows included; `active` marks what `sessionId` resolves to. */
	listCredentials(provider?: string, sessionId?: string): CredentialSummary[] {
		const activeByProvider = new Map<string, number | undefined>();
		return this.#catalog()
			.list(provider)
			.map(row => {
				if (!activeByProvider.has(row.provider)) {
					activeByProvider.set(row.provider, this.#activeCredentialId(row.provider, sessionId));
				}
				return summarizeCredentialRow(row, activeByProvider.get(row.provider));
			});
	}

	/** Store one more API key for `provider`; other rows stay. Returns the row id. */
	addApiKey(provider: string, key: string, label?: string | null): number {
		const id = this.#catalog().insertApiKey(provider, key, label ?? null);
		this.#pool.reloadProvider(provider);
		return id;
	}

	/** Name a credential; null clears the name. Throws when the name is taken within the provider. */
	renameCredential(id: number, label: string | null): void {
		this.#catalog().rename(id, label);
	}

	/** The row new sessions of `provider` resolve to first; null clears the default. */
	setDefaultCredential(provider: string, id: number | null): void {
		this.#catalog().setDefault(provider, id);
	}

	/** Strict session pin on an OAuth or API-key row; false when the row is missing. */
	pinSessionCredential(provider: string, sessionId: string, id: number): boolean {
		return this.#affinity.pinStrict(provider, sessionId, id);
	}

	/** Drop the session's strict pin; the session returns to the default and the pool. */
	clearSessionCredential(provider: string, sessionId: string): void {
		this.#affinity.unpin(provider, sessionId);
	}

	/** Clear a row's disabled cause. Returns false when no disabled row has this id. */
	enableCredential(id: number): boolean {
		const provider = this.#catalog().enable(id);
		if (provider === undefined) return false;
		this.#pool.reloadProvider(provider);
		return true;
	}

	/** Disable one row by id and emit the disabled event; false when no active row has this id. */
	disableCredentialById(id: number, cause: string): Promise<boolean> {
		return this.#pool.disable(id, cause);
	}

	/** Disable one row of `provider` as "deleted by user"; the other rows stay. */
	removeCredential(provider: string, id: number): Promise<boolean> {
		return this.#pool.removeById(provider, id);
	}

	#catalog(): CredentialCatalog {
		const catalog = this.#store.credentialCatalog;
		if (!catalog) throw new AIError.ConfigurationError("This credential store does not support credential management");
		return catalog;
	}

	#activeCredentialId(provider: string, sessionId: string | undefined): number | undefined {
		if (!sessionId || this.#overrides.has(provider)) return undefined;
		const preferred = this.#affinity.preferred(provider, sessionId);
		if (preferred || this.#affinity.strictPin(provider, sessionId) !== undefined) return preferred?.credentialId;
		const sticky = this.#affinity.get(provider, sessionId);
		return sticky ? this.#pool.entries(provider)[sticky.index]?.id : undefined;
	}
}
