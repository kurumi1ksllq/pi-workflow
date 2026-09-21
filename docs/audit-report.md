# 审计报表(第二阶段)

> 脚本:`scripts/pi_audit_report.py`
> 需求书:`docs/audit-report-spec.md`
> 上游:`docs/audit-log.md`(审计日志扩展怎么写日志)

一句话:**把 `*.jsonl` 审计日志汇总成人看的 Markdown 报表**。只读日志,不改扩展,不联网。

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
python ... --session 01a0c209 --show-args                                   # 打印 argsPreview/promptPreview 原文
```

约定:

- `--dir` / `--label` 可重复;给了 label 才出「按人」表
- 没给 `--dir` 时:`PI_AUDIT_DIR` → 否则 `~/.pi/agent/audit/logs`(`PI_AUDIT_DIR` 与扩展同一套)
- **默认只算今天**(本地时区切天);要跨天用 `--since/--until` 或 `--all-days`
- 目录不存在 / 没匹配文件 / `--session` 没命中 → 打一句人话提示,**退出码 0,不出 traceback**
- 纯离线、无交互、无网络,可被 cron 直接调

## 2. 报表结构(固定顺序)

| # | 段落 | 内容 |
| --- | --- | --- |
| 1 | 概览 | 时间范围、文件数、总行数、`skippedLines`、会话数、事件数、**事件类型分布**、不完整会话数、seq 缺口数、总 token |
| 2 | token 分布 | 按天 / 按模型 / Top 10 会话;每张表 `input`/`cacheRead`/`cacheWrite`/`output`/`reasoning`/`total` + `cacheRead` 占比 |
| 3 | 按人 | 仅多目录/label 时:token 六字段、会话数、工具调用数、失败率 |
| 4 | 工具 | 每工具:调用次数、成功/失败、失败率、平均/最长耗时、结果字符数 |
| 5 | skill 命中 | 每 skill:命中会话数、命中次数、`filePath`、来源包与版本;另附**每会话 `session.skillCount` vs filePath 去重数** |
| 6 | 完成度 | 收敛率(`agent_settled`)、未收敛清单(会话前缀/cwd/最后事件/`stopReason`/是否不完整) |
| 7 | 上下文压力 | `compact` 次数、`tokensBefore` 最大与中位、压缩 ≥2 次后 cacheRead 仍单调涨的会话 |
| 8 | 成本 | 仅 `--prices`:按模型金额、价目表来源与单位、混算警告 |
| 9 | 观察 | 3~5 条中文结论,每条都指回上面某张表 |

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

## 5. 隐私

- 默认**不打** `argsPreview` / `promptPreview` 原文;`--show-args` 只在 `--session` 模式下生效(附在报表末尾,并标警告)
- Markdown 里的 id(会话)截断成前 8 位;`--json` 不受此限,用于下游加工
- 不联网、不上传;`--out` 只写本地文件。日志本身已由扩展做过脱敏(见 `docs/audit-log.md` §5)

## 6. 和 `docs/audit-log.md` 的分工

| | `docs/audit-log.md` | 本文档 + `pi_audit_report.py` |
| --- | --- | --- |
| 阶段 | 第一阶段:采集 | 第二阶段:汇总 |
| 谁写 | `extensions/audit-log.ts` 写日志 | 脚本只读日志 |
| 回答什么 | 每条事件长什么样、字段口径是什么、脱敏规则 | 谁花了多少 token、工具哪里慢/失败、skill 从哪来、收敛没有 |
| 输出 | `~/.pi/agent/audit/logs/YYYY-MM-DD.jsonl` | Markdown 报表 / `--json` |
| 对账 | §7 真机对账(审计侧 vs session jsonl) | 同一套口径的跨会话汇总;单会话结果可与 `audit-log.md` §7 的表逐项对齐 |

排错顺序:报表数字可疑 → 先用 `--session <id> --json` 看单会话原始聚合 → 再拿 `docs/audit-log.md` §4 的字段表核对日志本身 → 最后查 session jsonl(`sessionFile` 定位,`toolCallId` join)。

## 7. 已知边界

- `compact` / `model_select` / `user_bash` / `thinking_level` 四类事件本机日志里尚未触发(上游缺口 3),第 7 段在真机数据里会显示 0,代码路径靠 mock 覆盖
- `--session` 前缀命中多个会话时全部纳入,并在 stderr 提示
- 报表不做 toolResult 全文 / thinking 全文回联(需要时单会话手工 join,不在本次范围)
