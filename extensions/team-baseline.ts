/**
 * team-baseline —— 团队基线引导扩展
 *
 * 解决 pi 的两个边界：
 *   1. 包内的 AGENTS.md 不会被加载（pi 只扫 cwd 祖先链 + ~/.pi/agent/）
 *      -> 这个扩展把包里的 team/RULES.md 追加进系统提示
 *   2. MCP 配置没有"从包里读"的入口（pi-mcp-adapter 只认固定几个位置）
 *      -> 项目里没有 .mcp.json 时，从包里补一份（只补不覆盖）
 *
 * 装法：随团队包分发，成员 `pi install -l <包>` 后自动生效，不需要额外操作。
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

export default function teamBaseline(pi: ExtensionAPI) {
	// 1. 团队规范注入系统提示
	pi.on("before_agent_start", async (event) => {
		const rules = readIfExists(rulesFile);
		if (!rules?.trim()) return;
		return {
			systemPrompt:
				event.systemPrompt +
				`

## 团队基线规范

以下规范来自团队 pi 基线包，优先级高于你的默认习惯：

${rules.trim()}
`,
		};
	});

	// 2. MCP 基线：只在项目没有 .mcp.json 时补，绝不覆盖已有的
	pi.on("session_start", async (_event, ctx) => {
		const projectMcp = path.join(ctx.cwd, ".mcp.json");
		if (fs.existsSync(projectMcp)) return;
		const template = readIfExists(mcpTemplateFile);
		if (!template) return;
		try {
			const parsed = JSON.parse(template);
			if (!parsed?.mcpServers || Object.keys(parsed.mcpServers).length === 0) return;
			fs.writeFileSync(projectMcp, template, "utf-8");
			ctx.ui.notify("已从团队基线补上 .mcp.json —— 凭据请用环境变量自行配置", "info");
		} catch {
			// 模板不合法就什么都不做
		}
	});

	// 3. 让人随时能查基线状态
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
