import { describe, expect, it } from "bun:test";
import type { CredentialSummary } from "@oh-my-pi/pi-ai";
import {
	credentialChoicesText,
	matchCredentialSelector,
	resolveCredentialTarget,
} from "@oh-my-pi/pi-coding-agent/auth/credential-selector";

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

describe("resolveCredentialTarget", () => {
	const work = row({ id: 5, label: "work", identity: "a@x", active: true });
	const gmail = row({ id: 6, identity: "b@x" });
	const apiKey = row({ id: 7, kind: "api_key", hint: "…ab12" });
	const rows: CredentialSummary[] = [work, gmail, apiKey];

	it("resolves an id, #id, label or identity to the same row", () => {
		for (const selector of ["anthropic/5", "anthropic/#5", "anthropic/work", "anthropic/A@X"]) {
			const resolved = resolveCredentialTarget(rows, selector);
			expect(resolved).toEqual({ ok: true, selection: { kind: "row", row: work } });
		}
	});

	it("resolves a bare selector against the given provider", () => {
		const resolved = resolveCredentialTarget(rows, "5", { provider: "anthropic" });
		expect(resolved).toEqual({ ok: true, selection: { kind: "row", row: work } });
	});

	it("resolves 'active' to the active row", () => {
		const resolved = resolveCredentialTarget(rows, "anthropic/active");
		expect(resolved).toEqual({ ok: true, selection: { kind: "row", row: work } });
	});

	it("refuses 'pool' unless allowPool is set", () => {
		const refused = resolveCredentialTarget(rows, "anthropic/pool");
		expect(refused.ok).toBe(false);

		const allowed = resolveCredentialTarget(rows, "anthropic/pool", { allowPool: true });
		expect(allowed).toEqual({ ok: true, selection: { kind: "pool" } });
	});

	it("fails with the choices listed when nothing matches", () => {
		const resolved = resolveCredentialTarget(rows, "anthropic/9");
		expect(resolved.ok).toBe(false);
		if (resolved.ok) throw new Error("expected a failure");
		expect(resolved.message).toBe(`No anthropic credential matches "9".\n${credentialChoicesText(rows)}`);
	});

	it("fails naming every match when a label is shared by two rows", () => {
		const shared: CredentialSummary[] = [
			row({ id: 1, label: "shared" }),
			row({ id: 2, label: "shared" }),
		];
		const resolved = resolveCredentialTarget(shared, "anthropic/shared");
		expect(resolved.ok).toBe(false);
		if (resolved.ok) throw new Error("expected a failure");
		expect(resolved.message).toContain('"shared" matches 2 anthropic credentials');
	});

	it("fails with the malformed message for a bare selector with no provider context", () => {
		const resolved = resolveCredentialTarget(rows, "work");
		expect(resolved).toEqual({
			ok: false,
			message: "Name a credential as <provider>/<id|active|#id|label|email>.",
		});
	});
});

describe("matchCredentialSelector", () => {
	const rows: CredentialSummary[] = [row({ id: 1, label: "Work" }), row({ id: 2, label: "Personal" })];

	it("treats a bare number as the credential id, never a list position", () => {
		expect(matchCredentialSelector(rows, "2")).toEqual([{ kind: "row", row: rows[1] }]);
	});

	it("matches #id the same way", () => {
		expect(matchCredentialSelector(rows, "#1")).toEqual([{ kind: "row", row: rows[0] }]);
	});

	it("returns no matches for an unrecognized selector", () => {
		expect(matchCredentialSelector(rows, "nobody")).toEqual([]);
	});
});

describe("credentialChoicesText", () => {
	it("marks the active row and shows provider/id", () => {
		const active = row({ id: 5, label: "work", active: true });
		const other = row({ id: 6, identity: "b@x" });
		expect(credentialChoicesText([active, other])).toBe(
			"- work [anthropic/5] (active)\n- b@x [anthropic/6]",
		);
	});
});
