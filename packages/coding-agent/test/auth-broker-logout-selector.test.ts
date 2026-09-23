import { describe, expect, test } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { resolveCredentialSelector } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";

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

describe("resolveCredentialSelector", () => {
	const rows: CredentialSummary[] = [
		row({ id: 1, label: "Work", identity: "work@example.com" }),
		row({ id: 2, label: "Personal", identity: "personal@example.com" }),
		row({ id: 3, kind: "api_key", label: null, identity: null, hint: "…ab12" }),
		row({ id: 4, label: null, identity: "shared@example.com" }),
		row({ id: 5, label: null, identity: "shared@example.com" }),
	];

	test("resolves by #id", () => {
		expect(resolveCredentialSelector(rows, "#3").id).toBe(3);
	});

	test("rejects an id that does not exist", () => {
		expect(() => resolveCredentialSelector(rows, "#99")).toThrow(/No credential #99/);
	});

	test("resolves by label, case-insensitive", () => {
		expect(resolveCredentialSelector(rows, "wORk").id).toBe(1);
	});

	test("resolves by exact identity/email", () => {
		expect(resolveCredentialSelector(rows, "personal@example.com").id).toBe(2);
	});

	test("throws when two rows share the same identity", () => {
		expect(() => resolveCredentialSelector(rows, "shared@example.com")).toThrow(/matches 2 credentials by identity/);
	});

	test("throws when nothing matches", () => {
		expect(() => resolveCredentialSelector(rows, "nobody@example.com")).toThrow(/No credential matches/);
	});
});
