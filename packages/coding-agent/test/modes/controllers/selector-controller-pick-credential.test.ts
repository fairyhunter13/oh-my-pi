/**
 * `SelectorController.pickCredential` is what `/login`'s re-login step
 * (`#loginWithCredentialPicker`) uses to decide whether a login runs as a
 * new account or as `replaceCredentialId` for an existing row. It is also
 * what `/usage` and `/logout` share for the same "ask which credential
 * first" rule.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

beforeAll(async () => {
	await initTheme();
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

interface EditorSlot {
	children: unknown[];
	clear: () => void;
	addChild: (child: unknown) => void;
}

function createCtx(): { ctx: InteractiveModeContext; editorContainer: EditorSlot } {
	const children: unknown[] = [];
	const editorContainer: EditorSlot = {
		children,
		clear: () => {
			children.length = 0;
		},
		addChild: child => {
			children.push(child);
		},
	};
	const ctx = {
		editor: { id: "editor" },
		editorContainer,
		ui: { setFocus: vi.fn(), getFocused: () => undefined, requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, editorContainer };
}

function mountedPicker(editorContainer: EditorSlot): { handleInput: (key: string) => void } {
	return editorContainer.children.at(-1) as { handleInput: (key: string) => void };
}

describe("SelectorController.pickCredential", () => {
	it("resolves the only row with no overlay when there is no newItem", async () => {
		const { ctx, editorContainer } = createCtx();
		const controller = new SelectorController(ctx);
		const onlyRow = row({ id: 1, provider: "kagi" });

		const target = await controller.pickCredential({ verb: "Log in", rows: [onlyRow] });

		expect(target).toEqual({ kind: "row", provider: "kagi", row: onlyRow });
		expect(editorContainer.children).toEqual([]);
	});

	it("shows the picker for a single row when a newItem is offered, and lets the caller re-login as that row", async () => {
		const { ctx, editorContainer } = createCtx();
		const controller = new SelectorController(ctx);
		const existing = row({ id: 7, provider: "kagi", label: "Work" });

		const pending = controller.pickCredential({
			verb: "Log in",
			rows: [existing],
			newItem: { label: "Add a new account", description: "Sign in with an account omp does not store yet" },
			lockProvider: true,
		});

		// The picker mounted into the editor slot instead of resolving directly.
		expect(editorContainer.children.length).toBe(1);
		const picker = mountedPicker(editorContainer);

		// Down to the stored row (newItem renders first), then select it: the
		// caller reads `target.row.id` as `replaceCredentialId`.
		picker.handleInput("\x1b[B");
		picker.handleInput("\n");

		await expect(pending).resolves.toEqual({ kind: "row", provider: "kagi", row: existing });
	});

	it("resolves a new-account pick with no row to re-login as", async () => {
		const { ctx, editorContainer } = createCtx();
		const controller = new SelectorController(ctx);
		const existing = row({ id: 7, provider: "kagi", label: "Work" });

		const pending = controller.pickCredential({
			verb: "Log in",
			rows: [existing],
			newItem: { label: "Add a new account", description: "Sign in with an account omp does not store yet" },
			lockProvider: true,
		});

		const picker = mountedPicker(editorContainer);
		picker.handleInput("\n"); // newItem renders first

		await expect(pending).resolves.toEqual({ kind: "new", provider: "kagi" });
	});

	it("resolves undefined on Esc, leaving the caller to skip the login", async () => {
		const { ctx, editorContainer } = createCtx();
		const controller = new SelectorController(ctx);
		const existing = row({ id: 7, provider: "kagi", label: "Work" });

		const pending = controller.pickCredential({
			verb: "Log in",
			rows: [existing],
			newItem: { label: "Add a new account", description: "Sign in with an account omp does not store yet" },
			lockProvider: true,
		});

		const picker = mountedPicker(editorContainer);
		picker.handleInput("\x1b"); // Esc, locked provider view cancels

		await expect(pending).resolves.toBeUndefined();
	});
});
