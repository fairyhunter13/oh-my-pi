import { beforeAll, describe, expect, it } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { CredentialPickerComponent, type CredentialPickerProvider } from "@oh-my-pi/pi-tui/overlays/credential-picker";
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

describe("CredentialPickerComponent", () => {
	it("lists providers with stored rows, an API-key-only provider, and an env/config-only provider shown disabled", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
			{ id: "openai", name: "OpenAI", summary: "2 API keys", disabled: false },
			{ id: "vertex", name: "Vertex", summary: "env: VERTEX_API_KEY", disabled: true },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
			[
				"openai",
				[row({ id: 2, provider: "openai", kind: "api_key" }), row({ id: 3, provider: "openai", kind: "api_key" })],
			],
		]);
		const component = new CredentialPickerComponent({
			verb: "Log out",
			providers,
			rowsByProvider,
			confirm: {
				heading: (provider, credential) => `Log out ${credential.label ?? credential.id} from ${provider}?`,
				actLabel: credential => `Remove #${credential.id}`,
			},
			onPick: () => {},
			onCancel: () => {},
		});
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

	it("renders one item per row and no All item", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "2 subscriptions", disabled: false },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			[
				"anthropic",
				[
					row({ id: 1, provider: "anthropic", label: "Work" }),
					row({ id: 2, provider: "anthropic", label: "Personal", disabled: "disabled by user" }),
				],
			],
		]);
		const component = new CredentialPickerComponent({
			verb: "Log out",
			providers,
			rowsByProvider,
			initialProvider: "anthropic",
			confirm: {
				heading: (provider, credential) => `Log out ${credential.label ?? credential.id} from ${provider}?`,
				actLabel: credential => `Remove #${credential.id}`,
			},
			onPick: () => {},
			onCancel: () => {},
		});
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Work");
		expect(rendered).toContain("Personal");
		expect(rendered).not.toMatch(/All \d/);
	});

	it("moves from rows to a confirmation view and reports the chosen row target on act", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rows: CredentialSummary[] = [row({ id: 1, provider: "anthropic", label: "Work" })];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([["anthropic", rows]]);
		let picked: unknown;
		const component = new CredentialPickerComponent({
			verb: "Log out",
			providers,
			rowsByProvider,
			initialProvider: "anthropic",
			confirm: {
				heading: (provider, credential) =>
					`Log out ${credential.label ?? credential.id} (#${credential.id}) from ${provider}?`,
				actLabel: credential => `Remove ${credential.label ?? credential.id} (#${credential.id})`,
			},
			onPick: target => {
				picked = target;
			},
			onCancel: () => {},
		});

		component.handleInput("\n"); // rows view: select the only row -> confirm view
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("Keep it");
		expect(rendered).toContain("Remove Work (#1)");

		component.handleInput("\x1b[B"); // move to the act item
		component.handleInput("\n");
		expect(picked).toEqual({ kind: "row", provider: "anthropic", row: rows[0] });
	});

	it("Esc on the rows view for a preselected provider steps back to the provider list, not cancel", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
		]);
		let cancelled = false;
		const component = new CredentialPickerComponent({
			verb: "Log out",
			providers,
			rowsByProvider,
			initialProvider: "anthropic",
			onPick: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});
		component.handleInput("\x1b");
		expect(cancelled).toBe(false);
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("pick a provider");
	});

	it("renders newItem first and fires a new target when picked", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic", label: "Work" })]],
		]);
		let picked: unknown;
		const component = new CredentialPickerComponent({
			verb: "Log in",
			providers,
			rowsByProvider,
			initialProvider: "anthropic",
			newItem: { label: "Add a new account", description: "Sign in with an account omp does not store yet" },
			onPick: target => {
				picked = target;
			},
			onCancel: () => {},
		});
		const rendered = component
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		const firstItemLine = rendered
			.split("\n")
			.find(line => line.includes("Add a new account") || line.includes("Work"));
		expect(firstItemLine).toContain("Add a new account");

		component.handleInput("\n"); // select the first item (newItem)
		expect(picked).toEqual({ kind: "new", provider: "anthropic" });
	});

	it("cancels instead of stepping back when lockProvider is set", () => {
		const providers: CredentialPickerProvider[] = [
			{ id: "anthropic", name: "Anthropic", summary: "1 subscription", disabled: false },
		];
		const rowsByProvider = new Map<string, readonly CredentialSummary[]>([
			["anthropic", [row({ id: 1, provider: "anthropic" })]],
		]);
		let cancelled = false;
		const component = new CredentialPickerComponent({
			verb: "Log in",
			providers,
			rowsByProvider,
			initialProvider: "anthropic",
			lockProvider: true,
			onPick: () => {},
			onCancel: () => {
				cancelled = true;
			},
		});
		component.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});
});
