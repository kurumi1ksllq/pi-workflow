/**
 * team-baseline —— 团队基线引导扩展
 *
 * 补 pi 的两个边界：
 *   1. 包内的 AGENTS.md 不会被加载（pi 只扫 cwd 祖先链 + ~/.pi/agent/）
 *      -> 把 team/RULES.md 追加进系统提示
 *   2. MCP 配置没有"从包里读"的入口（pi-mcp-adapter 只认固定几个位置）
 *      -> 项目缺 .mcp.json 时从包里补一份（只补不覆盖）
 *
 * ⚠️ 逻辑必须挂在 before_agent_start，不能挂 session_start：
 *    实测 session_start 在 print 模式（-p / --mode json / rpc）下不触发，
 *    挂那里会导致 MCP 基线静默同步失败（这个坑踩过一次）。
 *
 * 装法：随团队包分发，成员 `pi install -l <包>` 后自动生效。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const here = path.dirname(fileURLToPath(import.meta.url));
// extensions/team-baseline.ts -> 团队包根目录
const packageRoot = path.resolve(here, "..");
const rulesFile = path.join(packageRoot, "team", "RULES.md");
const mcpTemplateFile = path.join(packageRoot, "team", "mcp.template.json");

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}

/** 项目缺 .mcp.json 时从包里补一份。只补不覆盖，可重复调用。 */
export function syncMcpBaseline(projectDir: string): boolean {
	const projectMcp = path.join(projectDir, ".mcp.json");
	if (fs.existsSync(projectMcp)) return false;
	const template = readIfExists(mcpTemplateFile);
	if (!template) return false;
	try {
		const parsed = JSON.parse(template);
		if (!parsed?.mcpServers || Object.keys(parsed.mcpServers).length === 0) return false;
		fs.writeFileSync(projectMcp, template, "utf-8");
		return true;
	} catch {
		// 模板不合法就什么都不做
		return false;
	}
}

export default function teamBaseline(pi: ExtensionAPI) {
	// 核心：每次 agent 启动都跑（print 模式和交互模式都会触发）
	pi.on("before_agent_start", async (event) => {
		const projectDir = process.cwd();

		try {
			syncMcpBaseline(projectDir);
		} catch {
			// 同步失败不影响会话
		}

		const rules = readIfExists(rulesFile);
		if (!rules?.trim()) return;

		const injected =
			event.systemPrompt +
			`

## 团队基线规范

以下规范来自团队 pi 基线包，优先级高于你的默认习惯：

${rules.trim()}
`;

		// 自证开关：PI_BASELINE_DEBUG=1 时把完整上下文落到项目里，便于审计
		if (process.env.PI_BASELINE_DEBUG) {
			try {
				const dir = path.join(projectDir, ".pi");
				fs.mkdirSync(dir, { recursive: true });
				const diag =
					`packageRoot=${packageRoot}\n` +
					`rulesFile=${rulesFile} exists=${fs.existsSync(rulesFile)}\n` +
					`mcpTemplateFile=${mcpTemplateFile} exists=${fs.existsSync(mcpTemplateFile)}\n` +
					`cwd=${projectDir}\n\n`;
				fs.writeFileSync(path.join(dir, "team-baseline.debug.txt"), diag + injected, "utf-8");
			} catch {
				// 调试输出失败不影响正常流程
			}
		}

		return { systemPrompt: injected };
	});

	// 交互模式下的可见性：规范读不到就提示（print 模式下这个事件不触发，无害）
	pi.on("session_start", async (_event, ctx) => {
		if (!fs.existsSync(rulesFile)) {
			ctx.ui.notify("团队基线：读不到 team/RULES.md，团队规范没有被注入", "info");
		}
	});

	pi.registerCommand("team-baseline", {
		description: "查看团队基线的来源与同步状态",
		handler: async (_args, ctx) => {
			const ok = (p: string) => (fs.existsSync(p) ? "✓" : "✗");
			ctx.ui.notify(
				[
					`团队包：${packageRoot}`,
					`规范文件 team/RULES.md：${ok(rulesFile)}`,
					`MCP 模板 team/mcp.template.json：${ok(mcpTemplateFile)}`,
					`本项目 .mcp.json：${ok(path.join(ctx.cwd, ".mcp.json"))}`,
				].join("\n"),
				"info",
			);
		},
	});
}
