// 离线验证 /audit 命令：把扩展的 registerCommand 抓出来直接调 handler。
// 不启动 pi、不耗 token。
import { readFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const extPath = "E:/hermes/team-pi/extensions/team-baseline.ts";

// 先记下真实家目录（改 env 之前），末尾用来断言「没污染用户目录」。
const homedirReal = homedir();

// ⚠ 隔离家目录（验证产物不落用户目录），但数据源要显式指回真实位置：
// 脚本读 `PI_AUDIT_DIR`（日志）和 `PI_CODING_AGENT_DIR`（子代理 sessions），
// 不设的话会去找 `<沙箱>/.pi/...` → 空数据 → 报表从 6xx 行缩到 1xx 行（踩过）。
const sandbox = mkdtempSync(join(tmpdir(), "pi-audit-test-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
process.env.PI_AUDIT_DIR = join(homedirReal, ".pi", "agent", "audit", "logs");
process.env.PI_CODING_AGENT_DIR = join(homedirReal, ".pi", "agent");

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

const mod = await import(pathToFileURL(extPath).href);
mod.default(api);

let pass = 0, fail = 0;
const check = (label, ok, extra = "") => {
  if (ok) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${extra ? "  " + extra : ""}`); }
};

console.log("/audit 命令注册验证");
console.log("  注册的命令:", Object.keys(commands).join(", "));
check("audit 命令已注册", "audit" in commands);
check("audit 有 description", typeof commands.audit?.description === "string" && commands.audit.description.length > 0);
check("audit 有 handler", typeof commands.audit?.handler === "function");

// 真的调一次 handler —— 这才是「命令能不能跑」的证据
const notices = [];
const ctx = {
  cwd: "E:/hermes/team-pi",
  ui: {
    notify: (msg, level) => { notices.push({ msg, level }); },
  },
};

console.log("\n真机调用 handler（无参 → 默认 --all-days）…");
const t0 = Date.now();
await commands.audit.handler("", ctx);
const secs = ((Date.now() - t0) / 1000).toFixed(1);

for (const n of notices) console.log(`  [${n.level}] ${n.msg.split("\n").slice(0, 3).join(" | ")}`);

const final = notices[notices.length - 1];
const okMsg = final && final.level === "info" && /报表已生成/.test(final.msg);
check("handler 跑完并报出「报表已生成」", !!okMsg, final ? final.msg.slice(0, 120) : "(没有 notify)");

// 产物真的落盘了吗
const m = final && final.msg.match(/报表已生成：(\S+?)（/);
const outFile = m ? m[1] : null;
check("产物路径能解析出来", !!outFile, String(outFile));
check("产物文件真的存在", outFile ? existsSync(outFile) : false, String(outFile));
if (outFile && existsSync(outFile)) {
  const body = readFileSync(outFile, "utf-8");
  check("产物非空", body.length > 1000, `${body.length} 字符`);
  check("产物是 Markdown 报表", body.startsWith("# pi 审计报表"), body.slice(0, 40));
  check("产物含按模型段", body.includes("按模型"));
  check("产物含 token 口径（无金额段）", !body.includes("成本") || !body.includes("$"));
}
check("耗时在 2 分钟内", Number(secs) < 120, `${secs}s`);

// ── 参数透传：--since / --until / --label 有没有真传到脚本里 ──
console.log("\n参数透传验证");
async function runAudit(args) {
  const ns = [];
  await commands.audit.handler(args, {
    cwd: "E:/hermes/team-pi",
    ui: { notify: (msg, level) => ns.push({ msg, level }) },
  });
  const f = ns[ns.length - 1];
  const mm = f.msg.match(/报表已生成：(\S+?)（/);
  return { final: f, file: mm ? mm[1] : null };
}

const rs = await runAudit("--since 2026-09-25");
check("--since 跑成功", rs.file && existsSync(rs.file));
if (rs.file && existsSync(rs.file)) {
  const b = readFileSync(rs.file, "utf-8");
  const range = (b.match(/时间范围 \| ([^|]+) \|/) || [])[1];
  check("--since 真的收窄了起点", !!range && range.trim().startsWith("2026-09-25"), String(range));
}

const rl = await runAudit("--label 张三");
if (rl.file && existsSync(rl.file)) {
  const b = readFileSync(rl.file, "utf-8");
  check("--label 标进数据源", b.includes("（张三）"));
  // 有 label 就渲染「按人」段（与源数量无关）；无 label 才整段跳过。
  check("带 --label 时渲染「按人」段", /## 4\. 按人/.test(b));
  check("「按人」段含该 label", /## 4\. 按人[\s\S]{0,400}张三/.test(b));
}

// 多源 + label → 「按人」段必须出现，且两个名字都在
const multi = await runAudit(
  `--dir ${homedirReal}/.pi/agent/audit/logs --label 张三 --dir ${homedirReal}/.pi/agent/audit/logs --label 李四`,
);
if (multi.file && existsSync(multi.file)) {
  const b = readFileSync(multi.file, "utf-8");
  check("多源时渲染「按人」段", /## 4\. 按人/.test(b));
  check("「按人」段含两个名字", b.includes("张三") && b.includes("李四"));
}

// 不同参数必须落**不同文件**，否则后跑的会覆盖先跑的（踩过：--label 张三 覆盖了全量报表）
const files = new Set([outFile, rs.file, rl.file, multi.file].filter(Boolean));
check("四种参数落在四个不同文件（不互相覆盖）", files.size === 4, [...files].join(" | "));

// 产物必须落在沙里，不许碰用户真实目录
const realDir = join(homedirReal, ".pi", "agent", "audit", "reports");
const leaked = outFile && !outFile.startsWith(sandbox);
check("产物写在隔离沙箱内（没污染用户目录）", !leaked, String(outFile));

// 同参数重跑应覆盖同一个文件（幂等）
const again = await runAudit("");
check("同参数重跑覆盖同一文件（幂等）", again.file === outFile, `${again.file} vs ${outFile}`);

rmSync(sandbox, { recursive: true, force: true });

console.log(`\n耗时 ${secs}s  |  ${pass} 项通过, ${fail} 项失败`);
process.exit(fail === 0 ? 0 : 1);
