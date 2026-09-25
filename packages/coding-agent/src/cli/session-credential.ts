/**
 * `--credential <provider>/<id>` (repeatable): pins a chosen stored row as
 * this main session's active credential for that provider, before the first
 * turn. Addendum 5 (S-1): each main session keeps its own active credential,
 * independent of every other running session and of the provider-wide
 * default. Resolution is strict — a picker step would need a TTY, and this
 * flag exists so a script can start pinned with no prompt — so any unknown,
 * disabled or malformed value is a hard error listing the enabled rows,
 * through the one grammar every credential selector shares.
 */
import type { AuthStorage, CredentialSummary } from "@oh-my-pi/pi-ai";
import { resolveCredentialTarget } from "../auth/credential-selector";

/** One resolved `--credential <provider>/<id>` target. */
export interface SessionCredentialTarget {
	provider: string;
	row: CredentialSummary;
}

/** Resolve one `--credential` value against the stored, enabled rows. */
export function resolveSessionCredentialArg(authStorage: AuthStorage, arg: string): SessionCredentialTarget | string {
	const rows = authStorage.listCredentials().filter(row => row.disabled === null);
	const resolved = resolveCredentialTarget(rows, arg);
	if (!resolved.ok) return resolved.message;
	if (resolved.selection.kind === "pool") {
		return `"${arg}" is not "<provider>/<id|active|#id|label|email>".`;
	}
	return { provider: resolved.selection.row.provider, row: resolved.selection.row };
}

/**
 * Resolve every `--credential` value given on the launch command line. One
 * credential per provider: a second value for a provider already resolved,
 * or a value for the provider `--api-key` already targets, is refused rather
 * than silently picking the last one.
 */
export function resolveSessionCredentials(
	authStorage: AuthStorage,
	args: readonly string[],
	apiKeyProvider: string | undefined,
): SessionCredentialTarget[] | string {
	const seenByProvider = new Map<string, SessionCredentialTarget>();
	for (const arg of args) {
		const resolved = resolveSessionCredentialArg(authStorage, arg);
		if (typeof resolved === "string") return resolved;
		const prior = seenByProvider.get(resolved.provider);
		if (prior) {
			return `--credential ${resolved.provider}/${resolved.row.id} conflicts with --credential ${prior.provider}/${prior.row.id}: only one credential per provider.`;
		}
		if (apiKeyProvider !== undefined && apiKeyProvider.toLowerCase() === resolved.provider) {
			return `--credential ${resolved.provider}/${resolved.row.id} conflicts with --api-key for ${resolved.provider}. Use one or the other.`;
		}
		seenByProvider.set(resolved.provider, resolved);
	}
	return [...seenByProvider.values()];
}
