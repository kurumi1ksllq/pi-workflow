// 验「新装的环境里 /audit 命令真能用」——不启动 pi、不耗 token。
//
// 用法：node scripts/probe-audit-command.mjs <已装的clone路径> <日志目录> <HOME沙箱>
//
// 做什么：用 mock 的 pi 对象 import 那个 clone 里的 team-baseline.ts，
// 抓出 /audit 的 handler 直接调，然后检查报表文件真被写出来、内容像报表。
// 在 simulate-member.sh 里跑，验的是**成员拿到的那份产物**，不是工作副本。
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [cloneDir, logsDir, homeDir, agentDir] = process.argv.slice(2);
if (!cloneDir || !logsDir || !homeDir) {
  console.error("用法: node probe-audit-command.mjs <clone路径> <日志目录> <HOME沙箱> [agent目录]");
  process.exit(2);
}

// 输出目录跟着 HOME 走 → 指到沙箱，别碰用户真实报表目录
process.env.USERPROFILE = homeDir;
process.env.HOME = homeDir;
// 数据源显式给：只改 HOME 会让脚本去找 <沙箱>/.pi/agent/audit/logs（空的）
process.env.PI_AUDIT_DIR = logsDir;
// 子代理产物目录：默认跟沙箱（模拟成员时就是他的 agent 目录），也可显式给
process.env.PI_CODING_AGENT_DIR = agentDir || join(homeDir, ".pi", "agent");

// 比较路径前统一分隔符（Windows 上一个是 C:/ 一个是 C:\）
const norm = (s) => s.replace(/\\/g, "/").toLowerCase();

const ext = join(cloneDir, "extensions", "team-baseline.ts");
if (!existsSync(ext)) {
  console.log(`  ✗ 装的 clone 里没有 team-baseline.ts：${ext}`);
  process.exit(1);
}

const commands = {};
const api = {
  on: () => {},
  registerCommand: (name, opts) => { commands[name] = opts; },
  registerTool: () => {}, registerShortcut: () => {}, registerFlag: () => {},
  getFlag: () => undefined, registerMessageRenderer: () => {},
  registerMarkdownTransformer: () => {}, registerEntryRenderer: () => {},
  sendMessage: () => {}, exec: async () => ({ code: 1, stdout: "", stderr: "" }),
};

const mod = await import(pathToFileURL(ext).href);
mod.default(api);

if (!commands.audit) {
  console.log(`  ✗ 装的 clone 里没有注册 /audit 命令（装到的还是旧版）`);
  console.log(`    已注册的命令：${Object.keys(commands).join(", ") || "(无)"}`);
  process.exit(1);
}
console.log(`  ✓ 装的 clone 里注册了 /audit：${commands.audit.description.slice(0, 60)}…`);

const notices = [];
await commands.audit.handler("", {
  cwd: cloneDir,
  ui: { notify: (msg, level) => notices.push({ msg, level }) },
});

const final = notices[notices.length - 1]?.msg || "";
const m = final.match(/报表已生成：(\S+?)（/);
const outFile = m ? m[1] : null;

if (!outFile || !existsSync(outFile)) {
  console.log(`  ✗ 命令跑了但没写出报表。最后一条提示：${final.slice(0, 200)}`);
  process.exit(1);
}

const body = readFileSync(outFile, "utf-8");
const lines = body.split("\n").length;
const hasSections = /## 1\. 概览/.test(body) && /## 2\. token 分布/.test(body);
const noMoney = !/成本（折算）/.test(body); // 本团队只用 token 口径

console.log(`  ✓ /audit 在新装环境里真跑通：${outFile}`);
console.log(`    报表 ${lines} 行 | 段完整=${hasSections} | 无金额段=${noMoney}`);
console.log(`    产物落在沙箱内=${norm(outFile).startsWith(norm(homeDir))}`);

if (!hasSections || !noMoney) {
  console.log("  ✗ 报表内容不对（缺段或含金额段）");
  process.exit(1);
}
if (!norm(outFile).startsWith(norm(homeDir))) {
  console.log("  ✗ 产物没落在沙箱里 —— 污染了用户真实目录");
  process.exit(1);
}
process.exit(0);
