// 验「新装的环境里 /handoff 命令真能用」——不启动 pi、不耗 token。
//
// 用法：node scripts/probe-handoff-command.mjs <已装的clone路径>
//
// 做什么：用 mock 的 pi 对象 import 那个 clone 里的 handoff.ts，
// 抓出 /handoff 的 handler 直接调，然后检查：
//   - 命令注册了（成员装的这份里有）
//   - 素材文件真被写出来、内容含关键段
//   - newSession 被调用、给新会话的指令是「整理+续写」（不是脚本式覆盖）
// 在 simulate-member.sh 里跑，验的是**成员拿到的那份产物**，不是工作副本。
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const cloneDir = process.argv[2];
if (!cloneDir) {
  console.error("用法: node probe-handoff-command.mjs <clone路径>");
  process.exit(2);
}

const ext = join(cloneDir, "extensions", "handoff.ts");
if (!existsSync(ext)) {
  console.log(`  ✗ 装的 clone 里没有 handoff.ts：${ext}（装到的还是旧版）`);
  process.exit(1);
}

const commands = {};
const handlers = {};
const api = {
  on: (name, fn) => { handlers[name] = fn; },
  registerCommand: (name, opts) => { commands[name] = opts; },
  registerTool: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, registerMessageRenderer: () => {},
  registerMarkdownTransformer: () => {}, registerEntryRenderer: () => {},
  sendMessage: () => {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};

const mod = await import(pathToFileURL(ext).href);
mod.default(api);

if (!commands.handoff) {
  console.log(`  ✗ 装的 clone 里没有注册 /handoff 命令`);
  console.log(`    已注册的命令：${Object.keys(commands).join(", ") || "(无)"}`);
  process.exit(1);
}
console.log(`  ✓ 装的 clone 里注册了 /handoff：${commands.handoff.description.slice(0, 50)}…`);

// 用 clone 目录当 cwd（模拟成员在项目里敲）；素材会落 <clone>/docs/.handoff-material.md
let newSessionArg = null;
const entries = [
  { type: "message", message: { role: "user", content: "把 a-b 改成 a+b" } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "改好了。" }, { type: "toolCall", name: "edit", arguments: { file_path: join(cloneDir, "x.py") } }] } },
];
await commands.handoff.handler("接着补测试", {
  cwd: cloneDir,
  sessionManager: { getEntries: () => entries },
  getContextUsage: () => ({ tokens: 1000, contextWindow: 512000, percent: 0.2 }),
  ui: { notify: () => {} },
  newSession: async (arg) => { newSessionArg = arg; return { cancelled: false }; },
});

const material = join(cloneDir, "docs", ".handoff-material.md");
if (!existsSync(material)) {
  console.log(`  ✗ 命令跑了但没写出素材：${material}`);
  process.exit(1);
}
const m = readFileSync(material, "utf-8");
const hasKey = m.includes("本次给出的「下一步」") && m.includes("最近需求") && m.includes("最近改动文件") && m.includes("## git");
if (!hasKey) {
  console.log("  ✗ 素材内容不对（缺关键段）");
  process.exit(1);
}
console.log(`  ✓ 素材已写出：${material}（${m.split("\n").length} 行）`);

if (!newSessionArg?.withSession) {
  console.log("  ✗ 没调用 newSession（不会切新会话）");
  process.exit(1);
}
let sent = null;
await newSessionArg.withSession({ sendUserMessage: async (t) => { sent = t; } });
const n = (sent || "").replace(/\\/g, "/");
if (!/不要整篇覆盖/.test(sent || "")) {
  console.log("  ✗ 给新会话的指令没写「不要整篇覆盖」—— 会退化成脚本式覆盖");
  process.exit(1);
}
if (!n.includes("docs/.handoff.md")) {
  console.log(`  ✗ 指令里的落点不对（期望 docs/.handoff.md）：${n.slice(0, 120)}`);
  process.exit(1);
}
console.log(`  ✓ 新会话指令正确：整理+续写、落点 docs/.handoff.md`);

// 清理探针写的素材，别污染 clone
try { (await import("node:fs")).rmSync(material); } catch {}
process.exit(0);
