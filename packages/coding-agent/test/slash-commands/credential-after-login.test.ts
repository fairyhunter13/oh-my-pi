import { describe, expect, test } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import {
	applyCredentialAfterLoginName,
	applyCredentialAfterLoginScope,
	type CredentialAfterLoginStorage,
	suggestedCredentialName,
} from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/credential-after-login";

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

/** Records every call so a test can assert exactly which `AuthStorage` method ran. */
class StubStorage implements CredentialAfterLoginStorage {
	renamed: Array<{ id: number; label: string | null }> = [];
	pinned: Array<{ provider: string; sessionId: string; id: number }> = [];
	defaulted: Array<{ provider: string; id: number | null }> = [];
	pinResult = true;
	renameError: string | undefined;

	constructor(private rows: CredentialSummary[]) {}

	listCredentials(provider?: string, _sessionId?: string): CredentialSummary[] {
		return provider ? this.rows.filter(r => r.provider === provider) : this.rows;
	}

	renameCredential(id: number, label: string | null): void {
		if (this.renameError) throw new Error(this.renameError);
		this.renamed.push({ id, label });
		const target = this.rows.find(r => r.id === id);
		if (target) target.label = label;
	}

	pinSessionCredential(provider: string, sessionId: string, id: number): boolean {
		this.pinned.push({ provider, sessionId, id });
		return this.pinResult;
	}

	setDefaultCredential(provider: string, id: number | null): void {
		this.defaulted.push({ provider, id });
	}
}

describe("suggestedCredentialName", () => {
	test("delegates to suggestCredentialLabel for the stored row", () => {
		const storage = new StubStorage([row({ id: 1, identity: "work@example.com" })]);
		expect(suggestedCredentialName(storage, "anthropic", "s1", 1)).toBe("work@example.com");
	});

	test("throws when the row is gone", () => {
		const storage = new StubStorage([]);
		expect(() => suggestedCredentialName(storage, "anthropic", "s1", 1)).toThrow(/No stored credential #1/);
	});
});

describe("applyCredentialAfterLoginName", () => {
	test("an empty submission accepts the suggested name", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginName(storage, 1, "work@example.com", "   ");
		expect(result).toEqual({ ok: true, label: "work@example.com" });
		expect(storage.renamed).toEqual([{ id: 1, label: "work@example.com" }]);
	});

	test("a non-empty submission overrides the suggestion", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginName(storage, 1, "work@example.com", "  my key  ");
		expect(result).toEqual({ ok: true, label: "my key" });
		expect(storage.renamed).toEqual([{ id: 1, label: "my key" }]);
	});

	test("a clash surfaces the store's error instead of applying the name", () => {
		const storage = new StubStorage([row({ id: 1 }), row({ id: 2, label: "work" })]);
		storage.renameError = "'work' is already used for another anthropic credential";
		const result = applyCredentialAfterLoginName(storage, 1, "work", "work");
		expect(result).toEqual({ ok: false, error: storage.renameError });
	});

	test("retrying with a different name after a clash succeeds", () => {
		const storage = new StubStorage([row({ id: 1 }), row({ id: 2, label: "work" })]);
		storage.renameError = "clash";
		const first = applyCredentialAfterLoginName(storage, 1, "work", "work");
		expect(first.ok).toBe(false);
		storage.renameError = undefined;
		const second = applyCredentialAfterLoginName(storage, 1, "work", "work (2)");
		expect(second).toEqual({ ok: true, label: "work (2)" });
	});
});

describe("applyCredentialAfterLoginScope", () => {
	test("'session' pins the row when a session is running", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginScope(storage, "anthropic", "s1", 1, "session");
		expect(result).toEqual({ ok: true });
		expect(storage.pinned).toEqual([{ provider: "anthropic", sessionId: "s1", id: 1 }]);
		expect(storage.defaulted).toEqual([]);
	});

	test("'session' without a running session errors without calling the store", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginScope(storage, "anthropic", undefined, 1, "session");
		expect(result).toEqual({ ok: false, error: "No running session to pin." });
		expect(storage.pinned).toEqual([]);
	});

	test("'session' surfaces a failed pin (row missing or disabled)", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		storage.pinResult = false;
		const result = applyCredentialAfterLoginScope(storage, "anthropic", "s1", 1, "session");
		expect(result).toEqual({ ok: false, error: "Credential is missing or disabled." });
	});

	test("'default' sets the provider default", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginScope(storage, "anthropic", "s1", 1, "default");
		expect(result).toEqual({ ok: true });
		expect(storage.defaulted).toEqual([{ provider: "anthropic", id: 1 }]);
		expect(storage.pinned).toEqual([]);
	});

	test("'store' calls neither pin nor default", () => {
		const storage = new StubStorage([row({ id: 1 })]);
		const result = applyCredentialAfterLoginScope(storage, "anthropic", "s1", 1, "store");
		expect(result).toEqual({ ok: true });
		expect(storage.pinned).toEqual([]);
		expect(storage.defaulted).toEqual([]);
	});
});
