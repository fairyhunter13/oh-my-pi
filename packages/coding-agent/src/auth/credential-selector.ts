/**
 * One text grammar for naming a stored credential, shared by every
 * single-credential command and CLI flag: `<provider>/<selector>`, or a bare
 * `<selector>` when the caller already knows the provider. `selector` is
 * `active`, `pool` (only where the caller allows it), a bare id, `#<id>`, a
 * label (case-insensitive) or an identity (email/account id, case-insensitive).
 *
 * This replaces the provider-specific parsers that used to live next to each
 * command (`matchSessionPinSelector`, `resolveUsageRowByTarget`,
 * `resolveSessionCredentialArg`, …), so every surface fails and lists choices
 * the same way.
 */
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { credentialName } from "@oh-my-pi/pi-tui/setup/scenes/credential-format";

/** What a selector picked: one stored row, or the pool (only when the caller allows it). */
export type CredentialSelection = { kind: "row"; row: CredentialSummary } | { kind: "pool" };

/**
 * Match a bare selector (no `<provider>/` prefix) against rows already
 * scoped to one provider. A bare number is the credential's durable id,
 * never a 1-based list position. `pool` matches only with `allowPool`.
 */
export function matchCredentialSelector(
	rows: readonly CredentialSummary[],
	selector: string,
	options?: { allowPool?: boolean },
): CredentialSelection[] {
	const wanted = selector.trim();
	if (!wanted) return [];
	const lower = wanted.toLowerCase();
	if (lower === "pool") return options?.allowPool ? [{ kind: "pool" }] : [];
	if (lower === "active") return rows.filter(row => row.active).map(row => ({ kind: "row", row }));

	if (/^#\d+$/.test(wanted)) {
		const id = Number(wanted.slice(1));
		const row = rows.find(candidate => candidate.id === id);
		return row ? [{ kind: "row", row }] : [];
	}
	if (/^\d+$/.test(wanted)) {
		const id = Number(wanted);
		const row = rows.find(candidate => candidate.id === id);
		return row ? [{ kind: "row", row }] : [];
	}

	return rows
		.filter(
			row =>
				(row.label && row.label.toLowerCase() === lower) || (row.identity && row.identity.toLowerCase() === lower),
		)
		.map(row => ({ kind: "row", row }));
}

/** Every row of one provider, as a picker's "no match" listing: `- <name> [<provider>/<id>] (active)`. */
export function credentialChoicesText(rows: readonly CredentialSummary[]): string {
	return rows
		.map(row => `- ${credentialName(row)} [${row.provider}/${row.id}]${row.active ? " (active)" : ""}`)
		.join("\n");
}

/**
 * Resolve `<provider>/<selector>` (or a bare `<selector>` when
 * `options.provider` names the provider) against `rows`. Rows of every
 * provider may be passed; this filters to the parsed provider itself. A
 * caller that has already scoped `rows` to one provider and fixes
 * `options.provider` to the same provider gets the natural "no match" result
 * for any other provider prefix, because no row of that other provider is in
 * `rows` to match.
 */
export function resolveCredentialTarget(
	rows: readonly CredentialSummary[],
	target: string,
	options?: { provider?: string; allowPool?: boolean },
): { ok: true; selection: CredentialSelection } | { ok: false; message: string } {
	const trimmed = target.trim();
	const slash = trimmed.indexOf("/");
	let provider: string;
	let selectorText: string;
	if (slash > 0) {
		provider = trimmed.slice(0, slash).toLowerCase();
		selectorText = trimmed.slice(slash + 1).trim();
	} else if (options?.provider) {
		provider = options.provider.toLowerCase();
		selectorText = trimmed;
	} else {
		return { ok: false, message: "Name a credential as <provider>/<id|active|#id|label|email>." };
	}
	if (!selectorText) {
		return { ok: false, message: "Name a credential as <provider>/<id|active|#id|label|email>." };
	}

	const providerRows = rows.filter(row => row.provider.toLowerCase() === provider);
	const matches = matchCredentialSelector(providerRows, selectorText, { allowPool: options?.allowPool });
	if (matches.length === 0) {
		const choices = credentialChoicesText(providerRows);
		return {
			ok: false,
			message: `No ${provider} credential matches "${selectorText}".${choices ? `\n${choices}` : ""}`,
		};
	}
	if (matches.length > 1) {
		const names = matches.map(match => (match.kind === "pool" ? "pool" : credentialName(match.row))).join(", ");
		return {
			ok: false,
			message: `"${selectorText}" matches ${matches.length} ${provider} credentials: ${names}. Use the id.`,
		};
	}
	return { ok: true, selection: matches[0] as CredentialSelection };
}
