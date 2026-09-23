/**
 * "Name this credential" + "Use it for:" steps run after every login. Pure
 * decision logic against a narrow `AuthStorage` slice, so both coding-agent
 * login paths (`/login`'s OAuth flow and any future API-key flow) drive the
 * same rules instead of copying them.
 */
import { type CredentialSummary, suggestCredentialLabel } from "@oh-my-pi/pi-ai";

/** The `AuthStorage` slice these steps need. */
export interface CredentialAfterLoginStorage {
	listCredentials(provider?: string, sessionId?: string): CredentialSummary[];
	renameCredential(id: number, label: string | null): void;
	pinSessionCredential(provider: string, sessionId: string, id: number): boolean;
	setDefaultCredential(provider: string, id: number | null): void;
}

/** What "Use it for:" may pick once the credential is named. */
export type CredentialAfterLoginScope = "session" | "default" | "store";

/** "Use it for:" options in display order. `session` is disabled without a running session. */
export const CREDENTIAL_AFTER_LOGIN_SCOPES: ReadonlyArray<{
	value: CredentialAfterLoginScope;
	label: string;
	description?: string;
}> = [
	{ value: "session", label: "This session" },
	{ value: "default", label: "Default for new sessions" },
	{ value: "store", label: "Just store it" },
];

/** `suggestCredentialLabel` scoped to the just-stored row. Throws when the row is gone. */
export function suggestedCredentialName(
	storage: CredentialAfterLoginStorage,
	provider: string,
	sessionId: string | undefined,
	credentialId: number,
): string {
	const rows = storage.listCredentials(provider, sessionId);
	const row = rows.find(candidate => candidate.id === credentialId);
	if (!row) throw new Error(`No stored credential #${credentialId} for ${provider}`);
	return suggestCredentialLabel(rows, row);
}

export type CredentialAfterLoginNameResult = { ok: true; label: string } | { ok: false; error: string };

/**
 * Apply the "Name this credential" step. An empty submission accepts
 * `suggested` — this is the initial-name step, not the tab's rename-to-clear
 * step. A clash (the store throws) is reported back so the caller can ask again.
 */
export function applyCredentialAfterLoginName(
	storage: CredentialAfterLoginStorage,
	credentialId: number,
	suggested: string,
	input: string,
): CredentialAfterLoginNameResult {
	const label = input.trim() || suggested;
	try {
		storage.renameCredential(credentialId, label);
		return { ok: true, label };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

export type CredentialAfterLoginScopeResult = { ok: true } | { ok: false; error: string };

/** Apply the "Use it for:" step. `store` is a no-op: the row stays as named. */
export function applyCredentialAfterLoginScope(
	storage: CredentialAfterLoginStorage,
	provider: string,
	sessionId: string | undefined,
	credentialId: number,
	scope: CredentialAfterLoginScope,
): CredentialAfterLoginScopeResult {
	if (scope === "session") {
		if (!sessionId) return { ok: false, error: "No running session to pin." };
		if (!storage.pinSessionCredential(provider, sessionId, credentialId)) {
			return { ok: false, error: "Credential is missing or disabled." };
		}
		return { ok: true };
	}
	if (scope === "default") {
		storage.setDefaultCredential(provider, credentialId);
		return { ok: true };
	}
	return { ok: true };
}
