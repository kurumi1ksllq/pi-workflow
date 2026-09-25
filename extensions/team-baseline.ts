/**
 * team-baseline —— 团队基线引导扩展
 *
 * 补 pi 的两个边界：
 *   1. 包内的 AGENTS.md 不会被加载（pi 只扫 cwd 祖先链 + ~/.pi/agent/）
 *      -> 把 team/RULES.md 追加进系统提示
 *   2. MCP 配置没有"从包里读"的入口（pi-mcp-adapter 只认固定几个位置）
 *      -> 项目缺 .mcp.json 时从包里补一份（只补不覆盖）
 *
 * 设计原则：**不静默失效**
 *   - 自检发现问题 -> 写 stderr（print / json / rpc 模式都能看到，不像 ui.notify 只在交互模式）
 *   - 注入段里带版本号，随时能问出"跑的是哪一版"
 *   - `/team-baseline` 命令能跑出来本身就是"扩展在工作"的证据
 *   - 兜底：各项目仓库根放 templates/project-AGENTS.md（pi 原生加载），
 *     扩展彻底没跑时，那段文字会让模型主动报告
 *
 * ⚠️ 核心逻辑必须挂 before_agent_start，不能挂 session_start：
 *    实测 session_start 在 print 模式（-p / --mode json / rpc）下不触发。
 *
 * 装法：随团队包分发。团队全员**全局装**（`pi install <包>`，不带 -l），
 *       清单里的第三方包由本扩展补进全局 settings，与具体项目无关。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// extensions/team-baseline.ts -> 团队包根目录
const packageRoot = path.resolve(here, "..");
const rulesFile = path.join(packageRoot, "team", "RULES.md");
const mcpTemplateFile = path.join(packageRoot, "team", "mcp.template.json");
const packagesManifestFile = path.join(packageRoot, "team", "packages.json");
const agentSettingsFile = path.join(packageRoot, "team", "agent-settings.json");
const modelsTemplateFile = path.join(packageRoot, "team", "models.template.json");
const extensionConfigsDir = path.join(packageRoot, "team", "extensions");
const pkgJsonFile = path.join(packageRoot, "package.json");

// ───────────────────── 自动更新：跟远端最新 tag ─────────────────────
// 维护者只管 `release.sh` 打 tag + push，成员零动作：本扩展每次启动（默认 1 小时最多查一次
// 远端）比对**远端最新的 vX.Y.Z tag** 与本地 clone 的 HEAD，落后就 fetch + reset --hard，
// 并把 settings 里的源改写成新 tag。
//
// 为什么不能靠 pi 自己（0.86.1 源码 + 隔离 agent 目录实测）：
//   - pi 启动只在交互模式弹「Package Updates Available」，**不自动应用**；
//   - 钉了 tag 的源连提示都不弹（checkForAvailableUpdates 直接跳过 pinned）；
//   - 带 ref 的源在 `pi update --extensions` 时会被 `git reset --hard <ref>` **拉回配置的
//     那个 tag**。所以自动更新必须同时改写 settings 里的 ref —— 否则成员随手一次 update
//     就把 clone 打回旧版。
//
// 三道闸限制它只敢动「pi 自己 clone 的团队包目录」：clone 必须位于 <agent dir>/git/ 下、
// settings 里要有团队包的源条目、origin 指向本仓库。开发副本（比如维护者的 E:\hermes\team-pi）
// 因此永远不会被 reset --hard（那会丢掉未提交的活儿）。
const UPDATE_TTL_MS = (() => {
	const hours = Number(process.env.PI_BASELINE_UPDATE_TTL_HOURS);
	if (Number.isFinite(hours) && hours >= 0) return Math.round(hours * 3600_000);
	return 3600_000; // 默认 1 小时
})();
const UPDATE_LOCK_STALE_MS = 5 * 60_000;
// 状态与锁放自己名下（extensions/team-baseline/），与 syncExtensionConfigs 给别的扩展补配置的
// extensions/<扩展名>/config.json 互不干扰
const updateDir = () => path.join(getAgentDir(), "extensions", "team-baseline");
const updateStateFile = () => path.join(updateDir(), "update-state.json");
const updateLockFile = () => path.join(updateDir(), ".update.lock");

/** 语义化版本比较：v1.10.0 > v1.9.9（按数字段比，不是字符串比） */
export function compareVersions(a: string, b: string): number {
	const pa = a.replace(/^v/, "").split(".");
	const pb = b.replace(/^v/, "").split(".");
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (parseInt(pa[i] ?? "0", 10) || 0) - (parseInt(pb[i] ?? "0", 10) || 0);
		if (d !== 0) return d;
	}
	return 0;
}

export type LatestTag = { tag: string; sha: string };

/**
 * 纯函数：从 `git ls-remote --tags --refs origin` 的输出里挑出最大的 vX.Y.Z tag。
 *
 * 只认严格三段数字的 tag —— 带后缀的预发布（v1.3.0-rc1）故意不认，免得半成品被自动推给全员。
 * 离线可测，见 scripts/test-extension.mjs 场景 8。
 */
export function pickLatestTag(lsRemoteOutput: string): LatestTag | undefined {
	let best: LatestTag | undefined;
	for (const line of lsRemoteOutput.split("\n")) {
		const m = line.match(/^([0-9a-fA-F]{40})\s+refs\/tags\/(v\d+\.\d+\.\d+)$/);
		if (!m) continue;
		const [, sha, tag] = m;
		if (!best || compareVersions(tag, best.tag) > 0) best = { tag, sha: sha.toLowerCase() };
	}
	return best;
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

/**
 * 版本标识。优先用 git tag —— tag 才是发布的权威标识。
 * （踩过：tag v1.2.1 里包着的 package.json version 还是 1.2.0，因为发版时忘了同步。
 *   读 tag 就没有这个手工同步的环节了。）
 * 拿不到 tag 就退回 package.json。
 *
 * ⚠️ clone 里的 tag 可能是旧的：pi 升级已存在的 clone 时只跑 `git fetch origin <ref>`
 * （实测 dist/core/package-manager.js 的 installGit），**不会建本地 tag**。
 * 于是 describe 会给出 `v1.4.4-8-g8c8c540` 这种误导值。所以优先读 pi 设置里配的那个 ref
 * —— 那才是"这次装的是哪一版"的权威答案。
 */
function configuredRef(): string | undefined {
	const spec = baselineSourceSpec();
	const m = spec?.match(/@(v\d+\.\d+\.\d+[^@]*)$/);
	return m ? m[1] : undefined;
}

/**
 * 团队包自己的 settings 条目（`git:github.com/.../pi-workflow@vX.Y.Z`）。
 * 全局优先、其次项目级；同作用域里优先返回**带 ref 的那条**（历史写法里可能混着不带 ref 的）。
 */
function baselineSourceSpec(): string | undefined {
	const candidates = [
		path.join(getAgentDir(), "settings.json"),
		path.join(process.cwd(), ".pi", "settings.json"),
	];
	for (const file of candidates) {
		const raw = readIfExists(file);
		if (!raw) continue;
		try {
			const pkgs = JSON.parse(raw)?.packages;
			if (!Array.isArray(pkgs)) continue;
			const mine = pkgs.map(String).filter((spec) => spec.includes("pi-workflow"));
			if (mine.length === 0) continue;
			return mine.find((spec) => /@[^@/]+$/.test(spec)) ?? mine[0];
		} catch {
			// 设置读坏了就当没有，继续试下一个
		}
	}
	return undefined;
}

function packageVersion(): string {
	// 1) pi 设置里配的 ref —— 权威，且不受 clone 内 tag 陈旧影响
	const fromSettings = configuredRef();
	if (fromSettings) return fromSettings;
	// 2) clone 里的 tag（干净的 vX.Y.Z 才采用）
	try {
		const tag = execFileSync("git", ["describe", "--tags", "--always"], {
			cwd: packageRoot,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		if (tag) return tag;
	} catch {
		// 不是 git 目录 / 没装 git —— 退回 package.json
	}
	// 3) 最后兜底
	try {
		return JSON.parse(readIfExists(pkgJsonFile) ?? "{}").version ?? "unknown";
	} catch {
		return "unknown";
	}
}

/** 自检。返回问题列表，空数组 = 一切正常。 */
function healthCheck(): string[] {
	const problems: string[] = [];
	// 模板里最大的 maxTokens，跨两个文件对账用（见本函数末尾）
	let templateMaxOutput: number | undefined;
	if (!fs.existsSync(rulesFile)) {
		problems.push("team/RULES.md 不存在 -> 团队规范不会被注入");
	} else if (!readIfExists(rulesFile)?.trim()) {
		problems.push("team/RULES.md 是空文件");
	}
	const tpl = readIfExists(mcpTemplateFile);
	if (!tpl) {
		problems.push("team/mcp.template.json 不存在 -> MCP 基线不会同步");
	} else {
		try {
			JSON.parse(tpl);
		} catch {
			problems.push("team/mcp.template.json 不是合法 JSON -> MCP 同步被跳过");
		}
	}
	const settingsTpl = readIfExists(agentSettingsFile);
	if (!settingsTpl) {
		problems.push("team/agent-settings.json 不存在 -> 团队共享设置不会同步");
	} else {
		try {
			JSON.parse(settingsTpl);
		} catch {
			problems.push("team/agent-settings.json 不是合法 JSON -> 共享设置同步被跳过");
		}
	}
	const modelsTpl = readIfExists(modelsTemplateFile);
	if (!modelsTpl) {
		problems.push("team/models.template.json 不存在 -> 团队模型配置不会同步");
	} else {
		try {
			const parsed = JSON.parse(modelsTpl);
			// 凭据红线：模板进的是**公开**仓库，apiKey 只允许环境变量引用（$XXX）或命令（!cmd）。
			// 明文 key 一旦推出去就收不回来了 —— 这里机械挡住，别靠记性。
			for (const m of modelsTpl.matchAll(/"apiKey"\s*:\s*"([^"]*)"/g)) {
				const value = m[1];
				if (value.startsWith("$") || value.startsWith("!")) continue;
				problems.push("team/models.template.json 里有明文 apiKey —— 公开仓库不能放 key，改成 $环境变量");
			}
			if (!parsed?.providers || Object.keys(parsed.providers).length === 0) {
				problems.push("team/models.template.json 没有 providers -> 模型配置同步是空转");
			}
			// 列表首位的档位会变成「defaultModel 解析不到时」的静默回退目标。
			// 免费档放首位 = 全员默认跑在每账户每天 100 次请求的池子上（2026-09-23 实况）。
			for (const [pid, provider] of Object.entries(parsed?.providers ?? {}) as [string, any][]) {
				const first = Array.isArray(provider?.models) ? provider.models[0] : undefined;
				const firstId = typeof first?.id === "string" ? first.id : "";
				if (firstId && /free/i.test(firstId)) {
					problems.push(
						`team/models.template.json 的 ${pid}.models 首位是免费档 ${firstId} —— 解析不到 defaultModel 时会静默回退到它，把这档挪到列表末尾`,
					);
				}
			}
			// 上面已经在遍历档位，顺手记下「模板里最大的输出上限」——
			// 压缩预留必须 ≥ 它，见文件末尾那句对账。
			let maxOut = 0;
			for (const provider of Object.values(parsed?.providers ?? {}) as any[]) {
				for (const m of Array.isArray(provider?.models) ? provider.models : []) {
					if (typeof m?.maxTokens === "number") maxOut = Math.max(maxOut, m.maxTokens);
				}
			}
			templateMaxOutput = maxOut;
		} catch {
			problems.push("team/models.template.json 不是合法 JSON -> 模型配置同步被跳过");
		}
	}
	// 窗口与压缩预留是一对数：压缩触发点 = contextWindow − reserveTokens。
	// 预留小于「模板里最大的 maxTokens」时，触发那一刻没给模型留够输出空间 ——
	// 真到上限会是上游报错，而不是提前压缩。两处配置分居两个文件，只能机械对账。
	const sharedTpl = (() => {
		const raw = readIfExists(agentSettingsFile);
		if (!raw) return undefined;
		try {
			return JSON.parse(raw);
		} catch {
			return undefined;
		}
	})();
	const sharedReserve = sharedTpl?.compaction?.reserveTokens;
	const reserveFloor = templateMaxOutput ?? REQUIRED_RESERVE_MIN;
	if (typeof sharedReserve === "number" && sharedReserve < reserveFloor) {
		problems.push(
			`team/agent-settings.json 的 compaction.reserveTokens=${sharedReserve} 低于下限 ${reserveFloor}` +
				`（= models.template.json 里最大的 maxTokens）—— 压缩触发点离上限太近，` +
				`到上限会被上游报错而不是提前压缩；模板改窗口时这个值必须同批改`,
		);
	}
	return problems;
}

type McpSync = "written" | "exists" | "empty" | "invalid" | "error" | "not-a-project";

function syncMcpBaseline(projectDir: string): McpSync {
	const projectMcp = path.join(projectDir, ".mcp.json");
	if (fs.existsSync(projectMcp)) return "exists";
	// 只在已接入基线的目录里动手（有 .pi/ 才是 pi 项目工作区）。
	// 基线装成全局之后，不加这道闸的话，任何跑过 pi 的目录都会被塞一个 .mcp.json。
	if (!fs.existsSync(path.join(projectDir, ".pi"))) return "not-a-project";
	const template = readIfExists(mcpTemplateFile);
	if (!template) return "invalid";
	let parsed: any;
	try {
		parsed = JSON.parse(template);
	} catch {
		return "invalid";
	}
	if (!parsed?.mcpServers || Object.keys(parsed.mcpServers).length === 0) return "empty";
	try {
		fs.writeFileSync(projectMcp, template, "utf-8");
		return "written";
	} catch {
		return "error";
	}
}

type PkgSync = "added" | "none" | "error";

/** 去掉末尾的 @ref，用来判断"是不是同一个包" */
function packageKey(spec: string): string {
	return spec.trim().replace(/(@[^@/]+)$/, "");
}

/** 条目带了明确版本（`npm:foo@1.2.3` / `git:...#@v1.2.3`）= 钉死的，要全员一致 */
function isPinnedSpec(spec: string): boolean {
	return /@[^@/]+$/.test(spec.trim());
}

/** pi 的配置目录。团队全员都是全局装，所以清单要落到这里才算数。 */
function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

/**
 * 把缺的包补进某个 settings 文件，**并升级钉死的版本**。返回是否真的改了。
 *
 * 规则：只补不删，有一个例外 —— 清单里的条目带了明确版本（`npm:foo@1.2.3`），
 * 而成员设置里是同一个包但不带版本（`npm:foo`）时，替换成带版本的那条。
 *
 * 为什么要替换：不带版本的条目在 pi 眼里**不是 pinned**，启动时会弹
 * 「Package Updates Available」提示每个成员各自升到最新，团队就不在同一套上了；
 * 带上版本后，pi 启动时会发现已装版本与配置不符并自动装齐
 * （实测 package-manager 的 needsInstall 判断里含版本比对）。
 */
function addMissingPackages(settingsFile: string, wanted: string[]): boolean {
	const raw = readIfExists(settingsFile);
	let settings: any = {};
	if (raw) {
		try {
			settings = JSON.parse(raw);
		} catch {
			return false;
		}
	}
	const current: string[] = Array.isArray(settings.packages) ? settings.packages : [];
	const next: string[] = [...current];
	let changed = false;

	for (const wantRaw of wanted) {
		const want = String(wantRaw);
		const key = packageKey(want);
		const at = next.findIndex((s) => packageKey(String(s)) === key);
		if (at === -1) {
			next.push(want);
			changed = true;
			continue;
		}
		const existing = String(next[at]);
		if (existing === want) continue;
		// 同名条目已存在：只有清单里那条是钉死的版本才替换，否则不动成员自己的写法
		if (isPinnedSpec(want)) {
			next[at] = want;
			changed = true;
		}
	}

	if (!changed) return false;
	settings.packages = next;
	try {
		fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
		fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		return true;
	} catch {
		return false;
	}
}

/**
 * 把团队清单（team/packages.json）里的包补进 settings。
 *
 * 补两处：
 *   1. **全局**（~/.pi/agent/settings.json）—— 团队全员是全局装的，清单必须落到这里才生效
 *   2. 项目级（.pi/settings.json）—— 只有该目录本来就是 pi 项目时才补
 *
 * 只补不删、不动已有的、重复调用安全。
 */
function syncPackagesManifest(projectDir: string): PkgSync {
	const raw = readIfExists(packagesManifestFile);
	if (!raw) return "none";
	let wanted: unknown;
	try {
		wanted = JSON.parse(raw)?.packages;
	} catch {
		return "error";
	}
	if (!Array.isArray(wanted) || wanted.length === 0) return "none";
	const list = wanted.map(String);

	let changed = false;
	// 1) 全局
	try {
		changed = addMissingPackages(path.join(getAgentDir(), "settings.json"), list) || changed;
	} catch {
		// 全局写失败不影响项目级
	}
	// 2) 项目级（存在才补）
	try {
		const projectSettings = path.join(projectDir, ".pi", "settings.json");
		if (fs.existsSync(projectSettings)) {
			changed = addMissingPackages(projectSettings, list) || changed;
		}
	} catch {
		// 同上
	}

	return changed ? "added" : "none";
}

type SettingsSync = "merged" | "none" | "error";

/**
 * 已知的「过期真实模型名 → 档位别名」迁移表。
 *
 * 背景：早期版本的 team/agent-settings.json 直接写真实模型名（`z-ai/glm-5.3-flash` 等）。
 * 网关改成档位别名后那些名字不再有可用渠道，已装旧版的成员会拿到一个**报 403 的**
 * reviewer/researcher 配置 —— 而 mergeMissing 是「只补缺」，永远不会把它改掉。
 *
 * 所以这里做一次定向迁移：**只有当前值正好等于表中的旧名时才改写**。
 * 成员自己填的模型（`my-own/reviewer-model`）不匹配任何旧名，一律不动。
 */
const STALE_MODEL_MAP: Record<string, string> = {
	"z-ai/glm-5.3-flash": "tier-power",
	"gpt-5.6-sol": "tier-max",
	"deepseek/deepseek-v4.1-flash": "tier-std",
	"inclusionai/ling-3.0-flash-sante:free": "tier-free",
};

/**
 * 已知的「过期档位上下文窗口 → 新窗口」迁移表。
 *
 * 背景：合并规则里「成员已有档位定义一律不动」是为了不覆盖他自己调过的值，副作用是
 * **团队改模板也推不下去** —— 老成员的 models.json 里睡着旧模板写进去的 128000，永远补不上。
 * 2026-09-25 网关侧把三个付费档提到 512k 时就撞上这个：改模板只对新人生效。
 *
 * 判据收得很紧（和 STALE_MODEL_MAP 同一条思路）：**只有当前值正好等于旧模板发出去的
 * 那个数字时才改**。成员自己调过的窗口（哪怕只差 1）一律不动 —— 我们判断不了那是手改还是残留。
 * 只在我们自己 provider 段（模板里声明的那些）里找，成员自建 provider 一律不碰。
 *
 * ⚠️ 窗口改了必须同批改 `compaction.reserveTokens`（触发点 = 窗口 − reserve），
 *    见 STALE_COMPACTION_RESERVE，两者是一对数。
 */
const STALE_CONTEXT_WINDOW: Record<string, { from: number; to: number }> = {
	"tier-std": { from: 128_000, to: 512_000 },
	"tier-power": { from: 128_000, to: 512_000 },
	"tier-max": { from: 272_000, to: 512_000 },
	"tier-free": { from: 128_000, to: 256_000 },
};

/**
 * 压缩预留的定向迁移。理由同上：`compaction` 是「只补缺」，成员 settings 里已经有
 * 团队旧模板写进去的 `reserveTokens: 32768`，模板改成 65536 对他毫无影响 ——
 * 于是他的窗口变成 512k 而触发点还在 512k − 32k = 480k（93.8%），
 * 压不回模型的最大输出（tier-max 的 64000），到上限会被上游直接报错。
 *
 * 同样只认「正好等于旧模板值」：成员自己填的数字一律不动。
 */
const STALE_COMPACTION_RESERVE: Record<number, number> = { 32768: 65536 };

/**
 * 新窗口下 reserveTokens 的下限 = 模板里最大的 maxTokens。
 * 触发那一刻必须还给模型留得下它最大的输出，否则真到上限时是硬报错、不是提前压缩。
 */
const REQUIRED_RESERVE_MIN = 64_000;

/**
 * 一次性修掉写错形式的 `defaultModel`。
 *
 * pi 的 `defaultModel` 只认**裸模型 id**（配 `defaultProvider` 消歧）。写成 `<provider>/<id>`
 * 时 pi 解析不到，**不报错**，直接静默回退到模型列表的第一个 —— 2026-09-23 实况：本机写成
 * `newapi/tier-std`，于是所有默认会话都跑在列表首位的免费档（每账户每天 100 次请求）上，
 * 一天烧满 2 个账户。这种错误不会有人发现，只能机械改回来。
 *
 * 判据收得很紧：**仅当前缀正好等于 `defaultProvider` 时才剥掉前缀**。成员若把 defaultModel
 * 填成别的 provider 前缀（或 id 本身带斜杠的真实模型名），一律不动 —— 那种情况我们判断不了
 * 他想要什么。`defaultProvider` 缺失时也不动（无法确认前缀是 provider 还是模型名的一部分）。
 */
function migrateBrokenDefaultModel(settings: any): boolean {
	const provider = settings?.defaultProvider;
	const model = settings?.defaultModel;
	if (typeof provider !== "string" || !provider) return false;
	if (typeof model !== "string" || !model) return false;
	const prefix = `${provider}/`;
	if (!model.startsWith(prefix)) return false;
	const bare = model.slice(prefix.length);
	if (!bare) return false;
	settings.defaultModel = bare;
	return true;
}

/** 走一遍 settings.subagents.agentOverrides，把撞上旧名的 model 换成档位别名。 */
function migrateStaleModels(settings: any): boolean {
	const overrides = settings?.subagents?.agentOverrides;
	if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return false;
	let changed = false;
	for (const name of Object.keys(overrides)) {
		const entry = overrides[name];
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
		const mapped = STALE_MODEL_MAP[entry.model];
		if (mapped) {
			entry.model = mapped;
			changed = true;
		}
	}
	return changed;
}

/**
 * 深合并：**只补缺**。成员自己设过的键一律不动，也从不删键。
 * 数组整体当一个值（合并数组只会制造意外）；以 `_` 开头的键是给人看的说明，不写进设置。
 */
function mergeMissing(target: any, patch: any): boolean {
	let changed = false;
	for (const [key, value] of Object.entries(patch)) {
		if (key.startsWith("_")) continue;
		const current = target[key];
		if (current === undefined || current === null) {
			target[key] = value;
			changed = true;
			continue;
		}
		if (
			value !== null &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			typeof current === "object" &&
			!Array.isArray(current)
		) {
			changed = mergeMissing(current, value) || changed;
		}
	}
	return changed;
}

/**
 * 把老成员残留的旧上下文窗口刷成新值（见 STALE_CONTEXT_WINDOW）。
 *
 * 只在**模板自己声明的 provider** 里动手，且三重判据全中才改：
 *   ① 档位 id 在迁移表里；② 当前值 == 表里记的旧值；③ 模板里该档位的**现值** == 表里的新值
 * 第三条是防迁移表本身过期 —— 表说「改成 512k」而模板已经被改成别的数时，谁也不该动。
 */
function migrateStaleContextWindows(providers: any, template: any): boolean {
	let changed = false;
	for (const [providerId, tplProvider] of Object.entries(template ?? {}) as [string, any][]) {
		const target = providers?.[providerId];
		if (!target || typeof target !== "object" || !Array.isArray(target.models)) continue;
		const tplModels: any[] = Array.isArray(tplProvider?.models) ? tplProvider.models : [];
		for (const model of target.models) {
			const id = modelIdOf(model);
			const stale = id ? STALE_CONTEXT_WINDOW[id] : undefined;
			if (!stale) continue;
			if (model.contextWindow !== stale.from) continue;
			const tplEntry = tplModels.find((m) => modelIdOf(m) === id);
			if (tplEntry?.contextWindow !== stale.to) continue;
			model.contextWindow = stale.to;
			changed = true;
		}
	}
	return changed;
}

/**
 * 把老成员残留的旧 `compaction.reserveTokens` 刷成新值（见 STALE_COMPACTION_RESERVE）。
 * 只认「正好等于旧模板值」—— 成员自己填的数字一律不动。
 */
function migrateStaleCompactionReserve(settings: any): boolean {
	const current = settings?.compaction?.reserveTokens;
	if (typeof current !== "number") return false;
	const next = STALE_COMPACTION_RESERVE[current];
	if (next === undefined) return false;
	settings.compaction.reserveTokens = next;
	return true;
}

/**
 * 团队共享设置（team/agent-settings.json）→ 全局 ~/.pi/agent/settings.json。
 *
 * 只补缺，理由和 packages 一样：成员可能自己调过 compaction 或给某个 agent 换过模型，
 * 团队不该把他的手改覆盖掉 —— 覆盖会让人不敢在自己机器上动任何设置。
 * 需要「全员强制一致」时，改的是团队包的模板，然后发版让所有人的空缺被补上。
 */
function syncAgentSettings(): SettingsSync {
	const tpl = readIfExists(agentSettingsFile);
	if (!tpl) return "none";
	let patch: any;
	try {
		patch = JSON.parse(tpl);
	} catch {
		return "error";
	}
	const file = path.join(getAgentDir(), "settings.json");
	const raw = readIfExists(file);
	let settings: any = {};
	if (raw) {
		try {
			settings = JSON.parse(raw);
		} catch {
			return "error";
		}
	}
	const filled = mergeMissing(settings, patch);
	// 顺序有意：先补缺（新缺的键写进去的就是档位别名），再迁移成员本地残留的旧真实模型名、
	// 旧窗口（模板改过、但「已有档位不动」推不下去的那种）、旧压缩预留，
	// 最后修写错形式的 defaultModel（会静默落到列表首位，见该函数注释）。
	// 迁移都在补缺之后：先让该有的键存在，再判断哪些值需要刷。
	const migrated = migrateStaleModels(settings);
	const migratedReserve = migrateStaleCompactionReserve(settings);
	const fixedDefault = migrateBrokenDefaultModel(settings);
	if (!filled && !migrated && !migratedReserve && !fixedDefault) return "none";
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		return "merged";
	} catch {
		return "error";
	}
}

// ─────────────────── 模型配置同步（models.json）───────────────────
//
// 为什么需要这一步：`team/agent-settings.json` 里的 subagents 路由用的是**档位别名**
// （`tier-power` / `tier-max`），而别名只有在成员的 `models.json` 里定义了对应 provider + 模型
// 才解析得出来。没有这一步，新成员装完基线派出去的 reviewer 会拿到一个解析不了的模型名。
//
// 凭据红线：模板进的是**公开**仓库，所以只同步 baseUrl + 模型定义，
// apiKey 一律写成环境变量引用（`$NEWAPI_API_KEY`），成员自己 export 或走 /login。
// healthCheck 会机械拦住明文 key。

type ModelsSync = "merged" | "none" | "error";

/** 拿一个模型定义当「已存在」的判断依据：按 id 比对 */
function modelIdOf(entry: any): string | undefined {
	const id = entry?.id;
	return typeof id === "string" && id ? id : undefined;
}

/**
 * 模板里的 `_` 开头键是**给人看的说明**，不许写进成员的配置文件
 * （和 `team/agent-settings.json` 同一条规矩）。
 */
function stripDocKeys(value: any): any {
	if (Array.isArray(value)) return value.map(stripDocKeys);
	if (!value || typeof value !== "object") return value;
	const out: any = {};
	for (const [key, child] of Object.entries(value)) {
		if (key.startsWith("_")) continue;
		out[key] = stripDocKeys(child);
	}
	return out;
}

/**
 * 模型配置的合并规则：**按 provider 合并，provider 内部按 model id 追加**。
 *
 * 为什么不直接复用 `mergeMissing`（只补缺的对象深合并）：数组在那里是**整体当一个值**，
 * 于是「provider 已存在」就等于整个 models 数组不再更新 —— 团队以后往网关注册新档位
 * （加一个 `tier-x`），成员的 models.json 永远补不上，只能靠人喊。
 * 这里的语义是「**只追加缺的档位，已有的档位定义一律不动**」：
 *
 * - 成员的 `newapi` 里已经有 `tier-std` → 保留他那一份（他可能自己调过上下文长度）
 * - 模板里有、他那儿没有的 `tier-x` → 追加进去
 * - 他自建的 provider / 自建档位 → 一律不碰
 *
 * 其余 provider 级字段（`baseUrl` / `api` / `apiKey`）走 `mergeMissing`：缺才补，成员设过的不动。
 */
function mergeModelsTemplate(models: any, template: any): boolean {
	let changed = false;
	for (const [providerId, tplProvider] of Object.entries(template ?? {}) as [string, any][]) {
		if (!tplProvider || typeof tplProvider !== "object" || Array.isArray(tplProvider)) continue;
		let target = models[providerId];
		if (!target || typeof target !== "object" || Array.isArray(target)) {
			models[providerId] = structuredClone(tplProvider);
			changed = true;
			continue;
		}
		// provider 已存在：补缺的 provider 级字段（baseUrl / api / apiKey / name…），不动已有的
		changed = mergeMissing(target, { ...tplProvider, models: undefined }) || changed;
		const wanted = Array.isArray(tplProvider.models) ? tplProvider.models : [];
		if (wanted.length === 0) continue;
		const current = Array.isArray(target.models) ? target.models : [];
		const heardIds = new Set(current.map(modelIdOf).filter(Boolean));
		const toAdd = wanted.filter((m: any) => {
			const id = modelIdOf(m);
			return id && !heardIds.has(id);
		});
		if (toAdd.length === 0) continue;
		target.models = [...current, ...structuredClone(toAdd)];
		changed = true;
	}
	return changed;
}

/**
 * 把**缺的** provider / 模型从模板补进 models.json —— 只补不覆盖、不动别的键。
 *
 * 凭据红线再强调一遍：模板在公开仓库里，`apiKey` 只能写环境变量引用或 `!命令`。
 */
function syncModelsConfig(): ModelsSync {
	const tpl = readIfExists(modelsTemplateFile);
	if (!tpl) return "none";
	let patch: any;
	try {
		patch = JSON.parse(tpl);
	} catch {
		return "error";
	}
	if (!patch?.providers || typeof patch.providers !== "object") return "none";
	const template = stripDocKeys(patch.providers) as any;

	const file = path.join(getAgentDir(), "models.json");
	const raw = readIfExists(file);
	let models: any = { providers: {} };
	if (raw?.trim()) {
		try {
			models = JSON.parse(raw);
		} catch {
			// 成员文件坏了就**不碰** —— 覆盖会把他原本能修回来的内容抹掉
			return "error";
		}
	}
	if (!models || typeof models !== "object" || Array.isArray(models)) return "error";
	if (!models.providers || typeof models.providers !== "object" || Array.isArray(models.providers)) {
		models.providers = {};
	}

	const changed = mergeModelsTemplate(models.providers, template);
	// 存量迁移：老成员的 models.json 里睡着旧模板写进去的窗口（「已有档位不动」推不下去），
	// 这里只把**正好等于旧值**的那些刷成模板现值。见 STALE_CONTEXT_WINDOW。
	const migratedWindows = migrateStaleContextWindows(models.providers, template);
	if (!changed && !migratedWindows) return "none";
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(models, null, 2) + "\n", "utf-8");
		return "merged";
	} catch {
		return "error";
	}
}

/**
 * 扩展自己的配置文件：`team/extensions/<扩展名>.json` → `<agent dir>/extensions/<扩展名>/config.json`。
 *
 * 这是 pi-rtk-optimizer 这类「配置不在 settings.json 里、在自己的 config.json 里」的扩展。
 * 只看目标存不存在，**存在就完全不动** —— 成员调过的配置（比如关掉某个压缩项）不能被重置。
 */
function syncExtensionConfigs(): { written: string[]; failed: string[] } {
	const written: string[] = [];
	const failed: string[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(extensionConfigsDir);
	} catch {
		return { written, failed };
	}
	for (const entry of entries) {
		const m = entry.match(/^([^.].*)\.json$/);
		if (!m) continue;
		const name = m[1];
		const target = path.join(getAgentDir(), "extensions", name, "config.json");
		if (fs.existsSync(target)) continue;
		const content = readIfExists(path.join(extensionConfigsDir, entry));
		if (content === undefined) continue;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, content, "utf-8");
			written.push(name);
		} catch {
			failed.push(name);
		}
	}
	return { written, failed };
}

type RtkState = "ok" | "installed" | "not-in-path" | "no-bundle" | "error";

const isWin = process.platform === "win32";

/** 用 where/which 判断 rtk 在不在 PATH 里 —— 跟 pi-rtk-optimizer 自己的判定方式保持一致 */
function rtkOnPath(): boolean {
	try {
		execFileSync(isWin ? "where" : "which", ["rtk"], {
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 3000,
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * rtk 二进制（pi-rtk-optimizer 依赖，但 npm 装不到它）。
 * 团队成员机器上通常没有，所以包里带一份，缺了就从包里补到 ~/.local/bin。
 * 这是唯一一个"扩展往用户机器写可执行文件"的地方 —— 写的是团队自己的二进制。
 */
function ensureRtk(): RtkState {
	if (rtkOnPath()) return "ok"; // 已经有了
	const binName = isWin ? "rtk.exe" : "rtk";
	const bundled = path.join(packageRoot, "tools", binName);
	if (!fs.existsSync(bundled)) return "no-bundle";

	// 候选目录按"有多大概率已经在 PATH 里"排序，逐个试，写进去就用 where/which 验一次。
	// 放 ~/.local/bin 是不够的：Windows 上那个目录默认不在 PATH，装了也找不到（实测过）。
	const candidates = isWin
		? [
				// npm 全局 bin —— 用 npm 装过 pi 的人，这个目录必然在 PATH
				path.join(os.homedir(), "AppData", "Roaming", "npm"),
				path.join(os.homedir(), ".local", "bin"),
			]
		: [path.join(os.homedir(), ".local", "bin")];

	for (const dir of candidates) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			const target = path.join(dir, binName);
			fs.copyFileSync(bundled, target);
			if (!isWin) fs.chmodSync(target, 0o755);
			// 装完立刻验证：这一处能被 where/which 认到才算成功
			if (rtkOnPath()) return "installed";
		} catch {
			// 换下一个候选目录
		}
	}
	return "not-in-path";
}

// ───────────────────────── 自动更新的实现 ─────────────────────────

export type SelfUpdateState =
	| "current" // 已经是最新 tag
	| "updated" // 刚更新到新 tag
	| "off" // 显式关掉（PI_BASELINE_SELF_UPDATE=off）
	| "not-a-clone" // 不是 pi clone 出来的包目录（开发副本、本地路径装法）—— 不碰
	| "branch-ref" // 源钉的是分支/commit（不是 vX.Y.Z）—— 有意的固定，不覆盖
	| "throttled" // TTL 内，本轮不查
	| "locked" // 另一个 pi 实例正在更新
	| "no-tags" // 远端没有合法的 vX.Y.Z tag
	| "dirty" // clone 里有未提交的跟踪文件改动 —— 不碰，避免丢东西
	| "failed"; // git / 网络失败（静默）

type SelfUpdateResult = { state: SelfUpdateState; tag?: string; from?: string };

function runGitQuiet(args: string[], timeoutMs: number): string | undefined {
	try {
		return execFileSync("git", args, {
			cwd: packageRoot,
			encoding: "utf-8",
			timeout: timeoutMs,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return undefined;
	}
}

/** 只更新「pi 自己 clone 出来的团队包目录」—— 开发副本一律不碰（reset --hard 会丢活儿） */
function isManagedClone(): boolean {
	const gitRoot = path.join(getAgentDir(), "git");
	const rel = path.relative(gitRoot, packageRoot);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
	if (!fs.existsSync(path.join(packageRoot, ".git"))) return false;
	if (!baselineSourceSpec()) return false;
	const origin = runGitQuiet(["remote", "get-url", "origin"], 5000);
	return !!origin && origin.includes("pi-workflow");
}

function readUpdateState(): any {
	try {
		return JSON.parse(readIfExists(updateStateFile()) ?? "{}");
	} catch {
		return {};
	}
}

function writeUpdateState(state: SelfUpdateState, extra: Record<string, unknown> = {}): void {
	try {
		fs.mkdirSync(updateDir(), { recursive: true });
		fs.writeFileSync(
			updateStateFile(),
			JSON.stringify({ state, checkedAt: Date.now(), checkedAtIso: new Date().toISOString(), ...extra }, null, 2) + "\n",
			"utf-8",
		);
	} catch {
		// 状态写不了不影响更新本身
	}
}

/** 把 settings 里团队包的 ref 改写成新 tag —— 不改的话 pi 的 update 会把 clone 拉回旧 tag */
function retargetBaselineRef(newTag: string): boolean {
	let changed = false;
	for (const file of [
		path.join(getAgentDir(), "settings.json"),
		path.join(process.cwd(), ".pi", "settings.json"),
	]) {
		const raw = readIfExists(file);
		if (!raw) continue;
		try {
			const settings = JSON.parse(raw);
			if (!Array.isArray(settings.packages)) continue;
			let localChanged = false;
			settings.packages = settings.packages.map((entry: unknown) => {
				const spec = String(entry);
				if (!spec.includes("pi-workflow")) return entry;
				const want = `${packageKey(spec)}@${newTag}`;
				if (spec === want) return entry;
				localChanged = true;
				return want;
			});
			if (!localChanged) continue;
			fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf-8");
			changed = true;
		} catch {
			// 写不动就只留 clone 已更新；操作者能从 /team-baseline 看出来
		}
	}
	return changed;
}

/**
 * 跟远端最新 tag 对齐。全程失败静默（只写状态文件），
 * 唯一会往 stderr 说话的路径是「真的更新了」—— 见 export default 里的调用处。
 */
function selfUpdate(): SelfUpdateResult {
	if (process.env.PI_BASELINE_SELF_UPDATE === "off") return { state: "off" };
	if (!isManagedClone()) return { state: "not-a-clone" };

	// 源钉的是分支名或 commit（不是 vX.Y.Z）→ 那是有意的固定，别拿「最新 tag」去覆盖它
	const pinnedRef = baselineSourceSpec()?.match(/@([^@/]+)$/)?.[1];
	if (pinnedRef && !/^v\d+\.\d+\.\d+$/.test(pinnedRef)) return { state: "branch-ref" };

	const from = configuredRef();
	const last = Number(readUpdateState()?.checkedAt ?? 0);
	if (last && Date.now() - last < UPDATE_TTL_MS) return { state: "throttled" };

	const lock = updateLockFile();
	let locked = false;
	try {
		fs.mkdirSync(updateDir(), { recursive: true });
		fs.closeSync(fs.openSync(lock, "wx"));
		locked = true;
	} catch {
		// 锁已存在：可能是上一个进程崩了留下的 —— 够旧就抢过来，否则让给别人
		try {
			if (Date.now() - fs.statSync(lock).mtimeMs < UPDATE_LOCK_STALE_MS) return { state: "locked" };
			fs.rmSync(lock, { force: true });
			fs.closeSync(fs.openSync(lock, "wx"));
			locked = true;
		} catch {
			return { state: "locked" };
		}
	}

	try {
		const lsRemote = runGitQuiet(["ls-remote", "--tags", "--refs", "origin"], 30_000);
		if (lsRemote === undefined) {
			writeUpdateState("failed");
			return { state: "failed" };
		}
		const latest = pickLatestTag(lsRemote);
		if (!latest) {
			writeUpdateState("no-tags");
			return { state: "no-tags" };
		}
		const head = (runGitQuiet(["rev-parse", "HEAD"], 5000) ?? "").toLowerCase();
		if (head === latest.sha) {
			writeUpdateState("current", { tag: latest.tag });
			return { state: "current", tag: latest.tag };
		}
		// 落后了。有未提交的跟踪文件改动就停手 —— 那是别人的活儿，不该被 reset 掉
		const dirty = runGitQuiet(["status", "--porcelain", "--untracked-files=no"], 10_000);
		if (dirty) {
			writeUpdateState("dirty", { tag: latest.tag, detail: dirty.slice(0, 500) });
			return { state: "dirty", tag: latest.tag };
		}
		if (runGitQuiet(["fetch", "--no-tags", "origin", latest.tag], 180_000) === undefined) {
			writeUpdateState("failed", { tag: latest.tag });
			return { state: "failed", tag: latest.tag };
		}
		if (runGitQuiet(["reset", "--hard", "FETCH_HEAD"], 30_000) === undefined) {
			writeUpdateState("failed", { tag: latest.tag });
			return { state: "failed", tag: latest.tag };
		}
		retargetBaselineRef(latest.tag);
		writeUpdateState("updated", { tag: latest.tag, from });
		return { state: "updated", tag: latest.tag, from };
	} finally {
		if (locked) {
			try {
				fs.rmSync(lock, { force: true });
			} catch {
				// 下次靠 mtime 兜底
			}
		}
	}
}

/** `/team-baseline` 与调试输出里给人看的一行 */
function selfUpdateLabel(r: SelfUpdateResult): string {
	switch (r.state) {
		case "updated":
			return `✓ 本次启动已自动更新到 ${r.tag}（重启 pi 后生效）`;
		case "current":
			return `✓ 已是最新 tag${r.tag ? ` ${r.tag}` : ""}`;
		case "throttled":
			return "（本轮没查：距上次检查不到 TTL；设 PI_BASELINE_UPDATE_TTL_HOURS=0 可强制每次查）";
		case "off":
			return "已关闭（PI_BASELINE_SELF_UPDATE=off）";
		case "not-a-clone":
			return "（不是 pi 装出来的包目录，没动）";
		case "branch-ref":
			return "（源钉的是分支/commit，不自动跟 tag —— 想自动跟就改成钉 vX.Y.Z）";
		case "locked":
			return "（另一个 pi 正在更新，本轮跳过）";
		case "no-tags":
			return "（远端没有 vX.Y.Z 形式的 tag）";
		case "dirty":
			return `⚠ 远端已有 ${r.tag}，但包目录里有未提交改动，没敢动`;
		default:
			return "（跳过：git 或网络失败）";
	}
}

export default function teamBaseline(pi: ExtensionAPI) {
	const version = packageVersion();
	const problems = healthCheck();

	// 自检失败立刻报警。stderr 在任何模式下都可见。
	if (problems.length > 0) {
		console.error(
			`[team-baseline] 自检未通过（pi-workflow ${version}）:\n` +
				problems.map((p) => `  ✗ ${p}`).join("\n"),
		);
	}

	// ★ 这两个同步要在 pi 检查"缺哪些包"之前做完，所以放在扩展加载时（而不是 agent 启动时）。
	//   放在 before_agent_start 里会晚一步，导致成员必须启动两次才拿到清单里的扩展（实测踩过）。
	const bootProjectDir = process.cwd();
	let mcpResult: McpSync = "error";
	try {
		mcpResult = syncMcpBaseline(bootProjectDir);
	} catch {
		mcpResult = "error";
	}
	let pkgResult: PkgSync = "none";
	try {
		pkgResult = syncPackagesManifest(bootProjectDir);
		if (pkgResult === "added") {
			console.error(
				"[team-baseline] 已把团队清单里的扩展写进配置 —— **请退出再启动一次 pi**，它们会被装上（pi 的包安装发生在扩展加载之前，所以差了这一步）",
			);
		}
	} catch {
		pkgResult = "error";
	}

	// 团队共享设置（只补缺）+ 扩展自己的配置文件（只补不覆盖）
	let settingsResult: SettingsSync = "none";
	try {
		settingsResult = syncAgentSettings();
		if (settingsResult === "merged") {
			console.error(
				"[team-baseline] 已把团队共享设置补进 ~/.pi/agent/settings.json（只补了缺的键，你的手改没动）—— **重启 pi 生效**",
			);
		} else if (settingsResult === "error") {
			console.error(
				"[team-baseline] 团队共享设置写入失败（settings.json 不是合法 JSON 或没写权限）—— 本次按你原来的设置跑",
			);
		}
	} catch {
		settingsResult = "error";
	}
	let modelsResult: ModelsSync = "none";
	try {
		modelsResult = syncModelsConfig();
		if (modelsResult === "merged") {
			console.error(
				"[team-baseline] 已把团队模型配置（网关 + 档位别名）补进 ~/.pi/agent/models.json（只补缺的 provider 与档位，你已有的定义没动）—— **重启 pi 生效**",
			);
		} else if (modelsResult === "error") {
			console.error(
				"[team-baseline] 团队模型配置写入失败（models.json 不是合法 JSON 或没写权限）—— 本次按你原来的配置跑",
			);
		}
	} catch {
		modelsResult = "error";
	}
	let extConfigsWritten: string[] = [];
	try {
		const synced = syncExtensionConfigs();
		extConfigsWritten = synced.written;
		if (synced.written.length > 0) {
			console.error(
				`[team-baseline] 已补上扩展默认配置：${synced.written.join("、")}（已有配置的扩展一律没动）—— **重启 pi 生效**`,
			);
		}
		if (synced.failed.length > 0) {
			console.error(`[team-baseline] 扩展配置写入失败：${synced.failed.join("、")}`);
		}
	} catch {
		extConfigsWritten = [];
	}

	// pi-rtk-optimizer 需要的 rtk 二进制：缺了就从包里补一份
	let rtkResult: RtkState = "ok";
	try {
		rtkResult = ensureRtk();
		if (rtkResult === "installed") {
			console.error(
				"[team-baseline] 已把 rtk 装好（PATH 里能找到）—— **重启 pi** 后命令压缩就会生效",
			);
		} else if (rtkResult === "not-in-path") {
			console.error(
				`[team-baseline] rtk 已装好，但所在目录**不在 PATH 里** —— 请把 ${path.join(os.homedir(), ".local", "bin")} 加进 PATH，否则命令压缩不生效`,
			);
		} else if (rtkResult === "no-bundle") {
			console.error(
				`[team-baseline] 缺 rtk 且包里没有对应平台的二进制（当前 ${process.platform}）—— 请手动安装：https://github.com/rtk-ai/rtk`,
			);
		}
	} catch {
		rtkResult = "error";
	}

	// ★ 自动更新放在**最后**：这次会话用的还是旧版内容（pi 在扩展加载前就把资源列表收完了），
	//   这里只把 clone 拉到最新 tag，下次启动才是新版。维护者只管 push tag，成员零动作。
	let selfUpdateResult: SelfUpdateResult = { state: "off" };
	try {
		selfUpdateResult = selfUpdate();
		if (selfUpdateResult.state === "updated") {
			console.error(
				`[team-baseline] 团队基线已自动更新：${selfUpdateResult.from ? `${selfUpdateResult.from} → ` : ""}${selfUpdateResult.tag}` +
					"（包目录已切到最新 tag，设置里的 ref 也改好了）—— **重启 pi 生效**",
			);
		} else if (selfUpdateResult.state === "dirty") {
			console.error(
				`[team-baseline] 远端已有新版本 ${selfUpdateResult.tag}，但包目录里有未提交的改动 —— 没敢动。` +
					`手动升级：pi install git:github.com/kurumi1ksllq/pi-workflow@${selfUpdateResult.tag}`,
			);
		}
	} catch {
		selfUpdateResult = { state: "failed" };
	}

	pi.on("before_agent_start", async (event) => {
		const projectDir = process.cwd();
		const rules = readIfExists(rulesFile);
		if (!rules?.trim()) return;

		const status = problems.length > 0 ? "；⚠ 自检发现问题，详见 stderr" : "";
		const injected =
			event.systemPrompt +
			`

## 团队基线规范

（来源：pi-workflow ${version}，由 team-baseline 扩展注入${status}）

以下规范优先级高于你的默认习惯：

${rules.trim()}
`;

		if (process.env.PI_BASELINE_DEBUG) {
			try {
				const dir = path.join(projectDir, ".pi");
				fs.mkdirSync(dir, { recursive: true });
				const diag =
					`packageRoot=${packageRoot}\n` +
					`version=${version}\n` +
					`rulesFile exists=${fs.existsSync(rulesFile)}\n` +
					`mcpTemplate exists=${fs.existsSync(mcpTemplateFile)}\n` +
					`mcpSync=${mcpResult}\n` +
					`pkgSync=${pkgResult}\n` +
					`settingsSync=${settingsResult}\n` +
					`modelsSync=${modelsResult}\n` +
					`extConfigsSync=${extConfigsWritten.length ? extConfigsWritten.join(",") : "(无)"}\n` +
					`rtkSync=${rtkResult}\n` +
					`selfUpdate=${selfUpdateResult.state}${selfUpdateResult.tag ? ` (${selfUpdateResult.tag})` : ""}\n` +
					`problems=${problems.length ? problems.join(" | ") : "(无)"}\n` +
					`cwd=${projectDir}\n\n`;
				fs.writeFileSync(path.join(dir, "team-baseline.debug.txt"), diag + injected, "utf-8");
			} catch {
				// 调试输出失败不影响正常流程
			}
		}

		return { systemPrompt: injected };
	});

	// 交互模式下的可见提示（print 模式这个事件不触发，但上面的 stderr 已经覆盖了）
	pi.on("session_start", async (_event, ctx) => {
		if (problems.length > 0) {
			ctx.ui.notify(`团队基线自检未通过：${problems.join("；")}`, "info");
		}
	});

	pi.registerCommand("team-baseline", {
		description: "查看团队基线的来源、版本与同步状态",
		handler: async (_args, ctx) => {
			const ok = (b: boolean) => (b ? "✓" : "✗");
			const projectMcp = path.join(ctx.cwd, ".mcp.json");
			ctx.ui.notify(
				[
					`pi-workflow ${version}`,
					`包位置：${packageRoot}`,
					`团队规范：${ok(fs.existsSync(rulesFile))}`,
					`MCP 模板：${ok(fs.existsSync(mcpTemplateFile))}`,
					`共享设置模板：${ok(fs.existsSync(agentSettingsFile))}`,
					`模型配置模板：${ok(fs.existsSync(modelsTemplateFile))}`,
					`扩展配置模板：${ok(fs.existsSync(extensionConfigsDir))}`,
					`本次启动同步：清单 ${pkgResult} / 共享设置 ${settingsResult} / 模型配置 ${modelsResult} / 扩展配置 ${extConfigsWritten.length ? extConfigsWritten.join("、") : "无"}`,
					`自动更新：${selfUpdateLabel(selfUpdateResult)}`,
					`本项目 .mcp.json：${fs.existsSync(projectMcp) ? "存在" : "不存在"}`,
					`自检：${problems.length === 0 ? "✓ 全部通过" : "✗ " + problems.join("；")}`,
					"",
					"（这条命令能跑出来，本身就说明 team-baseline 扩展在工作）",
				].join("\n"),
				"info",
			);
		},
	});
}
