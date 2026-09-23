/**
 * Interactive-process credential refresh sweep: periodically keeps every
 * refreshable OAuth row fresh via {@link AuthStorage.oauth.refreshCredentials},
 * without running a full auth-broker server. Coding-agent hosts (CLI, TUI)
 * start this once at boot so an idle session's token does not go stale
 * between requests.
 */
import type { AuthStorage } from "../auth-storage";

export interface CredentialRefreshSweepOptions {
	/** Sweep cadence. Default 15 minutes. */
	intervalMs?: number;
	/** Refresh a row expiring within this window. Default 1 hour. */
	skewMs?: number;
}

const DEFAULT_INTERVAL_MS = 15 * 60_000;
const DEFAULT_SKEW_MS = 60 * 60_000;
const FIRST_TICK_DELAY_MS = 30_000;

/**
 * Starts the sweep and returns a `stop()` that clears both timers. Both
 * timers are `unref()`d so the sweep never keeps the process alive on its
 * own; the first tick runs 30s after start, not immediately, so it never
 * competes with a fresh process's startup work.
 */
export function startCredentialRefreshSweep(
	authStorage: AuthStorage,
	options: CredentialRefreshSweepOptions = {},
): () => void {
	const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
	const skewMs = options.skewMs ?? DEFAULT_SKEW_MS;

	const tick = (): void => {
		void authStorage.oauth.refreshCredentials({ skewMs });
	};

	const initial = setTimeout(tick, FIRST_TICK_DELAY_MS);
	initial.unref?.();
	const interval = setInterval(tick, intervalMs);
	interval.unref?.();

	return (): void => {
		clearTimeout(initial);
		clearInterval(interval);
	};
}
