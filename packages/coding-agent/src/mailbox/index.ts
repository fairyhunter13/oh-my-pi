// createMailboxExtension: /mail and mail_send, cross-session mail on this machine.
//
// Ported from ccw's ccw-mailbox.js (claude-code-workflows, internal/policy/ompjs). The
// mechanism lives here now; ccw no longer generates or embeds it. Every refusal, header field
// and directory name below stays byte for byte, because a stored session or a peer's mailbox
// reads them.
//
// CCW_MAILBOX=off turns the whole extension off.
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fchmodSync,
	type FSWatcher,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	renameSync,
	rmSync,
	type Stats,
	watch,
	writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import type { ExtensionContext, ExtensionFactory } from "../extensibility/extensions";

// Read per call, so PI_CODING_AGENT_DIR or setAgentDir after import still moves it.
const mailboxRoot = (): string => join(getAgentDir(), "mailbox");
const PRESENCE = ".presence.json";
const MAIL_TYPE = "ccw-mail";
const AUDIT_TYPE = "ccw-mailbox";
const MAX_BYTES = 64 * 1024;
// Every delivery starts a turn on the receiver's model, so a reply chain and a chatty sender
// are both bounded.
const MAX_HOP = 3;
const SENDER_LIMIT = 10;
const WINDOW_MS = 60 * 60 * 1000;
// fs.watch can miss an event, so a rescan backs it up.
const RESCAN_MS = 30 * 1000;
const SUBDIRS = ["tmp", "new", "delivered", "rejected"];
const HEADER_FIELDS = ["from", "to", "id", "in-reply-to", "hop", "sentAt"];
// A session id names a directory, so a header value that could climb out of the mailbox root is refused.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Optional on this fork's own process type (`getuid?(): number`) and absent on Windows. Every
// check below is a POSIX ownership/mode check, so a missing getuid degrades to "never this uid"
// rather than throwing. Read at 3 call sites: privateDirProblem, readPresence and inspect.
const getuid = (): number => (typeof process.getuid === "function" ? process.getuid() : -1);

interface Presence {
	sessionId: string;
	pid: number;
	cwd: string;
	name: string;
	startedAt?: string;
}

interface SessionRow {
	id: string;
	live: boolean;
	cwd: string;
	name: string;
}

interface Mail {
	from: string;
	to: string;
	id: string;
	inReplyTo: string;
	hop: number;
	sentAt: string;
	body: string;
}

interface AuditRow {
	id: string;
	from: string;
	inReplyTo: string;
	hop: number;
	at: number;
}

interface SentMail {
	id: string;
	to: SessionRow;
	hop: number;
}

interface MailSendParams {
	to: string;
	body: string;
	inReplyTo?: string;
}

type Verdict = { problem: string; mail?: undefined } | { problem?: undefined; mail: Mail };
type Recipient = { problem: string; row?: undefined } | { problem?: undefined; row: SessionRow };

// Another user who can write a mailbox directory can plant anything in it, so the reader
// trusts a directory only when it is this uid's and mode 0700.
function privateDirProblem(path: string): string {
	let stat: Stats;
	try {
		stat = lstatSync(path);
	} catch (error) {
		return path + " is unreadable (" + (error as NodeJS.ErrnoException).code + ")";
	}
	if (!stat.isDirectory()) {
		return path + " is not a directory";
	}
	if (stat.uid !== getuid()) {
		return path + " is owned by uid " + stat.uid;
	}
	if ((stat.mode & 0o777) !== 0o700) {
		return path + " has mode " + (stat.mode & 0o777).toString(8) + ", not 700";
	}
	return "";
}

function ensureMailbox(dir: string): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const sub of SUBDIRS) {
		mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
	}
}

// One byte past the cap is read, so a file that grew after its lstat is still caught.
function readCapped(fd: number): string | null {
	const buffer = Buffer.alloc(MAX_BYTES + 1);
	let length = 0;
	while (length < buffer.length) {
		const count = readSync(fd, buffer, length, buffer.length - length, null);
		if (count === 0) {
			break;
		}
		length += count;
	}
	return length > MAX_BYTES ? null : buffer.toString("utf8", 0, length);
}

// Stage in tmp/ and rename, so a reader of the target never sees a partial file.
function writeAtomic(tmpDir: string, name: string, target: string, body: string): void {
	const staged = join(tmpDir, name);
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
	const fd = openSync(staged, flags, 0o600);
	try {
		fchmodSync(fd, 0o600);
		writeSync(fd, body);
	} catch (error) {
		closeSync(fd);
		rmSync(staged, { force: true });
		throw error;
	}
	closeSync(fd);
	renameSync(staged, target);
}

function readPresence(sessionDir: string): Presence | null {
	const path = join(sessionDir, PRESENCE);
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== getuid()) {
			return null;
		}
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			// Own presence file, written only by writePresence below: not external input.
			return JSON.parse(readCapped(fd) || "null") as Presence | null;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) {
		return false;
	}
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// Every mailbox directory, live or not. Live means a presence whose pid runs and whose
// sessionId is the directory's own name.
function listSessions(): SessionRow[] {
	let names: string[];
	try {
		names = readdirSync(mailboxRoot());
	} catch {
		return [];
	}
	const rows: SessionRow[] = [];
	for (const name of names.sort()) {
		if (!SAFE_ID.test(name)) {
			continue;
		}
		const presence = readPresence(join(mailboxRoot(), name));
		rows.push({
			id: name,
			live: Boolean(presence) && presence?.sessionId === name && isAlive(presence?.pid ?? -1),
			cwd: (presence && presence.cwd) || "unknown cwd",
			name: (presence && presence.name) || "no name",
		});
	}
	return rows;
}

function describeSession(row: SessionRow): string {
	const state = row.live ? "" : ", not running";
	return row.id + " (" + row.name + ", " + row.cwd + state + ")";
}

// A prefix must name exactly one live session. The first match is never picked, because a
// guess sends one session's mail to another.
function resolveRecipient(prefix: string, selfId: string): Recipient {
	const wanted = String(prefix || "")
		.trim()
		.toLowerCase();
	if (!wanted) {
		return { problem: "name the recipient: a session id or a unique prefix of one (see /mail list)" };
	}
	const rows = listSessions();
	const matches = rows.filter(row => row.id.toLowerCase().startsWith(wanted));
	const live = matches.filter(row => row.live);
	if (live.length === 1) {
		return live[0].id === selfId ? { problem: "a session cannot mail itself" } : { row: live[0] };
	}
	if (live.length > 1) {
		return {
			problem:
				'"' +
				prefix +
				'" matches ' +
				live.length +
				" live sessions: " +
				live.map(describeSession).join("; ") +
				". Use a longer prefix.",
		};
	}
	if (matches.length > 0) {
		return {
			problem: '"' + prefix + '" matches no running session, only: ' + matches.map(describeSession).join("; "),
		};
	}
	const running = rows.filter(row => row.live);
	return {
		problem:
			'"' +
			prefix +
			'" matches no session. Running: ' +
			(running.length > 0 ? running.map(describeSession).join("; ") : "none"),
	};
}

function parseMail(text: string): Verdict {
	if (!text.startsWith("---\n")) {
		return { problem: "no frontmatter header" };
	}
	const end = text.indexOf("\n---\n", 3);
	if (end < 0) {
		return { problem: "the frontmatter header is not closed" };
	}
	const header: Record<string, string> = {};
	for (const line of text.slice(4, end).split("\n")) {
		const colon = line.indexOf(":");
		if (colon > 0) {
			header[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
		}
	}
	for (const field of HEADER_FIELDS) {
		if (!(field in header)) {
			return { problem: "the header has no " + field };
		}
	}
	for (const field of ["from", "to", "id"]) {
		if (!SAFE_ID.test(header[field])) {
			return { problem: "the header " + field + " is not a session-safe id" };
		}
	}
	if (header["in-reply-to"] !== "" && !SAFE_ID.test(header["in-reply-to"])) {
		return { problem: "the header in-reply-to is not a session-safe id" };
	}
	if (!/^[0-9]+$/.test(header.hop)) {
		return { problem: "the header hop is not an integer" };
	}
	if (header.sentAt === "") {
		return { problem: "the header sentAt is empty" };
	}
	return {
		mail: {
			from: header.from,
			to: header.to,
			id: header.id,
			inReplyTo: header["in-reply-to"],
			hop: Number(header.hop),
			sentAt: header.sentAt,
			body: text.slice(end + 5),
		},
	};
}

// The accept checks, in order. The content comes from the opened fd and never from a second
// lookup of the path, and O_NONBLOCK keeps a FIFO swapped in after the lstat from hanging.
function inspect(path: string, selfId: string): Verdict {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		return { problem: "it is a symlink" };
	}
	if (!stat.isFile()) {
		return { problem: "it is not a regular file" };
	}
	if (stat.uid !== getuid()) {
		return { problem: "it is owned by uid " + stat.uid };
	}
	if ((stat.mode & 0o777) !== 0o600) {
		return { problem: "its mode is " + (stat.mode & 0o777).toString(8) + ", not 600" };
	}
	if (stat.size > MAX_BYTES) {
		return { problem: "it is " + stat.size + " bytes, over the " + MAX_BYTES + "-byte cap" };
	}
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	} catch (error) {
		return { problem: "it could not be opened (" + (error as NodeJS.ErrnoException).code + ")" };
	}
	let text: string | null;
	try {
		const opened = fstatSync(fd);
		if (opened.ino !== stat.ino || opened.dev !== stat.dev) {
			return { problem: "it was replaced between the lstat and the open" };
		}
		text = readCapped(fd);
	} finally {
		closeSync(fd);
	}
	if (text === null) {
		return { problem: "it grew over the " + MAX_BYTES + "-byte cap" };
	}
	const parsed = parseMail(text);
	if (parsed.problem !== undefined) {
		return parsed;
	}
	if (parsed.mail.to !== selfId) {
		return { problem: "it is addressed to " + parsed.mail.to + ", not to this session" };
	}
	if (parsed.mail.hop > MAX_HOP) {
		return { problem: "hop " + parsed.mail.hop + " is over the limit of " + MAX_HOP };
	}
	return parsed;
}

interface MailboxHandle {
	id: string;
	dir: string;
	ctx: ExtensionContext;
	name: string;
	startedAt: string;
	watcher: FSWatcher | null;
	dirWarned: boolean;
}

export const createMailboxExtension: ExtensionFactory = pi => {
	if (process.env.CCW_MAILBOX === "off") {
		return;
	}

	// Only a subagent session carries a session_init entry (task/executor.ts:3966), appended
	// before its session_start (:4056). The same logic as ccw-agent-profile: a miss is never cached.
	let myAgent: string | undefined;
	const isChild = (ctx: ExtensionContext): boolean => {
		if (myAgent) {
			return true;
		}
		try {
			const entries = ctx.sessionManager.getEntries() || [];
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry && entry.type === "session_init") {
					myAgent = entry.agent || "";
					return myAgent !== "";
				}
			}
		} catch {}
		return false;
	};

	// The open mailbox: the session id it is keyed by, its directory, its watcher and the ctx
	// the watcher and the timer act through. null in a child, in a one-shot run and after
	// shutdown.
	let box: MailboxHandle | null = null;
	let timer: Timer | null = null;
	// sender id -> when its last hold was reported, so a held sender costs one notice an hour.
	const heldNotices = new Map<string, number>();

	function warn(ctx: ExtensionContext, message: string): void {
		if (!ctx.hasUI) {
			return;
		}
		ctx.ui.notify("ccw-mailbox: " + message, "warning");
	}

	function auditOf(ctx: ExtensionContext): AuditRow[] {
		const rows: AuditRow[] = [];
		for (const entry of ctx.sessionManager.getEntries() || []) {
			if (entry.type === "custom" && entry.customType === AUDIT_TYPE && entry.data) {
				// Own appendEntry payload below, keyed by AUDIT_TYPE: not external input.
				rows.push(entry.data as AuditRow);
			}
		}
		return rows;
	}

	function writePresence(ctx: ExtensionContext, name: string): void {
		if (!box) {
			return;
		}
		const presence: Presence = {
			sessionId: box.id,
			pid: process.pid,
			cwd: ctx.cwd,
			name,
			startedAt: box.startedAt,
		};
		const staged = PRESENCE + "." + process.pid;
		rmSync(join(box.dir, "tmp", staged), { force: true });
		writeAtomic(join(box.dir, "tmp"), staged, join(box.dir, PRESENCE), JSON.stringify(presence) + "\n");
		box.name = name;
	}

	function open(ctx: ExtensionContext): void {
		const id = String(ctx.sessionManager.getSessionId() || "");
		if (!SAFE_ID.test(id)) {
			warn(ctx, "the session id " + JSON.stringify(id) + " cannot name a mailbox, so mail is off");
			return;
		}
		const dir = join(mailboxRoot(), id);
		ensureMailbox(dir);
		const current: MailboxHandle = {
			id,
			dir,
			ctx,
			name: "",
			startedAt: new Date().toISOString(),
			watcher: null,
			dirWarned: false,
		};
		box = current;
		writePresence(ctx, ctx.sessionManager.getSessionName() || basename(ctx.cwd));
		try {
			current.watcher = watch(join(dir, "new"), { persistent: false }, () => {
				if (box === current) {
					scan();
				}
			});
			current.watcher.on("error", () => {
				current.watcher?.close();
				current.watcher = null;
			});
		} catch (error) {
			warn(ctx, "fs.watch failed (" + String(error) + "), so mail arrives on the 30 s rescan only");
		}
		scan();
	}

	function close(): void {
		if (!box) {
			return;
		}
		if (box.watcher) {
			box.watcher.close();
		}
		rmSync(join(box.dir, PRESENCE), { force: true });
		box = null;
	}

	function deliver(mail: Mail): void {
		const presence = readPresence(join(mailboxRoot(), mail.from));
		const cwd = presence && presence.sessionId === mail.from && presence.cwd ? presence.cwd : "unknown cwd";
		pi.sendMessage(
			{
				customType: MAIL_TYPE,
				content: "[mail from " + mail.from + " " + cwd + ", id " + mail.id + "] " + mail.body,
				display: true,
				attribution: "agent",
				details: { id: mail.id, from: mail.from, inReplyTo: mail.inReplyTo, hop: mail.hop },
			},
			// Queued behind a running turn, and one new turn at idle. Never steer: a steer
			// skips the rest of the running tool batch (pi-agent-core agent.ts:1111-1117).
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function take(name: string, audit: AuditRow[], seen: Set<string>): void {
		if (!box) {
			return;
		}
		const { ctx, dir } = box;
		const path = join(dir, "new", name);
		const verdict = inspect(path, box.id);
		if (verdict.problem !== undefined) {
			renameSync(path, join(dir, "rejected", name));
			warn(ctx, "rejected " + name + ", now in " + join(dir, "rejected") + ": " + verdict.problem);
			return;
		}
		const mail = verdict.mail;
		if (seen.has(mail.id)) {
			renameSync(path, join(dir, "delivered", name));
			return;
		}
		const now = Date.now();
		const recent = audit.filter(row => row.from === mail.from && row.at > now - WINDOW_MS).length;
		if (recent >= SENDER_LIMIT) {
			if (now - (heldNotices.get(mail.from) || 0) >= WINDOW_MS) {
				heldNotices.set(mail.from, now);
				warn(
					ctx,
					"held mail from " +
						mail.from +
						" in " +
						join(dir, "new") +
						": " +
						recent +
						" were delivered in the last hour, and the limit is " +
						SENDER_LIMIT,
				);
			}
			return;
		}
		deliver(mail);
		const row: AuditRow = { id: mail.id, from: mail.from, inReplyTo: mail.inReplyTo, hop: mail.hop, at: now };
		pi.appendEntry(AUDIT_TYPE, row);
		audit.push(row);
		seen.add(mail.id);
		// Moved only after the send, so a crash before this line leaves the file in new/, and
		// the audit entry makes the next scan file it without a second delivery.
		renameSync(path, join(dir, "delivered", name));
	}

	function scan(): void {
		if (!box) {
			return;
		}
		const { ctx, dir } = box;
		try {
			const problem = privateDirProblem(dir) || privateDirProblem(join(dir, "new"));
			if (problem) {
				if (!box.dirWarned) {
					warn(ctx, problem + ", so no mail is read until it is this user's and mode 700");
				}
				box.dirWarned = true;
				return;
			}
			box.dirWarned = false;
			// The title arrives after the first turn, so a later scan carries it into the presence.
			const name = ctx.sessionManager.getSessionName() || basename(ctx.cwd);
			if (name !== box.name) {
				writePresence(ctx, name);
			}
			const audit = auditOf(ctx);
			const seen = new Set(audit.map(row => row.id));
			for (const file of readdirSync(join(dir, "new")).sort()) {
				try {
					take(file, audit, seen);
				} catch (error) {
					warn(ctx, "could not file " + join(dir, "new", file) + ": " + String(error));
				}
			}
		} catch (error) {
			warn(ctx, "the mailbox scan failed: " + String(error));
		}
	}

	function send(ctx: ExtensionContext, to: string, body: string, inReplyTo: string | undefined): SentMail {
		if (isChild(ctx)) {
			throw new Error("a subagent cannot send mail; only a top-level session can");
		}
		if (!box) {
			throw new Error("this session has no mailbox");
		}
		const text = String(body || "");
		if (text.trim() === "") {
			throw new Error("the mail has no body");
		}
		const target = resolveRecipient(to, box.id);
		if (target.problem !== undefined) {
			throw new Error(target.problem);
		}
		const parent = String(inReplyTo || "").trim();
		let hop = 0;
		if (parent !== "") {
			const row = auditOf(ctx).find(entry => entry.id === parent);
			if (!row) {
				throw new Error(
					"no mail with id " + parent + " was delivered to this session, so there is nothing to reply to",
				);
			}
			hop = Number(row.hop) + 1;
			if (hop > MAX_HOP) {
				throw new Error(
					"this reply would be hop " + hop + ", over the limit of " + MAX_HOP + ", so the chain ends here",
				);
			}
		}
		const id = randomUUID();
		const mail =
			"---\nfrom: " +
			box.id +
			"\nto: " +
			target.row.id +
			"\nid: " +
			id +
			"\nin-reply-to: " +
			parent +
			"\nhop: " +
			hop +
			"\nsentAt: " +
			new Date().toISOString() +
			"\n---\n" +
			text;
		if (Buffer.byteLength(mail) > MAX_BYTES) {
			throw new Error("the mail is over the " + MAX_BYTES + "-byte cap");
		}
		const recipient = join(mailboxRoot(), target.row.id);
		const problem =
			privateDirProblem(recipient) ||
			privateDirProblem(join(recipient, "tmp")) ||
			privateDirProblem(join(recipient, "new"));
		if (problem) {
			throw new Error(problem);
		}
		const name = Date.now() + "-" + id + ".md";
		writeAtomic(join(recipient, "tmp"), name, join(recipient, "new", name), mail);
		return { id, to: target.row, hop };
	}

	const z = pi.zod;
	pi.registerTool({
		name: "mail_send",
		label: "Mail",
		description:
			"Send mail to another top-level omp session on this machine. to is its session id or a unique prefix of it. " +
			"To answer a [mail from ..., id X] message, pass X as inReplyTo. Each mail starts a turn in the recipient, " +
			"so send only what it needs.",
		parameters: z.object({
			to: z.string().describe("The recipient session id, or a unique prefix of it"),
			body: z.string().describe("The message text"),
			inReplyTo: z.string().optional().describe("The id of the mail this answers"),
		}),
		approval: "write",
		async execute(
			_toolCallId: string,
			params: MailSendParams,
			_signal: unknown,
			_onUpdate: unknown,
			ctx: ExtensionContext,
		) {
			const sent = send(ctx, params.to, params.body, params.inReplyTo);
			return {
				content: [
					{
						type: "text",
						text: "Sent mail " + sent.id + " to " + describeSession(sent.to) + ", hop " + sent.hop + ".",
					},
				],
				details: { id: sent.id, to: sent.to.id, hop: sent.hop },
			};
		},
	});

	pi.registerCommand("mail", {
		description: "Mail another top-level session: /mail <to> <text>, /mail list, /mail inbox",
		handler: async (args, ctx) => {
			try {
				if (isChild(ctx)) {
					ctx.ui.notify("/mail works in a top-level session only.", "error");
					return;
				}
				const text = String(args || "").trim();
				if (text === "list") {
					const live = listSessions().filter(row => row.live);
					const lines = live.map(
						row => describeSession(row) + (box && row.id === box.id ? " <- this session" : ""),
					);
					ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No running session has a mailbox.", "info");
					return;
				}
				if (text === "inbox") {
					if (!box) {
						ctx.ui.notify("This session has no mailbox.", "error");
						return;
					}
					const held = readdirSync(join(box.dir, "new")).sort();
					const recent = auditOf(ctx).slice(-10);
					const lines = ["Held in " + join(box.dir, "new") + ": " + (held.length > 0 ? held.join(", ") : "none")];
					lines.push("Last " + recent.length + " delivered:");
					for (const row of recent) {
						lines.push(new Date(row.at).toISOString() + " " + row.id + " from " + row.from + ", hop " + row.hop);
					}
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
				const space = text.search(/\s/);
				if (space < 0) {
					ctx.ui.notify("Usage: /mail <session id or unique prefix> <text> | /mail list | /mail inbox", "error");
					return;
				}
				const sent = send(ctx, text.slice(0, space), text.slice(space + 1).trim(), "");
				ctx.ui.notify("Sent mail " + sent.id + " to " + describeSession(sent.to) + ".", "info");
			} catch (error) {
				ctx.ui.notify("/mail failed: " + (error instanceof Error ? error.message : String(error)), "error");
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		try {
			// A one-shot run has no one to answer mail, and a delivery would start a turn in it.
			if (isChild(ctx) || ctx.mode === "print" || ctx.mode === "json") {
				return;
			}
			open(ctx);
			if (box && timer === null) {
				timer = ctx.setInterval(() => scan(), RESCAN_MS);
			}
		} catch (error) {
			warn(ctx, "startup failed: " + String(error));
		}
	});

	// /new, /resume and /fork change the session id under the same process, and so does a branch.
	const rekey = (_event: unknown, ctx: ExtensionContext): void => {
		try {
			if (!box || box.id === ctx.sessionManager.getSessionId()) {
				return;
			}
			close();
			open(ctx);
		} catch (error) {
			warn(ctx, "could not move the mailbox to the new session: " + String(error));
		}
	};
	pi.on("session_switch", rekey);
	pi.on("session_branch", rekey);

	pi.on("session_shutdown", (_event, ctx) => {
		close();
		if (timer !== null) {
			ctx.clearTimer(timer);
			timer = null;
		}
	});
};
