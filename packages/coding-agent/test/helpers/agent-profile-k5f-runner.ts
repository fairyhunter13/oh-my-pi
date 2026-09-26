// Run as a child `bun` process with a fixed HOME env var: REAL_HOME (agent-profile/index.ts) is
// realpathSync(homedir()), and Bun's os.homedir() reads HOME only at process start, so a
// same-process env mutation never takes effect. This is the only way to exercise the exclusion
// of $HOME's own .claude/agents from every repoScope walk.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createAgentProfileExtension } from "../../src/agent-profile";
import { makeAuthStorage, makeCtx, makePi } from "./agent-profile-harness";
import { Settings } from "../../src/config/settings";
import "../../src/config/all-settings";

const home = process.env.HOME as string;
const agentDir = process.env.PI_CODING_AGENT_DIR as string;
const nestedRepo = join(home, "nested-repo");

await Settings.init({ inMemory: true, agentDir });

const auth = makeAuthStorage();
const row = auth.credentials.find(candidate => candidate.id === 2);
if (row) (row as { label: string | null }).label = "personal";
const notices: string[] = [];
const pi = makePi(createAgentProfileExtension);
const nestedCtx = makeCtx("nested", null, auth, notices, { cwd: join(nestedRepo, "src") });

await (pi.command as { handler: (args: string, ctx: typeof nestedCtx) => Promise<void> }).handler("tiered", nestedCtx);
await (pi.command as { handler: (args: string, ctx: typeof nestedCtx) => Promise<void> }).handler(
	"set scout account=personal scope=repo",
	nestedCtx,
);
const setReport = pi.reports.at(-1) as string;
const spawnResult = await (
	pi.handlers.get("before_subagent_spawn") as (event: unknown, ctx: typeof nestedCtx) => unknown
)({ type: "before_subagent_spawn", agent: "scout", invocationKind: "task", patterns: [] }, nestedCtx);
const gitignore = readFileSync(join(nestedRepo, ".gitignore"), "utf8");

console.log(JSON.stringify({ setReport, spawnResult, gitignore, notices }));
