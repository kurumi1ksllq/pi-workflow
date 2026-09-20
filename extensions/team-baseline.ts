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
const pkgJsonFile = path.join(packageRoot, "package.json");

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
			for (const entry of pkgs) {
				const spec = String(entry);
				if (!spec.includes("pi-workflow")) continue;
				const m = spec.match(/@(v\d+\.\d+\.\d+[^@]*)$/);
				if (m) return m[1];
			}
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
					`rtkSync=${rtkResult}\n` +
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
