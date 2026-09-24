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
import { deserializeCredential, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
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
export { suggestCredentialLabel } from "./auth/credential-catalog";
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
		if (options.onCredentialRemoved) this.#modules.pool.onRemoved(options.onCredentialRemoved);
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
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher, store });

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

	/** Every stored credential, disabled rows included, removed rows left out; `active` and `pinned` describe `sessionId`'s choice. */
	listCredentials(provider?: string, sessionId?: string): CredentialSummary[] {
		const marksByProvider = new Map<string, { activeId?: number; pinnedId?: number }>();
		return this.#catalog()
			.list(provider)
			.map(row => {
				let marks = marksByProvider.get(row.provider);
				if (!marks) {
					marks = this.#credentialMarks(row.provider, sessionId);
					marksByProvider.set(row.provider, marks);
				}
				return summarizeCredentialRow(row, marks);
			});
	}

	/**
	 * C-2: the full stored credential for `id`, enabled or disabled —
	 * `listCredentials`/`listDisabled` return summaries with no secret to
	 * fetch a live usage report with, and `credentials.list(provider)` only
	 * covers the enabled in-memory pool. `undefined` when the store keeps no
	 * catalog (a broker predating the endpoint) or no row has this id.
	 */
	credentialById(id: number): AuthCredential | undefined {
		const row = this.#store.credentialCatalog?.get(id);
		if (!row) return undefined;
		return deserializeCredential(row) ?? undefined;
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

	/**
	 * Strict session pin on an OAuth or API-key row; false when the row is missing. `exclusive`
	 * is a binding's pin (a subagent bound to an account): a model that only other accounts serve
	 * moves a plain pin for that request, never this one.
	 */
	pinSessionCredential(provider: string, sessionId: string, id: number, options?: { exclusive?: boolean }): boolean {
		return this.#affinity.pinStrict(provider, sessionId, id, options);
	}

	/** Whether the session's pin is a binding's pin, which nothing moves. */
	sessionPinIsExclusive(provider: string, sessionId: string): boolean {
		return this.#affinity.strictPinIsExclusive(provider, sessionId);
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

	/**
	 * Remove one row of `provider`, active or disabled; the other rows stay. A removed row no
	 * longer lists. When `options.sessionId`'s strict pin names this row, the pin is cleared —
	 * later resolves for that session fall through to the provider's default or the ranked pool.
	 */
	async removeCredential(provider: string, id: number, options?: { sessionId?: string }): Promise<boolean> {
		const removed = await this.#pool.removeById(provider, id);
		if (removed && options?.sessionId) this.#clearPinOnRemoval(provider, id, options.sessionId);
		return removed;
	}

	/**
	 * Remove every stored row of `provider`. When `options.sessionId` is given, that session's
	 * pin (if any) is cleared — every row it could have named is now gone.
	 */
	async remove(provider: string, options?: { sessionId?: string }): Promise<void> {
		await this.#pool.remove(provider);
		if (options?.sessionId) this.#affinity.unpin(provider, options.sessionId);
	}

	/** Clear `sessionId`'s pin when it names the row just removed. A no-op without a match. */
	#clearPinOnRemoval(provider: string, credentialId: number, sessionId: string): void {
		if (this.#affinity.strictPin(provider, sessionId) === credentialId) this.#affinity.unpin(provider, sessionId);
	}

	#catalog(): CredentialCatalog {
		const catalog = this.#store.credentialCatalog;
		if (!catalog)
			throw new AIError.ConfigurationError("This credential store does not support credential management");
		return catalog;
	}

	/**
	 * Only a user choice marks a row: the pin, else the default. Ranking and the sticky never do.
	 * A runtime override marks nothing; a config key that counts hides the default, not the pin.
	 */
	#credentialMarks(provider: string, sessionId: string | undefined): { activeId?: number; pinnedId?: number } {
		if (!sessionId || this.#overrides.hasRuntime(provider)) return {};
		const pinnedId = this.#affinity.strictPin(provider, sessionId);
		if (pinnedId === undefined && this.#overrides.configCounts(provider)) return {};
		return {
			activeId: this.#affinity.preferredOrSole(provider, sessionId)?.credentialId,
			pinnedId,
		};
	}
}
