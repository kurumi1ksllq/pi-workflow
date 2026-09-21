// 自更新链路的离线全链路验证 —— 不用网络、不用启动 pi、不碰本机 ~/.pi/agent
//
// 跑法：node scripts/test-self-update.mjs
//
// 做法：造一个本地 bare 仓库当「远端」，按 pi 的目录约定（<agent dir>/git/<host>/<org>/<repo>）
// 手搓出 clone 布局，然后**直接 import clone 里的那个扩展文件** —— 就是成员机器上真实跑的那条路径 ——
// 看它有没有把 clone 切到新 tag、有没有把 settings 里的 ref 一起改掉。
//
// 覆盖：
//   1. 落后一个新 tag → fetch + reset --hard 到新 tag，settings 里的 ref 跟着改成新 tag
//   2. 幂等：已经是最新 tag 时什么都不动
//   3. clone 里有未提交的跟踪文件改动 → 不动手（不拿别人的活儿换版本）
//   4. 开发副本（packageRoot 不在 <agent dir>/git/ 下）→ 完全不碰，连状态文件都不写
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SB = path.join(os.tmpdir(), "pi-workflow-selfupdate-test");
const AGENT = path.join(SB, "agent");
const PROJ = path.join(SB, "proj");
const WORK = path.join(SB, "work");
const BARE = path.join(SB, "origin", "pi-workflow.git");
const CLONE = path.join(AGENT, "git", "github.com", "kurumi1ksllq", "pi-workflow");
const settingsFile = path.join(AGENT, "settings.json");
const stateFile = path.join(AGENT, "extensions", "team-baseline", "update-state.json");
const lockFile = path.join(AGENT, "extensions", "team-baseline", ".update.lock");

const problems = [];
const check = (ok, message) => {
	if (!ok) problems.push(message);
};
const git = (args, cwd) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf-8",
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	}).trim();
const commit = (message, cwd) =>
	git(["-c", "user.name=selftest", "-c", "user.email=selftest@example.com", "commit", "-q", "-m", message], cwd);
const stateOf = () => JSON.parse(fs.readFileSync(stateFile, "utf-8"));
const settingsPackages = () => JSON.parse(fs.readFileSync(settingsFile, "utf-8")).packages;

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(AGENT, { recursive: true });

// 1) 「当前版本」= 工作区的样子（含未提交改动），打成 v9.0.0
fs.cpSync(repoRoot, WORK, {
	recursive: true,
	filter: (src) => !/[/\\](\.git|node_modules)([/\\]|$)/.test(src),
});
git(["init", "-q", "-b", "main"], WORK);
git(["add", "-A"], WORK);
commit("v9.0.0", WORK);
git(["tag", "v9.0.0"], WORK);

// 2) 本地 bare 仓库当远端
fs.mkdirSync(path.dirname(BARE), { recursive: true });
git(["init", "-q", "--bare", BARE], SB);
git(["remote", "add", "origin", BARE], WORK);
git(["push", "-q", "origin", "main", "--tags"], WORK);

// 3) 按 pi 的目录约定搓出 clone（成员机器上的真实布局）
fs.mkdirSync(path.dirname(CLONE), { recursive: true });
git(["clone", "-q", BARE, CLONE], SB);
git(["checkout", "-q", "v9.0.0"], CLONE);
fs.writeFileSync(
	settingsFile,
	JSON.stringify({ packages: ["git:github.com/kurumi1ksllq/pi-workflow@v9.0.0"] }, null, 2) + "\n",
	"utf-8",
);

// 4) 维护者发了新版：新 commit + 新 tag v9.0.1（clone 那边还不知道）
fs.appendFileSync(path.join(WORK, "CHANGELOG.md"), "\n## v9.0.1\n- 自更新链路验证用的假版本\n");
git(["add", "-A"], WORK);
commit("v9.0.1", WORK);
git(["tag", "v9.0.1"], WORK);
git(["push", "-q", "origin", "main", "--tags"], WORK);
const sha901 = git(["rev-parse", "v9.0.1^{commit}"], WORK);

// 5) 跑扩展（import clone 里的那个文件 = 成员机器上真实跑的代码）
process.env.PI_CODING_AGENT_DIR = AGENT;
process.env.PI_BASELINE_UPDATE_TTL_HOURS = "0"; // 每次启动都查，绕开 TTL
delete process.env.PI_BASELINE_SELF_UPDATE; // 明确打开
process.chdir(PROJ);
const extInClone = path.join(CLONE, "extensions", "team-baseline.ts");
const runExtension = async (extPath) => {
	const mod = await import(pathToFileURL(extPath).href + "?t=" + Date.now() + Math.random());
	mod.default({ on: () => {}, registerCommand: () => {}, registerTool: () => {} });
};

await runExtension(extInClone);

check(git(["rev-parse", "HEAD"], CLONE) === sha901, "场景 1：clone 没切到新 tag 的 commit");
// 注意：pi 升级 clone 时不建本地 tag（只 fetch + reset），所以 describe 会给出 v9.0.0-1-gXXXX
// 这种「基于旧 tag 的偏移」写法 —— 这是已知现象，版本标识以 settings 里钉的 ref 为准。
check(
	!git(["describe", "--tags", "--always"], CLONE).startsWith("v9.0.1"),
	"场景 1：clone 里不该凭空出现新 tag（pi 的 clone 只 fetch + reset，不建本地 tag —— 这条要是挂了说明行为变了）",
);
check(
	settingsPackages()[0] === "git:github.com/kurumi1ksllq/pi-workflow@v9.0.1",
	`场景 1：settings 里的 ref 没跟着改（现在是 ${settingsPackages()[0]}）—— 不改会被 pi update 拉回旧 tag`,
);
check(stateOf().state === "updated" && stateOf().tag === "v9.0.1", "场景 1：状态文件没记成 updated/v9.0.1");
check(!fs.existsSync(lockFile), "场景 1：更新完锁没清掉");

// 场景 2：幂等 —— 已经是最新 tag，什么都不该动
const before2 = fs.readFileSync(settingsFile, "utf-8");
await runExtension(extInClone);
check(stateOf().state === "current", `场景 2：已经最新时状态该是 current（现在是 ${stateOf().state}）`);
check(fs.readFileSync(settingsFile, "utf-8") === before2, "场景 2：已经最新时不该再改 settings");

// 场景 3：clone 里有未提交的跟踪文件改动 → 停手（不拿别人的活儿换版本）
fs.appendFileSync(path.join(CLONE, "README.md"), "\n本地手改的一行\n");
fs.appendFileSync(path.join(WORK, "CHANGELOG.md"), "\n## v9.0.2\n- 又一个假版本\n");
git(["add", "-A"], WORK);
commit("v9.0.2", WORK);
git(["tag", "v9.0.2"], WORK);
git(["push", "-q", "origin", "main", "--tags"], WORK);
const sha902 = git(["rev-parse", "v9.0.2^{commit}"], WORK);
fs.rmSync(stateFile, { force: true });
await runExtension(extInClone);
check(git(["rev-parse", "HEAD"], CLONE) === sha901, "场景 3：有未提交改动时不该动 clone（可能会丢东西）");
check(stateOf().state === "dirty", `场景 3：状态该是 dirty（现在是 ${stateOf().state}）`);
check(
	fs.readFileSync(path.join(CLONE, "README.md"), "utf-8").includes("本地手改"),
	"场景 3：手改的内容被 reset 掉了（不该动别人的活儿）",
);
git(["checkout", "-q", "--", "."], CLONE);

// 场景 4：开发副本（不在 <agent dir>/git/ 下）→ 连状态文件都不该写
fs.rmSync(stateFile, { force: true });
await runExtension(path.join(repoRoot, "extensions", "team-baseline.ts"));
check(!fs.existsSync(stateFile), "场景 4：开发副本不该走自更新（状态文件都不该出现）");

// 场景 5：源钉的是分支 → 不自动跟 tag（别拿最新 tag 覆盖有意的固定，比如"发版前先验 main"）
fs.writeFileSync(
	settingsFile,
	JSON.stringify({ packages: ["git:github.com/kurumi1ksllq/pi-workflow@main"] }, null, 2) + "\n",
	"utf-8",
);
fs.rmSync(stateFile, { force: true });
const headBefore5 = git(["rev-parse", "HEAD"], CLONE);
await runExtension(extInClone);
check(git(["rev-parse", "HEAD"], CLONE) === headBefore5, "场景 5：钉分支时不该动 clone");
check(!fs.existsSync(stateFile), "场景 5：钉分支时连状态文件都不该写（连查都不该查）");

console.log("clone HEAD：", git(["log", "--oneline", "-1"], CLONE));
console.log("settings：", JSON.stringify(settingsPackages()));
console.log(problems.length === 0 ? "\n全部通过 ✓" : "\n问题：\n- " + problems.join("\n- "));

if (process.env.PI_SELFUPDATE_KEEP === "1") {
	console.log("保留现场：", SB);
} else {
	process.chdir(repoRoot); // 别站在要被删的目录里（Windows 上会 EPERM）
	try {
		fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
	} catch (error) {
		console.log("清理失败（不影响结论，可手动删）：", SB, "-", error.message);
	}
}
process.exit(problems.length === 0 ? 0 : 1);
