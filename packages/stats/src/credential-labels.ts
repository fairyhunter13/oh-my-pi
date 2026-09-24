import { Database } from "bun:sqlite";
import {
	describeCredential,
	summarizeCredentialRow,
	type CredentialCatalogRow,
} from "@oh-my-pi/pi-ai/auth/credential-catalog";
import { getAgentDbPath } from "@oh-my-pi/pi-utils";

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
