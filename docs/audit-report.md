# 审计报表(第三阶段已并入)

> 脚本:`scripts/pi_audit_report.py`
> 需求书:`docs/audit-report-spec.md`、`docs/audit-optimize-spec.md`
> 上游:`docs/audit-log.md`(审计日志扩展怎么写日志)

一句话:**把 `*.jsonl` 审计日志汇总成人看的 Markdown 报表**。只读日志,不改扩展,不联网。

> 本报表已含三个阶段:① 子代理归属(§5)、② 配置指纹(与 `docs/audit-log.md` §4.1 配套)、
> ③ 上下文构成(§9)。

## 1. 用法

```bash
python E:/hermes/team-pi/scripts/pi_audit_report.py                        # 默认:今天的日志
python ... --all-days                                                       # 不限日期,算目录里全部
python ... --since 2026-09-18 --until 2026-09-21                            # 日期区间(含两端,本地时区)
python ... --session 01a0c209                                               # 只看某个会话(id 前缀)
python ... --dir D:/audit-logs                                              # 换日志目录
python ... --dir D:/audit-logs/E --label 张三 --dir D:/audit-logs/F --label 李四   # 多目录=按人分组
python ... --json                                                           # 只出结构化 JSON
python ... --out report.md                                                  # 写文件而不是 stdout
python ... --prices prices.json                                             # 折算成本
python ... --sessions-dir D:/sessions                                       # 换子代理产物目录
python ... --model-map alias.json                                           # 手工指定「别名→真实模型」映射（见 §2.1）
python ... --no-subagents                                                   # 不扫子代理产物
python ... --session 01a0c209 --show-args                                   # 打印 argsPreview/promptPreview 原文
```

约定:

- `--dir` / `--label` 可重复;给了 label 才出「按人」表
- 没给 `--dir` 时:`PI_AUDIT_DIR` → 否则 `~/.pi/agent/audit/logs`(`PI_AUDIT_DIR` 与扩展同一套)
- 没给 `--sessions-dir` 时:`$PI_CODING_AGENT_DIR/sessions` → 否则 `~/.pi/agent/sessions`(与扩展的 agent 目录同一套)
- **默认只算今天**(本地时区切天);要跨天用 `--since/--until` 或 `--all-days`
- 目录不存在 / 没匹配文件 / `--session` 没命中 → 打一句人话提示,**退出码 0,不出 traceback**
- **脏行不容忍崩溃**:日志是外部追加写的,坏行(字段型别错位)不能让整份报表挂掉。
  凡是“从日志里取的值”都先归一化再使用,且**不用 `v or []` / `v or {}`** ——
  `True`/`8.0`/`"x"` 都是真值会原样穿透。具体见 §10「脏值健壮性」。
- 纯离线、无交互、无网络,可被 cron 直接调

### 2.1 「按模型」表如何归并（别名 → 档位）

**要回答的问题**：哪个**档位**在烧 token。而同一档位在数据里有多个名字 —— 运行时用别名
（`tier-std`），子代理 `meta.json` 带 provider 前缀（`newapi/tier-power`），上游响应又给真实模型名
（`deepseek/deepseek-v4.1-flash`）。不归并的话，每个成员的「按模型」表都虚拆成 4 行以上，
看不出钱花在哪。

**映射从数据推导，不硬编码**。权威来源是会话 jsonl 里**同一条 assistant 消息**上的两个字段：

```json
{"message": {"role": "assistant", "model": "tier-std", "responseModel": "deepseek/deepseek-v4.1-flash"}}
```

| 步骤 | 做法 |
| --- | --- |
| 扫描集 | `<sessions>/**/*.jsonl`，**只排除** `_fork-backup*` 与 `<父会话>/<runId>/run-0/session.jsonl`。`subagent-artifacts/*.jsonl` **要算进去** —— `tier-power → zai/glm-5.3-flash` 这种配对只在那儿有 |
| 同别名多个真实名 | 取**出现次数最多**的，并在表尾注明歧义（歧义组数 + 少数派） |
| 未命中映射的名字 | **单独成行**并在表尾计数上报，**不静默归入「(未知模型)」** |
| `--model-map FILE` | JSON `{"tier-std": "deepseek/deepseek-v4.1-flash"}`；给定时**完全替代**自动推导。读不到该文件→打提示并**回退到自动推导**，不中断 |
| 行名 | 取**档位别名**（`tier-std`），不是上游真名 —— 报告要回答的是「哪个档位在烧」，真名只是它背后的实现 |

**守恒是硬约束**：归并**只改分组，不改总量**。`sum(按模型表 total)` 与 `overview.totalTokens`
必须逐字节相等（`--self-test` 已固化这条断言）。

归一化规则（`_norm_meta_model`，实测踩过）：

| 输入 | 归一到 | 原因 |
| --- | --- | --- |
| `newapi/tier-power` | `tier-power` | 子代理 `meta.json` 的 `model` 带 provider 前缀（实测 33 次）。**只有 2 段** |
| `newapi/z-ai/glm-5.3-flash` | `z-ai/glm-5.3-flash` | 同上，剥第一段 |
| `zai/glm-5.3-flash` | `z-ai/glm-5.3-flash` | 上游拼法漂移，三种拼法实际同一模型 |
| `zai-org/glm-5.3-flash` | `z-ai/glm-5.3-flash` | 同上 |

⚠ **剥前缀的判据是「第一段是已知 provider 名」，不是「段数 ≥ 3」** —— 后者会漏掉
`newapi/tier-power` 这种 2 段写法（自检阶段实际抓到过这个 bug）。provider 名单同样从数据里采
（assistant 消息的 `provider` 字段），网关改名也不会漏判。

⚠ **拼法统一必须在剥前缀之前**：否则 `zai/glm-5.3-flash` 会被当成 provider 前缀剥成
`glm-5.3-flash`，丢掉组织段。

## 2. 报表结构(固定顺序)

| # | 段落 | 内容 |
| --- | --- | --- |
| 1 | 概览 | 时间范围、文件数、总行数、`skippedLines`、会话数、事件数、**事件类型分布**、不完整会话数、seq 缺口数、总 token |
| 2 | token 分布 | 按天 / 按模型 / Top 10 会话（含**类型**列：`父会话` / `子代理:<角色>`）；每张表 `input`/`cacheRead`/`cacheWrite`/`output`/`reasoning`/`total` + `cacheRead` 占比。**按模型表已做别名归并**（见 §2.1） |
| 3 | 子代理 | 按 角色 × 模型：run 数、数字口径、审计/meta token/turns、审计侧来源、对账；表尾合计 + 占比（见 §5）；另有一行**归因覆盖率**与本轮到次清单（见 §5.4） |
| 4 | 按人 | 仅多目录/label 时:token 六字段、会话数、工具调用数、失败率 |
| 5 | 工具 | 每工具:调用次数、成功/失败、失败率、平均/最长耗时、结果字符数 |
| 6 | 上下文构成 | 每会话:**轮数**、固定税(字符)、工具定义(字符)、首轮/末轮增长(字符)、每轮平均 input+缓存读、固定税估算占比;表下写口径与字符→token 比例、对账偏差(见 §9) |
| 7 | skill 命中 | 每 skill:命中会话数、命中次数、`filePath`、来源包与版本;另附**每会话 `session.skillCount` vs filePath 去重数** |
| 8 | 完成度 | 收敛率(`agent_settled`)、未收敛清单(会话前缀/cwd/最后事件/`stopReason`/是否不完整) |
| 9 | 上下文压力 | `compact` 次数、`tokensBefore` 最大与中位、压缩 ≥2 次后 cacheRead 仍单调涨的会话 |
| 10 | 成本 | 仅 `--prices`:按模型金额、价目表来源与单位、混算警告 |
| 11 | 观察 | 3~5 条中文结论,每条都指回上面某张表 |

主表里出现的 id 一律截断成前 8 位;`--json` 模式给全 id,且不做截断。

## 3. 口径(与 `docs/audit-log.md` §7 同源)

| 指标 | 口径 |
| --- | --- |
| token 用量 | 只聚合 `assistant_usage.usage` 的 `input`/`cacheRead`/`cacheWrite`/`output` 逐条相加;`total` = 四字段之和。**不用** `agent_end.turnTokens`,也不直接采信 `usage.totalTokens` |
| 过滤 | 任何统计先按 `sessionId` 分组,不跨会话相加 |
| 完成度 | `agent_settled` 是权威标记;`stopReason` 只作辅助展示 |
| 工具失败率 | 分子分母都取 `tool_result`(`isError === true` / 全部 `tool_result`)。**不用 `tool_call` 做分母**;两者条数不等时表下会给注 |
| 工具耗时 | `tool_result.durationMs`(平均取算术平均,最长取 max) |
| skill 命中 | `session.skills[].filePath` 为权威键,跨会话按 filePath 去重计数 |
| 丢行检测 | 同 `sessionId` 内 `seq` 应连续递增;`seq` 回退视为新进程不判缺口,前跳才计 `seqGaps`(配合 `ts` 排序) |
| 不完整会话 | 有 `turn_start`/`assistant_usage` 但没有 `session` 事件 → 标「不完整」,概览报数量,照算不跳过 |
| 时区 | `ts` 自带偏移,按本地时区(UTC+8)切天 |
| 坏行 | 空行跳过;JSON 解析失败或不是对象 → 跳过并计入 `skippedLines`,概览可见,**不静默吞** |

**为什么 `total` 不直读 `usage.totalTokens`**:2026-09-21 在本机实测两者等价 —— 110 条审计 `assistant_usage` + 1459 次 session jsonl assistant 调用里,
`totalTokens ≠ 四字段之和` 的**0 例**(pi 0.86.1);但采信冗余字段一旦上游给坏值,概览与按天表就会打架(审查时用 999999 探针坐实过)。
所以统一由四字段导出,`reasoning` 不计入 `total`(单列展示)。**要改回直读 `totalTokens` 先重新对账。**

## 4. 成本折算

`cost` 字段恒为 0,折算必须外置价目表。`--prices` 传 JSON:

```json
{
  "note": "价格来源与日期,例:newapi 渠道倍率,2026-09-21",
  "unit": "USD",
  "perTokens": 1000000,
  "models": {
    "deepseek/deepseek-v4.1-flash": { "input": 0.28, "cacheRead": 0.028, "cacheWrite": 0.28, "output": 0.42 }
  }
}
```

- `note`(价格来源与日期)与 `unit` 会原样打进报表
- `perTokens` 可选,默认 `1`(单价 = 每 token)。按每百万 token 报价时写 `1000000`
- 金额 = Σ(四字段 token × 单价) ÷ `perTokens`,只用计费 token 口径
- 模型不在表里 → 该行标 `无价目`、金额记 `-`,不猜;合计只统计已计价模型并在表下标警告
- 报表固定打一条混算警告:`结果字符数`/`systemPromptChars` 是**字符口径**,不可与计费 token 互换

## 5. 子代理归属（第三阶段·阶段 1）

报表除了审计日志，还会**独立扫一眼子代理产物**（`--no-subagents` 关掉）。

### 两处产物，互不覆盖

| 位置 | 内容 |
| --- | --- |
| `<sessions>/<项目编码>/subagent-artifacts/<runId>_<agent>_meta.json` | **权威标签源**：`agent`(角色) / `model` / `usage{turns,...}`（报表只取这三个；文件里还有 `timestamp`/`task`/`exitCode`/`skills` 等，本段不用） |
| `<sessions>/<项目编码>/<父会话>/<runId>/run-0/session.jsonl` | 子会话本体（标准 pi session jsonl），**首行 `id` = 子会话 `sessionId`** |

两处按 **`runId`** 合并去重（都是同一个 uuid），四种组合都容错：只有 meta / 只有 run-0 / 两边都有 / 都坏。

### runId 对不上时的指纹兜底

实测见过：一次子代理 run 只落了 meta，`run-0/` 目录挂的是**另一个** runId，但两者 `input`/`cacheRead`/`cacheWrite`/`output`/`turns` **逐项相等**（同一个子会话，两个产物各记了一份）。
严格按 runId join 这组就永远对不上，所以允许指纹兜底——**只接受一对一唯一命中**：

- 指纹 = `(模型, input, cacheRead, cacheWrite, output, turns)`（meta 侧多比一个角色）
- 同指纹命中 ≥2 个 run-0，或有数字全 0 / `turns=0` 的行 → **放弃配对**（宁可不配也不瞎配）
- 配上后：`runId` 保留 run-0 那个，角色/模型/meta usage 从 meta 行合过来，meta 行**不再单独成行**（不重复计数）
- 报表里的「对账」列会打 `✓ 指纹配对 N 个`，并在表下插一句说明；JSON 里看 `matchBy == "usage"`
- `stats` 给三个指纹计数：`fingerprintMatched` / `fingerprintMiss` / `fingerprintAmbiguous`

> 指纹配对是**启发式**，不保证与 runId join 等价（唯一命中才用，仍可能在数字巧合时配错）。

### 关联链路

```
runId ──(目录名)──► <父会话>/<runId>/run-0/session.jsonl 首行 id ──► 子会话 sessionId
      ──(文件名)──► subagent-artifacts/<runId>_<agent>_meta.json ──► 角色 / 模型 / meta usage
```

找到子会话 sessionId 就在审计数据里把它**标记成子代理**（而不是父会话）——Top 10 会话的「类型」列因此能打出 `子代理:未知`。
角色只在有 meta 时才知道；只有 run-0 的 run 角色就是 `未知`（**不猜**）。

### 「审计侧」列的取值

| 取值 | 含义 |
| --- | --- |
| `已入审计(标记为子代理)` | 该 role×model 分组的 run 全部在审计日志里找到了 |
| `已入审计(标记为子代理) + 仅 meta` | 同一分组里两路产物都行（审计侧看得到的 + 只看得到 meta 的） |
| `未入审计` | run-0 存在但没有对应审计数据（子代理进程没加载审计扩展） |
| `仅 meta` | 只有 meta.json，且没有 run-0（或 run-0 未配对） |

### 「数字口径」列（数字列取自哪一侧）

`input`/`cacheRead`/`cacheWrite`/`output`/`turns` **只填一侧的数字**，用「数字口径」列标明取自哪侧：

| 取值 | 含义 |
| --- | --- |
| `审计` | 取审计日志里子会话的 `assistant_usage`（该行有**非零**审计数字时优先） |
| `meta` | 审计侧没有数字（无子会话，或子会话数字全 0），退而取 meta.json 的 `usage` |
| `—` | 两侧都没数字（比如「未入审计」且无 meta） |

为什么不两侧都填：已入审计的 run 在 meta 里可能是 **0**（子代理进程没加载审计扩展，meta 的 usage 反而缺失），
若数字列固定填 meta，同一行会打出 `0` 而合计行却是真实值，**同表自相矛盾**。
故采用「审计侧优先 + 显式标口径」。混合分组（`已入审计 + 仅 meta`）的行只展示审计侧那个数，
meta-only 那部分的数字看表尾「仅 meta(未入审计)」合计行——两路数字**不混进同一格**。

### 「对账」列

只有**两侧都有数字**（meta 有非零 usage 或 turns；审计侧有非零 usage 或 turns）时才逐项比 `input`/`cacheRead`/`cacheWrite`/`output`：
全等打 `✓`，不等打 `✗ 审计=X meta=Y`；只有一侧有数字打 `—`（无从对账，不评好坏）。

### 「run 数」列是聚合值（与 spec 的一处偏离）

spec 的表格设计是**一行一个 run**（那样「run 数」列恒为 1，没信息量）。这里改成**按 角色 × 模型 聚合**，
「run 数」就是该分组的 run 个数；表尾「合计」行给总 run 数（**已去重**：指纹配对的两个 runId 只算一个）。
要逐 run 明细看 `--json`（`subagents` 只有聚合结果，明细得自己沿 `runId` 查产物目录）。

### 总量口径（关键，别重复计数）

- 概览的 **总 token 仍然 = 审计日志全集**（已入审计的子代理本来就在里面，不做任何增减）
- 子代理段**只做标签化**，不把 `meta.usage` 再加一遍
- 未入审计的子代理单列为「仅 meta(未入审计)」，表下注明「另有 X token 只存在于 meta.json」，**绝不并进「总 token」**
- 「子代理占全部消耗 X%」的分母是审计全集，分子是审计侧已标记为子代理的部分
- 子代理段的审计侧数字一律取**全量**会话数据，**不受 `--since` / `--until` / `--session` 影响**：
  子代理产物本身不按日期过滤，若审计侧只取当前范围，范围外的子代理会被误标「未入审计」，
  而占比分子又被 `--session` 削到 0、分母仍是全量——同一页里两个口径打架
  （概览/其它段落仍是过滤后的口径，子代理段是全量口径，故段内注明）

> 拿同一份日志跑两次（有/无 `--no-subagents`），概览总 token 必须相同——`--self-test` 里断言了这一点。

### 5.4 子代理归因：挂到父会话的第几轮

上面回答「花了多少」，这节回答「**哪一轮派了谁**」。每个 run 会尝试三条路径定位父会话与轮次，
**按可靠度排序、命中即停**，结果写进 `--json` 的 `parentSessionId` / `parentTurnIndex`：

| 序 | 路径 | 做法 | 本机实测命中 |
| --- | --- | --- | --- |
| 1 | `metaTranscriptPath` | `meta.json` 的 `transcriptPath` 定位项目编码目录，再到 `<sessions>/<项目>/<父会话目录>/<runId>/run-0/` 把父会话找出来（三层上级即父会话目录名） | 46 |
| 2 | `toolResultRunId` | 父会话 `toolResult` 正文里的 `Run: <runId>` → 它的 `toolCallId` → 反查同 id 的 `toolCall` 属于哪条 assistant 消息 → 所属轮次（**最可靠**，runId 就在 toolResult 里，天然带 toolCallId） | 5 |
| 3 | `sessionPath` | `toolResult` 正文里 `Session: ...\<runId>\run-0\...` 的路径反推 | 2 |

⚠ **`Run:` 只在 `toolResult` 的返回正文里**，发起子代理的那条 `toolCall` 的 `arguments` 里**没有 runId**
（实测只有 `agent`/`task`/`context`/`async`/`timeoutMs`）。所以关联方向是「结果 → 调用」，不是「调用 → 结果」。

⚠ **不用文件名/路径做启发式猜测** —— 实测会全部落空并给出相反结论。

**轮次口径**：一段会话里第几条 `user` 消息。同一个 runId 在多轮里可能被重复播报
（状态刷新型 `toolResult`），**首次出现**的那一轮才算发起轮次。

**覆盖率必须上报，并不得含糊**。Markdown 里固定一行：

```text
子代理归因:命中 53/69 (76.8%)（路径1:46 / 路径2:5 / 路径3:2）
```

`--json` 里在 `subagents.attribution`：

```json
{"hit": 53, "total": 69,
 "byPath": {"metaTranscriptPath": 46, "toolResultRunId": 5, "sessionPath": 2},
 "unattributed": 16}
```

`hit + unattributed == total` 是硬约束（`--self-test` 已断言）。**覆盖不全时报表不会说「全部归因完成」** ——
未归因的那些 run 表下会直说「三条路径都没命中……这些 run **不算作已归因**」。

> 本机 69 个 run 里只有 53 个能归因，剩下的多是较早的产物：它们的父会话已不在
> `~/.pi/agent/sessions/` 里了（会话文件被清理），不是路径写错。

三个 id 空间互不相等是归因难的根源（实测）：`meta.runId` 与 `run-0` 目录名只有 30/56 对得上，
`Run:` 里的 uuid **从不**出现在会话目录名里。所以任何一条路径都不能单独承诺全命中。

## 6. 隐私

- 默认**不打** `argsPreview` / `promptPreview` 原文;`--show-args` 只在 `--session` 模式下生效(附在报表末尾,并标警告)
- Markdown 里的 id(会话)截断成前 8 位;`--json` 不受此限,用于下游加工
- 不联网、不上传;`--out` 只写本地文件。日志本身已由扩展做过脱敏(见 `docs/audit-log.md` §5)

## 7. 和 `docs/audit-log.md` 的分工

| | `docs/audit-log.md` | 本文档 + `pi_audit_report.py` |
| --- | --- | --- |
| 阶段 | 第一阶段:采集 | 第二阶段:汇总 |
| 谁写 | `extensions/audit-log.ts` 写日志 | 脚本只读日志 |
| 回答什么 | 每条事件长什么样、字段口径是什么、脱敏规则 | 谁花了多少 token、工具哪里慢/失败、skill 从哪来、收敛没有 |
| 输出 | `~/.pi/agent/audit/logs/YYYY-MM-DD.jsonl` | Markdown 报表 / `--json` |
| 对账 | §7 真机对账(审计侧 vs session jsonl) | 同一套口径的跨会话汇总;单会话结果可与 `audit-log.md` §7 的表逐项对齐 |

排错顺序:报表数字可疑 → 先用 `--session <id> --json` 看单会话原始聚合 → 再拿 `docs/audit-log.md` §4 的字段表核对日志本身 → 最后查 session jsonl(`sessionFile` 定位,`toolCallId` join)。

## 8. 已知边界

- `compact` / `model_select` / `user_bash` / `thinking_level` 四类事件本机日志里尚未触发（上游缺口 3），第 8 段在真机数据里会显示 0，代码路径靠 mock 覆盖
- `--session` 前缀命中多个会话时全部纳入，并在 stderr 提示
- 子代理段是**另一路扫描**，与 `--since/--until` 无关：日期只过滤审计日志，不过滤子代理产物（子代理的 token 与父会话同一天，分开过滤反而容易两边对不上）
- 子代理产物目录默认取 `$PI_CODING_AGENT_DIR/sessions`，与审计日志的 `PI_AUDIT_DIR` 不是一个环境变量；共享盘场景两边都要显式指
- 报表不做 toolResult 全文 / thinking 全文回联（需要时单会话手工 join，不在本次范围）

## 9. 上下文构成（第三阶段·阶段 3）

回答「每轮 input 里到底什么在占字」——固定税、历史、工具回灌各占多少。数据源只有
`context_sample` 事件（见 `docs/audit-log.md` §4.3），**老日志（该事件上线前）没有本段**，
报表会退化成一句提示，不算错。

### 表格与口径

每会话一行（最多前 10 个，按轮数降序）：`会话` / `轮数` / `固定税(字符)` / `工具定义(字符)` /
`首轮增长(字符)` / `末轮增长(字符)` / `每轮平均 input+缓存读` / `固定税估算占比`。

| 项 | 口径 |
| --- | --- |
| **固定税** | `sections` 合计 + `toolDefs.chars`（每轮完全不变的那部分） |
| **增长** | `messages.charsByRole` 合计 − 该轮 `system` 部分（system 已含 sections） |
| **首轮/末轮增长** | 首轮末尾是用户输入；末轮末尾是用户输入 + 历史 + 工具回灌 |
| **每轮平均 input+缓存读** | 该会话全部 `assistant_usage.usage.input + cacheRead` 的平均 |
| **固定税估算占比** | 固定税字符 × 比例 ÷ 每轮平均 input+缓存读 |

### 字符 → token 比例（不许直接把字符当 token）

比例 = 同一批日志里 `contextTokens ÷ 该轮总字符`（总字符 = messages 合计 + toolDefs.chars），
**跨所有会话收齐每一轮的逐轮比例，只取一次中位**，然后用**同一个比例**换算表里每一行。
**两个容易写错的点**：

1. **不许每行用自己的会话内比例** —— 那样表里数字与表下公布的换算比例不是同一个数。
2. **不许「先每会话取中位、再对这些中位取中位」** —— 会话轮数不等时会明显失真：
   100 轮 0.25 + 1 轮 1.0，逐轮中位 = 0.25，中位的中位 = 0.625（差 2.5 倍），
   会把这个误差乘到每一行的固定税估算上。

报表必须把这个比例打在表下。
实测（2026-09-22，中英混排）：**≈ 0.26**，即约 **3.9 字符 / token**，不是常见的 4。

### 对账（不静默）

`contextTokens` 应 ≈ 该轮 `assistant_usage.usage.input + cacheRead`（同一次请求的两种口径）。
误差 > 2% 时表下打 `⚠ 对账偏差 X%`。

配对方式：`assistant_usage` **不带 `turnIndex`**，只能按会话内 `(ts, seq)` 顺序与 `context_sample` 双指针就近配对
（同轮里 usage 先写、sample 后写）。比较必须用完整的 `(ts, seq)`：**只比 `ts` 会在同毫秒时间戳时
把 seq 排在本轮 sample 之后的 usage 错配进来**。**不能用 `zip`**：升级当天部分轮次没有 sample，
zip 会从头部错位，把 A 轮的 usage 配到 B 轮的 sample 上，偏差看着很小却是假的。

### 实测（真机，`pi -p` 5 轮，`pi 0.86.1`）

| 轮 | messages 条数 | 固定税(字符) | 末轮增长(字符) | contextTokens |
| --- | --- | --- | --- | --- |
| 0 | 2 | 53,021 | 154 | 16,457 |
| 4 | 10 | 53,021 | 2,744 | 16,510 |

固定税占比 **≈ 84%**：用户输入 154 字符，固定税 53,021 字符 —— 差 **340 倍**。这就是 cacheRead 占 95% 的机理。

> ⚠️ **固定税是下限估计**。`sections` 合计（14,713）< 真实 system prompt（22,455），
> 差在扩展注入的正文不进 `sections`（见 `docs/audit-log.md` §4.3）。而 `toolDefs.chars`（38,308）是精确值。

## 10. 脏值健壮性

日志是**外部追加写**的（扩展进程随时可能被 kill、写一半），所以报表侧一律把字段当“不可信输入”。
规范：**从日志里取的值先归一化再用**，四个 helper 收口：

| helper | 归一化 | 为什么不能偷懒 |
| --- | --- | --- |
| `_sid(v)` | 只收非空 `str` | `sessionId` 当字典键;若是 `dict`/`list` → `TypeError: unhashable type` |
| `_label(v, fb)` | 只收非空 `str` | `model`/`toolName`/`filePath` 同样当键 |
| `_list(v)` / `_dict(v)` | 只收 `list` / `dict` | **`v or []` / `v or {}` 对真值无效**:`True`/`8.0`/`"x"` 会原样穿透,后续 `.iter()` 直接炸 |
| `_sort_key(ev)` | `ts` 规范成 `str`、`seq` 规范成 `int` | `(ts, seq)` 排序里混进 `dict`/`list` → `'<' not supported` |

回归守卫：`E:/hermes/audit-scratch/verify_stage3.py` 断言 7b（含三类型别错位脏值,`默认`/`--json`/`--no-subagents` 各跑一次）。
另外用模糊测试扫过 **600 组 × 4 种参数 = 2400 次**,零 traceback。
