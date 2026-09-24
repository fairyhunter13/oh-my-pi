import { Database } from "bun:sqlite";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth/types";
import {
	describeCredential,
	summarizeCredentialRow,
	type CredentialCatalogRow,
} from "@oh-my-pi/pi-ai/auth/credential-catalog";
import { buildUsageCredential, usageCacheIdentity } from "@oh-my-pi/pi-ai/auth/usage-cache";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";
import type { StatsCredential } from "./shared-types";
import type { UsageSnapshotRow } from "./usage-windows";

/**
 * Human label for every stored credential, keyed `"<provider>:<id>"`, read
 * directly from `agent.db`'s `auth_credentials` table — the dashboard server
 * has no `AuthStorage` instance of its own. Empty when the file is missing or
 * unreadable (no agent installed yet, or a permissions problem), so a caller
 * falls back to `#<id>` per row.
 */
export function readCredentialLabels(): Map<string, string> {
	const labels = new Map<string, string>();
	let db: Database;
	try {
		db = new Database(getAgentDbPath(), { readonly: true });
	} catch {
		return labels;
	}
	try {
		const rows = db
			.prepare("SELECT id, provider, credential_type, data, disabled_cause, label, is_default FROM auth_credentials")
			.all() as CredentialCatalogRow[];
		for (const row of rows) {
			const summary = summarizeCredentialRow(row, {});
			labels.set(`${row.provider}:${row.id}`, describeCredential(summary, row.id));
		}
	} catch {
		// Table missing (pre-auth_credentials install) or unreadable: labels stay empty.
	} finally {
		db.close();
	}
	return labels;
}

function credentialRowAccountKey(row: { provider: string; credential_type: string; data: string }): string | null {
	try {
		const parsed = JSON.parse(row.data) as Record<string, unknown>;
		const authCredential = {
			type: row.credential_type === "api_key" ? "api_key" : "oauth",
			...parsed,
		} as AuthCredential;
		return usageCacheIdentity(buildUsageCredential(authCredential));
	} catch {
		return null;
	}
}

/**
 * Test whether a `usage_history` row belongs to `credential` (F5). A picked
 * stored row matches by its computed `usageCacheIdentity` account key. The
 * unattributed bucket (`credentialId: null`) matches every snapshot whose
 * account key belongs to no *currently* stored credential of the provider —
 * the same "no stored row produced it" rule messages use, since a
 * `usage_history` snapshot carries no credential id of its own to test
 * directly.
 */
export function usageRowMatchesCredential(credential: StatsCredential): (row: UsageSnapshotRow) => boolean {
	let db: Database;
	try {
		db = new Database(getAgentDbPath(), { readonly: true });
	} catch {
		return row => row.provider === credential.provider && credential.credentialId === null;
	}
	try {
		const rows = db
			.prepare("SELECT id, provider, credential_type, data FROM auth_credentials WHERE provider = ?")
			.all(credential.provider) as Array<{ id: number; provider: string; credential_type: string; data: string }>;
		if (credential.credentialId === null) {
			const known = new Set(rows.map(credentialRowAccountKey).filter((key): key is string => key !== null));
			return row => row.provider === credential.provider && !known.has(row.accountKey);
		}
		const target = rows.find(row => row.id === credential.credentialId);
		const accountKey = target ? credentialRowAccountKey(target) : null;
		return row => accountKey !== null && row.provider === credential.provider && row.accountKey === accountKey;
	} finally {
		db.close();
	}
}
