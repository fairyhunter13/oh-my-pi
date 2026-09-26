// Ported from ccw's internal/policy/omp_mailbox_test.go (claude-code-workflows, commit
// 843a5bc). The Go test spawned the extension's JS in a bun subprocess against a fake
// ExtensionAPI; here the extension lives in this tree, so the same fake API and the same
// sequence of checks run in-process against the real fs. Sections mirror the original
// harness's numbered comments and share one temp mailbox ROOT and one running story, because
// the domain itself is sequential: session B's mailbox must exist before A can address it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	watch,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, setAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionAPI, ExtensionContext } from "../src/extensibility/extensions";
import { createMailboxExtension } from "../src/mailbox";

const originalAgentDir = getAgentDir();
const testAgentDir = mkdtempSync(join(tmpdir(), "mailbox-agent-"));
const ROOT = join(testAgentDir, "mailbox");

// The extension reads getAgentDir() per call, so this file's cases see this dir even when a
// sibling test file moved it before this one ran.
beforeAll(() => {
	setAgentDir(testAgentDir);
});

afterAll(() => {
	setAgentDir(originalAgentDir);
	rmSync(testAgentDir, { recursive: true, force: true });
});

const A = "01990000-aaaa-7000-8000-000000000001";
const A2 = "01990000-aaaa-7000-8000-00000000000a";
const B = "01990000-bbbb-7000-8000-000000000002";
const D = "01990000-bbbb-7000-8000-000000000003";
const DEAD = "01990000-cccc-7000-8000-000000000004";
const CHATTY = "01990000-eeee-7000-8000-000000000005";
const CHILD = "01990000-ffff-7000-8000-000000000006";

interface MailDetails {
	id: string;
	from: string;
	inReplyTo: string;
	hop: number;
}

interface AuditData {
	id: string;
	from: string;
	inReplyTo: string;
	hop: number;
	at: number;
}

interface FakeEntry {
	type: "custom";
	customType: string;
	data: AuditData;
}

interface FakeMessage {
	customType: string;
	content: string;
	display?: boolean;
	attribution?: string;
	details?: Record<string, unknown>;
}

interface SentRecord {
	message: FakeMessage;
	options?: { triggerTurn?: boolean; deliverAs?: string };
	outcome: string;
}

interface FakeToolResult {
	content: { type: string; text: string }[];
	details?: Record<string, unknown>;
}

interface FakeTool {
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<FakeToolResult>;
}

interface FakeCommand {
	handler: (args: string, ctx: ExtensionContext) => Promise<void>;
}

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakePi {
	handlers: Map<string, Handler>;
	tools: Record<string, FakeTool>;
	command: FakeCommand | null;
	entries: FakeEntry[];
}

interface FakeCtx {
	sessionId: string;
	intervals: (() => void)[];
}

let busy = false;
let failNextSend = false;
const sent: SentRecord[] = [];
const userMessages: unknown[] = [];
const notices: string[] = [];

// agent-session.ts: streaming takes nextTurn and aside as they are, followUp as a follow-up and
// anything else as a steer (:7727-7753). Idle, aside and triggerTurn start a turn (:7777-7813).
function outcomeOf(options?: { triggerTurn?: boolean; deliverAs?: string }): string {
	const deliverAs = options?.deliverAs;
	if (busy) {
		if (deliverAs === "nextTurn" || deliverAs === "aside" || deliverAs === "followUp") {
			return deliverAs;
		}
		return "steer";
	}
	if (deliverAs === "aside" || options?.triggerTurn) {
		return "turn";
	}
	return "appended";
}

function makePi(): FakePi & ExtensionAPI {
	const handlers = new Map<string, Handler>();
	const tools: Record<string, FakeTool> = {};
	const entries: FakeEntry[] = [];
	const chain = { describe: () => chain, optional: () => chain };
	const api = {
		handlers,
		tools,
		command: null as FakeCommand | null,
		entries,
		zod: { object: (shape: unknown) => ({ shape }), string: () => chain },
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		registerTool: (tool: FakeTool & { name: string }) => {
			tools[tool.name] = tool;
		},
		registerCommand: (_name: string, spec: FakeCommand) => {
			api.command = spec;
		},
		sendMessage: (message: FakeMessage, options?: { triggerTurn?: boolean; deliverAs?: string }) => {
			if (failNextSend) {
				failNextSend = false;
				throw new Error("the session went away mid-send");
			}
			sent.push({ message, options, outcome: outcomeOf(options) });
		},
		sendUserMessage: (content: unknown) => {
			userMessages.push(content);
		},
		appendEntry: (customType: string, data?: unknown) => {
			entries.push({ type: "custom", customType, data: data as AuditData });
		},
	};
	const full = api as unknown as FakePi & ExtensionAPI;
	createMailboxExtension(full);
	return full;
}

function makeCtx(api: FakePi, sessionId: string, agent: string | null): FakeCtx & ExtensionContext {
	const ctx = {
		sessionId,
		cwd: "/work/" + sessionId.slice(-4),
		mode: "tui",
		hasUI: true,
		isIdle: () => !busy,
		ui: {
			notify: (message: string, level: string) => {
				notices.push(ctx.sessionId + " " + level + ": " + message);
			},
		},
		intervals: [] as (() => void)[],
		setInterval: (callback: () => void) => {
			ctx.intervals.push(callback);
			return ctx.intervals.length as unknown as Timer;
		},
		clearTimer: () => {},
		sessionManager: {
			getSessionId: () => ctx.sessionId,
			getSessionName: () => undefined,
			getEntries: () => (agent ? [{ type: "session_init", agent }, ...api.entries] : api.entries),
		},
	};
	return ctx as unknown as FakeCtx & ExtensionContext;
}

async function fire(
	api: FakePi,
	event: string,
	ctx: ExtensionContext,
	payload: Record<string, unknown> = {},
): Promise<void> {
	const handler = api.handlers.get(event);
	if (!handler) {
		throw new Error("no handler for " + event);
	}
	await handler({ type: event, ...payload }, ctx);
}

function header(fields: Record<string, string | undefined> = {}): { id: string; text: string } {
	const values: Record<string, string | undefined> = {
		from: B,
		to: A,
		id: randomUUID(),
		"in-reply-to": "",
		hop: "0",
		sentAt: new Date().toISOString(),
		...fields,
	};
	const lines = ["---"];
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined) {
			lines.push(key + ": " + value);
		}
	}
	lines.push("---");
	return { id: values.id as string, text: lines.join("\n") + "\n" };
}

function drop(sessionId: string, name: string, text: string, mode = 0o600): string {
	const path = join(ROOT, sessionId, "new", name);
	writeFileSync(path, text, { mode });
	chmodSync(path, mode);
	return path;
}

function listOf(sessionId: string, sub: string): string[] {
	return readdirSync(join(ROOT, sessionId, sub)).sort();
}

function parseHeader(path: string): Record<string, string> {
	const fields: Record<string, string> = {};
	const text = readFileSync(path, "utf8");
	for (const line of text.split("\n---\n")[0].split("\n").slice(1)) {
		const colon = line.indexOf(":");
		fields[line.slice(0, colon)] = line.slice(colon + 1).trim();
	}
	return fields;
}

const modeOf = (path: string): number => lstatSync(path).mode & 0o777;

async function attempt(
	api: FakePi,
	ctx: ExtensionContext,
	params: { to: string; body: string; inReplyTo?: string },
): Promise<{ result?: FakeToolResult; error?: string }> {
	try {
		return { result: await api.tools.mail_send.execute("t", params, undefined, undefined, ctx) };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

describe("mailbox: cross-session mail via createMailboxExtension", () => {
	let a: FakePi & ExtensionAPI;
	let aCtx: FakeCtx & ExtensionContext;
	let first: { id: string; text: string };

	it("1. delivers mail that arrived while down, via the session_start rescan", async () => {
		mkdirSync(ROOT, { recursive: true, mode: 0o700 });
		for (const sub of ["", "tmp", "new", "delivered", "rejected"]) {
			mkdirSync(join(ROOT, A, sub), { recursive: true, mode: 0o700 });
		}
		first = header({});
		drop(A, "001-good.md", first.text + "hello from B");

		a = makePi();
		aCtx = makeCtx(a, A, null);
		await fire(a, "session_start", aCtx);

		const presencePath = join(ROOT, A, ".presence.json");
		const presence = JSON.parse(readFileSync(presencePath, "utf8"));
		// presence is 0600 and names the session
		expect(modeOf(presencePath)).toBe(0o600);
		expect(presence.sessionId).toBe(A);
		expect(presence.pid).toBe(process.pid);
		expect(presence.cwd).toBe(aCtx.cwd);
		expect(presence.name).toBe(basename(aCtx.cwd));
		expect(presence.startedAt).toBeTruthy();

		// every mailbox dir is 0700
		for (const sub of ["", "tmp", "new", "delivered", "rejected"]) {
			expect(modeOf(join(ROOT, A, sub))).toBe(0o700);
		}

		expect(sent.length).toBe(1);
		const delivered = sent[0];
		const details = delivered.message.details as unknown as MailDetails;
		// a good file is delivered once as agent-attributed ccw-mail
		expect(delivered.message.customType).toBe("ccw-mail");
		expect(delivered.message.attribution).toBe("agent");
		expect(delivered.message.display).toBe(true);
		expect(details.id).toBe(first.id);
		expect(details.from).toBe(B);
		expect(details.hop).toBe(0);
		expect(
			delivered.message.content.startsWith("[mail from " + B + " unknown cwd, id " + first.id + "] hello from B"),
		).toBe(true);
		// idle delivery starts a turn
		expect(delivered.outcome).toBe("turn");
		// the delivery is audited
		expect(
			a.entries.some(
				entry =>
					entry.customType === "ccw-mailbox" &&
					entry.data.id === first.id &&
					entry.data.from === B &&
					entry.data.hop === 0 &&
					entry.data.at > 0,
			),
		).toBe(true);
		// a delivered file ends in delivered/
		expect(listOf(A, "delivered")).toContain("001-good.md");
		expect(listOf(A, "new")).not.toContain("001-good.md");
		// an interval rescan is scheduled
		expect(aCtx.intervals.length).toBe(1);
	});

	it("2. busy mail waits as a follow-up, and a failed send is retried on the next scan", () => {
		busy = true;
		drop(A, "002-busy.md", header({}).text + "while you work");
		aCtx.intervals[0]();
		busy = false;
		// busy delivery is followUp
		expect(sent.length).toBe(2);
		expect(sent.at(-1)?.outcome).toBe("followUp");

		const retried = header({});
		drop(A, "002-retry.md", retried.text + "try again");
		failNextSend = true;
		aCtx.intervals[0]();
		// a failed send leaves the file in new/ unaudited
		expect(listOf(A, "new")).toContain("002-retry.md");
		expect(a.entries.some(entry => entry.data.id === retried.id)).toBe(false);
		aCtx.intervals[0]();
		// the next scan delivers it
		const lastDetails = sent.at(-1)?.message.details as unknown as MailDetails;
		expect(lastDetails.id).toBe(retried.id);
		expect(listOf(A, "delivered")).toContain("002-retry.md");
	});

	it("3. every rejected file lands in rejected/ with a notice naming it, and hop 3 still delivers", () => {
		const outside = join(ROOT, "..", "planted.md");
		writeFileSync(outside, header({}).text + "planted", { mode: 0o600 });
		chmodSync(outside, 0o600);
		drop(A, "r-0644.md", header({}).text + "loose", 0o644);
		symlinkSync(outside, join(ROOT, A, "new", "r-symlink.md"));
		drop(A, "r-big.md", header({}).text + "x".repeat(65 * 1024));
		drop(A, "r-no-sentAt.md", header({ sentAt: undefined }).text + "no date");
		drop(A, "r-wrong-to.md", header({ to: D }).text + "not yours");
		drop(A, "r-hop4.md", header({ hop: "4" }).text + "too deep");
		drop(A, "r-climb.md", header({ from: "../../escape" }).text + "climb");
		drop(A, "r-no-header.md", "just text");
		drop(A, "s-hop3.md", header({ hop: "3" }).text + "last hop");
		const beforeRejects = sent.length;
		aCtx.intervals[0]();
		for (const name of [
			"r-0644.md",
			"r-symlink.md",
			"r-big.md",
			"r-no-sentAt.md",
			"r-wrong-to.md",
			"r-hop4.md",
			"r-climb.md",
			"r-no-header.md",
		]) {
			// rejected <name>
			expect(listOf(A, "rejected")).toContain(name);
			expect(listOf(A, "new")).not.toContain(name);
			expect(notices.some(line => line.includes("rejected " + name))).toBe(true);
		}
		// hop 3 is still delivered
		expect(sent.length).toBe(beforeRejects + 1);
		expect((sent.at(-1)?.message.details as unknown as MailDetails).hop).toBe(3);
		expect(listOf(A, "delivered")).toContain("s-hop3.md");
		// the symlink target was never read
		expect(readFileSync(outside, "utf8").endsWith("planted")).toBe(true);
		expect(sent.some(row => row.message.content.includes("planted"))).toBe(false);
	});

	it("4. a mailbox dir another user could write to stops all reading", () => {
		chmodSync(join(ROOT, A, "new"), 0o755);
		drop(A, "003-open-dir.md", header({}).text + "open dir");
		const beforeOpen = sent.length;
		aCtx.intervals[0]();
		// a 0755 new/ delivers nothing
		expect(sent.length).toBe(beforeOpen);
		expect(listOf(A, "new")).toContain("003-open-dir.md");
		expect(notices.some(line => line.includes("has mode 755"))).toBe(true);
		chmodSync(join(ROOT, A, "new"), 0o700);
		aCtx.intervals[0]();
		// the same file is delivered once new/ is 0700 again
		expect(sent.length).toBe(beforeOpen + 1);
		expect(listOf(A, "delivered")).toContain("003-open-dir.md");
	});

	it("5. a duplicate id is filed with no second delivery", () => {
		drop(A, "004-dup.md", first.text + "hello again");
		const beforeDup = sent.length;
		aCtx.intervals[0]();
		expect(sent.length).toBe(beforeDup);
		expect(listOf(A, "delivered")).toContain("004-dup.md");
		expect(listOf(A, "new")).not.toContain("004-dup.md");
	});

	it("6. the 11th mail from one sender inside an hour is held, and reported once", () => {
		for (let i = 1; i <= 11; i++) {
			drop(A, "chatty-" + String(i).padStart(2, "0") + ".md", header({ from: CHATTY }).text + "note " + i);
		}
		const beforeChatty = sent.length;
		aCtx.intervals[0]();
		aCtx.intervals[0]();
		const chattyNotices = notices.filter(line => line.includes("held mail from " + CHATTY));
		// the 11th mail from one sender is held in new/
		expect(sent.length).toBe(beforeChatty + 10);
		expect(listOf(A, "new")).toContain("chatty-11.md");
		expect(
			sent.slice(beforeChatty).every(row => (row.message.details as unknown as MailDetails).from === CHATTY),
		).toBe(true);
		// a held sender is reported once per hour
		expect(chattyNotices.length).toBe(1);
		for (const entry of a.entries) {
			if (entry.data.from === CHATTY) {
				entry.data.at -= 2 * 60 * 60 * 1000;
			}
		}
		aCtx.intervals[0]();
		// held mail is delivered once the window allows
		expect(sent.length).toBe(beforeChatty + 11);
		expect(listOf(A, "new")).not.toContain("chatty-11.md");
	});

	it("7. a subagent opens no mailbox, and its tool and command refuse", async () => {
		const child = makePi();
		const childCtx = makeCtx(child, CHILD, "task");
		await fire(child, "session_start", childCtx);
		// a child session starts no watcher and writes no presence
		expect(existsSync(join(ROOT, CHILD))).toBe(false);
		expect(childCtx.intervals.length).toBe(0);
		let childRefusal = "";
		try {
			await child.tools.mail_send.execute("t1", { to: A, body: "from a child" }, undefined, undefined, childCtx);
		} catch (error) {
			childRefusal = (error as Error).message;
		}
		await child.command?.handler(A + " from a child", childCtx);
		// a child cannot send mail
		expect(childRefusal.includes("subagent")).toBe(true);
		expect(notices.at(-1)?.startsWith(CHILD + " error:")).toBe(true);
		expect(listOf(A, "new").length).toBe(0);
	});

	it("8. the watcher delivers with no rescan", async () => {
		const watched = header({}).text + "seen by fs.watch";
		const beforeWatch = sent.length;
		drop(A, "005-watched.md", watched);
		// Real fs.watch timing: this exercises the extension's actual watcher, not a fake clock.
		for (let waited = 0; waited < 3000 && sent.length === beforeWatch; waited += 50) {
			await Bun.sleep(50);
		}
		// fs.watch delivers without a rescan
		expect(sent.length).toBe(beforeWatch + 1);
		expect(sent.at(-1)?.message.content.endsWith("seen by fs.watch")).toBe(true);
	});

	let b: FakePi & ExtensionAPI;
	let bCtx: FakeCtx & ExtensionContext;
	let d: FakePi & ExtensionAPI;
	let dCtx: FakeCtx & ExtensionContext;

	it("9. send: a unique prefix resolves, an ambiguous or a dead one is an error, and never a guess", async () => {
		b = makePi();
		bCtx = makeCtx(b, B, null);
		await fire(b, "session_start", bCtx);
		d = makePi();
		dCtx = makeCtx(d, D, null);
		await fire(d, "session_start", dCtx);
		for (const sub of ["", "tmp", "new", "delivered", "rejected"]) {
			mkdirSync(join(ROOT, DEAD, sub), { recursive: true, mode: 0o700 });
		}
		writeFileSync(
			join(ROOT, DEAD, ".presence.json"),
			JSON.stringify({ sessionId: DEAD, pid: 2147483646, cwd: "/work/gone", name: "gone" }),
			{ mode: 0o600 },
		);

		const unique = await attempt(b, bCtx, { to: "01990000-AAAA", body: "prefix mail" });
		const landed = listOf(A, "new");
		const landedPath = join(ROOT, A, "new", landed[0] || "missing");
		const landedHeader = landed.length === 1 ? parseHeader(landedPath) : {};
		// a unique case-insensitive prefix resolves
		expect(unique.error).toBeUndefined();
		expect(landed.length).toBe(1);
		expect(landedHeader.from).toBe(B);
		expect(landedHeader.to).toBe(A);
		expect(landedHeader.hop).toBe("0");
		expect(landedHeader["in-reply-to"]).toBe("");
		expect(landedHeader.sentAt).toBeTruthy();
		// a sent file is 0600 in new/ and nothing is left in tmp/
		expect(modeOf(landedPath)).toBe(0o600);
		expect(listOf(A, "tmp").length).toBe(0);

		const ambiguous = await attempt(a, aCtx, { to: "01990000-bbbb", body: "which one" });
		// an ambiguous prefix is an error that lists both
		expect(ambiguous.error?.includes(B)).toBe(true);
		expect(ambiguous.error?.includes(D)).toBe(true);
		expect(ambiguous.error?.includes("/work/")).toBe(true);
		const dead = await attempt(a, aCtx, { to: "01990000-cccc", body: "anyone there" });
		// a dead session is an error that names it
		expect(dead.error?.includes(DEAD)).toBe(true);
		expect(dead.error?.includes("no running session")).toBe(true);
		expect(listOf(DEAD, "new").length).toBe(0);
		const self = await attempt(a, aCtx, { to: "01990000-aaaa", body: "me" });
		// a session cannot mail itself
		expect(self.error?.includes("itself")).toBe(true);

		// The file must pass through tmp/: a watcher on D's tmp/ sees the name the mail lands under.
		const staged: string[] = [];
		const tmpWatcher = watch(join(ROOT, D, "tmp"), (_type, name) => {
			if (name) {
				staged.push(String(name));
			}
		});
		const beforeStage = sent.length;
		const toD = await attempt(a, aCtx, { to: D, body: "staged" });
		for (let waited = 0; waited < 3000 && sent.length === beforeStage; waited += 50) {
			await Bun.sleep(50);
		}
		tmpWatcher.close();
		const dDelivered = listOf(D, "delivered");
		// a send stages in tmp/ before new/
		expect(toD.error).toBeUndefined();
		expect(dDelivered.length).toBe(1);
		expect(staged.includes(dDelivered[0])).toBe(true);
		expect(listOf(D, "tmp").length).toBe(0);
	});

	it("10. a reply carries in-reply-to and hop parent + 1, and hop 4 is refused at the sender", async () => {
		// A watcher can deliver before a rescan does, so each mail is found by its body.
		function detailsOf(body: string): MailDetails {
			const row = sent.findLast(entry => entry.message.content.endsWith("] " + body));
			return (row?.message.details ?? {}) as unknown as MailDetails;
		}
		aCtx.intervals[0]();
		const m1 = detailsOf("prefix mail");
		const reply1 = await attempt(a, aCtx, { to: B, body: "reply one", inReplyTo: m1.id });
		bCtx.intervals[0]();
		const m2 = detailsOf("reply one");
		// a reply's hop is parent + 1
		expect(reply1.error).toBeUndefined();
		expect(m1.hop).toBe(0);
		expect(m2.hop).toBe(1);
		expect(m2.inReplyTo).toBe(m1.id);
		expect(m2.from).toBe(A);
		await attempt(b, bCtx, { to: A, body: "reply two", inReplyTo: m2.id });
		aCtx.intervals[0]();
		const m3 = detailsOf("reply two");
		await attempt(a, aCtx, { to: B, body: "reply three", inReplyTo: m3.id });
		bCtx.intervals[0]();
		const m4 = detailsOf("reply three");
		const reply4 = await attempt(b, bCtx, { to: A, body: "reply four", inReplyTo: m4.id });
		// the chain reaches hop 3 and a fourth reply is refused
		expect(m2.hop).toBe(1);
		expect(m3.hop).toBe(2);
		expect(m4.hop).toBe(3);
		expect(reply4.error?.includes("hop 4")).toBe(true);
		expect(listOf(A, "new").length).toBe(0);
		const orphan = await attempt(a, aCtx, { to: B, body: "to nothing", inReplyTo: randomUUID() });
		// a reply to an unknown id is refused
		expect(orphan.error?.includes("nothing to reply to")).toBe(true);
	});

	it("11. /new re-keys the mailbox, and shutdown removes the presence but keeps the mail", async () => {
		const presencePath = join(ROOT, A, ".presence.json");
		aCtx.sessionId = A2;
		await fire(a, "session_switch", aCtx, { reason: "new" });
		const a2Presence = JSON.parse(readFileSync(join(ROOT, A2, ".presence.json"), "utf8"));
		// a session switch moves the presence to the new id
		expect(existsSync(presencePath)).toBe(false);
		expect(a2Presence.sessionId).toBe(A2);
		expect(existsSync(join(ROOT, A, "delivered", "001-good.md"))).toBe(true);
		const toOld = await attempt(b, bCtx, { to: A, body: "old id" });
		// the old id no longer takes mail
		expect(toOld.error?.includes("no running session")).toBe(true);
		await fire(a, "session_shutdown", aCtx);
		// shutdown removes the presence and keeps the mail dirs
		expect(existsSync(join(ROOT, A2, ".presence.json"))).toBe(false);
		expect(existsSync(join(ROOT, A2, "new"))).toBe(true);
		expect(existsSync(join(ROOT, A2, "delivered"))).toBe(true);
	});

	it("12. sendUserMessage is never used, and no delivery ever steers", () => {
		expect(userMessages.length).toBe(0);
		expect(sent.every(row => row.outcome === "turn" || row.outcome === "followUp")).toBe(true);
	});

	it("13. CCW_MAILBOX=off registers nothing at all", () => {
		process.env.CCW_MAILBOX = "off";
		const off = makePi();
		delete process.env.CCW_MAILBOX;
		expect(off.handlers.size).toBe(0);
		expect(Object.keys(off.tools).length).toBe(0);
		expect(off.command).toBeNull();
	});

	afterAll(async () => {
		await fire(b, "session_shutdown", bCtx);
		await fire(d, "session_shutdown", dCtx);
	});
});
