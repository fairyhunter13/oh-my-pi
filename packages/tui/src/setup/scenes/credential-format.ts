import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import type { SelectItem } from "../../components/select-list";

/** The user's name for a row, falling back through identity and hint to its id. */
export function credentialName(row: CredentialSummary): string {
	return row.label ?? row.identity ?? row.hint ?? `#${row.id}`;
}

/**
 * One row as a `SelectList` item: the name column holds only the name, marks
 * lead the second column so a long name never hides them. Shared by the
 * `/providers` → Credentials tab, `/logout` and `/session pin`.
 */
export function credentialItem(row: CredentialSummary): SelectItem {
	const detail = [
		row.kind === "oauth" ? "subscription" : "API key",
		row.active ? "active" : null,
		row.pinned ? "pinned" : null,
		row.isDefault ? "default" : null,
		row.disabled ? "disabled" : null,
		row.label ? (row.identity ?? row.hint) : null,
		row.org,
		`#${row.id}`,
		row.disabled,
	].filter(Boolean);
	return { value: `row:${row.id}`, label: credentialName(row), description: detail.join(" · ") };
}
