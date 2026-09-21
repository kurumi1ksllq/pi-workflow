# 审计扩展 audit-log —— 开发要求(spec)

> 目的:让 pi 会话可追溯、可审计、可统计。本文件是交给 pi 开发的**需求书**,不是实现描述。
> 实施顺序:**先只装本机 `~/.pi/agent/extensions/`,跑通验证后**再讨论要不要进团队包 `extensions/`。

## 0. 为什么要写这个扩展(禁止"优化掉")

pi 自己写的 session jsonl(`~/.pi/agent/sessions/<项目编码>/<ISO>_<uuid>.jsonl`)已经包含:user/assistant/toolResult 消息、thinking、toolCall 参数、每次调用的 `usage`(input/cacheRead/cacheWrite/output/reasoning)、`stopReason`、compaction 事件。

它**缺**四样,这四样就是本扩展存在的理由:

| 缺什么 | 后果 |
| --- | --- |
| **system prompt 不在 session 文件里** | 查不到"这次会话加载了哪些 skill、system prompt 是什么" |
| **没有跨会话的单一流** | 统计要按项目编码目录扫一堆文件,团队汇总更没有入口 |
| **没有收敛/中断的显式标记** | "任务完成度"只能靠 `stopReason` 猜,拿不到 `agent_settled` 这种"本轮真的结束了"的信号 |
| **日志体量不可控** | session jsonl 里 toolResult 全文极占地方,做统计要先解析大文件 |

因此:审计日志是**索引 + 指标**,session jsonl 是**内容**。审计日志里每条工具事件带 `toolCallId`,需要原文时用它 join 回 session jsonl —— **不要把 toolResult 全文、thinking 全文抄进审计日志**。

## 1. 交付物

| 文件 | 说明 |
| --- | --- |
| `~/.pi/agent/extensions/audit-log.ts` | 扩展本体(本机验证阶段直接放这里,pi 自动发现 `agentDir/extensions/` 下的直接 `.ts`/`.js` 文件,不用改 settings.json) |
| `scripts/test-audit-extension.mjs` | 离线 mock 测试,不用启动 pi、不用 provider、不碰真实 `~/.pi/agent` |
| `docs/audit-log.md` | 字段表 + 配置项 + 统计口径 + 已知缺口 |

把扩展源码同时留一份在 `E:\hermes\team-pi\extensions\audit-log.ts` 之外的位置无所谓,**验证阶段不算进团队包**。

## 2. 落盘格式

- 目录:`~/.pi/agent/audit/logs/`,按天分文件 `<YYYY-MM-DD>.jsonl`(本地日期,UTC+8 由系统时区决定)
- 目录可用环境变量 `PI_AUDIT_DIR` 覆盖(为将来指到共享盘留口)
- 一事件一行 JSON,`fs.appendFileSync`,`\n` 结尾,UTF-8 无 BOM
- 单行上限 8192 字节:超长字段先按 `maxFieldChars`(默认 2000)截断,再整体兜底;任何截断过的字段旁标 `"truncated": true`
- 追加写、不缓冲、不重排:进程被 kill 也要留下已发生的事件

## 3. 记录哪些事件(字段级)

每条记录都带的公共字段:

```
v: 1                    // schema 版本
ts: "2026-09-21T10:31:02.123+08:00"   // ISO8601 带本地偏移
event: "..."            // 见下表
sessionId: string       // ctx.sessionManager.getSessionId()
sessionFile: string     // ctx.sessionManager.getSessionFile(),拿不到就 null
cwd: string             // ctx.cwd
piVersion: string       // 启动时取一次
model: string|null      // 当前 model,如 "deepseek/deepseek-v4.1-flash"
provider: string|null
seq: number             // 本进程内递增计数器,用于排序与丢行检测
```

事件类型(全部必做):

| event | 触发 | 必记字段 |
| --- | --- | --- |
| `session` | `before_agent_start` 首次触发时写一次(session 级信息) | `reason`(session_start 能给就带上,给不到写 null)、`skillCount`、`systemPromptChars`、`systemPromptSha256`、`skills[]` |
| `turn_start` | `turn_start` | `turnIndex` |
| `user_input` | `input` | `chars`、`sha256`、`source`(interactive/rpc/extension)、`promptPreview`(前 500 字符,`recordFullPrompt=true` 时记全文) |
| `user_bash` | `user_bash` | `commandPreview`(脱敏后前 500 字符)、`excludeFromContext` |
| `tool_call` | `tool_execution_start` | `toolName`、`toolCallId`、`argsPreview`(脱敏后序列化,受 maxFieldChars 限制)、`argsSha256` |
| `tool_result` | `tool_execution_end` | `toolName`、`toolCallId`、`isError`、`durationMs`、`resultChars`、`resultSha256` |
| `assistant_usage` | `message_end`(role=assistant) | `usage:{input,cacheRead,cacheWrite,output,reasoning,totalTokens}`、`cost`(原样记,pi 目前全 0)、`stopReason`、`hasThinking`、`thinkingChars`、`textChars` |
| `turn_end` | `turn_end` | `turnIndex`、`toolCalls`、`toolErrors`、`lastStopReason` |
| `agent_end` | `agent_end` | `messageCount`、`turnTokens`(本 run 累计 usage) |
| `agent_settled` | `agent_settled` | —— **这是"本轮真的收敛了(不再重试/压缩/续跑)"的权威标记**,统计完成度靠它 |
| `compact` | `session_compact` | `reason`(manual/threshold/overflow)、`tokensBefore`、`summaryChars`、`fromExtension`、`willRetry` |
| `model_select` | `model_select` | `from`、`to`、`source` |
| `thinking_level` | `thinking_level_select` | `from`、`to` |
| `shutdown` | `session_shutdown` | `reason`(quit/reload/new/resume/fork) |

`skills[]` 来自 `before_agent_start` 的 `event.systemPromptOptions.skills: Skill[]`,每项取 `{ name, description, filePath, baseDir, sourceInfo }`(description 截断到 200 字符)。**这是"加载了哪些 skill"的唯一权威来源** —— 不要试图从 session 文件反推。

## 4. 脱敏(硬要求)

审计日志会被汇总,不能把凭据带出去。写盘前对**所有字符串字段**过一遍规则,命中即替换为 `<redacted:规则名>`:

内置规则(最少要有这些):

1. `Authorization: ...` / `Bearer <token>`(头或命令行里的 `-H`、`--header`)
2. `sk-`、`sk_`、`xoxb-`、`ghp_`、`gho_`、`AKIA` 开头的长串
3. `api[_-]?key`、`apikey`、`password`、`passwd`、`secret`、`token` 后面跟 `=`/`:` 的值
4. `mysql://user:pass@`、`postgres://`、`redis://` 这类 URL 里的 userinfo
5. 长度 ≥ 32 的纯 base64/hex 串(兜底,防止漏网的 key)

验证方式见 §6 第 2 条 —— **日志里出现任何 ruled-out 的明文即判定不合格**。

## 5. 红线(不许做的事)

- **绝不改写会话**:不返回 `systemPrompt` 修改、不改 tool input/result、不 `sendMessage`、不 `registerTool`(审计对模型必须完全不可见)
- **绝不联网**:本阶段只落本地文件
- **绝不抛异常**:所有 handler 用 try/catch 包住,异常写 stderr(每类错误只报一次,避免刷屏),不允许中断 agent 循环
- **绝不阻塞**:只做 `appendFileSync` 级别的写;不统计、不聚合、不做慢 IO
- **不挂 `session_start` 做核心逻辑**:实测它在 print 模式(`-p` / `--mode json` / `rpc`)**不触发**。session 级信息在 `before_agent_start` 首次触发时写
- **不依赖 `sessionManager` 之外的非公开 API**;用不到的信息写 null,不要瞎猜

## 6. 验收标准(全部要跑出真实输出)

### 1) 离线 mock 测试 —— `node scripts/test-audit-extension.mjs`

照 `scripts/test-extension.mjs` 的手法:传一个 mock 给扩展的默认导出

```js
const handlers = {};
mod.default({ on: (n, f) => (handlers[n] = f), registerCommand: () => {}, registerTool: () => {} });
```

`PI_AUDIT_DIR` 指向临时目录,断言:

- `before_agent_start`(带 mock 的 `systemPromptOptions.skills`)→ 写出 `session` 事件,`skills[]` 与输入一致
- `tool_execution_start` + `tool_execution_end` → 两条记录,`durationMs` 是数字,`isError` 透传
- 参数里塞 `Authorization: Bearer sk-abcdef...(40 位)` 和 `password=hunter2` → 落盘内容不含原串
- 单个 100KB 的 args → 该字段被截断,`truncated: true`,整行 ≤ 8192 字节
- 没给 `ctx.sessionManager`(或它抛异常)→ 不崩,`sessionId`/`sessionFile` 为 null,仍写出记录
- handler 抛异常 → 被吞掉并写 stderr,进程退出码仍是 0
- 同一天跑两次 → 追加、不覆盖,行数累加

### 2) 真机跑一次

```bash
mkdir -p E:/hermes/pi-audit-test && cd E:/hermes/pi-audit-test
cp <扩展源文件> ~/.pi/agent/extensions/audit-log.ts
pi -p "跑一次 echo hello,然后用一句话说明结果" --approve
```

(空目录,无 `.pi/`,不触发项目信任闸;要留 session 档以便对账,所以**不要**加 `--no-session`)

跑完断言:

- `~/.pi/agent/audit/logs/<今天>.jsonl` 存在,且至少出现 `session` / `turn_start` / `user_input` / `tool_call` / `tool_result` / `assistant_usage` / `turn_end` / `agent_end` 八类事件
- `session` 事件里的 `skills[]` 至少 1 条,且每条 `filePath` 在本机真实存在(`~/.pi/agent/npm/...` 或 `~/.pi/agent/git/...`)
- **对账**:审计日志里该会话的 `input / cacheRead / cacheWrite / output` 四项合计,与 `~/.pi/agent/sessions/**/<同 uuid>.jsonl` 里 assistant 消息 `usage` 的合计一致(允许差最后一条未落盘,差值必须为 0 或等于最后一条的用量)
- 全文件 grep `sk-` / `Bearer ` / `password=` → 无明文命中

### 3) 回传

把上面两条命令的**实际输出**、产物文件路径、对账数字一起贴出来。跑不通就说卡在哪,别改需求绕过。

## 7. 编码约定(本仓规矩)

- 扩展是 `export default function (pi: ExtensionAPI) {...}`;`import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` 是 type-only,**不要**写进 `package.json` 的 dependencies
- 缩进用 Tab,注释用中文,和 `extensions/team-baseline.ts` 保持一致
- 只用 Node 内置模块(`node:fs` / `node:path` / `node:crypto` / `node:os`)
- Node 24 能直接跑 `.ts`(type stripping);动态 import 本地绝对路径要用 `pathToFileURL`
- 不新增第三方依赖

## 8. 明确不在本次范围

- 汇总报表脚本(token/工具/失败率/skill 使用/完成度分布):**第二阶段**,等审计日志跑稳了再写
- 团队侧汇总(共享盘 / HTTP 上报 / 云端):第二阶段
- 网关侧按人归因(new-api 日志、一人一令牌):另一条线,不在这里做
