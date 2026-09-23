import { beforeAll, describe, expect, it } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { SessionAccountSelectorComponent } from "@oh-my-pi/pi-tui/overlays/session-account-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	await initTheme();
});

function row(overrides: Partial<CredentialSummary> & { id: number }): CredentialSummary {
	return {
		provider: "anthropic",
		kind: "oauth",
		label: null,
		identity: null,
		hint: null,
		disabled: null,
		isDefault: false,
		active: false,
		pinned: false,
		org: null,
		...overrides,
	};
}

const rows: CredentialSummary[] = [
	row({ id: 11, identity: "first@example.com" }),
	row({ id: 12, identity: "second@example.com", active: true }),
];

describe("SessionAccountSelectorComponent", () => {
	it("handles navigation, selection, Escape, and Ctrl+C while focused", () => {
		const selected: number[] = [];
		let cancellations = 0;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			rows,
			selection => {
				if (selection.kind === "row") selected.push(selection.row.id);
			},
			() => {
				cancellations += 1;
			},
		);

		component.handleInput("\x1b[A");
		component.handleInput("\n");
		expect(selected).toEqual([11]);

		const escapeComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			rows,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		escapeComponent.handleInput("\x1b");

		const ctrlCComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			rows,
			() => {},
			() => {
				cancellations += 1;
			},
		);
		ctrlCComponent.handleInput("\x03");
		expect(cancellations).toBe(2);
	});

	it("offers 'Use the pool' only when a row is pinned, and it clears the pin", () => {
		const pinnedRows: CredentialSummary[] = [row({ id: 21, identity: "a@example.com", pinned: true, active: true })];
		let selection: string | undefined;
		const component = new SessionAccountSelectorComponent(
			"Anthropic",
			pinnedRows,
			result => {
				selection = result.kind;
			},
			() => {},
		);
		// Navigate past the single row to "Use the pool" and select it.
		component.handleInput("\x1b[B");
		component.handleInput("\n");
		expect(selection).toBe("pool");

		let noPinSelection: string | undefined;
		const noPinComponent = new SessionAccountSelectorComponent(
			"Anthropic",
			[row({ id: 22, identity: "b@example.com" })],
			result => {
				noPinSelection = result.kind;
			},
			() => {},
		);
		noPinComponent.handleInput("\x1b[B");
		noPinComponent.handleInput("\n");
		expect(noPinSelection).toBe("row");
	});
});
