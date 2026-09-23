import { describe, expect, test } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import { matchSessionPinSelector } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/session-pin";

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

describe("matchSessionPinSelector", () => {
	const rows: CredentialSummary[] = [
		row({ id: 1, label: "Work", identity: "work@example.com" }),
		row({ id: 2, label: "Personal", identity: "personal@example.com", active: true }),
		row({ id: 3, kind: "api_key", label: null, identity: null, hint: "…ab12" }),
	];

	test("resolves by label, case-insensitive", () => {
		expect(matchSessionPinSelector(rows, "wORk")).toEqual([{ kind: "row", row: rows[0] }]);
	});

	test("resolves by exact identity/email", () => {
		expect(matchSessionPinSelector(rows, "personal@example.com")).toEqual([{ kind: "row", row: rows[1] }]);
	});

	test("resolves by #id", () => {
		expect(matchSessionPinSelector(rows, "#3")).toEqual([{ kind: "row", row: rows[2] }]);
	});

	test("resolves by 1-based position in the listed order", () => {
		expect(matchSessionPinSelector(rows, "2")).toEqual([{ kind: "row", row: rows[1] }]);
	});

	test("resolves 'active' to the currently active row", () => {
		expect(matchSessionPinSelector(rows, "active")).toEqual([{ kind: "row", row: rows[1] }]);
	});

	test("resolves 'pool' to the pool sentinel regardless of case", () => {
		expect(matchSessionPinSelector(rows, "Pool")).toEqual([{ kind: "pool" }]);
	});

	test("returns no matches for an unknown selector", () => {
		expect(matchSessionPinSelector(rows, "nobody@example.com")).toEqual([]);
	});

	test("returns no matches for an out-of-range position or #id", () => {
		expect(matchSessionPinSelector(rows, "99")).toEqual([]);
		expect(matchSessionPinSelector(rows, "#99")).toEqual([]);
	});

	test("returns every row sharing an identity", () => {
		const shared: CredentialSummary[] = [
			row({ id: 10, identity: "shared@example.com" }),
			row({ id: 11, identity: "shared@example.com" }),
		];
		expect(matchSessionPinSelector(shared, "shared@example.com")).toEqual([
			{ kind: "row", row: shared[0] },
			{ kind: "row", row: shared[1] },
		]);
	});

	test("returns nothing for an empty selector", () => {
		expect(matchSessionPinSelector(rows, "   ")).toEqual([]);
	});
});
