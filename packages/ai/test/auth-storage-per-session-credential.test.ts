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

	test("a default change moves neither a pinned session nor an adopted (settled) one, and only a fresh session sees it", async () => {
		await auth.credentials.upsert(PROVIDER, oauthCredential("a"));
		await auth.credentials.upsert(PROVIDER, oauthCredential("b"));
		await auth.credentials.reload();
		const rows = auth.listCredentials(PROVIDER);
		const rowA = rows.find(row => row.identity === "a@example.com")!.id;
		const rowB = rows.find(row => row.identity === "b@example.com")!.id;
		// Start the default on row B, so a session that resolves without a pin lands there.
		auth.setDefaultCredential(PROVIDER, rowB);

		// A strict pin, off the current default, on row A.
		expect(auth.pinSessionCredential(PROVIDER, "pinned-session", rowA)).toBe(true);
		const pinnedBefore = await auth.keys.get(PROVIDER, "pinned-session");
		expect(pinnedBefore).toContain("access-a");

		// No pin yet: an unpinned resolve follows the LIVE default (row B here) on every
		// call — that is what "default" means. `sessions.adopt` is the operator's own
		// "keep me here" moment (the turn-completion hook in the real coding agent, or
		// `/session pin` implicitly), promoting the row that just served into a durable
		// pin so this settled session stops tracking the default from here on.
		const settledBefore = await auth.keys.get(PROVIDER, "settled-session");
		expect(settledBefore).toContain("access-b");
		expect(auth.sessions.adopt(PROVIDER, "settled-session")).toBe(rowB);

		// The default moves to the OTHER row. Neither the pinned nor the settled session moves.
		auth.setDefaultCredential(PROVIDER, rowA);
		expect(await auth.keys.get(PROVIDER, "pinned-session")).toBe(pinnedBefore);
		expect(await auth.keys.get(PROVIDER, "settled-session")).toBe(settledBefore);

		// A brand-new session, with no pin and never adopted, sees the new default at once.
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
});
