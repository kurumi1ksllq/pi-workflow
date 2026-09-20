// 离线测扩展逻辑 —— 不用启动 pi、不用 provider、不碰本机 ~/.pi/agent
//
// 跑法：node scripts/test-extension.mjs
//
// 覆盖的四个场景（都是踩过坑才加的规则）：
//   1. 清单里钉版本的包，成员设置里是同一个包但不带版本 → 必须被替换成钉版本那条
//   2. 清单里有、设置里没有的包 → 追加
//   3. 别人的私有条目、无关设置项 → 一律不动；重复运行必须幂等
//   4. 版本标识：设置里钉的 ref 要赢过 clone 里的陈旧 tag
//      （pi 升级已有 clone 时只 fetch <ref>、不建本地 tag，describe 会给 v1.4.4-8-gXXXX 这种误导值）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(repoRoot, "extensions", "team-baseline.ts");
const AGENT = path.join(os.tmpdir(), "pi-workflow-ext-test", "agent");
const settingsFile = path.join(AGENT, "settings.json");

const pkgList = JSON.parse(fs.readFileSync(path.join(repoRoot, "team", "packages.json"), "utf-8")).packages;
const problems = [];
const check = (ok, message) => {
	if (!ok) problems.push(message);
};

const load = async () => {
	process.env.PI_CODING_AGENT_DIR = AGENT;
	const handlers = {};
	// 缓存破坏：同一路径 import 两次会拿到缓存，场景 4 需要重新求值
	const mod = await import(pathToFileURL(EXT).href + "?run=" + Date.now() + Math.random());
	mod.default({ on: (n, f) => (handlers[n] = f), registerCommand: () => {}, registerTool: () => {} });
	return handlers;
};

const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, "utf-8"));

fs.rmSync(path.dirname(AGENT), { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });

// —— 场景 1 / 2 / 3：清单同步 ——
// 起点：成员手里是旧的不带版本条目 + 一个私有包 + 无关设置项
fs.writeFileSync(
	settingsFile,
	JSON.stringify(
		{
			theme: "dark",
			packages: ["npm:pi-context-view", "npm:my-private-thing@1.0.0"],
		},
		null,
		2,
	),
	"utf-8",
);

const handlers = await load();
let after = readSettings();

for (const want of pkgList) {
	check(after.packages.includes(want), `清单里的 ${want} 没进设置`);
}
check(
	after.packages.some((p) => p.startsWith("npm:pi-context-view@")),
	"旧的不带版本条目没被替换成钉版本（场景 1）",
);
check(after.packages.includes("npm:my-private-thing@1.0.0"), "动了别人的私有条目（场景 3）");
check(after.theme === "dark", "动了无关设置项（场景 3）");

// 幂等：再跑一次不该改文件
const before2 = fs.readFileSync(settingsFile, "utf-8");
await load();
check(fs.readFileSync(settingsFile, "utf-8") === before2, "第二次运行不该再改文件（场景 3：幂等）");

// 注入：规范 + 版本号
const injected = await handlers.before_agent_start({ systemPrompt: "BASE" });
check(injected?.systemPrompt?.includes("团队基线规范"), "before_agent_start 没注入规范");
check(/pi-workflow v[\d.]+/.test(injected?.systemPrompt ?? ""), "注入段没有版本号");

// —— 场景 4：版本标识以设置里钉的 ref 为准 ——
const versioned = readSettings();
versioned.packages = [`git:github.com/kurumi1ksllq/pi-workflow@v9.9.9`, ...versioned.packages.slice(1)];
fs.writeFileSync(settingsFile, JSON.stringify(versioned, null, 2), "utf-8");
const handlers4 = await load();
const injected4 = await handlers4.before_agent_start({ systemPrompt: "BASE" });
check(
	injected4.systemPrompt.includes("pi-workflow v9.9.9"),
	"版本标识没优先用设置里钉的 ref（场景 4：clone 内 tag 陈旧时会报错版本）",
);

console.log("设置里的 packages：", JSON.stringify(after.packages));
console.log("注入段版本行：", injected4.systemPrompt.split("\n").find((l) => l.includes("pi-workflow")));
console.log(problems.length === 0 ? "\n全部通过 ✓" : "\n问题：\n- " + problems.join("\n- "));

fs.rmSync(path.dirname(AGENT), { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
