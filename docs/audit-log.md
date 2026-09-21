# audit-log 扩展

> 审计日志是**索引 + 指标**，session jsonl 是**内容**。
> 审计日志每条工具事件带 `toolCallId`，需要原文时用它 join 回 session jsonl。
> **不要把 toolResult 全文、thinking 全文抄进审计日志。**
>
> 需求书：`docs/audit-log-spec.md`。本文件是**实现说明**（字段表 / 配置项 / 统计口径 / 已知缺口）。

## 1. 装在哪、产物在哪

| 产物 | 路径 |
| --- | --- |
| 扩展本体（本机生效） | `~/.pi/agent/extensions/audit-log.ts` |
| 扩展源码（仓库留档） | `extensions/audit-log.ts` |
| 离线 mock 测试 | `scripts/test-audit-extension.mjs` |
| 审计日志 | `~/.pi/agent/audit/logs/<YYYY-MM-DD>.jsonl`（本地日期） |

pi 自动发现 `agentDir/extensions/` 下的直接 `.ts`/`.js` 文件，不用改 `settings.json`。

**随团队包分发**（v1.8.0 起）：扩展本体在包里的 `extensions/audit-log.ts`，成员全局装基线即生效；
默认配置由基线扩展从 `team/extensions/audit-log.json` 补到 `~/.pi/agent/extensions/audit-log/config.json`（只补缺）。

## 2. 落盘格式

- 一事件一行 JSON，`fs.appendFileSync`，`\n` 结尾，UTF-8 **无 BOM**
- 追加写、不缓冲、不重排：进程被 kill 也要留下已发生的事件
- 单行上限 **8192 字节**；超长字段先按 `maxFieldChars`（默认 2000）截断，再整体兜底
- 任何被截断的记录带 `"truncated": true`

### 截断阶梯（实测踩坑后的设计）

`session` 事件要装下全部 skill，16 个 skill 的路径一叠加很容易顶到 8KB。兜底截断会把 `filePath` **从中间切断**，
而 `filePath` 正是回联会话的权威键——切断了整条记录就废了。所以 `session` 事件按固定优先级让步，**绝不靠兜底**：

1. `sourceInfo` 只留 `source`/`scope`/`origin`（`path`/`baseDir` 与顶层字段重复，先去掉）
2. 仍装不下 → 按 `200 → 80 → 40 → 16 → 0` 逐级压 `description`，并记 `descriptionChars`
3. 压到 0 仍装不下 → 按**完整条目**丢弃 skill，记 `skillsOmitted`

实测：本机 16 个 skill → 7835 字节，`descriptionChars: 80`，16/16 条 `filePath` 全部真实存在。

**尺寸判断必须量“即将落盘的那条记录”**（`commonRecord()`），不能估余量。曾经写成「`base + skills` ≤ 8192 − 400」，
但公共字段（`ts`/`sessionFile`/`cwd`/`event`…）实测能吃掉 **400+ 字节**，工程编码目录一长 `sessionFile` 就更大。
后果：判断放行（7426 ≤ 7792）、真落盘 8334 > 8192、兜底截断把 `filePath` 切断。
现在 `measure()` 与 `write()` 共用 `commonRecord()`，两端字段不可能再漂移。

### 每天一个文件，但不是每个会话一行

`<YYYY-MM-DD>.jsonl` 是**当天所有会话**混在一个文件里（包括你正在用的交互会话）。
按会话统计/对账时**必须先用 `sessionId` 过滤**，否则会把同一天的其他会话一起算进来，
对账数字会看起来对不上。

## 3. 公共字段（每条记录都有）

| 字段 | 说明 |
| --- | --- |
| `v` | schema 版本，当前 `1` |
| `ts` | ISO8601 带本地偏移，如 `2026-09-21T10:31:02.123+08:00` |
| `event` | 事件类型，见下表 |
| `sessionId` | `ctx.sessionManager.getSessionId()`；拿不到写 `null` |
| `sessionFile` | `ctx.sessionManager.getSessionFile()`；拿不到写 `null`。**对账靠它** |
| `cwd` | `ctx.cwd` |
| `piVersion` | 启动时取一次（从 pi 的 `package.json` 读） |
| `model` | 如 `deepseek/deepseek-v4.1-flash` |
| `provider` | 如 `newapi` |
| `seq` | **本进程内**递增计数器。见 §6 缺口 |

## 4. 事件类型与专属字段

| event | 触发点 | 专属字段 |
| --- | --- | --- |
| `session` | `before_agent_start` 首次触发（写一次） | `reason`、`skillCount`、`systemPromptChars`、`systemPromptSha256`、`skills[]`、`descriptionChars?`、`skillsOmitted?` |
| `turn_start` | `turn_start` | `turnIndex` |
| `user_input` | `input` | `chars`、`sha256`、`source`、`promptPreview` |
| `user_bash` | `user_bash` | `commandPreview`、`excludeFromContext` |
| `tool_call` | `tool_execution_start` | `toolName`、`toolCallId`、`argsPreview`、`argsSha256` |
| `tool_result` | `tool_execution_end` | `toolName`、`toolCallId`、`isError`、`durationMs`、`resultChars`、`resultSha256` |
| `assistant_usage` | `message_end`（role=assistant） | `usage{input,cacheRead,cacheWrite,output,reasoning,totalTokens}`、`cost`、`stopReason`、`hasThinking`、`thinkingChars`、`textChars` |
| `turn_end` | `turn_end` | `turnIndex`、`toolCalls`、`toolErrors`、`lastStopReason` |
| `agent_end` | `agent_end` | `messageCount`、`turnTokens`（本 run 累计 usage） |
| `agent_settled` | `agent_settled` | —— |
| `compact` | `session_compact` | `reason`、`tokensBefore`、`summaryChars`、`fromExtension`、`willRetry` |
| `model_select` | `model_select` | `from`、`to`、`source` |
| `thinking_level` | `thinking_level_select` | `from`、`to` |
| `shutdown` | `session_shutdown` | `reason` |

`skills[]` 每项：`{ name, description, filePath, baseDir, sourceInfo }`。
`description` 上限 200 字符，整行装不下时按 §2 阶梯压缩。
**这是"加载了哪些 skill"的唯一权威来源**——不要从 session 文件反推。

`toolCallId` 是审计日志与 session jsonl 的唯一 join 键。

## 5. 脱敏

写盘前对所有字符串字段过一遍规则，命中替换为 `<redacted:规则名>`：

| 规则名 | 命中 |
| --- | --- |
| `auth-header` | `Authorization:` / `Bearer <token>`（含命令行 `-H` / `--header`） |
| `token-prefix` | `sk-`、`sk_`、`xoxb-`、`ghp_`、`gho_`、`AKIA` 开头的长串 |
| `credential-kv` | `api_key` / `apikey` / `password` / `passwd` / `secret` / `token` 后跟 `=`/`:` 的值 |
| `url-userinfo` | `mysql://user:pass@`、`postgres://`、`redis://` 里的 userinfo |
| `long-opaque` | 长度 ≥ 32 的纯 base64/hex 串（兜底） |

两个例外，避免误伤结构信息：

- 键名以 `sha256` 结尾的字段跳过（那是我们自己的摘要）
- `filePath` / `baseDir` / `path` / `cwd` / `sessionFile` / `toolCallId` / `sessionId` / `model` / `provider` / `note` 跳过兜底规则（路径和 ID 会被误判成长 token）

**验收线：日志里出现任何明文即不合格。**

## 6. 配置项

| 配置 | 位置 | 默认 | 说明 |
| --- | --- | --- | --- |
| `PI_AUDIT_DIR` | 环境变量 | 空 | 覆盖日志目录，为将来指到共享盘留口。设了就**直接用这个目录**，不再拼 `audit/logs` |
| `PI_CODING_AGENT_DIR` | 环境变量 | `~/.pi/agent` | agent 根目录（也决定用户配置的位置） |
| `enabled` | 用户配置文件 | `true` | **总开关**。`false` 时一条都不写（在唯一出口 `emit()` 处断掉，覆盖所有事件类型） |
| `maxFieldChars` | 用户配置文件 | `2000` | 单字段预览字符上限 |
| `recordFullPrompt` | 用户配置文件 | `false` | `true` 时 `promptPreview` 记全文（默认只记前 500 字符） |

**配置文件查找顺序（第一个存在的说了算，不合并）**：

1. `<agent dir>/extensions/audit-log/config.json` —— **团队成员改这个**
   （团队包按约定把 `team/extensions/audit-log.json` 模板补到这里；扩展本体在包 clone 里，改 clone 留不住）
2. `<扩展同目录>/audit-log.config.json` —— 本机单独装扩展时的位置（向后兼容）

进程内只读一次并缓存。文件不存在、坏 JSON、字段类型不对 → 走全默认值，只往 stderr 报一次。

关掉审计的写法（成员自己就能关，不用卸包）：

```bash
mkdir -p ~/.pi/agent/extensions/audit-log
echo '{"enabled": false}' > ~/.pi/agent/extensions/audit-log/config.json
```

## 7. 统计口径

| 指标 | 口径 |
| --- | --- |
| **token 用量** | 聚合 `assistant_usage.usage`。四字段 `input`/`cacheRead`/`cacheWrite`/`output` 逐条相加。**不要**用 `agent_end.turnTokens` 做跨会话汇总，那是单 run 累计 |
| **任务完成度** | 以 `agent_settled` 为权威标记（"本轮真的收敛了，不再重试/压缩/续跑"）。只有 `stopReason` 是猜的 |
| **工具失败率** | `tool_result` 中 `isError === true` 占比。分子分母都取 `tool_result`，不要用 `tool_call` 做分母（异常路径下两者条数可能不等） |
| **工具耗时** | `tool_result.durationMs` |
| **skill 使用** | `session.skills[].filePath`。跨会话汇总时按 `filePath` 去重计数 |
| **轮次/调用数** | `turn_end.toolCalls` / `turn_end.toolErrors` |
| **丢行检测** | 同一 `sessionId` 内 `seq` 应连续递增。跨进程 `seq` 会重置，**必须配合 `ts` 和 `sessionId` 一起判** |
| **会话回联** | 用 `sessionFile` 定位 session jsonl；用 `toolCallId` 在该文件里找对应 `toolResult` 原文 |

### 真机对账结果（2026-09-21，`pi 0.86.1`）

按 `sessionId` 过滤出目标会话（13 行）后，审计侧 `assistant_usage` 合计 vs session jsonl 里 assistant 消息 `usage` 合计：

| 字段 | 审计侧 | 会话侧 | 差值 |
| --- | --- | --- | --- |
| `input` | 14767 | 14767 | 0 |
| `output` | 91 | 91 | 0 |
| `cacheRead` | 19968 | 19968 | 0 |
| `cacheWrite` | 0 | 0 | 0 |
| `totalTokens` | 34826 | 34826 | 0 |
| `reasoning` | 26 | 26 | 0 |

四字段差值全为 0，`assistant_usage` 条数 2/2 一致。

## 8. 已知缺口

1. **`cost` 目前恒为 0**——pi 侧本来就是 0，原样记录，不做推算。
2. **`seq` 跨进程不单调**。它是"本进程内递增计数器"，用于排序和丢行检测，**不是全局序号**。跨进程判丢行必须带上 `sessionId` + `ts`。
3. **`user_bash` / `compact` / `model_select` / `thinking_level` 四类事件未在真机验证中触发**（`-p` 一次性会话既不进交互式 bash、也不压缩、不切模型）。代码路径已注册，只有 mock 覆盖；等真实场景出现再补对账。
4. **`session.reason` 依赖 `session_start`**，而 spec 记录该事件在 print 模式可能不触发。代码里的处理：拿不到就写 `null`，核心信息仍照写。实测 `pi -p` 拿到了 `startup`。
5. **兜底截断仍可能切断长字符串**——8192 是硬上限，最后手段是整体缩短。`session` 事件已通过 §2 阶梯彻底规避；其他事件字段控制在 `maxFieldChars` 内，正常不会触发。
6. **不记录 `thinking` 全文与 `toolResult` 全文**（这是设计，不是缺口）。只记 `thinkingChars` / `resultChars` / `*Sha256`。
7. **汇总报表脚本尚未实现**——spec 明确划到第二阶段。
8. **`sourceInfo` 只留 `source`/`scope`/`origin`**，丢掉了 `path`/`baseDir`（与顶层字段重复，且会把 `session` 行顶爆）。需要完整溯源信息时从 `filePath` 反推。
9. **验证日志要用「凭据形状」的正则，不要用裸子串**。裸 `grep -F 'sk-'` 会把**搜索命令自己的 argsPreview** 算成命中——审计日志忠实地记下了你执行的那条 `grep 'sk-'` 命令。
   判断“有没有泄露”必须用 `/sk-[A-Za-z0-9_-]{20,}/` 这类形状匹配，并且**先按 `sessionId` 过滤掉自己的交互会话**。
   本机实测：目标会话上 10 条形状规则全部 0 命中；34 条长 token 全是 `sessionId`/`sessionFile`/`sha256`/`toolCallId` 这类结构值。

## 9. 怎么跑

```bash
# 离线 mock（不启动 pi，不碰真实 ~/.pi/agent）
node scripts/test-audit-extension.mjs

# 真机跑一次（空目录、无 .pi/、不加 --no-session，要留 session 档对账）
mkdir -p E:/hermes/pi-audit-test && cd E:/hermes/pi-audit-test
cp extensions/audit-log.ts ~/.pi/agent/extensions/audit-log.ts
pi -p "跑一次 echo hello,然后用一句话说明结果" --approve
```

## 10. 红线（改这个扩展时必须守住）

- **绝不改写会话**：不返回 `systemPrompt` 修改、不改 tool input/result、不 `sendMessage`、不 `registerTool`。审计对模型必须完全不可见
- **绝不联网**：本阶段只落本地文件
- **绝不抛异常**：所有 handler 用 `guard()` 包住，异常写 stderr（每类错误只报一次），不允许中断 agent 循环
- **绝不阻塞**：只做 `appendFileSync` 级别的写；不统计、不聚合、不做慢 IO
- **不依赖 `sessionManager` 之外的非公开 API**：用不到的信息写 `null`，不瞎猜
