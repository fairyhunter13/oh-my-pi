import { beforeAll, describe, expect, it } from "bun:test";
import type { AuthStorage, CredentialSummary } from "@oh-my-pi/pi-ai";
import { CredentialsTab } from "@oh-my-pi/pi-tui/setup/scenes/credentials";
import type { SetupSceneHost } from "@oh-my-pi/pi-tui/setup/scenes/types";
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

// The actions/policy/resets menus here never exceed the default max-visible
// count, so SelectList's overflow search policy leaves typed filtering off
// (select-list.ts `#canEditSearch`): navigation must move the cursor by
// index, not by typed text.
function down(tab: CredentialsTab, times = 1): void {
	for (let i = 0; i < times; i++) tab.handleInput("\x1b[B");
}

function type(tab: CredentialsTab, text: string): void {
	for (const ch of text) tab.handleInput(ch);
}

function enter(tab: CredentialsTab): void {
	tab.handleInput("\n");
}

function esc(tab: CredentialsTab): void {
	tab.handleInput("\x1b");
}

function rendered(tab: CredentialsTab): string {
	return tab
		.render(80)
		.map(line => Bun.stripANSI(line))
		.join("\n");
}

interface TestHostOptions {
	usageLines?: (provider: string, id: number) => Promise<string[]>;
	resetStatus?: (
		provider: string,
		id: number,
	) => Promise<{ lines: string[]; redeemable: boolean; autoRedeem: "unset" | "yes" | "no" } | undefined>;
	redeemReset?: (provider: string, id: number) => Promise<string>;
	setAutoRedeem?: (provider: string, id: number, value: "unset" | "yes" | "no") => void;
	accountPolicy?: (provider: string, id: number) => { priority?: number; reservePct?: number } | undefined;
	saveAccountPolicy?: (
		provider: string,
		id: number,
		policy: { priority?: number; reservePct?: number } | undefined,
	) => string | undefined;
	forgetCredential?: (provider: string, id: number) => void;
}

function makeHost(
	rows: CredentialSummary[],
	options: TestHostOptions = {},
): { host: SetupSceneHost; removed: number[] } {
	const removed: number[] = [];
	const authStorage = {
		listCredentials: (provider?: string) =>
			provider ? rows.filter(candidate => candidate.provider === provider) : rows,
		removeCredential: async (_provider: string, id: number) => {
			removed.push(id);
			return true;
		},
	} as unknown as AuthStorage;

	const host = {
		ctx: {
			authStorage,
			sessionId: undefined,
			disabledProviders: [],
			getModels: () => ({ available: [], all: [], current: undefined }),
			...options,
		},
		requestRender(): void {},
		finish(): void {},
		setFocus(): void {},
		restoreFocus(): void {},
	} as unknown as SetupSceneHost;

	return { host, removed };
}

/** Reach the anthropic `work` (#5) row's actions view: providers → credentials → actions. */
function openActions(tab: CredentialsTab): void {
	enter(tab); // providers: "anthropic" (only stored provider) is already selected
	enter(tab); // credentials: "work" (#5) is the first row
}

describe("CredentialsTab per-row actions", () => {
	it("shows Usage…, Saved resets… and Priority and reserve… for an anthropic OAuth row", () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const { host } = makeHost([anthropicRow], {
			usageLines: async () => [],
			resetStatus: async () => undefined,
			accountPolicy: () => undefined,
			saveAccountPolicy: () => undefined,
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			const text = rendered(tab);
			expect(text).toContain("Usage…");
			expect(text).toContain("Saved resets…");
			expect(text).toContain("Priority and reserve…");
		} finally {
			tab.dispose();
		}
	});

	it("shows neither Saved resets… nor Priority and reserve… for an API-key row", () => {
		const openaiKeyRow = row({ id: 7, provider: "openai", kind: "api_key", label: "prodkey", hint: "…a1b2" });
		const { host } = makeHost([openaiKeyRow], { usageLines: async () => [] });
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			const text = rendered(tab);
			expect(text).toContain("Usage…");
			expect(text).not.toContain("Saved resets…");
			expect(text).not.toContain("Priority and reserve…");
		} finally {
			tab.dispose();
		}
	});

	it("Usage… renders the lines the host returns", async () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const called = Promise.withResolvers<void>();
		const { host } = makeHost([anthropicRow], {
			usageLines: async (provider, id) => {
				expect(provider).toBe("anthropic");
				expect(id).toBe(5);
				called.resolve();
				return ["USAGE_MARKER_LINE"];
			},
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			down(tab, 1); // "Usage…" is the second action item
			enter(tab);
			await called.promise;
			await Promise.resolve();
			await Promise.resolve();
			expect(rendered(tab)).toContain("USAGE_MARKER_LINE");
		} finally {
			tab.dispose();
		}
	});

	it("Saved resets… shows Spend one now only when redeemable, and marks the current auto-redeem answer", async () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const { host } = makeHost([anthropicRow], {
			usageLines: async () => [],
			resetStatus: async () => ({ lines: ["work: 2 saved, 1 usable now"], redeemable: true, autoRedeem: "yes" }),
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			down(tab, 2); // "Saved resets…" is the third action item
			enter(tab);
			await Promise.resolve();
			await Promise.resolve();
			const text = rendered(tab);
			expect(text).toContain("Spend one now");
			expect(text).toContain("Auto-redeem for this credential: yes (current)");
			expect(text).not.toContain("Auto-redeem for this credential: ask (current)");
		} finally {
			tab.dispose();
		}
	});

	it("removing a row calls forgetCredential before the host's remove", async () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const order: string[] = [];
		const { host, removed } = makeHost([anthropicRow], {
			usageLines: async () => [],
			forgetCredential: (provider, id) => {
				expect(provider).toBe("anthropic");
				expect(id).toBe(5);
				order.push("forget");
			},
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			down(tab, 6); // "Remove…" is the last action item
			enter(tab);
			down(tab, 1); // "Remove work (#5)" is the second item in the confirm view
			enter(tab);
			await Promise.resolve();
			await Promise.resolve();
			expect(order).toEqual(["forget"]);
			expect(removed).toEqual([5]);
		} finally {
			tab.dispose();
		}
	});

	it("the policy view rejects an out-of-range reservePct and a non-number priority without calling saveAccountPolicy", () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const saveCalls: unknown[] = [];
		const { host } = makeHost([anthropicRow], {
			usageLines: async () => [],
			accountPolicy: () => undefined,
			saveAccountPolicy: (_provider, _id, policy) => {
				saveCalls.push(policy);
				return undefined;
			},
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			down(tab, 3); // "Priority and reserve…" is the fourth action item
			enter(tab);
			// policy view: "Priority: not set" is the first item
			enter(tab);
			type(tab, "not-a-number");
			enter(tab);
			expect(rendered(tab)).toContain("Priority must be a number.");
			esc(tab); // back to the policy view
			down(tab, 1); // "Reserve: not set" is the second item
			enter(tab);
			type(tab, "150");
			enter(tab);
			expect(rendered(tab)).toContain("Reserve % must be 0-100.");
			expect(saveCalls).toEqual([]);
		} finally {
			tab.dispose();
		}
	});

	it("Save with priority 10 calls saveAccountPolicy(provider, id, { priority: 10 })", () => {
		const anthropicRow = row({ id: 5, provider: "anthropic", kind: "oauth", label: "work" });
		const saveCalls: Array<[string, number, unknown]> = [];
		const { host } = makeHost([anthropicRow], {
			usageLines: async () => [],
			accountPolicy: () => undefined,
			saveAccountPolicy: (provider, id, policy) => {
				saveCalls.push([provider, id, policy]);
				return undefined;
			},
		});
		const tab = new CredentialsTab(host);
		try {
			openActions(tab);
			down(tab, 3); // "Priority and reserve…" is the fourth action item
			enter(tab);
			enter(tab); // "Priority: not set" is the first policy item
			type(tab, "10");
			enter(tab);
			down(tab, 2); // "Save" is the third policy item
			enter(tab);
			expect(saveCalls).toEqual([["anthropic", 5, { priority: 10 }]]);
		} finally {
			tab.dispose();
		}
	});
});
