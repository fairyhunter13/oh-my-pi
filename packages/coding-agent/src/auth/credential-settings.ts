/**
 * `auth.accountPolicies` scoped to one stored credential (`/providers` →
 * Credentials → "Priority and reserve…"). The routing policy applies to
 * OAuth subscriptions only — `AccountPolicies.forCredential` (pi-ai) already
 * skips API keys, so an api_key row is refused here rather than silently
 * accepted and then ignored by routing.
 */
import type { AuthAccountPolicies, AuthAccountPolicy, AuthAccountSelector, CredentialSummary } from "@oh-my-pi/pi-ai";
import { matchesAuthAccountSelector } from "@oh-my-pi/pi-ai/auth/policy";
import { cfgAuthAccountPolicies } from "../config/model-settings";
import type { Settings } from "../config/settings";
import type { AuthStorage } from "../session/auth-storage";
import {
	cfgClaudeResetsAutoRedeemByCredential,
	cfgCodexResetsAutoRedeemByCredential,
	cfgRetryUsageReservePct,
} from "../session/settings";

/** Priority/reserve fields a `/providers` row edits; both omitted clears the entry. */
export interface CredentialPolicyFields {
	priority?: number;
	reservePct?: number;
}

/** Resolve `row`'s stored OAuth identity, or `undefined` for an api_key row or a row no longer stored. */
function storedOAuthIdentity(authStorage: AuthStorage, row: CredentialSummary): AuthAccountSelector | undefined {
	if (row.kind !== "oauth") return undefined;
	const stored = authStorage.credentials.list(row.provider).find(entry => entry.id === row.id);
	if (!stored || stored.credential.type !== "oauth") return undefined;
	const credential = stored.credential;
	const account: { email?: string; accountId?: string; projectId?: string; orgId?: string } = {};
	if (credential.email) account.email = credential.email;
	else if (credential.accountId) account.accountId = credential.accountId;
	else if (credential.projectId) account.projectId = credential.projectId;
	if (credential.orgId) account.orgId = credential.orgId;
	return account;
}

/** The configured policy for `row`, or `undefined` when none matches (or `row` is an api_key). */
export function accountPolicyFor(
	settings: Settings,
	authStorage: AuthStorage,
	row: CredentialSummary,
): CredentialPolicyFields | undefined {
	const account = storedOAuthIdentity(authStorage, row);
	if (!account) return undefined;
	const entry = cfgAuthAccountPolicies
		.get(settings)
		.find(policy => policy.provider === row.provider && matchesAuthAccountSelector(policy.account, account));
	if (!entry) return undefined;
	const fields: CredentialPolicyFields = {};
	if (entry.priority !== undefined) fields.priority = entry.priority;
	if (entry.reservePct !== undefined) fields.reservePct = entry.reservePct;
	return fields;
}

/**
 * Replace, append, or remove `row`'s entry in `auth.accountPolicies`. Every
 * other entry stays byte-for-byte unchanged. Validates through
 * `authStorage.setAccountPolicies` BEFORE persisting the setting, so a
 * selector that now matches zero or two+ stored rows is refused with the
 * live `AccountPolicies` error instead of being written and silently
 * ignored until the next reapply. Returns the error text on failure,
 * `undefined` on success.
 */
export function saveAccountPolicy(
	settings: Settings,
	authStorage: AuthStorage,
	row: CredentialSummary,
	policy: CredentialPolicyFields | undefined,
): string | undefined {
	if (row.kind !== "oauth") {
		return `${row.label ?? row.identity ?? `#${row.id}`} is an API key; the routing policy applies to subscriptions only.`;
	}
	const account = storedOAuthIdentity(authStorage, row);
	if (!account) return `${row.provider} credential #${row.id} is no longer stored.`;

	const current = cfgAuthAccountPolicies.get(settings);
	const index = current.findIndex(
		existing => existing.provider === row.provider && matchesAuthAccountSelector(existing.account, account),
	);
	const cleared = !policy || (policy.priority === undefined && policy.reservePct === undefined);
	let next: AuthAccountPolicies;
	if (cleared) {
		if (index === -1) return undefined;
		next = current.filter((_entry, i) => i !== index);
	} else {
		const entry: AuthAccountPolicy = {
			provider: row.provider,
			account,
			...(policy.priority !== undefined ? { priority: policy.priority } : {}),
			...(policy.reservePct !== undefined ? { reservePct: policy.reservePct } : {}),
		};
		next = index === -1 ? [...current, entry] : current.map((existing, i) => (i === index ? entry : existing));
	}

	try {
		authStorage.setAccountPolicies({ accountPolicies: next, defaultReservePct: cfgRetryUsageReservePct.get(settings) });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	cfgAuthAccountPolicies.set(settings, next);
	return undefined;
}

/**
 * Drop `row`'s routing policy and per-credential auto-redeem answers before
 * the credential itself is removed (`/logout`, `omp auth-broker logout`,
 * the Credentials tab's Remove…). A no-op for any field `row` never set.
 */
export function forgetCredentialSettings(settings: Settings, authStorage: AuthStorage, row: CredentialSummary): void {
	saveAccountPolicy(settings, authStorage, row, undefined);
	const key = String(row.id);
	for (const setting of [cfgClaudeResetsAutoRedeemByCredential, cfgCodexResetsAutoRedeemByCredential]) {
		const current = setting.get(settings);
		if (!(key in current)) continue;
		const next = { ...current };
		delete next[key];
		setting.set(settings, next);
	}
}
