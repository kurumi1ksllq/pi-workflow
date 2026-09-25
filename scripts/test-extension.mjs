// 离线测扩展逻辑 —— 不用启动 pi、不用 provider、不碰本机 ~/.pi/agent
//
// 跑法：node scripts/test-extension.mjs
//
// 覆盖的场景（都是踩过坑才加的规则）：
//   1. 清单里钉版本的包，成员设置里是同一个包但不带版本 → 必须被替换成钉版本那条
//   2. 清单里有、设置里没有的包 → 追加
//   3. 别人的私有条目、无关设置项 → 一律不动；重复运行必须幂等
//   4. 版本标识：设置里钉的 ref 要赢过 clone 里的陈旧 tag
//      （pi 升级已有 clone 时只 fetch <ref>、不建本地 tag，describe 会给 v1.4.4-8-gXXXX 这种误导值）
//   5. 团队共享设置（team/agent-settings.json）只补缺：成员自己设过的键一个都不能被覆盖
//   6. 扩展自己的配置（team/extensions/*.json）只补不覆盖：成员调过的不许被重置
//   7. 模板里 `_` 开头的说明键不许写进设置
//   8. 自动更新挑版本：从 ls-remote 输出里挑最大的 vX.Y.Z（1.10.0 要赢过 1.9.9，预发布与分支不入选）
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 扩展顶层现在还会做「自动更新」（git ls-remote + fetch）。离线测里必须关掉，
// 否则这个测试会去动网络；真实自更新链路由 scripts/test-self-update.mjs 用本地 bare 仓库验。
process.env.PI_BASELINE_SELF_UPDATE = "off";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXT = path.join(repoRoot, "extensions", "team-baseline.ts");
const AGENT = path.join(os.tmpdir(), "pi-workflow-ext-test", "agent");
const settingsFile = path.join(AGENT, "settings.json");

const pkgList = JSON.parse(fs.readFileSync(path.join(repoRoot, "team", "packages.json"), "utf-8")).packages;
const sharedSettings = JSON.parse(fs.readFileSync(path.join(repoRoot, "team", "agent-settings.json"), "utf-8"));
const extCfgDir = path.join(repoRoot, "team", "extensions");
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
// 安全红线里「按命令行过滤杀进程」这条是防「agent 自己把 pi 杀掉」的唯一闸门，
// 内容被误删时这里必须红 —— 别改成只查标题。
check(
	injected?.systemPrompt?.includes("不要按进程名杀 node"),
	"注入段缺了「不要按进程名杀 node」这条红线",
);
// oracle 误用是全链路最贵的单项浪费（缓存读单价 166 倍），靠明文规矩拦，必须有断言护：
// 一次误编辑删掉这段，全团队会重新拿 oracle 当 reviewer 用，且没有任何别的信号。
// 断言串必须只属于这一段 —— 「oracle」「方案本身拿不准」在别处也出现，用它们做判据抓不住删除。
check(
	injected?.systemPrompt?.includes("一次 oracle 约等于"),
	"注入段缺了「oracle 只用于方案拿不准」这条纪律",
);

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

// —— 场景 5 / 6 / 7：共享设置只补缺 + 扩展配置只补不覆盖 ——
// 重开隔离目录：这次成员手里有"自己调过的"设置和扩展配置
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	settingsFile,
	JSON.stringify(
		{
			theme: "light",
			compaction: { enabled: false },
			subagents: { agentOverrides: { reviewer: { model: "my-own/reviewer-model" } } },
		},
		null,
		2,
	),
	"utf-8",
);
const rtkCfgPath = path.join(AGENT, "extensions", "pi-rtk-optimizer", "config.json");
fs.mkdirSync(path.dirname(rtkCfgPath), { recursive: true });
fs.writeFileSync(rtkCfgPath, JSON.stringify({ enabled: false }, null, 2), "utf-8");

await load();
const mine = readSettings();

check(mine.theme === "light", "动了无关设置项（场景 5）");
check(mine.compaction.enabled === false, "覆盖了成员关掉的 compaction（场景 5：只补缺）");
check(
	mine.compaction.reserveTokens === sharedSettings.compaction.reserveTokens &&
		mine.compaction.keepRecentTokens === sharedSettings.compaction.keepRecentTokens,
	"compaction 里缺的键没补上（场景 5）",
);
check(
	mine.subagents.agentOverrides.reviewer.model === "my-own/reviewer-model",
	"覆盖了成员自设的 reviewer 模型（场景 5：只补缺）",
);
check(
	mine.subagents.agentOverrides.oracle?.model === sharedSettings.subagents.agentOverrides.oracle.model,
	"缺的 agent override 没补上（场景 5：oracle）",
);
check(mine.subagents.disableThinking === sharedSettings.subagents.disableThinking, "subagents.disableThinking 没补上（场景 5）");
check(!Object.keys(mine).some((k) => k.startsWith("_")), "模板里的 `_` 说明键被写进了设置（场景 7）");
check(
	JSON.parse(fs.readFileSync(rtkCfgPath, "utf-8")).enabled === false,
	"覆盖了成员调过的扩展配置（场景 6：只补不覆盖）",
);

// 成员机器上还没有这个扩展的配置 → 从模板补一份，内容必须与模板逐字节一致
fs.rmSync(path.dirname(rtkCfgPath), { recursive: true, force: true });
await load();
check(
	fs.readFileSync(rtkCfgPath, "utf-8") === fs.readFileSync(path.join(extCfgDir, "pi-rtk-optimizer.json"), "utf-8"),
	"扩展配置没按模板补上（场景 6）",
);

// —— 场景 8：自动更新的纯函数（挑最新 tag）——
const mod8 = await import(pathToFileURL(EXT).href + "?pure=" + Date.now());
const { pickLatestTag, compareVersions } = mod8;
const lsRemote = [
	"1111111111111111111111111111111111111111	refs/tags/v1.7.0",
	"2222222222222222222222222222222222222222	refs/tags/v1.10.0",
	"3333333333333333333333333333333333333333	refs/tags/v1.9.9",
	"4444444444444444444444444444444444444444	refs/tags/v2.0.0-rc1",
	"5555555555555555555555555555555555555555	refs/heads/main",
	"6666666666666666666666666666666666666666	refs/tags/v1.8.0^{}",
	"",
].join("\n");
const latest = pickLatestTag(lsRemote);
check(
	latest?.tag === "v1.10.0",
	`挑最新 tag 挑错了：${latest?.tag}（v1.10.0 该赢过 v1.9.9；预发布、分支、剥离行都不该入选）`,
);
check(latest?.sha === "2222222222222222222222222222222222222222", "最新 tag 对应的 sha 不对（场景 8）");
check(compareVersions("v1.10.0", "v1.9.9") > 0, "compareVersions 把 1.10.0 排到了 1.9.9 后面（场景 8：字符串比较的老毛病）");
check(compareVersions("v1.8.0", "v1.8.0") === 0, "同版本该返回 0（场景 8）");
check(pickLatestTag("") === undefined, "空输入不该挑出 tag（场景 8）");
check(pickLatestTag("abc	refs/tags/v1.0.0") === undefined, "sha 不合法时不该挑出 tag（场景 8）");

// —— 场景 9：老成员设置里残留的真实模型名要被迁移成档位别名 ——
// 只改「正好等于已知旧名」的值；成员自填的模型必须原样保留。
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	settingsFile,
	JSON.stringify(
		{
			subagents: {
				agentOverrides: {
					reviewer: { model: "z-ai/glm-5.3-flash" }, // 旧模板写进去的真实名
					researcher: { model: "z-ai/glm-5.3-flash" },
					oracle: { model: "gpt-5.6-sol" },
					scout: { model: "my-own/scout-model" }, // 成员自填的，不能被碰
				},
			},
		},
		null,
		2,
	),
	"utf-8",
);
await load();
const mig = readSettings().subagents.agentOverrides;
check(mig.reviewer.model === "tier-power", `旧真实名没迁移成档位别名：${mig.reviewer.model}（场景 9）`);
check(mig.researcher.model === "tier-power", `researcher 的旧真实名没迁移：${mig.researcher.model}（场景 9）`);
check(mig.oracle.model === "tier-max", `oracle 的旧真实名没迁移：${mig.oracle.model}（场景 9）`);
check(mig.scout.model === "my-own/scout-model", `动了成员自填的模型：${mig.scout.model}（场景 9：只迁移已知旧名）`);

// 迁移过之后再跑一次应当是 no-op（幂等）
const beforeSecond = fs.readFileSync(settingsFile, "utf-8");
await load();
check(fs.readFileSync(settingsFile, "utf-8") === beforeSecond, "迁移不幂等：第二次启动又改了设置（场景 9）");

// —— 场景 10：团队模型配置（models.json）只补缺地并进全局 ——
// 成员手里：自己写的 newapi（改了 baseUrl、只有 tier-std）+ 一个自建 provider
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
const modelsFile = path.join(AGENT, "models.json");
fs.writeFileSync(
	modelsFile,
	JSON.stringify(
		{
			providers: {
				newapi: {
					baseUrl: "http://my-own-proxy:3000/v1", // 成员自己改过的，不能被模板覆盖
					api: "openai-completions",
					models: [{ id: "tier-std", name: "我自己写的标准档" }],
				},
				mine: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "local" }] },
			},
		},
		null,
		2,
	),
	"utf-8",
);
await load();
const mm = JSON.parse(fs.readFileSync(modelsFile, "utf-8"));
const tplProviders = JSON.parse(fs.readFileSync(path.join(repoRoot, "team", "models.template.json"), "utf-8")).providers;
const tplNewapi = tplProviders.newapi;
check(mm.providers.newapi.baseUrl === "http://my-own-proxy:3000/v1", "覆盖了成员自己改的 baseUrl（场景 10：只补缺）");
check(
	mm.providers.newapi.models.find((m) => m.id === "tier-std").name === "我自己写的标准档",
	"覆盖了成员已有的档位定义（场景 10：已有档位不动）",
);
for (const want of tplNewapi.models.map((m) => m.id)) {
	check(
		mm.providers.newapi.models.some((m) => m.id === want),
		`模板里的档位 ${want} 没补进成员配置（场景 10：缺的档位要追加）`,
	);
}
check(mm.providers.mine?.models?.[0]?.id === "local", "动了成员自建的 provider（场景 10）");
check(!JSON.stringify(mm).includes('"_说明"'), "模板里的 `_` 说明键被写进了 models.json（场景 10）");
check(!/"apiKey"\s*:\s*"(?!\$|!)/.test(fs.readFileSync(path.join(repoRoot, "team", "models.template.json"), "utf-8")),
	"team/models.template.json 里出现了明文 apiKey —— 公开仓库不许放 key（场景 10）");
check(mm.providers.newapi.apiKey === tplNewapi.apiKey, "provider 缺的 apiKey 没补上（场景 10）");

// 幂等：再跑一次不该改文件
const modelsBefore2 = fs.readFileSync(modelsFile, "utf-8");
await load();
check(fs.readFileSync(modelsFile, "utf-8") === modelsBefore2, "模型配置同步不幂等：第二次启动又改了文件（场景 10）");

// 成员的 models.json 坏掉时不许碰（覆盖会把他能修回来的内容抹掉）
fs.writeFileSync(modelsFile, "{ this is not json", "utf-8");
await load();
check(fs.readFileSync(modelsFile, "utf-8") === "{ this is not json", "models.json 坏了却动了它（场景 10）");

// —— 场景 11：写错形式的 defaultModel 要被剥掉 provider 前缀 ——
// 背景：`defaultModel` 只认裸 id。写成 `newapi/tier-std` 时 pi 不报错，直接静默回退到
// 模型列表的第一个 —— 曾因此让默认档落到每账户每天 100 次请求的免费档上，一天烧满 2 个账户。
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	settingsFile,
	JSON.stringify(
		{
			defaultProvider: "newapi",
			defaultModel: "newapi/tier-std", // 写错的形式，要被修成 tier-std
			theme: "dark",
		},
		null,
		2,
	),
	"utf-8",
);
await load();
const dm = readSettings();
check(dm.defaultModel === "tier-std", `写错形式的 defaultModel 没被修正：${dm.defaultModel}（场景 11）`);
check(dm.defaultProvider === "newapi", "动了 defaultProvider（场景 11）");
check(dm.theme === "dark", "动了无关设置项（场景 11）");

// 幂等 + 不越界：成员填别的 provider 前缀、或 provider 缺失时，一律不许动
const dmBefore = fs.readFileSync(settingsFile, "utf-8");
await load();
check(fs.readFileSync(settingsFile, "utf-8") === dmBefore, "defaultModel 迁移不幂等（场景 11）");

fs.writeFileSync(
	settingsFile,
	JSON.stringify({ defaultProvider: "newapi", defaultModel: "my-own/reviewer-model" }, null, 2),
	"utf-8",
);
await load();
check(
	readSettings().defaultModel === "my-own/reviewer-model",
	`剥掉了不属于 defaultProvider 的前缀：${readSettings().defaultModel}（场景 11：判据要收紧）`,
);

fs.writeFileSync(
	settingsFile,
	JSON.stringify({ defaultProvider: "my-own-provider", defaultModel: "newapi/tier-std" }, null, 2),
	"utf-8",
);
await load();
check(
	readSettings().defaultModel === "newapi/tier-std",
	`剥掉了不属于成员 defaultProvider 的前缀：${readSettings().defaultModel}（场景 11：判据要收紧）`,
);
check(
	readSettings().defaultProvider === "my-own-provider",
	"覆盖了成员自己设的 defaultProvider（场景 11：只补缺）",
);

// 模板卫生：列表首位不许是免费档（会变成静默回退目标）；defaultModel 必须是裸 id
const tplRaw = fs.readFileSync(path.join(repoRoot, "team", "models.template.json"), "utf-8");
const tplFirstId = JSON.parse(tplRaw).providers.newapi.models[0]?.id;
check(
	!/free/i.test(tplFirstId ?? ""),
	`team/models.template.json 首位是免费档 ${tplFirstId} —— defaultModel 解析不到时会静默回退到它（场景 11）`,
);
const sharedDm = sharedSettings.defaultModel;
check(
	typeof sharedDm !== "string" || !sharedDm.includes("/"),
	`team/agent-settings.json 的 defaultModel 写了 provider/id 形式：${sharedDm}（场景 11：只认裸 id）`,
);

// —— 场景 12：存量档位窗口迁移（2026-09-25 网关提到 512k）——
// 背景：合并规则是「成员已有档位定义一律不动」，于是老成员 models.json 里旧模板写进去的
// 128000 永远推不下去 —— 改模板只对新人生效。这一场景钉住三条：
//   ① 正好等于旧值 → 刷成新值；② 成员自己调过的值 → 原样不动；③ 模板没改到的档位 → 不动。
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	modelsFile,
	JSON.stringify(
		{
			providers: {
				newapi: {
					baseUrl: "http://my-own-proxy:3000/v1",
					api: "openai-completions",
					models: [
						{ id: "tier-std", contextWindow: 128000 }, // 旧模板值 → 要刷成 512000
						{ id: "tier-power", contextWindow: 200000 }, // 成员自己调过 → 不许动
						{ id: "tier-max", contextWindow: 272000 }, // 旧模板值 → 要刷成 512000
						{ id: "tier-free", contextWindow: 128000 }, // 旧模板值 → 要刷成 256000
					],
				},
				mine: { baseUrl: "http://localhost:11434/v1", api: "openai-completions", models: [{ id: "local" }] },
			},
		},
		null,
		2,
	),
	"utf-8",
);
await load();
const win = JSON.parse(fs.readFileSync(modelsFile, "utf-8")).providers.newapi.models;
const winOf = (id) => win.find((m) => m.id === id)?.contextWindow;
const tplWin = JSON.parse(fs.readFileSync(path.join(repoRoot, "team", "models.template.json"), "utf-8")).providers.newapi
	.models;
const tplWinOf = (id) => tplWin.find((m) => m.id === id)?.contextWindow;
check(
	winOf("tier-std") === tplWinOf("tier-std"),
	`旧的 tier-std 窗口没被刷成模板现值：${winOf("tier-std")}（场景 12：存量迁移）`,
);
check(winOf("tier-max") === tplWinOf("tier-max"), `旧的 tier-max 窗口没被刷（场景 12）：${winOf("tier-max")}`);
check(winOf("tier-free") === tplWinOf("tier-free"), `旧的 tier-free 窗口没被刷（场景 12）：${winOf("tier-free")}`);
check(
	winOf("tier-power") === 200000,
	`覆盖了成员自己调过的窗口：${winOf("tier-power")}（场景 12：只改正好等于旧值的）`,
);
// 幂等：再跑一次不该改文件
const winBefore2 = fs.readFileSync(modelsFile, "utf-8");
await load();
check(fs.readFileSync(modelsFile, "utf-8") === winBefore2, "窗口迁移不幂等：第二次启动又改了文件（场景 12）");

// —— 场景 13：存量 compaction.reserveTokens 迁移 ——
// 窗口提到 512k 后，触发点（= 窗口 − reserve）必须还给模型留得下最大的输出（模板里 tier-max 的 64000）。
// compaction 也是「只补缺」，老成员设置里已有旧模板的 32768 —— 不迁移就等于触发点落在 480k。
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	settingsFile,
	JSON.stringify({ compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 } }, null, 2),
	"utf-8",
);
await load();
const cm = readSettings().compaction;
check(
	cm.reserveTokens === sharedSettings.compaction.reserveTokens,
	`旧的 reserveTokens 没被刷成模板值：${cm.reserveTokens}（场景 13：存量迁移）`,
);
check(cm.keepRecentTokens === 20000, `动了成员自己设的 keepRecentTokens：${cm.keepRecentTokens}（场景 13）`);

// 成员自己设的 reserveTokens（不等于旧模板值）一律不动
fs.rmSync(AGENT, { recursive: true, force: true });
fs.mkdirSync(AGENT, { recursive: true });
fs.writeFileSync(
	settingsFile,
	JSON.stringify({ compaction: { reserveTokens: 50000 } }, null, 2),
	"utf-8",
);
await load();
check(
	readSettings().compaction.reserveTokens === 50000,
	`覆盖了成员自己设的 reserveTokens：${readSettings().compaction.reserveTokens}（场景 13：判据要收紧）`,
);

// 模板卫生：窗口与压缩预留是一对数 —— 预留不许小于模板里最大的 maxTokens
const tplParsed = JSON.parse(tplRaw);
const maxOut = Math.max(
	...tplParsed.providers.newapi.models.map((m) => (typeof m.maxTokens === "number" ? m.maxTokens : 0)),
);
check(
	sharedSettings.compaction.reserveTokens >= maxOut,
	`agent-settings.json 的 reserveTokens=${sharedSettings.compaction.reserveTokens} 小于模板最大 maxTokens=${maxOut} —— 压缩触发点离上限太近`,
);

console.log("设置里的 packages：", JSON.stringify(after.packages));
console.log("注入段版本行：", injected4.systemPrompt.split("\n").find((l) => l.includes("pi-workflow")));
console.log("共享设置补缺后：", JSON.stringify({ compaction: mine.compaction, subagents: mine.subagents }));
console.log(problems.length === 0 ? "\n全部通过 ✓" : "\n问题：\n- " + problems.join("\n- "));

fs.rmSync(path.dirname(AGENT), { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
