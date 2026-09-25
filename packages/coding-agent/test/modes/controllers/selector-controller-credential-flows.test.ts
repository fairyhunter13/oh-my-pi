/**
 * `showResetUsageSelector` and `showSessionPinSelector` (F-0/F-1) both pick a
 * credential through the shared `pickCredential` picker before they act on
 * it. `pickCredential` itself is covered by
 * `selector-controller-pick-credential.test.ts`; these tests substitute it
 * directly so they exercise only what each method does with the pick.
 */
import { describe, expect, it, vi } from "bun:test";
import type {
	CredentialSummary,
	ResetCreditAccountStatus,
	ResetCreditRedeemOutcome,
	ResetCreditTarget,
} from "@oh-my-pi/pi-ai";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { CredentialPickerTarget } from "@oh-my-pi/pi-tui/overlays/credential-picker";

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

function pickedRow(provider: string, pickedRowValue: CredentialSummary): CredentialPickerTarget {
	return { kind: "row", provider, row: pickedRowValue };
}

function pickedPool(provider: string): CredentialPickerTarget {
	return { kind: "new", provider };
}

function createCtx(session: Record<string, unknown>) {
	const showStatus = vi.fn();
	const showWarning = vi.fn();
	const showHookConfirm = vi.fn(async (_title: string, _message: string) => true);
	const ctx = {
		session,
		showStatus,
		showError: vi.fn(),
		showWarning,
		showHookConfirm,
		statusLine: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() },
	} as unknown as InteractiveModeContext;
	return { ctx, showStatus, showWarning, showHookConfirm };
}

describe("SelectorController.showResetUsageSelector", () => {
	const account = row({ id: 6, provider: "openai-codex", identity: "b@x" });

	function makeSession(statuses: ResetCreditAccountStatus[], redeemOutcome?: ResetCreditRedeemOutcome) {
		const redeemResetCredit = vi.fn(async (_target: ResetCreditTarget) => redeemOutcome ?? { ok: true, code: "reset" });
		return {
			session: {
				modelRegistry: { authStorage: { listCredentials: () => [account] } },
				sessionId: "session-1",
				listResetCredits: vi.fn(async () => statuses),
				redeemResetCredit,
			},
			redeemResetCredit,
		};
	}

	it("shows no rows found and asks nothing when nothing is stored", async () => {
		const { ctx, showStatus } = createCtx({
			modelRegistry: { authStorage: { listCredentials: () => [] } },
			sessionId: "session-1",
		});
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn();

		await controller.showResetUsageSelector();

		expect(controller.pickCredential).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("No Claude or Codex account is stored. Use /login to add one.");
	});

	it("picks the credential first, then reports 0 usable resets with no redeem", async () => {
		const { session, redeemResetCredit } = makeSession([
			{
				provider: "openai-codex",
				credentialId: 6,
				email: "b@x",
				availableCount: 0,
				redeemableCount: 0,
				credits: [],
				active: false,
			},
		]);
		const { ctx, showStatus } = createCtx(session);
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn(async () => pickedRow("openai-codex", account));

		await controller.showResetUsageSelector();

		expect(controller.pickCredential).toHaveBeenCalledWith({ verb: "Saved resets", rows: [account] });
		expect(session.listResetCredits).toHaveBeenCalledWith(expect.any(AbortSignal), "openai-codex");
		expect(showStatus.mock.calls.at(-1)?.[0]).toContain("no saved reset usable now");
		expect(redeemResetCredit).not.toHaveBeenCalled();
	});

	it("confirms before spending, and redeems exactly once", async () => {
		const { session, redeemResetCredit } = makeSession([
			{
				provider: "openai-codex",
				credentialId: 6,
				email: "b@x",
				availableCount: 2,
				redeemableCount: 2,
				credits: [],
				active: false,
			},
		]);
		const { ctx, showHookConfirm } = createCtx(session);
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn(async () => pickedRow("openai-codex", account));

		await controller.showResetUsageSelector();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(showHookConfirm.mock.calls[0]?.[0]).toContain("Spend 1 saved reset for");
		expect(redeemResetCredit).toHaveBeenCalledTimes(1);
		expect(redeemResetCredit.mock.calls[0]?.[0]).toEqual({ provider: "openai-codex", credentialId: 6, email: "b@x" });
	});

	it("spends nothing when the confirm is declined", async () => {
		const { session, redeemResetCredit } = makeSession([
			{
				provider: "openai-codex",
				credentialId: 6,
				email: "b@x",
				availableCount: 2,
				redeemableCount: 2,
				credits: [],
				active: false,
			},
		]);
		const { ctx, showHookConfirm } = createCtx(session);
		showHookConfirm.mockImplementation(async () => false);
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn(async () => pickedRow("openai-codex", account));

		await controller.showResetUsageSelector();

		expect(showHookConfirm).toHaveBeenCalledTimes(1);
		expect(redeemResetCredit).not.toHaveBeenCalled();
	});
});

describe("SelectorController.showSessionPinSelector", () => {
	const anthropicRow = row({ id: 5, provider: "anthropic", label: "work" });

	function createPinCtx() {
		const pinSessionCredential = vi.fn(() => true);
		const clearSessionCredential = vi.fn();
		const authStorage = {
			credentials: { reload: vi.fn(async () => {}) },
			listCredentials: () => [anthropicRow],
			pinSessionCredential,
			clearSessionCredential,
		};
		const { ctx, showStatus } = createCtx({
			isStreaming: false,
			model: { provider: "anthropic", id: "claude" },
			modelRegistry: { authStorage },
			sessionId: "session-1",
		});
		return { ctx, showStatus, pinSessionCredential, clearSessionCredential };
	}

	it("picks the credential first, then pins the chosen row", async () => {
		const { ctx, showStatus, pinSessionCredential, clearSessionCredential } = createPinCtx();
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn(async () => pickedRow("anthropic", anthropicRow));

		await controller.showSessionPinSelector();

		expect(controller.pickCredential).toHaveBeenCalledWith(
			expect.objectContaining({ verb: "Pin to this session", rows: [anthropicRow], initialProvider: "anthropic" }),
		);
		expect(pinSessionCredential).toHaveBeenCalledWith("anthropic", "session-1", 5);
		expect(clearSessionCredential).not.toHaveBeenCalled();
		expect(showStatus.mock.calls.at(-1)?.[0]).toContain("Pinned");
	});

	it("returns the session to the pool on the 'Use the pool' pick", async () => {
		const { ctx, showStatus, pinSessionCredential, clearSessionCredential } = createPinCtx();
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn(async () => pickedPool("anthropic"));

		await controller.showSessionPinSelector();

		expect(clearSessionCredential).toHaveBeenCalledWith("anthropic", "session-1");
		expect(pinSessionCredential).not.toHaveBeenCalled();
		expect(showStatus.mock.calls.at(-1)?.[0]).toContain("pool again");
	});

	it("stops while the session is streaming, with no pick attempted", async () => {
		const { ctx, showStatus } = createPinCtx();
		(ctx.session as unknown as { isStreaming: boolean }).isStreaming = true;
		const controller = new SelectorController(ctx);
		controller.pickCredential = vi.fn();

		await controller.showSessionPinSelector();

		expect(controller.pickCredential).not.toHaveBeenCalled();
		expect(showStatus).toHaveBeenCalledWith("Cannot pin an account while the session is streaming.");
	});
});
