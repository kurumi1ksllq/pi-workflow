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
 * 装法：随团队包分发，成员 `pi install -l <包>` 后自动生效。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
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
 */
function packageVersion(): string {
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

type PkgSync = "added" | "none" | "not-a-project" | "error";

/** 去掉末尾的 @ref，用来判断"是不是同一个包" */
function packageKey(spec: string): string {
	return spec.trim().replace(/(@[^@/]+)$/, "");
}

/**
 * 把团队清单（team/packages.json）里的包补进项目的 .pi/settings.json。
 * 只补不删、不动已有的，重复调用安全。
 */
function syncPackagesManifest(projectDir: string): PkgSync {
	const projectSettings = path.join(projectDir, ".pi", "settings.json");
	if (!fs.existsSync(projectSettings)) return "not-a-project";

	const raw = readIfExists(packagesManifestFile);
	if (!raw) return "none";
	let wanted: unknown;
	try {
		wanted = JSON.parse(raw)?.packages;
	} catch {
		return "error";
	}
	if (!Array.isArray(wanted) || wanted.length === 0) return "none";

	let settings: any;
	try {
		settings = JSON.parse(readIfExists(projectSettings) ?? "{}");
	} catch {
		return "error";
	}
	const current: string[] = Array.isArray(settings.packages) ? settings.packages : [];
	const have = new Set(current.map((s) => packageKey(String(s))));
	const missing = (wanted as string[]).filter((w) => !have.has(packageKey(String(w))));
	if (missing.length === 0) return "none";

	settings.packages = [...current, ...missing];
	try {
		fs.writeFileSync(projectSettings, JSON.stringify(settings, null, 2) + "\n", "utf-8");
		return "added";
	} catch {
		return "error";
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

	pi.on("before_agent_start", async (event) => {
		const projectDir = process.cwd();

		let mcpResult: McpSync = "error";
		try {
			mcpResult = syncMcpBaseline(projectDir);
		} catch {
			mcpResult = "error";
		}

		// 团队清单里的第三方包：补进项目设置，下次启动生效
		let pkgResult: PkgSync = "none";
		try {
			pkgResult = syncPackagesManifest(projectDir);
			if (pkgResult === "added") {
				console.error(
					`[team-baseline] 已把团队清单里的新包补进 .pi/settings.json —— 重启 pi 后生效，记得提交这个文件`,
				);
			}
		} catch {
			pkgResult = "error";
		}

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
