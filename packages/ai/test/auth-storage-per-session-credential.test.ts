import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";

// Addendum 5 (each main session has its own active credential): two sessions of one provider
// never move each other's credential. API-key rows avoid an OAuth network refresh; the
// sticky-restore path (sessions.pin with restoredAtMs) is OAuth-only, so the sticky/default
// tests below use OAuth rows with a far-future expiry instead.
const PROVIDER = "unit-per-session";

function oauthCredential(suffix: string) {
	return {
		type: "oauth" as const,
		access: `access-${suffix}`,
		refresh: `refresh-${suffix}`,
		expires: Date.now() + 60 * 60_000,
		email: `${suffix}@example.com`,
	};
}

describe("AuthStorage: each session keeps its own credential", () => {
	let tempDir = "";
	let store: SqliteAuthCredentialStore | null = null;
	let auth: AuthStorage;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-per-session-"));
		store = await SqliteAuthCredentialStore.open(path.join(tempDir, "agent.db"));
		auth = new AuthStorage(store);
	});

	afterEach(async () => {
		store?.close();
		store = null;
		if (tempDir) {
			await fs.rm(tempDir, { recursive: true, force: true });
			tempDir = "";
		}
	});

	test("two pinned sessions resolve their own row under interleaved calls", async () => {
		const rowA = auth.addApiKey(PROVIDER, "sk-a");
		const rowB = auth.addApiKey(PROVIDER, "sk-b");
		expect(auth.pinSessionCredential(PROVIDER, "session-a", rowA)).toBe(true);
		expect(auth.pinSessionCredential(PROVIDER, "session-b", rowB)).toBe(true);

		// Interleaved A, B, A, B: each call must still resolve its own session's row, never
		// the sibling's — a pin race or a shared "current" pointer would leak across sessions.
		expect(await auth.keys.get(PROVIDER, "session-a")).toBe("sk-a");
		expect(await auth.keys.get(PROVIDER, "session-b")).toBe("sk-b");
		expect(await auth.keys.get(PROVIDER, "session-a")).toBe("sk-a");
		expect(await auth.keys.get(PROVIDER, "session-b")).toBe("sk-b");
	});

	test("a default change moves neither a pinned session nor a sticky one, and only a fresh session sees it", async () => {
		await auth.credentials.upsert(PROVIDER, oauthCredential("a"));
		await auth.credentials.upsert(PROVIDER, oauthCredential("b"));
		await auth.credentials.reload();
		const rows = auth.listCredentials(PROVIDER);
		const rowA = rows.find(row => row.identity === "a@example.com")!.id;
		const rowB = rows.find(row => row.identity === "b@example.com")!.id;

		// A strict pin, on row A, serves that session regardless of the default.
		expect(auth.pinSessionCredential(PROVIDER, "pinned-session", rowA)).toBe(true);
		const pinnedBefore = await auth.keys.get(PROVIDER, "pinned-session");
		expect(pinnedBefore).toContain("access-a");

		// Two UNPINNED sessions, each served once while a different row was the live default —
		// that first serve is what records their own sticky row.
		auth.setDefaultCredential(PROVIDER, rowA);
		const stickyABefore = await auth.keys.get(PROVIDER, "sticky-session-a");
		expect(stickyABefore).toContain("access-a");
		auth.setDefaultCredential(PROVIDER, rowB);
		const stickyBBefore = await auth.keys.get(PROVIDER, "sticky-session-b");
		expect(stickyBBefore).toContain("access-b");

		// The default moves again, to row A. Nothing already running moves: the pinned session
		// keeps its pin, sticky-session-a happens to still match the new default (its own sticky
		// row, not the default, is what keeps it there), and sticky-session-b — whose sticky row
		// now DIFFERS from the new default — proves the point: it stays on row B.
		auth.setDefaultCredential(PROVIDER, rowA);
		expect(await auth.keys.get(PROVIDER, "pinned-session")).toBe(pinnedBefore);
		expect(await auth.keys.get(PROVIDER, "sticky-session-a")).toBe(stickyABefore);
		expect(await auth.keys.get(PROVIDER, "sticky-session-b")).toBe(stickyBBefore);

		// A brand-new session, never served, sees the current default at once.
		expect(await auth.keys.get(PROVIDER, "new-session")).toContain("access-a");
	});

	test("a usage-limit mark on one row switches only the session that hit it", async () => {
		await auth.credentials.upsert(PROVIDER, oauthCredential("a"));
		await auth.credentials.upsert(PROVIDER, oauthCredential("b"));
		await auth.credentials.reload();
		const rows = auth.listCredentials(PROVIDER);
		const rowA = rows.find(row => row.identity === "a@example.com")!.id;
		const rowB = rows.find(row => row.identity === "b@example.com")!.id;

		// Restore (sticky-only) each unpinned session onto its own row, deterministically.
		expect(auth.sessions.pin(PROVIDER, "session-a", rowA, { restoredAtMs: Date.now() })).toBe(true);
		expect(auth.sessions.pin(PROVIDER, "session-b", rowB, { restoredAtMs: Date.now() })).toBe(true);
		expect(await auth.keys.get(PROVIDER, "session-a")).toContain("access-a");
		expect(await auth.keys.get(PROVIDER, "session-b")).toContain("access-b");

		const result = await auth.limits.markReached(PROVIDER, "session-a", { retryAfterMs: 60_000 });
		expect(result.switched).toBe(true);
		// session-a moved off the now-blocked row, onto its only sibling.
		expect(await auth.keys.get(PROVIDER, "session-a")).toContain("access-b");
		// session-b's own routing is untouched: it never named row A, so marking row A reached
		// changes nothing for it.
		expect(await auth.keys.get(PROVIDER, "session-b")).toContain("access-b");
	});

	test("clearSessionCredential returns the session to the default, not the row it served while pinned", async () => {
		const rowLowest = auth.addApiKey(PROVIDER, "sk-lowest");
		const rowDefault = auth.addApiKey(PROVIDER, "sk-default");
		auth.setDefaultCredential(PROVIDER, rowDefault);

		expect(auth.pinSessionCredential(PROVIDER, "session-x", rowLowest)).toBe(true);
		expect(await auth.keys.get(PROVIDER, "session-x")).toBe("sk-lowest");

		// A pin writes through the sticky path too (SessionAffinity.record), so clearing must
		// drop that sticky row as well — otherwise SessionAffinity.preferred's sticky-before-
		// default fallback keeps serving the old pinned row after the pin itself is gone.
		auth.clearSessionCredential(PROVIDER, "session-x");
		expect(await auth.keys.get(PROVIDER, "session-x")).toBe("sk-default");
		const afterClear = auth.listCredentials(PROVIDER, "session-x");
		expect(afterClear.some(row => row.pinned)).toBe(false);
		expect(afterClear.find(row => row.active)?.id).toBe(rowDefault);
	});

	test("a pin cleared on one session never leaks its row to an unrelated, never-served session", async () => {
		const rowLowest = auth.addApiKey(PROVIDER, "sk-lowest2");
		auth.addApiKey(PROVIDER, "sk-second2");

		// Pin and clear a DIFFERENT session first, matching the selftest's ordering: an earlier
		// check's pin/clear sequence must not leave state a later, unrelated session can see.
		expect(auth.pinSessionCredential(PROVIDER, "session-y", rowLowest)).toBe(true);
		expect(await auth.keys.get(PROVIDER, "session-y")).toBe("sk-lowest2");
		auth.clearSessionCredential(PROVIDER, "session-y");

		// No pin, no default: a brand-new session id resolves to the lowest enabled row.
		expect(await auth.keys.get(PROVIDER, "session-z")).toBe("sk-lowest2");
	});
});
