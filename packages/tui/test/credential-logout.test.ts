import { beforeAll, describe, expect, it } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { CredentialLogoutComponent, type CredentialLogoutProvider } from "@oh-my-pi/pi-tui/overlays/credential-logout";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

function row(overrides: Partial<CredentialSummary> & { id: number; provider: string }): CredentialSummary {
	return {
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

describe("CredentialLogoutComponent", () => {
	it("lists providers with stored rows, an API-key-only provider, and an env/config-only provider shown disabled", () => {
		const providers: CredentialLogoutProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
			{ id: "openai", name: "OpenAI", summary: "2 API keys", disabled: false },
			{ id: "vertex", name: "Vertex", summary: "env: VERTEX_API_KEY", disabled: true },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
			[
				"openai",
				[
					row({ id: 2, provider: "openai", kind: "api_key" }),
					row({ id: 3, provider: "openai", kind: "api_key" }),
				],
			],
		]);
		const component = new CredentialLogoutComponent(providers, rowsByProvider, undefined, () => {}, () => {});
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Anthropic");
		expect(rendered).toContain("1 subscription");
		expect(rendered).toContain("OpenAI");
		expect(rendered).toContain("2 API keys");
		expect(rendered).toContain("Vertex");
		expect(rendered).toContain("env: VERTEX_API_KEY");
	});

	it('offers "All N" only once a provider has 2 or more rows, and counts a disabled row', () => {
		const providers: CredentialLogoutProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const singleRow = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
		]);
		const single = new CredentialLogoutComponent(providers, singleRow, "anthropic", () => {}, () => {});
		const singleRendered = single
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(singleRendered).not.toContain("All 1");

		const twoRows = new Map<string, readonly CredentialSummary[]>([
			[
				"anthropic",
				[
					row({ id: 1, provider: "anthropic" }),
					row({ id: 2, provider: "anthropic", disabled: "disabled by user" }),
				],
			],
		]);
		const multi = new CredentialLogoutComponent(providers, twoRows, "anthropic", () => {}, () => {});
		const multiRendered = multi
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(multiRendered).toContain("All 2 credentials of anthropic");
	});

	it("moves from rows to a confirmation view and reports the chosen row target on confirm", () => {
		const providers: CredentialLogoutProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rows: CredentialSummary[] = [row({ id: 1, provider: "anthropic", label: "Work" })];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([["anthropic", rows]]);
		let confirmed: unknown;
		const component = new CredentialLogoutComponent(
			providers,
			rowsByProvider,
			"anthropic",
			target => {
				confirmed = target;
			},
			() => {},
		);

		component.handleInput("\n"); // rows view: select the only row -> confirm view
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Keep it");
		expect(rendered).toContain("Remove Work (#1)");

		component.handleInput("\x1b[B"); // move to "Remove"
		component.handleInput("\n");
		expect(confirmed).toEqual({ kind: "row", provider: "anthropic", row: rows[0] });
	});

	it("Esc on the rows view for a preselected provider steps back to the provider list, not cancel", () => {
		const providers: CredentialLogoutProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
		]);
		let cancelled = false;
		const component = new CredentialLogoutComponent(
			providers,
			rowsByProvider,
			"anthropic",
			() => {},
			() => {
				cancelled = true;
			},
		);
		component.handleInput("\x1b");
		expect(cancelled).toBe(false);
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("pick a provider");
	});
});
