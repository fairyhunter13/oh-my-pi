/**
 * `--credential <provider>/<id>` (repeatable): pins a chosen stored row as
 * this main session's active credential for that provider, before the first
 * turn. Addendum 5 (S-1): each main session keeps its own active credential,
 * independent of every other running session and of the provider-wide
 * default. Resolution is strict — a picker step would need a TTY, and this
 * flag exists so a script can start pinned with no prompt — so any unknown,
 * disabled or malformed value is a hard error listing the enabled rows of
 * that provider, in the same shape as `omp usage`'s `--credential`.
 */
import type { AuthStorage, CredentialSummary } from "@oh-my-pi/pi-ai";
import { credentialName } from "@oh-my-pi/pi-tui/setup/scenes/credential-format";

/** One resolved `--credential <provider>/<id>` target. */
export interface SessionCredentialTarget {
	provider: string;
	row: CredentialSummary;
}

/** Enabled rows of `provider`, formatted the way `omp usage`'s picker lists choices. */
function listChoices(authStorage: AuthStorage, provider: string): string[] {
	return authStorage
		.listCredentials(provider)
		.filter(row => row.disabled === null)
		.map(
			row =>
				`  ${row.provider}/${row.id}  ${credentialName(row)}  (${row.kind === "oauth" ? "subscription" : "API key"})`,
		);
}

/** Resolve one `--credential` value against the stored, enabled rows. */
export function resolveSessionCredentialArg(authStorage: AuthStorage, arg: string): SessionCredentialTarget | string {
	const slash = arg.indexOf("/");
	if (slash <= 0) return `"${arg}" is not "<provider>/<credential id>".`;
	const provider = arg.slice(0, slash).toLowerCase();
	const idPart = arg.slice(slash + 1);
	if (!/^\d+$/.test(idPart)) return `"${arg}" is not "<provider>/<credential id>".`;
	const id = Number(idPart);
	const row = authStorage.listCredentials(provider).find(entry => entry.id === id && entry.disabled === null);
	if (!row) {
		const choices = listChoices(authStorage, provider);
		const disabledMatch = authStorage.listCredentials(provider).find(entry => entry.id === id);
		const reason = disabledMatch ? "is disabled" : "matches no stored row";
		if (choices.length === 0) {
			return `"${arg}" ${reason}. No enabled stored credential for provider "${provider}". Use /login to add one.`;
		}
		return `"${arg}" ${reason}. Pick a credential with --credential <provider>/<id>:\n${choices.join("\n")}`;
	}
	return { provider, row };
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
