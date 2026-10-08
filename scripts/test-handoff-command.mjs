// 离线验证 /handoff 命令：把扩展的 registerCommand 抓出来直接调 handler。
// 不启动 pi、不耗 token、不碰用户目录（在 mkdtemp 沙箱里跑）。
//
// 覆盖：
//   1. 命令注册了（有 description、有 handler）
//   2. 默认落点是 docs/.handoff.md（避开项目里人写的 docs/HANDOFF.md）
//   3. HANDOFF_FILE 能改落点
//   4. 素材文件真的写出来了，内容含「下一步 / 最近需求 / 改动文件 / git」
//   5. newSession 被调用，且给新会话的指令是「整理+续写」，明写「不要整篇覆盖」
//   6. --doc-only 让新会话只整理文档、不开发
//   7. 阈值提醒：低于阈值不注入；越档注入一次；同档不重复
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = "E:/Project-hub/team-pi/extensions/handoff.ts";

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? "  " + extra : ""}`); }
};

// 每个场景用独立沙箱（扩展顶层读 env，改 env 后要重新 import 才能重求值）
async function loadExt() {
  const mod = await import(pathToFileURL(extPath).href + "?v=" + Date.now() + Math.random());
  const commands = {};
  const handlers = {};
  const api = {
    on: (name, fn) => { handlers[name] = fn; },
    registerCommand: (name, opts) => { commands[name] = opts; },
    registerTool: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerMarkdownTransformer: () => {},
    registerEntryRenderer: () => {},
    sendMessage: () => {},
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  mod.default(api);
  return { commands, handlers };
}

// 造一个假会话 ctx：有历史（一条 user + 一条 assistant，assistant 里带一次 edit 工具调用）
function makeCtx(cwd, opts = {}) {
  const notices = [];
  const newSessionCalls = [];
  const entries = [
    { type: "message", message: { role: "user", content: "把 calc.py 的 a-b 改成 a+b" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "改好了，a-b 现在是 a+b。" },
          { type: "toolCall", name: "edit", arguments: { file_path: join(cwd, "calc.py") } },
        ],
      },
    },
  ];
  const ctx = {
    cwd,
    sessionManager: { getEntries: () => entries },
    getContextUsage: () => opts.usage ?? { tokens: 1000, contextWindow: 512000, percent: 0.2 },
    ui: { notify: (msg, level) => notices.push({ msg, level }) },
    newSession: async (arg) => { newSessionCalls.push(arg); return { cancelled: false }; },
  };
  return { ctx, notices, newSessionCalls };
}

// ── 1. 注册 ──
console.log("/handoff 命令注册验证");
const { commands, handlers } = await loadExt();
check("handoff 命令已注册", "handoff" in commands);
check("有 description", typeof commands.handoff?.description === "string" && commands.handoff.description.length > 0);
check("description 里带默认落点 docs/.handoff.md", /docs\/\.handoff\.md/.test(commands.handoff?.description || ""));
check("有 handler", typeof commands.handoff?.handler === "function");
check("挂了 before_agent_start", typeof handlers.before_agent_start === "function");

// ── 2. 默认落点 ──
console.log("\n默认落点（避开项目里人写的 docs/HANDOFF.md）");
const sb1 = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
const { ctx: c1, newSessionCalls: n1 } = makeCtx(sb1);
await commands.handoff.handler("接着补单元测试", c1);
const defaultDoc = join(sb1, "docs", ".handoff.md");
const material1 = join(sb1, "docs", ".handoff-material.md");
// 设计：扩展只写**素材**，交接文档由新会话的模型整理续写 —— 所以这里断言「扩展没有预先创建交接文档」。
check("扩展不预先创建交接文档（留给模型写）", !existsSync(defaultDoc), defaultDoc);
check("没有误建 docs/HANDOFF.md", !existsSync(join(sb1, "docs", "HANDOFF.md")));
check("素材文件写出来了", existsSync(material1));
if (existsSync(material1)) {
  const m = readFileSync(material1, "utf-8");
  check("素材含「下一步」且记下了那句话", m.includes("本次给出的「下一步」") && m.includes("接着补单元测试"));
  check("素材含最近需求", m.includes("最近需求") && m.includes("a-b 改成 a+b"));
  check("素材含改动文件（edit calc.py）", m.includes("最近改动文件") && /edit:.*calc\.py/.test(m));
  check("素材含 git 段", m.includes("## git"));
}
check("newSession 被调用", n1.length === 1);
const sent1 = n1[0]?.withSession ? await captureSend(n1[0]) : null;
const sent1n = (sent1 || "").replace(/\\/g, "/"); // Windows 下 join 出反斜杠，断言前归一化
check("指令要求「整理续写」", /整理续写|整理 \+ 续写|整理\+续写/.test(sent1 || ""), sent1?.slice(0, 80));
check("指令明写「不要整篇覆盖」", /不要整篇覆盖/.test(sent1 || ""));
check("指令指向交接文档", sent1n.includes("docs/.handoff.md"), sent1n.slice(0, 140));
check("指令指向素材文件", sent1n.includes(".handoff-material.md"));

// 抓 withSession 里 sendUserMessage 的内容（真调一次）
async function captureSend(call) {
  let captured = null;
  await call.withSession({ sendUserMessage: async (t) => { captured = t; } });
  return captured;
}

// ── 3. HANDOFF_FILE 改落点 ──
console.log("\nHANDOFF_FILE 改落点");
const sb2 = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
process.env.HANDOFF_FILE = "HANDOFF.auto.md";
const { commands: cmd2 } = await loadExt();
const { ctx: c2, newSessionCalls: n2 } = makeCtx(sb2);
await cmd2.handoff.handler("", c2);
check("改落点后素材落在项目根（HANDOFF.auto.md 同目录）", existsSync(join(sb2, ".handoff-material.md")), sb2);
check("没再建 docs/.handoff.md", !existsSync(join(sb2, "docs", ".handoff.md")));
const sent2 = n2[0]?.withSession ? await captureSend(n2[0]) : null;
check("指令里的落点跟着改成 HANDOFF.auto.md", (sent2 || "").replace(/\\/g, "/").includes("HANDOFF.auto.md"), sent2?.slice(0, 120));
delete process.env.HANDOFF_FILE;

// ── 4. --doc-only ──
console.log("\n--doc-only（只整理文档、不开发）");
const { commands: cmd3 } = await loadExt();
const sb3 = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
const { ctx: c3, newSessionCalls: n3 } = makeCtx(sb3);
await cmd3.handoff.handler("--doc-only 只整理", c3);
const sent3 = n3[0]?.withSession ? await captureSend(n3[0]) : null;
check("--doc-only 指令写「只整理文档，不要开发」", /只整理文档，不要开发/.test(sent3 || ""), sent3?.slice(0, 100));
check("--doc-only 不写「接着做完」", !/接着做完/.test(sent3 || ""));
const { commands: cmd4 } = await loadExt();
const sb4 = mkdtempSync(join(tmpdir(), "pi-handoff-test-"));
const { ctx: c4, newSessionCalls: n4 } = makeCtx(sb4);
await cmd4.handoff.handler("接着补单元测试", c4);
const sent4 = n4[0]?.withSession ? await captureSend(n4[0]) : null;
check("非 doc-only 指令写「接着做完」", /接着做完/.test(sent4 || ""));

// ── 5. 阈值提醒 ──
console.log("\n阈值提醒（每档只提一次）");
const { handlers: h5 } = await loadExt();
const mkEvent = () => ({ systemPrompt: "BASE" });
// 低于阈值：不注入
let r = h5.before_agent_start(mkEvent(), { getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }) });
check("低于阈值不注入", r == null);
// 越档 72%：注入一次
r = h5.before_agent_start(mkEvent(), { getContextUsage: () => ({ tokens: 720, contextWindow: 1000, percent: 72 }) });
check("越 70% 注入提醒", !!(r && r.message && /上下文已到/.test(r.message.content)));
// 同档（73%）再调：不再注入
r = h5.before_agent_start(mkEvent(), { getContextUsage: () => ({ tokens: 730, contextWindow: 1000, percent: 73 }) });
check("同档不重复注入", r == null);
// 进下一档 85%：再注入一次
r = h5.before_agent_start(mkEvent(), { getContextUsage: () => ({ tokens: 850, contextWindow: 1000, percent: 85 }) });
check("进 80% 档再注入一次", !!(r && r.message && /上下文已到/.test(r.message.content)));

// ── 6. HANDOFF_THRESHOLD 关闭提醒 ──
console.log("\nHANDOFF_THRESHOLD 关闭提醒");
process.env.HANDOFF_THRESHOLD = "101";
const { handlers: h6 } = await loadExt();
r = h6.before_agent_start(mkEvent(), { getContextUsage: () => ({ tokens: 990, contextWindow: 1000, percent: 99 }) });
check("阈值 101 时不注入", r == null);
delete process.env.HANDOFF_THRESHOLD;

// 清理
for (const d of [sb1, sb2, sb3, sb4]) rmSync(d, { recursive: true, force: true });

console.log(`\n${pass} 项通过, ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
