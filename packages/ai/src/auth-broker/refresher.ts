/**
 * Background OAuth refresh loop for the auth-broker server.
 *
 * Iterates active OAuth credentials at `refreshIntervalMs` cadence, refreshing
 * any whose `expires - Date.now() < refreshSkewMs`. Delegates to
 * {@link AuthStorage.oauth.refreshCredentials}, so single-flight, the durable
 * lease and CAS-disable all live in one place shared by manual and background
 * refreshes.
 * Definitively-failed credentials (invalid_grant / bare 401, not a network
 * blip) are torn down inside {@link AuthStorage.oauth.refresh} via a
 * compare-and-set disable — only when no peer/login rotated the row first — so
 * the next snapshot pull surfaces a clean delete on the client.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { AuthStorage } from "../auth-storage";
import { isDefinitiveOAuthFailure } from "../error/auth-classify";
import { DEFAULT_REFRESH_INTERVAL_MS, DEFAULT_REFRESH_SKEW_MS } from "./types";

export interface AuthBrokerRefresherOptions {
	storage: AuthStorage;
	/** Refresh credentials expiring within this window. Default 5 min. */
	refreshSkewMs?: number;
	/** Loop cadence. Default 60s. */
	refreshIntervalMs?: number;
	/** Override clock (tests). */
	now?: () => number;
}

export interface AuthBrokerRefresherSchedule {
	enabled: boolean;
	intervalMs: number;
	skewMs: number;
	nextSweepAt: number;
}

export class AuthBrokerRefresher {
	readonly #storage: AuthStorage;
	readonly #refreshSkewMs: number;
	readonly #refreshIntervalMs: number;
	readonly #now: () => number;
	#timer: NodeJS.Timeout | undefined;
	#running = false;
	#nextSweepAt: number;
	constructor(opts: AuthBrokerRefresherOptions) {
		this.#storage = opts.storage;
		this.#refreshSkewMs = opts.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
		this.#refreshIntervalMs = opts.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
		this.#now = opts.now ?? Date.now;
		this.#nextSweepAt = this.#now();
	}

	start(): void {
		if (this.#timer !== undefined) return;
		// Refresh sweep is best-effort; kick once immediately so freshly-booted
		// brokers don't hand out near-expired tokens for the first interval.
		this.#nextSweepAt = this.#now();
		void this.tick();
		this.#timer = setInterval(() => {
			void this.tick();
		}, this.#refreshIntervalMs);
	}

	stop(): void {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	getSchedule(): AuthBrokerRefresherSchedule {
		return {
			enabled: true,
			intervalMs: this.#refreshIntervalMs,
			skewMs: this.#refreshSkewMs,
			nextSweepAt: this.#nextSweepAt,
		};
	}

	/** Run one sweep. Exposed for tests. */
	async tick(): Promise<void> {
		if (this.#running) return;
		this.#running = true;
		this.#nextSweepAt = this.#now();
		try {
			const result = await this.#storage.oauth.refreshCredentials({ skewMs: this.#refreshSkewMs });
			for (const { id, error } of result.failed) {
				if (isDefinitiveOAuthFailure(error)) {
					// AuthStorage.oauth.refresh already CAS-disabled the row
					// (unless a peer/login rotated it first, in which case the live
					// credential is intentionally kept). Nothing to do here but record it.
					logger.warn("auth-broker refresh failed definitively", { id, error });
				} else {
					logger.debug("auth-broker refresh failed (transient)", { id, error });
				}
			}
		} finally {
			this.#running = false;
			this.#nextSweepAt = this.#now() + this.#refreshIntervalMs;
		}
	}
}
