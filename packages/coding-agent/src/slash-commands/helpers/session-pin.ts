import type { CredentialSummary } from "@oh-my-pi/pi-ai";

/** What a `/session pin` selector picked: one stored row, or the pool. */
export type SessionPinSelection = { kind: "row"; row: CredentialSummary } | { kind: "pool" };

/**
 * Match a `/session pin` selector against usable rows (disabled rows already
 * excluded by the caller). Accepts a label (case-insensitive), an exact
 * identity/email, `#id`, the 1-based position in the listed order, `active`,
 * or `pool` (clears the session's pin).
 */
export function matchSessionPinSelector(
	rows: readonly CredentialSummary[],
	selector: string,
): SessionPinSelection[] {
	const wanted = selector.trim();
	if (!wanted) return [];
	const lower = wanted.toLowerCase();
	if (lower === "pool") return [{ kind: "pool" }];
	if (lower === "active") return rows.filter(row => row.active).map(row => ({ kind: "row", row }));

	if (/^#\d+$/.test(wanted)) {
		const id = Number(wanted.slice(1));
		const row = rows.find(candidate => candidate.id === id);
		return row ? [{ kind: "row", row }] : [];
	}
	if (/^\d+$/.test(wanted)) {
		const row = rows[Number(wanted) - 1];
		return row ? [{ kind: "row", row }] : [];
	}

	return rows
		.filter(
			row =>
				(row.label && row.label.toLowerCase() === lower) || (row.identity && row.identity.toLowerCase() === lower),
		)
		.map(row => ({ kind: "row", row }));
}
