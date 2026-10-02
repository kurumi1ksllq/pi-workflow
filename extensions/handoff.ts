/**
 * handoff —— 会话交接扩展（团队基线版）
 *
 * 干什么：一条斜杠命令，把当前会话的机械记录（最近需求/改动文件/最后状态/git/下一步）
 *         抽成一份**素材**文件，然后开一个新会话，让新会话里的模型**读懂旧文档 + 素材**，
 *         在保留旧内容的前提下「整理 + 续写」交接文档 —— 而不是脚本式整篇覆盖。
 *
 * 分工：扩展只做机械的事（抽取、开新会话）；判断与写作交给模型（它理解现状再动手）。
 *
 * 用法：
 *   /handoff [下一步一句话]            抽素材 + 切新会话，新会话整理续写文档并接着干
 *   /handoff --doc-only [下一步一句话] 同上，但新会话只整理文档、不开发
 *
 * 阈值提醒：每轮开始时若上下文占用越过 70/80/90% 的新档位，注入一条提醒（每档只提一次）。
 * 阈值可用环境变量 HANDOFF_THRESHOLD 改（默认 70）；设 >100 关闭提醒。
 *
 * 环境变量：
 *   HANDOFF_THRESHOLD  提醒阈值，默认 70（百分比）
 *   HANDOFF_FILE       交接文档落点，默认 docs/.handoff.md（相对项目根）
 *
 * 落点为什么默认是 docs/.handoff.md（点文件）：
 *   很多项目已经有人手写的 docs/HANDOFF.md（历史记录/接手说明）。自动交接若写同名文件，
 *   会去「续写」一份本该由人维护的文档 —— 语义混在一起。点文件把两者分开；要改落点用 HANDOFF_FILE。
 *
 * 边界（pi 的设计，不是本扩展的限制）：
 *   - 只有斜杠命令的 ctx 有 newSession；工具 ctx 没有 → 无法由模型自己触发切换，
 *     必须由人敲 /handoff。这是 pi 故意的（模型不能自行清空上下文）。
 *   - 扩展只落本机文件、绝不联网。完全停用：把本文件从包里删掉，或把 HANDOFF_THRESHOLD 设 >100
 *     只关提醒（命令仍可用）。
 *
 * ⚠️ 本扩展已随团队包分发。本机若还留着同名副本（<agent dir>/extensions/handoff.ts），
 *    pi 会按路径加载两份 —— 扩展副作用跑两遍、命令注册两次。进包后务必删掉本机副本。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname, relative, isAbsolute } from "node:path";
import { execSync } from "node:child_process";

type Blk = { type?: string; text?: string; name?: string; toolName?: string; arguments?: any; args?: any };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Blk[])
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text ?? "" : ""))
      .join("");
  }
  return "";
}

const THRESHOLD = (() => {
  const v = Number(process.env.HANDOFF_THRESHOLD);
  return Number.isFinite(v) && v > 0 ? v : 70;
})();

// 交接文档落点（相对项目根）；素材写在同目录下的隐藏文件。
const DOC_REL = process.env.HANDOFF_FILE || "docs/.handoff.md";

export default function (pi: ExtensionAPI) {
  let lastBucket = -1; // 提醒过的 10% 档位

  // ---- 阈值提醒（每档只提一次） ----
  pi.on("before_agent_start", (_e: any, ctx: any) => {
    if (THRESHOLD > 100) return;
    let usage: any;
    try {
      usage = ctx.getContextUsage();
    } catch {
      return;
    }
    if (!usage || typeof usage.percent !== "number") return;
    const p = usage.percent;
    if (p < THRESHOLD) return;
    const bucket = Math.floor(p / 10);
    if (bucket <= lastBucket) return;
    lastBucket = bucket;
    return {
      message: {
        customType: "handoff-reminder",
        content:
          `⚠ 上下文已到 ${p.toFixed(1)}%（${usage.tokens}/${usage.contextWindow}）。` +
          `建议敲 /handoff 把状态交接进项目文档并切到新会话，避免长会话越跑越贵。`,
        display: true,
      },
    };
  });

  // ---- /handoff 命令 ----
  pi.registerCommand("handoff", {
    description:
      `抽交接素材并切到新会话，由新会话整理+续写项目交接文档（${DOC_REL}）。用法：/handoff [--doc-only] [下一步一句话]`,
    handler: async (args: string, ctx: any) => {
      const docOnly = /--doc-only\b/.test(args);
      const note = args.replace(/--doc-only\b/, "").trim();
      const cwd: string = ctx.cwd;

      // ---- 机械抽取：最近需求 / 改动文件 / 最后状态 ----
      let entries: any[] = [];
      try {
        entries = ctx.sessionManager.getEntries();
      } catch {
        /* keep empty */
      }

      const users = entries
        .filter((e) => e?.type === "message" && e.message?.role === "user")
        .map((e) => textOf(e.message.content))
        .filter(Boolean);
      const asst = entries
        .filter((e) => e?.type === "message" && e.message?.role === "assistant")
        .map((e) => textOf(e.message.content))
        .filter(Boolean);

      const touched = new Set<string>();
      for (const e of entries) {
        if (e?.type !== "message" || !Array.isArray(e.message?.content)) continue;
        for (const c of e.message.content as Blk[]) {
          if (c?.type !== "toolCall" && c?.type !== "tool_call") continue;
          const name = c.name || c.toolName || "tool";
          if (!/^(edit|write|multiedit|patch)$/i.test(name)) continue;
          const a = c.arguments || c.args || {};
          const p = a.file_path || a.path || a.filePath;
          if (p) touched.add(`${name}: ${p}`);
        }
      }

      let usage: any = null;
      try {
        usage = ctx.getContextUsage();
      } catch {
        /* ignore */
      }

      let git = "";
      try {
        // 常量命令串、无任何用户输入插值 → 无注入面（用 execSync 只为拿 git 状态）
        git = execSync("git status --short && echo '---' && git log --oneline -3", {
          cwd,
          encoding: "utf-8",
          timeout: 10000,
        });
      } catch {
        git = "(不是 git 仓库 / git 取不到)";
      }

      const docPath = join(cwd, DOC_REL);
      const materialPath = join(dirname(docPath), ".handoff-material.md");
      const docExists = existsSync(docPath);

      const material = [
        `# 交接素材（机械抽取，供整理时参考，不是最终文档）`,
        ``,
        `> ${new Date().toISOString()}` +
          (usage ? ` · 上下文 ${usage.percent.toFixed(1)}% (${usage.tokens}/${usage.contextWindow})` : ``),
        ``,
        `## 本次给出的「下一步」`,
        note || `(未指定)`,
        ``,
        `## 最近需求（倒序）`,
        ...(users.length
          ? users.slice(-8).reverse().map((u) => `- ${u.slice(0, 300).replace(/\n/g, " ")}`)
          : [`- (无)`]),
        ``,
        `## 最近改动文件`,
        ...(touched.size ? [...touched].slice(-25).map((t) => `- ${t}`) : [`- (无)`]),
        ``,
        `## 最后状态（助手原话）`,
        asst.length ? asst[asst.length - 1].slice(0, 2000) : `(无)`,
        ``,
        `## git`,
        "```",
        git.trim(),
        "```",
        ``,
      ].join("\n");

      try {
        const dir = dirname(materialPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(materialPath, material, "utf-8");
      } catch (e) {
        try {
          ctx.ui?.notify?.(`写交接素材失败: ${e}`, "error");
        } catch {
          /* ignore */
        }
        return;
      }

      // 相对路径展示：模型在自己的 cwd 下读更稳
      const rel = (p: string) => (isAbsolute(p) ? relative(cwd, p) || p : p);
      const docShow = rel(docPath);
      const matShow = rel(materialPath);

      const instruction =
        `你刚接手一个进行中的任务（上一个会话因上下文过长而交接）。先做一次**交接整理**，` +
        `不要急着写新代码。\n\n` +
        `1. 读两样东西：交接文档 \`${docShow}\`${docExists ? `` : `（目前不存在，需要新建）`}` +
        ` 和本次交接素材 \`${matShow}\`。\n` +
        `2. 在**保留并更新**旧文档的前提下整理续写 \`${docShow}\`：` +
        `已有条目按最新事实更新状态（已完成/进行中/作废），新的进展追加进去；` +
        `**不要整篇覆盖、不要丢弃仍然有效的历史条目**。旧文档与素材冲突时，以仓库现状为准。\n` +
        `3. 素材里「本次给出的下一步」是你接手后要先做的事${docOnly ? ` —— 但本次只整理文档，不要开发` : ``}。\n` +
        `4. 写回 \`${docShow}\` 后，用两三句话交代：文档改了什么、你理解的当前状态、接下来做什么。` +
        (docOnly ? `` : `\n\n整理完成后，若「下一步」明确就接着做完；若为空，停在文档更新这一步并问我。`);

      await ctx.newSession({
        setup: async (sm: any) => {
          sm.appendCustomMessageEntry(
            "handoff-seed",
            `上一会话已交接。交接文档 ${docShow}，素材 ${matShow}（素材是临时的，整理完可删）。`,
            false,
          );
        },
        withSession: async (nctx: any) => {
          await nctx.sendUserMessage(instruction);
        },
      });
    },
  });
}
