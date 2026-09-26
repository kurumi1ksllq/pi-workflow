#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""pi 审计报表(只读)。

把 pi 审计扩展写出的 ``~/.pi/agent/audit/logs/*.jsonl`` 汇总成人看的 Markdown 报表。

- 只读日志，不改扩展，不删文件
- 只用 Python 3.11 标准库(argparse/json/pathlib/collections/datetime/statistics)
- 不联网，无交互，可被 cron 调
- 口径见 docs/audit-report-spec.md §4，用法见 docs/audit-report.md
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

TOKEN_KEYS = ("input", "cacheRead", "cacheWrite", "output")
USAGE_KEYS = TOKEN_KEYS + ("reasoning", "totalTokens")
DEFAULT_DIR = Path.home() / ".pi" / "agent" / "audit" / "logs"

# 子代理 runId 就是 pi-subagents 生成的 uuid(36 字符)，两种产物都拿它做合并键
RUN_ID_RE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
# `toolResult` 正文里的子会话路径：`...\<runId>\run-0\session.jsonl`（路径2 的兜底，§2.4）
SESSION_PATH_RE = re.compile(RUN_ID_RE.pattern + r"[\\/]+run-0")
# 「审计侧」列的三个取值（docs/audit-report.md §5）
SUBAGENT_AUDITED = "已入审计(标记为子代理)"
SUBAGENT_NOT_AUDITED = "未入审计"
SUBAGENT_META_ONLY = "仅 meta"

# 子代理归因的三条路径名，顺序与 §2.4 的可靠度排序一致
ATTR_PATHS = ("metaTranscriptPath", "toolResultRunId", "sessionPath")
ATTR_PATH_LABEL = {"metaTranscriptPath": "路径1", "toolResultRunId": "路径2",
                   "sessionPath": "路径3"}

# 已知 provider 名（`newapi` / `commandcode` …），由 `scan_session_models` 从
# assistant 消息的 `provider` 字段填进来 —— **不硬编码**，网关改名/换名也不会漏判。
# 它只影响 `_norm_meta_model` 的前缀剥除：`newapi/tier-power` 只有 2 段，
# 光靠「段数≥3」的旧规则剥不掉它。
KNOWN_PROVIDERS = set()


# --------------------------------------------------------------------------- #
# 小工具
# --------------------------------------------------------------------------- #
def _fmt(n) -> str:
    """整数千分位；拿不到数字就 '-'。"""
    try:
        return f"{int(n):,}"
    except (TypeError, ValueError):
        return "-"


def _pct(part, whole) -> str:
    if not whole:
        return "-"
    return f"{100.0 * part / whole:.1f}%"


def _num(v) -> int:
    """可无损转 int 的数值（含 float，拒 bool）；其余算 0。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return 0
    try:
        return int(v)
    except (OverflowError, ValueError):
        return 0


def _sid(v):
    """sessionId 必须是可哈希的字符串。脏值（list/dict/int）→ None，调用方跳过。

    日志是外部追加写的，坏行不应让整份报表挂掉；而且用 list/dict 当字典键会直接 TypeError。
    """
    return v if isinstance(v, str) and v else None


def _sort_key(ev) -> tuple:
    """统一的 (ts, seq) 排序 key：ts 规范成 str，seq 规范成 int。

    直接把原始值丢进 tuple 比较，一旦混入 dict/list 就会 TypeError: '<' not supported；
    把所有排序点收敛到这一个函数，避免每处各修一次。
    """
    ts = ev.get("ts")
    seq = ev.get("seq")
    return (ts if isinstance(ts, str) else "", seq if isinstance(seq, int) and not isinstance(seq, bool) else 0)


def _label(v, fallback: str) -> str:
    """从日志里取的**当字典键用的标签**（模型名/工具名/路径/角色）必须是 str。

    脏值若为 dict/list，拿去当键会直接 `TypeError: unhashable type`；
    统一在这里归一，免得每处 `.get()` 各写一遍 isinstance。
    """
    return v if isinstance(v, str) and v else fallback


def _list(v) -> list:
    """日志里的数组字段。不能用 `v or []` —— `True`/`8.0`/`"x"` 都是真值，会原样穿透。"""
    return v if isinstance(v, list) else []


def _dict(v) -> dict:
    """日志里的对象字段。同上，不能用 `v or {}`。"""
    return v if isinstance(v, dict) else {}


def _short_id(s) -> str:
    """id 一律截断成前 8 位(§6 隐私)；空值 '-'，桶名占位符原样。"""
    if not s:
        return "-"
    s = str(s)
    return s if s.startswith("(") or len(s) <= 8 else s[:8]


def _code(x) -> str:
    """表格里的路径/枚举值：空值显示 '-'。"""
    return f"`{x}`" if x not in (None, "") else "-"


def _parse_ts(s):
    if not isinstance(s, str):
        return None
    try:
        return datetime.fromisoformat(s)
    except ValueError:
        return None


def _local_date(dt):
    """ts 自带偏移，按本地时区切天(§4)。naive 时间按本地算。"""
    if dt is None:
        return None
    try:
        return dt.astimezone().date()
    except (OSError, OverflowError, ValueError):
        return None


def md_table(headers, rows) -> str:
    out = ["| " + " | ".join(headers) + " |",
           "| " + " | ".join("---" for _ in headers) + " |"]
    for r in rows:
        out.append("| " + " | ".join("" if c is None else str(c) for c in r) + " |")
    return "\n".join(out)


# --------------------------------------------------------------------------- #
# 命令行
# --------------------------------------------------------------------------- #
class _DirAction(argparse.Action):
    """--dir 可重复；与后面紧跟的 --label 配对。"""

    def __call__(self, parser, ns, values, option_string=None):
        ns.dirs.append([values, None])


class _LabelAction(argparse.Action):
    """--label 挂到最近一个 --dir；前面没有 --dir 就先记下来配默认目录。"""

    def __call__(self, parser, ns, values, option_string=None):
        if ns.dirs and ns.dirs[-1][1] is None:
            ns.dirs[-1][1] = values
        else:
            ns.dirs.append([None, values])


def parse_args(argv=None):
    p = argparse.ArgumentParser(
        prog="pi_audit_report.py",
        description="把 pi 审计日志(.jsonl)汇总成 Markdown 报表(只读、离线)。",
    )
    p.add_argument("--dir", action=_DirAction, dest="dirs", default=[], metavar="PATH",
                   help="日志目录，可重复；--dir A --label 张三 --dir B --label 李四 即按人分组")
    p.add_argument("--label", action=_LabelAction, dest="unused_label", default=None,
                   metavar="NAME", help="给最近一个 --dir 起人名，可重复")
    p.add_argument("--since", metavar="YYYY-MM-DD", help="起始日期(含)，按本地时区")
    p.add_argument("--until", metavar="YYYY-MM-DD", help="结束日期(含)，按本地时区")
    p.add_argument("--session", metavar="ID_PREFIX", help="只看某个会话(支持 id 前缀)")
    p.add_argument("--json", action="store_true", help="只出结构化 JSON，不打 Markdown")
    p.add_argument("--out", metavar="FILE", help="写文件而不是 stdout")
    p.add_argument("--prices", metavar="prices.json", help="价目表，折算成本")
    p.add_argument("--show-args", action="store_true",
                   help="打印 argsPreview/promptPreview 原文(仅 --session 模式)")
    p.add_argument("--all-days", action="store_true",
                   help="不限定日期，统计目录里全部日志（默认只算今天）")
    p.add_argument("--sessions-dir", metavar="PATH",
                   help="子代理产物目录（默认 ~/.pi/agent/sessions，PI_CODING_AGENT_DIR 兜底）")
    p.add_argument("--no-subagents", action="store_true",
                   help="不扫子代理产物（子代理段退化成一句提示）")
    p.add_argument("--model-map", metavar="FILE",
                   help="别名→真实模型的映射 JSON（给定时完全替代自动推导）")
    p.add_argument("--self-test", action="store_true",
                   help="对真实日志跑一遍内建断言（spec §8 对账基线），不打印报表")
    return p.parse_args(argv)


def _parse_day(s, flag):
    if not s:
        return None
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except (TypeError, ValueError):
        print(f"[warn] {flag} 不是 YYYY-MM-DD：{s!r}，忽略该参数", file=sys.stderr)
        return None


def resolve_dirs(args):
    """返回 [(Path, label|None)]。--dir 优先，PI_AUDIT_DIR 兜底(§2)。"""
    entries = list(args.dirs)
    if not entries:
        env = os.environ.get("PI_AUDIT_DIR") or ""
        base = Path(env) if env.strip() else DEFAULT_DIR
        entries = [[str(base), None]]
    out = []
    for d, label in entries:
        path = Path(d) if d else (Path(os.environ.get("PI_AUDIT_DIR") or DEFAULT_DIR))
        out.append((path, label))
    return out


# --------------------------------------------------------------------------- #
# 读日志
# --------------------------------------------------------------------------- #
def default_sessions_dir() -> Path:
    """子代理产物目录：`~/.pi/agent/sessions`，`PI_CODING_AGENT_DIR` 兜底（与扩展同一套）。"""
    env = os.environ.get("PI_CODING_AGENT_DIR") or ""
    base = Path(env) if env.strip() else Path.home() / ".pi" / "agent"
    return base / "sessions"


def _run_id_from(name: str):
    m = RUN_ID_RE.search(name or "")
    return m.group(0) if m else None


def _toolresult_text(m: dict) -> str:
    """把 `toolResult` 的 content 拍平成纯文本，用于找 `Run:` / `Session:`（不落盘，只看不发）。"""
    c = m.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "\n".join(x.get("text", "") for x in c if isinstance(x, dict))
    return ""


# 上游模型名的拼法漂移：三种写法实际同一个模型(§2.2 实测)。
# 用正则锚在**段首**，这样 `newapi/zai/x` 这种被 provider 包着的也能中。
MODEL_SPELLING_RE = re.compile(r"(^|/)(?:zai|zai-org)/")


def _norm_meta_model(model, providers=None):
    """模型名归一化(§2.2)—— meta.model / 审计侧 / 上游响应名三者要能对上。

    两步，顺序不能反：
    - **先统一拼法**：`zai/x` / `zai-org/x` → `z-ai/x`（锚在段首，`newapi/zai/x` 也中）。
      必须在剥前缀**之前**做，否则 `zai/x` 会被当成 provider 前缀剥成 `x`，丢掉组织段。
    - **再剥 provider 前缀**：判据是「第一段是已知 provider 名」（`newapi` / `commandcode`…，
      名单由 `scan_session_models` 从数据里采出来，见 `KNOWN_PROVIDERS`）。
      ⚠ 不能只看「段数≥3」：`newapi/tier-power` 只有 2 段，旧规则会漏掉它（自检抓到过）。
      段数≥3 作为兼容保留（前缀名未采到时的保守行为）。
    """
    if not isinstance(model, str) or not model:
        return None
    norm = MODEL_SPELLING_RE.sub(r"\1z-ai/", model)
    parts = norm.split("/")
    provs = KNOWN_PROVIDERS if providers is None else providers
    if parts[0] in provs or len(parts) >= 3:
        norm = "/".join(parts[1:])
    return norm or None


def scan_subagents(sessions_dir: Path, sessions=None):
    """按 `runId` 合并两处互不覆盖的子代理产物(见 docs/audit-report.md §5)：

    - `<项目编码>/subagent-artifacts/<runId>_<agent>_meta.json` —— 角色/模型/usage 权威源
    - `<项目编码>/<父会话>/<runId>/run-0/session.jsonl`         —— 子会话本体，首行 `id` = 子 sessionId

    两边 runId 对不上时用 usage 指纹兜底配对（`match_runs_by_usage`）。
    返回 `(runs, stats, ok)`；目录不存在时 `ok=False`，不算错。
    """
    runs = {}
    stats = {"metaFiles": 0, "run0Files": 0, "badJson": 0, "badRunId": 0,
             "zeroTurns": 0,
             "fingerprintMatched": 0, "fingerprintMiss": 0, "fingerprintAmbiguous": 0}
    if not sessions_dir.is_dir():
        return runs, stats, False

    def slot(rid):
        return runs.setdefault(rid, {
            "runId": rid, "agent": None, "model": None, "metaUsage": None,
            "childSessionId": None, "hasMeta": False, "hasRun0": False,
            "matchBy": None, "transcriptPath": None,
            "parentSessionId": None, "parentTurnIndex": None, "parentPath": None,
            "attrPath": None,
        })

    for p in sorted(sessions_dir.rglob("subagent-artifacts/*_meta.json")):
        stats["metaFiles"] += 1
        rid = _run_id_from(p.name)
        if not rid:
            stats["badRunId"] += 1
            continue
        try:
            doc = json.loads(p.read_text(encoding="utf-8", errors="replace"))
        except (OSError, ValueError) as exc:
            print(f"[warn] 读不了 {p}：{exc}", file=sys.stderr)
            stats["badJson"] += 1
            continue
        if not isinstance(doc, dict):
            stats["badJson"] += 1
            continue
        r = slot(rid)
        r["hasMeta"] = True
        r["matchBy"] = "runId"
        if isinstance(doc.get("agent"), str):
            r["agent"] = doc["agent"]
        if isinstance(doc.get("model"), str):
            r["model"] = doc["model"]
        if isinstance(doc.get("transcriptPath"), str):
            r["transcriptPath"] = doc["transcriptPath"]
        u = doc.get("usage")
        if isinstance(u, dict):
            usage = {k: _num(u.get(k)) for k in TOKEN_KEYS}
            usage["turns"] = _num(u.get("turns"))
            r["metaUsage"] = usage

    for p in sorted(sessions_dir.rglob("run-0/session.jsonl")):
        stats["run0Files"] += 1
        rid = p.parent.parent.name
        if not RUN_ID_RE.fullmatch(rid or ""):
            stats["badRunId"] += 1
            continue
        sid = None
        try:
            with p.open("r", encoding="utf-8", errors="replace") as fh:
                first = json.loads(fh.readline())
            if isinstance(first, dict) and isinstance(first.get("id"), str):
                sid = first["id"]
        except (OSError, ValueError) as exc:
            print(f"[warn] 读不了 {p} 首行：{exc}", file=sys.stderr)
            stats["badJson"] += 1
        r = slot(rid)
        r["hasRun0"] = True
        r["childSessionId"] = sid

    for r in runs.values():
        u = r["metaUsage"]
        if u and u["turns"] == 0 and not any(u[k] for k in TOKEN_KEYS):
            stats["zeroTurns"] += 1

    match_runs_by_usage(runs, sessions or {}, stats)
    return runs, stats, True


def _usage_fingerprint(agent, model, usage, turns):
    """一轮 run 的指纹：角色 + 规范化模型 + 五个数字。

    只有能唯一对上时才用于兜底配对（见 `match_runs_by_usage`），所以指纹越严越好。
    """
    if not usage or not any(usage.get(k) for k in TOKEN_KEYS):
        return None
    if not turns:
        return None
    return (agent or "未知", _norm_meta_model(model),
            tuple(usage.get(k) or 0 for k in TOKEN_KEYS), turns)


def match_runs_by_usage(runs, sessions, stats):
    """兜底配对：meta 的 `runId` 与 run-0 目录名对不上时，用「角色+模型+五个数字」配对。

    真实数据里见过：一次子代理 run 只落了 meta，run-0 目录挂的是**另一个** runId，
    但两者 usage 逐项相等（同一个子会话，两个产物各记了一份）。严格按 runId join 就永远对不上，
    故允许指纹兜底——**只接受一对一唯一命中**，命中不了就不配（宁可不配也不瞎配）。

    配对成功后在两边都盖 `pairedWith`/`matchBy`，并把 meta 行合进 run-0 那一行
    （runId 保留 run-0 那个，因为目录里就长这样）。
    """
    metas, run0s = [], []
    for rid, r in runs.items():
        if r["hasMeta"] and not r["hasRun0"]:
            fp = _usage_fingerprint(r["agent"], r["model"], r["metaUsage"],
                                    _dict(r["metaUsage"]).get("turns"))
            if fp:
                metas.append((rid, fp))
        elif r["hasRun0"] and not r["hasMeta"]:
            s = sessions.get(r["childSessionId"]) if r["childSessionId"] else None
            if not s or not s["usageCalls"]:
                continue
            fp = _usage_fingerprint(None, s.get("model"), s["tokens"], s["usageCalls"])
            if fp:
                run0s.append((rid, fp))

    for rid_m, fp_m in metas:
        # 审计侧指纹里角色是未知（run-0 不知道角色），只比模型+数字那 3 段
        hits = [rid_c for rid_c, fp_c in run0s if fp_c[1:] == fp_m[1:]]
        if len(hits) != 1:
            stats["fingerprintAmbiguous" if hits else "fingerprintMiss"] += 1
            continue
        rid_c = hits[0]
        m, c = runs[rid_m], runs[rid_c]
        if c["agent"] and m["agent"] and c["agent"] != m["agent"]:
            stats["fingerprintAmbiguous"] += 1
            continue
        c["agent"] = c["agent"] or m["agent"]
        c["model"] = c["model"] or m["model"]
        c["hasMeta"] = True
        c["metaUsage"] = m["metaUsage"]
        c["matchBy"] = "usage"
        m["pairedWith"] = rid_c
        stats["fingerprintMatched"] += 1
        run0s = [(x, f) for x, f in run0s if x != rid_c]


def _iter_session_lines(path: Path):
    """逐行读会话 jsonl；坏行/空行跳过（含正文的会话文件不整份读进内存）。"""
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    yield obj
    except OSError as exc:
        print(f"[warn] 读不了 {path}：{exc}", file=sys.stderr)


def _parent_session_files(sessions_dir: Path):
    """父会话文件 = `<sessions>/<项目编码>/<会话>.jsonl`（实测就这一层，不用递归）。

    排除三类不是父会话的：`_fork-backup*`（浏览器转储，本机占了全目录 90% 体积）、
    `<父会话>/<runId>/run-0/session.jsonl`（子会话）、`subagent-artifacts/`（子代理转储）。
    """
    if not sessions_dir.is_dir():
        return []
    out = []
    for proj in sorted(sessions_dir.iterdir()):
        if not proj.is_dir():
            continue
        for f in sorted(proj.glob("*.jsonl")):
            if "_fork-backup" in f.name:
                continue
            out.append(f)
    return out


def _model_scan_files(sessions_dir: Path):
    """推导别名映射的扫描集（§2.1）：`<sessions>/**/*.jsonl`，只排除两类。

    - `_fork-backup*`：浏览器转储，不是运行时记录（本机占了全目录 90% 体积）
    - `<父会话>/<runId>/run-0/session.jsonl`：子会话本体（同 `runId` 目录下）

    **`subagent-artifacts/*.jsonl` 要算进去** —— `tier-power → zai/glm-5.3-flash`
    这种配对只出现在子代理产物里；只扫父会话会漏掉它，那一行永远并不了。
    代价：这 51 MB 文本要过一遍（本机实测 0.3~1s）。
    """
    if not sessions_dir.is_dir():
        return []
    out = []
    for f in sessions_dir.rglob("*.jsonl"):
        p = str(f).replace(os.sep, "/")
        if "_fork-backup" in f.name or "/run-0/" in p:
            continue
        out.append(f)
    return sorted(out)


def build_model_map(pairs, manual=None):
    """别名 → 真实模型的映射（§2.1）。

    `pairs` 是 `(model, responseModel)` 计数：**权威来源是会话 jsonl 同一条 assistant 消息上的
    这两个字段**（`model` = 请求用的档位别名，`responseModel` = 上游真实名），从数据推导，不硬编码。
    `manual` 给定时**完全替代**自动推导（§2.1 第 3 条）。

    返回 `(map, info)`；`map` 的键是归一化后的运行时名字，值是归一化后的真实名。
    同一别名映射到多个真实名时取**出现次数最多**的，并在 `info["ambiguous"]` 里注明。
    """
    ambiguous, unmatched, alias_pairs = {}, Counter(), 0
    if manual is not None:
        m = {}
        skipped = []
        for k, v in manual.items():
            nk = _norm_meta_model(k)
            if not isinstance(v, str) or not v.strip():
                skipped.append(str(k))
                continue
            m[nk] = _norm_meta_model(v.strip())
        return m, {"source": "manual", "pairs": len(pairs),
                   "skipped": skipped, "ambiguous": {}, "unmatched": {}}

    votes = defaultdict(Counter)          # 归一化运行时名 → Counter(归一化真实名)
    for (model, resp), n in pairs.items():
        if not model or not resp:
            continue                       # responseModel 为 null：不参与映射推导(§2.1)
        alias_pairs += 1
        key = _norm_meta_model(model)
        # 键已经是真实模型名（与响应名同类、带 `/`）时不必映射，记「未命中」让它原样成行
        votes[key][_norm_meta_model(resp)] += n

    result = {}
    for key, counter in votes.items():
        if len(counter) == 1:
            target = next(iter(counter))
        else:
            target = counter.most_common(1)[0][0]
            ambiguous[key] = {"picked": target, "count": counter[target],
                              "others": {k: v for k, v in counter.items() if k != target}}
        # 真实名已知的（自带 `/` 或 `:`）不建映射，让它们原样保留成行(§5.4)
        if "/" in key or ":" in key:
            continue
        result[key] = target

    matched = sum(n for (model, resp), n in pairs.items()
                  if model and resp and _norm_meta_model(model) in result)
    unmatched = {"pairsWithoutResponseModel":
                 sum(n for (model, resp), n in pairs.items() if model and not resp),
                 "responseModels": sum(1 for (m, r) in pairs if not m)}
    return result, {"source": "auto", "pairs": len(pairs), "aliasPairs": alias_pairs,
                    "derived": result, "aliasHits": matched,
                    "ambiguous": ambiguous, "unmatched": unmatched}


def scan_session_models(sessions_dir: Path):
    """扫会话 jsonl，收集 `(model, responseModel)` 配对并推导**族映射**（§2.1）。

    返回 `(families, pairs, stats)`：
    - `families`：运行时名字 → **族名**。同一上游模型的别名与真实名归一族，
      族名优先取**别名**（`tier-std`），因为报告要回答的是「哪个档位在烧 token」
      （§0 动机）—— 真实名只是它背后的上游模型。推不出别名时（本机只有真实名，
      比如本机已无 `tier-max` 的记录）族名就是真实名自身，原样成行（§5.4）。
    - `pairs`：`Counter[(model, responseModel)]`，给 `build_model_map` 推导 别名→真实名
    """
    pairs = Counter()
    stats = {"files": 0, "assistantMsgs": 0, "withResponseModel": 0, "providers": []}
    providers = set()
    for f in _model_scan_files(sessions_dir):
        stats["files"] += 1
        for obj in _iter_session_lines(f):
            # 两种形状：会话 jsonl 用 `type`，子代理产物用 `recordType`（实测）
            if (obj.get("type") or obj.get("recordType")) != "message":
                continue
            m = obj.get("message")
            if not isinstance(m, dict) or m.get("role") != "assistant":
                continue
            stats["assistantMsgs"] += 1
            if isinstance(m.get("provider"), str) and m["provider"]:
                providers.add(m["provider"])
            model, resp = m.get("model"), m.get("responseModel")
            if model:
                pairs[(model, resp if isinstance(resp, str) and resp else None)] += 1
            if isinstance(resp, str) and resp:
                stats["withResponseModel"] += 1

    # provider 名单收集完再聚类 —— `_norm_meta_model` 靠它剥 `newapi/` 这类前缀（§2.2）
    KNOWN_PROVIDERS.update(providers)
    stats["providers"] = sorted(providers)

    # 按「上游真实名」聚类：同族的每个名字都指向族名（别名优先）
    by_real = defaultdict(Counter)
    for (model, resp), n in pairs.items():
        if not model or not isinstance(resp, str) or not resp:
            continue
        by_real[_norm_meta_model(resp)][_norm_meta_model(model)] += n

    families = {}
    for real, members in by_real.items():
        aliases = [(m, n) for m, n in members.items() if m != real and "/" not in m]
        # 别名形态（不带 `/`）里取出现次数最多的作为族名；没有别名就用真实名本身
        family = max(aliases, key=lambda kv: kv[1])[0] if aliases else real
        families.setdefault(real, family)
        for m in members:
            families.setdefault(m, family)
    # 没参与任何配对的名字（如 responseModel 恒 null 的档位）原样成行(§5.4)
    for (model, _resp) in pairs:
        if model:
            families.setdefault(_norm_meta_model(model), _norm_meta_model(model))
    return families, pairs, stats


def families_from_map(mapping, auto):
    """族映射 = 别名→族名。`mapping` 是别名→真实名（§2.1 的映射）。

    `families` 的族名必须取**别名**那一侧（`tier-std` 而不是它的上游真名），
    否则报告答不了「哪个档位在烧 token」这个原始问题（§0）。
    """
    fam = dict(auto)
    for alias, real in (mapping or {}).items():
        fam[_norm_meta_model(alias)] = _norm_meta_model(alias)
        if isinstance(real, str) and real:
            # 真实名也指回别名；别名缺位时（本机只有真名）才拿真名当族名
            fam[_norm_meta_model(real)] = fam.get(_norm_meta_model(alias), _norm_meta_model(alias))
    return fam


def merge_model_buckets(buckets, canonical_map):
    """按归并映射把「按模型」桶并族（§5.2 第 3 条）。

    **只改分组，不改总量**：所有键都只做「旧桶取数 → 新桶累加」，没有一步乘除或去重。
    顺序有关：目标键自己可能也在 `buckets` 里，先冻结成 `raw` 再写回，避免重复累加。
    """
    raw = {k: dict(v) for k, v in buckets.items()}
    out = defaultdict(lambda: dict.fromkeys(USAGE_KEYS, 0))
    for key, bucket in raw.items():
        target = canonical_map.get(_norm_meta_model(key), key)
        for k in USAGE_KEYS:
            out[target][k] += _num(bucket.get(k))
    return dict(out)


def attribute_subagents(runs, sessions_dir: Path):
    """把子代理 run 挂回父会话的具体轮次（§2.4）。

    三条路径按可靠度排序，命中即停，并把命中的路径名写进 `attrPath`：

    1. `meta.json` 的 `transcriptPath` 所在目录（`<项目编码>/subagent-artifacts/`）与
       `<项目编码>/<父会话>/<runId>/run-0/` 是同一个项目编码目录下的兄弟 —— 用那个
       runId 目录找到父会话文件名
    2. 父会话 `toolResult` 正文里的 `Run: <runId>` → 它的 `toolCallId` → 反查同 id 的
       `toolCall` 属于哪条 assistant 消息 → 所属轮次（**最可靠**，runId 就在 toolResult 里，
       天然带 toolCallId）
    3. `toolResult` 正文里 `Session: ...` 路径带 `<runId>/run-0` 的，用那个 uuid 反推

    **不用文件名/路径做启发式猜测** —— 实测会全部落空并给出相反结论（§2.4 末）。
    返回统计 `stats`，它也会写回每个 run 的 `parentSessionId` / `parentTurnIndex`；
    没命中的字段**保持 `null` 并计数**，不瞎填。
    """
    stats = {"files": 0, "toolResults": 0, "hit": 0, "total": 0, "unattributed": 0,
             "byPath": dict.fromkeys(ATTR_PATHS, 0),
             "parents": 0}
    if not runs:
        return stats
    alive = [r for r in runs.values() if not r.get("pairedWith")]
    stats["total"] = len(alive)          # `hit + unattributed == total` 是硬约束(§5.3 第 5 条)
    if not alive:
        return stats

    # —— 路径 1：`transcriptPath` 的项目编码目录 → `<项目>/<父会话目录>/<runId>/run-0/` —— #
    # 实测层级就四段（别少写一层，见 §3.4）：
    # `<sessions>/<项目编码>/<父会话目录>/<runId>/run-0/session.jsonl`，
    # 所以三个上级目录就是**父会话目录名**，它的兄弟 `同名.jsonl` 才是父会话文件。
    by_run_dir = defaultdict(list)
    if sessions_dir.is_dir():
        for p in sessions_dir.glob("*/*/*/run-0/session.jsonl"):
            parts = p.relative_to(sessions_dir).parts       # (项目, 父会话目录, runId, run-0, file)
            if len(parts) >= 5:
                by_run_dir[parts[2]].append(sessions_dir / parts[0] / f"{parts[1]}.jsonl")
    path1 = {}
    for r in alive:
        rid = r["runId"]
        cands = [p for p in by_run_dir.get(rid, []) if p.is_file()]
        if len(cands) == 1:
            path1[rid] = cands[0]

    def _session_id_of(path: Path):
        """父会话 jsonl 首行 `type=session` 的 `id`；读不到返回 None。"""
        for obj in _iter_session_lines(path):
            if obj.get("type") == "session" and obj.get("id"):
                return obj["id"]
        return None

    # —— 路径 2/3：扫父会话 jsonl，建 runId → (父会话, 轮次) 与 runId → 父会话 —— #
    run_index, sess_index = {}, {}
    for f in _parent_session_files(sessions_dir):
        stats["files"] += 1
        sid, turn, call_turn = None, 0, {}
        for obj in _iter_session_lines(f):
            if obj.get("type") == "session" and sid is None and obj.get("id"):
                sid = obj["id"]
            if obj.get("type") != "message":
                continue
            m = obj.get("message")
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            if role == "user":
                turn += 1                       # 轮次 = 第几条 user 消息（含 toolResult 回灌的那类）
            elif role == "assistant":
                for c in _list(m.get("content")):
                    if isinstance(c, dict) and c.get("type") == "toolCall" and c.get("id"):
                        call_turn[c["id"]] = turn
            elif role == "toolResult":
                stats["toolResults"] += 1
                text = _toolresult_text(m)
                if not text:
                    continue
                tcid = m.get("toolCallId")
                for rid in set(RUN_ID_RE.findall(text)) if "Run:" in text else ():
                    # 同一个 runId 在多轮里重复播报（状态刷新型 toolResult），**首次出现**才算发起轮次
                    run_index.setdefault(rid, (sid, obj.get("id"), call_turn.get(tcid, turn), f))
                for cand in SESSION_PATH_RE.findall(text):
                    rid2 = _run_id_from(cand)
                    if rid2:
                        sess_index.setdefault(rid2, (sid, f))
        if sid:
            stats["parents"] += 1

    for r in alive:
        rid = r["runId"]
        if rid in path1:
            r["parentPath"], r["attrPath"] = str(path1[rid]), "metaTranscriptPath"
            r["parentSessionId"] = _session_id_of(path1[rid])
        elif rid in run_index:
            sid, tid, tix, path = run_index[rid]
            r["parentSessionId"], r["parentTurnIndex"] = sid, tix
            r["parentPath"], r["attrPath"] = str(path), "toolResultRunId"
        elif rid in sess_index:
            sid, path = sess_index[rid]
            r["parentSessionId"], r["parentPath"] = sid, str(path)
            r["attrPath"] = "sessionPath"
        if r["attrPath"]:
            stats["hit"] += 1
            stats["byPath"][r["attrPath"]] += 1
        else:
            stats["unattributed"] += 1
    return stats


def discover_files(dir_path: Path, since, until):
    """按文件名日期预筛；名字不是 YYYY-MM-DD.jsonl 的照收，交给 ts 过滤。"""
    if not dir_path.is_dir():
        return []
    files = []
    for f in sorted(dir_path.glob("*.jsonl")):
        stem = f.name[:-len(".jsonl")]
        try:
            d = datetime.strptime(stem, "%Y-%m-%d").date()
        except ValueError:
            files.append(f)
            continue
        if since and d < since:
            continue
        if until and d > until:
            continue
        files.append(f)
    return files


def load_events(path: Path, label):
    """逐行读；空行跳过，坏 JSON 跳过并计数(§4)。返回 (events, total_lines, skipped)。"""
    events, total, skipped = [], 0, 0
    try:
        raw = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        print(f"[warn] 读不了 {path}：{exc}", file=sys.stderr)
        return events, 0, 0
    for line in raw.splitlines():
        total += 1
        if not line.strip():
            skipped += 1
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            skipped += 1
            continue
        if not isinstance(obj, dict):
            skipped += 1
            continue
        obj["_label"] = label
        obj["_file"] = str(path)
        events.append(obj)
    return events, total, skipped


# --------------------------------------------------------------------------- #
# 聚合
# --------------------------------------------------------------------------- #
def _new_session(sid, ev):
    return {
        "sessionId": sid,
        "cwd": ev.get("cwd"),
        "model": ev.get("model"),
        "provider": ev.get("provider"),
        "tokens": dict.fromkeys(USAGE_KEYS, 0),
        "usageCalls": 0,
        "settled": 0,
        "hasSessionEvent": 0,
        "skillCount": None,
        "skills": {},
        "tools": defaultdict(lambda: {"calls": 0, "results": 0, "errors": 0,
                                      "durs": [], "chars": 0}),
        "events": Counter(),
        "labels": set(),
        "compacts": [],
        "cacheReadSeries": [],
        "seqGaps": 0,
        "lastStopReason": None,
        "firstTs": None,
        "lastTs": None,
        "lastSeq": -1,
        "lastEvent": None,
    }


def _usage_total(u):
    """§4：token 用量只取 usage 四字段逐条相加（不用 agent_end.turnTokens，也不依赖 totalTokens）。"""
    return sum(_num(u.get(k)) for k in TOKEN_KEYS)


def aggregate(events):
    """按 sessionId 分组聚合。返回 (sessions dict, daily, bymodel)。"""
    S = {}
    daily = defaultdict(lambda: dict.fromkeys(USAGE_KEYS, 0))
    bymodel = defaultdict(lambda: dict.fromkeys(USAGE_KEYS, 0))

    for ev in sorted(events, key=_sort_key):
        sid = _sid(ev.get("sessionId")) or "(无 sessionId)"
        s = S.get(sid)
        if s is None:
            s = S[sid] = _new_session(sid, ev)
        if ev.get("cwd"):
            s["cwd"] = ev["cwd"]
        if ev.get("model"):
            s["model"] = ev["model"]
        if ev.get("provider"):
            s["provider"] = ev["provider"]
        if ev.get("_label"):
            s["labels"].add(ev["_label"])

        kind = ev.get("event") or "(unknown)"
        s["events"][kind] += 1
        s["lastEvent"] = kind
        dt = _parse_ts(ev.get("ts"))
        if dt is not None:
            if s["firstTs"] is None:
                s["firstTs"] = dt
            s["lastTs"] = dt
        seq = ev.get("seq")
        if isinstance(seq, int):
            # seq 是进程内计数器；回退即新进程，不判缺口(§4)
            if s["lastSeq"] >= 0 and seq > s["lastSeq"] + 1:
                s["seqGaps"] += 1
            s["lastSeq"] = seq

        if kind == "session":
            s["hasSessionEvent"] += 1
            if isinstance(ev.get("skillCount"), int):
                s["skillCount"] = ev["skillCount"]
            for sk in _list(ev.get("skills")):
                if not isinstance(sk, dict):
                    continue
                fp = _label(sk.get("filePath") or sk.get("name"), "(无路径)")
                if not fp:
                    continue
                info = sk.get("sourceInfo") if isinstance(sk.get("sourceInfo"), dict) else {}
                rec = s["skills"].setdefault(fp, {
                    "name": sk.get("name"),
                    "filePath": fp,
                    "source": info.get("source"),
                    "origin": info.get("origin"),
                    "scope": info.get("scope"),
                    "sessions": set(),
                    "hits": 0,
                })
                rec["hits"] += 1
                rec["sessions"].add(sid)

        elif kind == "assistant_usage":
            u = ev.get("usage") if isinstance(ev.get("usage"), dict) else {}
            s["usageCalls"] += 1
            # total 一律由四字段导出，不采信日志里的 usage.totalTokens(§4)，否则与按天/按模型表打架
            total = _usage_total(u)
            for k in TOKEN_KEYS + ("reasoning",):
                s["tokens"][k] += _num(u.get(k))
            s["tokens"]["totalTokens"] += total
            day = _local_date(dt)
            slot = day.isoformat() if day else "(无 ts)"
            model = _label(ev.get("model"), "(未知模型)")
            for bucket in (daily[slot], bymodel[model]):
                for k in TOKEN_KEYS:
                    bucket[k] += _num(u.get(k))
                bucket["reasoning"] += _num(u.get("reasoning"))
                bucket["totalTokens"] += total
            if u.get("cacheRead") is not None:
                s["cacheReadSeries"].append(_num(u.get("cacheRead")))
            if ev.get("stopReason"):
                s["lastStopReason"] = ev["stopReason"]

        elif kind == "tool_call":
            name = _label(ev.get("toolName"), "(未知工具)")
            s["tools"][name]["calls"] += 1

        elif kind == "tool_result":
            name = _label(ev.get("toolName"), "(未知工具)")
            t = s["tools"][name]
            t["results"] += 1
            if ev.get("isError") is True:
                t["errors"] += 1
            d = ev.get("durationMs")
            if isinstance(d, (int, float)) and not isinstance(d, bool):
                t["durs"].append(d)
            t["chars"] += _num(ev.get("resultChars"))

        elif kind == "agent_settled":
            s["settled"] += 1

        elif kind == "compact":
            s["compacts"].append({
                "tokensBefore": _num(ev.get("tokensBefore")),
                "reason": ev.get("reason"),
                "ts": ev.get("ts"),
            })

    return S, daily, bymodel


def build_subagents(audit_sessions, runs, enabled, sessions_dir, attribution=None):
    """子代理段数据（docs/audit-report.md §5）。

    口径铁则：**子代理段只做标签化，不往总量里加一次**。
    - 概览 `总 token` 始终 = 审计日志全集（已入审计的子代理本来就在里面）
    - `meta.usage` 只在「仅 meta」行里展示，单列出「未入审计」合计，绝不并进总 token

    `audit_sessions` 必须是**未过滤的全量会话**（`main()` 负责保证）：`--session/--since/--until`
    会把审计日志过滤掉，若子代理段用过滤后的口径，占比分子会被削到 0 而分母仍是全量，
    同一页里两个口径打架。

    返回 `(section_dict, type_by_sessionId)`。
    """
    audit_sessions = audit_sessions or {}
    type_by_sid = {}
    groups = {}

    def group(agent, model):
        key = (agent or "未知", model or "(未知)")
        return groups.setdefault(key, {
            "role": agent or "未知", "model": model, "runs": 0,
            "metaUsage": dict.fromkeys(TOKEN_KEYS, 0), "metaTurns": 0,
            "auditUsage": dict.fromkeys(TOKEN_KEYS, 0), "auditTurns": 0,
            "auditedRuns": 0, "metaOnlyRuns": 0,
            "mismatch": False, "usageMatched": 0,
        })

    for r in sorted(runs.values(), key=lambda x: x["runId"]):
        if r.get("pairedWith"):
            continue  # 这条 meta 已合进被配对的 run-0 那一行，不重复计数
        s = audit_sessions.get(r["childSessionId"]) if r["childSessionId"] else None
        audit_t = s["tokens"] if s else None
        audit_turns = s["usageCalls"] if s else 0
        # 模型：审计侧有就用审计侧的（同一个模型，审计侧模型会带 newapi/ 前缀差异，以审计侧为准）
        model = (s.get("model") if s else None) or _norm_meta_model(r["model"])
        g = group(r["agent"], model)
        g["runs"] += 1
        if r.get("matchBy") == "usage":
            g["usageMatched"] += 1

        if r["hasMeta"] and r["metaUsage"]:
            for k in TOKEN_KEYS:
                g["metaUsage"][k] += r["metaUsage"][k]
            g["metaTurns"] += r["metaUsage"].get("turns") or 0
        if audit_t:
            g["auditedRuns"] += 1
            g["auditTurns"] += audit_turns
            for k in TOKEN_KEYS:
                g["auditUsage"][k] += audit_t[k]
            type_by_sid[r["childSessionId"]] = f"子代理:{r['agent'] or '未知'}"
        if r["hasMeta"] and not (r["hasRun0"] and audit_t):
            g["metaOnlyRuns"] += 1
        # 对账：两侧都有数字才比（meta 的 turns=0 / 侧边缺失不算不一致）
        if r["hasMeta"] and r["metaUsage"] and audit_t:
            for k in TOKEN_KEYS:
                if r["metaUsage"][k] != audit_t[k]:
                    g["mismatch"] = True

    rows = []
    for (role, model), g in sorted(
            groups.items(),
            key=lambda kv: -max(sum(kv[1]["auditUsage"].values()), sum(kv[1]["metaUsage"].values()))):
        if g["auditedRuns"] and not g["metaOnlyRuns"]:
            side = SUBAGENT_AUDITED
        elif g["auditedRuns"]:
            side = f"{SUBAGENT_AUDITED} + 仅 meta"
        elif g["metaOnlyRuns"]:
            side = SUBAGENT_META_ONLY
        else:
            side = SUBAGENT_NOT_AUDITED
        rows.append({
            "role": role, "model": model, "runs": g["runs"], "side": side,
            "metaUsage": dict(g["metaUsage"]), "metaTurns": g["metaTurns"],
            "auditUsage": dict(g["auditUsage"]), "auditTurns": g["auditTurns"],
            "mismatch": g["mismatch"], "metaOnlyRuns": g["metaOnlyRuns"],
            "usageMatched": g["usageMatched"],
        })

    totals = {
        "runs": 0,
        "metaOnly": dict.fromkeys(TOKEN_KEYS, 0), "metaOnlyRuns": 0,
        "audit": dict.fromkeys(TOKEN_KEYS, 0), "auditedRuns": 0,
    }
    for r in runs.values():
        if r.get("pairedWith"):
            continue
        totals["runs"] += 1
        s = audit_sessions.get(r["childSessionId"]) if r["childSessionId"] else None
        if r["hasMeta"] and r["metaUsage"] and not s:
            totals["metaOnlyRuns"] += 1
            for k in TOKEN_KEYS:
                totals["metaOnly"][k] += r["metaUsage"][k]
        if s:
            totals["auditedRuns"] += 1
            for k in TOKEN_KEYS:
                totals["audit"][k] += s["tokens"][k]

    audit_total = sum(sum(s["tokens"][k] for k in TOKEN_KEYS) for s in audit_sessions.values())
    return {
        "enabled": enabled,
        "sessionsDir": str(sessions_dir),
        "exists": sessions_dir.is_dir(),
        "rows": rows,
        "totals": totals,
        "auditTotalTokens": audit_total,
        "auditedShare": _pct(sum(totals["audit"].values()), audit_total),
        "metaOnlyTotal": sum(totals["metaOnly"].values()),
        "usageMatchedRuns": sum(1 for r in runs.values() if r.get("matchBy") == "usage"),
        "attribution": attribution or {"hit": 0, "total": 0,
                                        "byPath": dict.fromkeys(ATTR_PATHS, 0),
                                        "unattributed": 0},
        "attributed": [{
            "runId": r["runId"], "agent": r.get("agent"),
            "model": _norm_meta_model(r.get("model")),
            "parentSessionId": r.get("parentSessionId"),
            "parentTurnIndex": r.get("parentTurnIndex"),
            "attrPath": r.get("attrPath"),
        } for r in sorted(runs.values(), key=lambda x: x["runId"]) if r.get("attrPath")],
    }, type_by_sid


def build_context_composition(events, max_sessions=10):
    """上下文构成段数据（docs/audit-report.md §9）。

    数据源只有阶段 3 新增的 `context_sample` 事件（每轮一条，挂在 `turn_end`）。
    老日志里没这个事件 → 本段为空，报表侧写「本段需要 context_sample 事件」，不 traceback。

    口径（spec §3.3，别自己发明）：
    - **固定税** = `sections` 合计 + `toolDefs.chars`（每轮完全不变的那部分）
    - **增长** = `messages.charsByRole` 合计 − 该轮 `system` 部分（system 里已含 sections）
    - **字符 → token 比例** = `contextTokens` ÷ 该轮总字符（总字符 = messages 合计 + toolDefs.chars）
    - **对账** = |`contextTokens` − (`input` + `cacheRead`)| ÷ (`input` + `cacheRead`) ≤ 2%

    `assistant_usage` 不带 `turnIndex`，只能按会话内 `(ts, seq)` 顺序与 `context_sample` 逐轮配对；
    同轮里 `assistant_usage`（message_end）永远早于 `context_sample`（turn_end），所以顺序配对成立。
    """
    by_sid = defaultdict(lambda: {"samples": [], "usages": []})
    for ev in events:
        sid = _sid(ev.get("sessionId"))
        if not sid:
            continue
        kind = ev.get("event")
        if kind == "context_sample":
            by_sid[sid]["samples"].append(ev)
        elif kind == "assistant_usage":
            by_sid[sid]["usages"].append(ev)

    rows = []
    # 全局字符→token 比例：收齐**所有会话、所有轮次**的逐轮比例，最后取**一次**中位。
    # 不能“每会话先取中位、再对这些中位取中位”：会话轮数不等时会失真
    # （100 轮 0.25 + 1 轮 1.0 → 正确 0.25，中位的中位却是 0.625），
    # 而这个比例会拿去换算每一行的固定税，错一处就全错。
    all_turn_ratios = []
    for sid, d in by_sid.items():
        if not d["samples"]:
            continue
        order = _sort_key
        samples = sorted(d["samples"], key=order)
        usages = sorted(d["usages"], key=order)

        def chars_of(s):
            msgs = s.get("messages")
            byrole_raw = _dict(msgs.get("charsByRole")) if isinstance(msgs, dict) else {}
            byrole = {k: _num(v) for k, v in byrole_raw.items()} if isinstance(byrole_raw, dict) else {}
            tool_defs = s.get("toolDefs")
            tool = _num(tool_defs.get("chars") if isinstance(tool_defs, dict) else 0)
            return {
                "total": sum(byrole.values()) + tool,
                "tool": tool,
                "fixed": _num(s.get("sectionsTotalChars")) + tool,
                # 增长 = 全部消息 − system 部分（system 里已含 sections）
                "growth": sum(byrole.values()) - byrole.get("system", 0),
            }

        per_turn = [chars_of(s) for s in samples]
        for s, c in zip(samples, per_turn, strict=False):
            tk = s.get("contextTokens")
            if isinstance(tk, (int, float)) and not isinstance(tk, bool) and c["total"] > 0:
                all_turn_ratios.append(tk / c["total"])

        # 对账：两列表都按 (ts, seq) 排好了，同轮里 `assistant_usage` 先写、`context_sample` 后写，
        # 所以双指针就近配对即可。不能用 zip：升级当天部分轮次没 sample，zip 会从头部错位。
        # 比较必须用完整 (ts, seq)：同毫秒时间戳时只比 ts 会把 seq 在 sample 之后的 usage 错配进来。
        reconcile = None
        j = 0
        for s in samples:
            sk = order(s)
            while j + 1 < len(usages) and order(usages[j + 1]) <= sk:
                j += 1
            if j >= len(usages) or order(usages[j]) > sk:
                continue
            us = usages[j].get("usage") if isinstance(usages[j].get("usage"), dict) else {}
            j += 1  # 消费掉，不重复配
            billed = _num(us.get("input")) + _num(us.get("cacheRead"))
            tk = s.get("contextTokens")
            if billed > 0 and isinstance(tk, (int, float)) and not isinstance(tk, bool):
                dev = abs(tk - billed) / billed * 100
                if reconcile is None or dev > reconcile:
                    reconcile = dev

        # 「每轮平均 input+缓存读」按该会话**全部** assistant_usage 算（这就是「每轮」的含义）
        billed_all = [_num(_dict(u.get("usage")).get("input")) + _num(_dict(u.get("usage")).get("cacheRead"))
                      for u in usages if isinstance(u.get("usage"), dict)]
        billed_all = [b for b in billed_all if b > 0]
        avg_billed = statistics.mean(billed_all) if billed_all else None

        rows.append({
            "sessionId": sid,
            "turns": len(samples),
            "fixedTaxChars": per_turn[0]["fixed"],
            "toolChars": per_turn[0]["tool"],
            "firstGrowth": per_turn[0]["growth"],
            "lastGrowth": per_turn[-1]["growth"],
            "avgInputCache": avg_billed,
            "reconcilePct": reconcile,
        })

    # 两阶段：先求全局中位比例（逐轮汇总，不是中位的中位），再回填每行。
    # 若各行用自己的会话内比例，与表下公布的换算比例就不是同一个数，表中「估算」列会与说明不符。
    ratio = statistics.median(all_turn_ratios) if all_turn_ratios else None
    for r in rows:
        fixed_tokens = r["fixedTaxChars"] * ratio if ratio else None
        r["fixedTaxTokens"] = fixed_tokens
        # 存裸百分比数值（与 reconcilePct 同构），Markdown 侧再转 "83.8%"。
        # 若存 _pct() 的字符串，--json 下游拿到的是 "83.8%" 而非数字，没法直接算。
        r["fixedTaxSharePct"] = (100.0 * fixed_tokens / r["avgInputCache"]
                                 if (fixed_tokens is not None and r["avgInputCache"]) else None)
        r["ratio"] = ratio

    rows.sort(key=lambda r: (-r["turns"], r["sessionId"]))
    return {"rows": rows[:max_sessions], "totalRows": len(rows),
            "ratio": ratio,
            "maxReconcilePct": max([r["reconcilePct"] for r in rows if r["reconcilePct"] is not None], default=None)}


# --------------------------------------------------------------------------- #
# 报表数据
# --------------------------------------------------------------------------- #
def build_data(args, entries, sessions, daily, bymodel, stats, events, subagents=None,
               sid_types=None, model_map=None, modelmap_info=None):
    R = {"generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
         "sources": [], "overview": {}, "tokensByDay": [], "tokensByModel": [],
         "topSessions": [], "byPerson": None, "tools": [], "skills": [],
         "completion": {}, "contextPressure": {}, "contextComposition": {},
         "cost": None, "observations": []}

    for path, label in entries:
        R["sources"].append({"dir": str(path), "label": label})

    grand = dict.fromkeys(USAGE_KEYS, 0)
    for s in sessions.values():
        for k in USAGE_KEYS:
            grand[k] += s["tokens"][k]

    incomplete = [s for s in sessions.values()
                  if not s["hasSessionEvent"] and (s["usageCalls"] or s["events"].get("turn_start"))]
    R["overview"] = {
        "files": stats["files"],
        "totalLines": stats["lines"],
        "skippedLines": stats["skipped"],
        "sessions": len(sessions),
        "events": len(events),
        "eventTypes": dict(Counter(e.get("event") or "(unknown)" for e in events).most_common()),
        "incompleteSessions": len(incomplete),
        "seqGaps": sum(s["seqGaps"] for s in sessions.values()),
        "since": args._since.isoformat() if args._since else None,
        "until": args._until.isoformat() if args._until else None,
        "totalTokens": grand["totalTokens"],
        "tokens": dict(grand),
    }

    for day in sorted(daily):
        d = daily[day]
        R["tokensByDay"].append({"day": day, **d, "cacheReadPct": _pct(d["cacheRead"], d["totalTokens"])})

    # 「按模型」表归族(§2.1)：同一上游模型的别名与真实名并成一行，行名取**档位别名**
    # （报告要回答「哪个档位在烧 token」，见 §0）。归并在**桶级**发生，
    # `overview.totalTokens` 不走这条路 —— 它由 aggregate 直接逐条累加(§5.2 第 4 条)。
    fam = model_map or {}
    merged = merge_model_buckets(bymodel, fam)
    # 未命中映射的名字**单独成行并在表尾计数上报**，不许静默归入「(未知模型)」(§2.1 第 4 条)
    unmapped = sorted(k for k in merged if _norm_meta_model(k) not in fam)
    for model in sorted(merged, key=lambda m: -merged[m]["totalTokens"]):
        m = merged[model]
        R["tokensByModel"].append({"model": model, **m, "cacheReadPct": _pct(m["cacheRead"], m["totalTokens"])})
    R["modelMap"] = {
        "rowsBefore": len(bymodel), "rowsAfter": len(merged),
        "groups": [{"from": k, "to": fam[_norm_meta_model(k)]}
                   for k in sorted(bymodel) if fam.get(_norm_meta_model(k), k) != k],
        "unmapped": unmapped, "info": modelmap_info or {},
    }

    # 每会话 skillCount（§8.2 验收要能直接读到）
    R["skillCounts"] = [{
        "sessionId": s["sessionId"], "skillCount": s["skillCount"],
        "filePathCount": len(s["skills"]), "incomplete": not s["hasSessionEvent"],
    } for s in sorted(sessions.values(), key=lambda x: x["sessionId"])]

    for s in sorted(sessions.values(), key=lambda x: -x["tokens"]["totalTokens"])[:10]:
        t = s["tokens"]
        R["topSessions"].append({
            "sessionId": s["sessionId"], "cwd": s["cwd"], "model": s["model"],
            "type": _dict(sid_types).get(s["sessionId"]) or "父会话",
            **t, "cacheReadPct": _pct(t["cacheRead"], t["totalTokens"]),
            "settled": bool(s["settled"]),
        })

    # 按人(仅给了 label 时)
    if any(label for _, label in entries):
        persons = defaultdict(lambda: {"tokens": dict.fromkeys(USAGE_KEYS, 0),
                                       "sessions": set(), "toolCalls": 0,
                                       "toolResults": 0, "toolErrors": 0})
        for s in sessions.values():
            keys = s["labels"] or {"(未标注)"}
            for key in keys:
                p = persons[key]
                p["sessions"].add(s["sessionId"])
                for k in USAGE_KEYS:
                    p["tokens"][k] += s["tokens"][k]
                for t in s["tools"].values():
                    p["toolCalls"] += t["calls"]
                    p["toolResults"] += t["results"]
                    p["toolErrors"] += t["errors"]
        R["byPerson"] = [
            {"label": k, **v, "sessionCount": len(v["sessions"]),
             "cacheReadPct": _pct(v["tokens"]["cacheRead"], v["tokens"]["totalTokens"]),
             "failRate": _pct(v["toolErrors"], v["toolResults"])}
            for k, v in sorted(persons.items(), key=lambda kv: -kv[1]["tokens"]["totalTokens"])
        ]

    # 工具
    tool_agg = defaultdict(lambda: {"calls": 0, "results": 0, "errors": 0, "durs": [], "chars": 0})
    for s in sessions.values():
        for name, t in s["tools"].items():
            a = tool_agg[name]
            a["calls"] += t["calls"]
            a["results"] += t["results"]
            a["errors"] += t["errors"]
            a["durs"].extend(t["durs"])
            a["chars"] += t["chars"]
    for name, a in sorted(tool_agg.items(), key=lambda kv: (-kv[1]["calls"], kv[0])):
        R["tools"].append({
            "tool": name, "calls": a["calls"], "results": a["results"],
            "ok": a["results"] - a["errors"], "errors": a["errors"],
            "failRate": _pct(a["errors"], a["results"]),
            "avgMs": round(statistics.fmean(a["durs"]), 1) if a["durs"] else None,
            "maxMs": max(a["durs"]) if a["durs"] else None,
            "resultChars": a["chars"],
        })

    # skill 命中(filePath 权威键，跨会话按会话去重计数)
    skill_agg = {}
    skill_sessions = defaultdict(set)
    for s in sessions.values():
        for fp, rec in s["skills"].items():
            skill_sessions[fp].add(s["sessionId"])
            agg = skill_agg.setdefault(fp, dict(rec, hits=0))
            agg["hits"] += rec["hits"]
    for fp, agg in skill_agg.items():
        R["skills"].append({
            "name": agg.get("name"), "filePath": fp, "source": agg.get("source"),
            "origin": agg.get("origin"), "hits": agg["hits"],
            "sessionCount": len(skill_sessions[fp]),
        })
    R["skills"].sort(key=lambda x: (-x["hits"], x["filePath"] or ""))

    # 完成度
    settled = [s for s in sessions.values() if s["settled"]]
    unsettled = [s for s in sessions.values() if not s["settled"]]
    R["completion"] = {
        "total": len(sessions), "settled": len(settled),
        "rate": _pct(len(settled), len(sessions)),
        "unsettled": [{
            "sessionId": s["sessionId"], "cwd": s["cwd"],
            "lastEvent": s["lastEvent"] or "-",
            "stopReason": s["lastStopReason"],
            "incomplete": not s["hasSessionEvent"],
        } for s in sorted(unsettled, key=lambda x: x["sessionId"])],
    }

    # 上下文压力
    all_compacts = [c for s in sessions.values() for c in s["compacts"]]
    befores = [c["tokensBefore"] for c in all_compacts]
    growing = []
    for s in sessions.values():
        if len(s["compacts"]) >= 2:
            series = s["cacheReadSeries"]
            if len(series) >= 2 and all(b >= a for a, b in zip(series, series[1:], strict=False)) and series[-1] > series[0]:
                growing.append({"sessionId": s["sessionId"], "compacts": len(s["compacts"]),
                                "cacheReadFirst": series[0], "cacheReadLast": series[-1]})
    R["contextPressure"] = {
        "compacts": len(all_compacts),
        "sessionsWithCompact": sum(1 for s in sessions.values() if s["compacts"]),
        "tokensBeforeMax": max(befores) if befores else None,
        "tokensBeforeMedian": statistics.median(befores) if befores else None,
        "growing": growing,
        "details": [{"sessionId": s["sessionId"], "reason": c["reason"],
                     "tokensBefore": c["tokensBefore"], "ts": c["ts"]}
                    for s in sessions.values() for c in s["compacts"]],
    }

    if args.prices:
        R["cost"] = build_cost(args.prices, bymodel)

    R["subagents"] = subagents
    R["contextComposition"] = build_context_composition(events)
    R["observations"] = build_observations(R, grand)
    return R


def build_cost(prices_path, bymodel):
    cost = {"pricesFile": str(prices_path), "note": None, "unit": None,
            "models": [], "total": None, "unpriced": [], "warning": None}
    try:
        doc = json.loads(Path(prices_path).read_text(encoding="utf-8"))
    except OSError as exc:
        print(f"[warn] 读不了价目表 {prices_path}：{exc}", file=sys.stderr)
        cost["error"] = str(exc)
        return cost
    except ValueError as exc:
        print(f"[warn] 价目表不是合法 JSON：{exc}", file=sys.stderr)
        cost["error"] = str(exc)
        return cost

    if not isinstance(doc, dict):
        print(f"[warn] 价目表顶层应为对象，实际是 {type(doc).__name__}，按空表处理", file=sys.stderr)
        doc = {}
    cost["note"] = doc.get("note")
    cost["unit"] = doc.get("unit")
    # 单价口径：默认每 1 token；价目表按每百万 token 报价时写 "perTokens": 1000000
    per = doc.get("perTokens", 1)
    if not isinstance(per, (int, float)) or isinstance(per, bool) or per <= 0:
        print(f"[warn] price 文件的 perTokens 非法：{per!r}，按 1 处理", file=sys.stderr)
        per = 1
    cost["perTokens"] = per
    models = doc.get("models") if isinstance(doc.get("models"), dict) else {}
    total = 0.0
    any_priced = False
    for model in sorted(bymodel, key=lambda m: -bymodel[m]["totalTokens"]):
        u = bymodel[model]
        p = models.get(model)
        row = {"model": model, **{k: u[k] for k in TOKEN_KEYS + ("totalTokens",)}}
        if not isinstance(p, dict):
            row["amount"] = None
            cost["unpriced"].append(model)
            cost["models"].append(row)
            continue
        try:
            amt = sum(_num(u[k]) * float(p.get(k, 0) or 0) for k in TOKEN_KEYS) / per
        except (TypeError, ValueError):
            row["amount"] = None
            cost["unpriced"].append(model)
            cost["models"].append(row)
            continue
        row["amount"] = round(amt, 6)
        any_priced = True
        total += amt
        cost["models"].append(row)
    cost["total"] = round(total, 6) if any_priced else None
    if cost["unpriced"] and any_priced:
        cost["warning"] = "部分模型无价目，合计仅为已计价模型之和，不完整。"
    elif cost["unpriced"]:
        cost["warning"] = "所有出现的模型都不在价目表里，无法折算。"
    return cost


def build_observations(R, grand) -> list:
    """3~5 条中文观察，每条都能指回上面某张表(§3.9)。"""
    obs = []
    ov, tools, comp = R["overview"], R["tools"], R["completion"]

    if grand["totalTokens"]:
        share = _pct(grand["cacheRead"], grand["totalTokens"])
        top = R["tokensByModel"][0] if R["tokensByModel"] else None
        line = f"**cacheRead 占全部 token 的 {share}**（{_fmt(grand['cacheRead'])}/{_fmt(grand['totalTokens'])}），成本主要压在上下文复用上。"
        if top:
            line += f" 单模型看，`{top['model']}` 占 {_pct(top['totalTokens'], grand['totalTokens'])}。"
        obs.append(line)

    if tools:
        scored = [t for t in tools if t["results"]]
        if scored:
            worst = max(scored, key=lambda t: t["errors"] / t["results"])
            if worst["errors"]:
                obs.append(
                    f"**`{worst['tool']}` 失败率 {worst['failRate']}**（{worst['errors']}/{worst['results']}）"
                    f"是最高；全表工具调用 {_fmt(sum(t['calls'] for t in tools))} 次、"
                    f"失败 {_fmt(sum(t['errors'] for t in tools))} 次。"
                )
            else:
                obs.append(f"**工具全部成功**：{len(tools)} 个工具、{_fmt(sum(t['results'] for t in tools))} 次 tool_result，"
                           f"零失败（见「工具」表）。")
            slow = max((t for t in tools if t["maxMs"] is not None), key=lambda t: t["maxMs"], default=None)
            if slow:
                obs.append(f"最慢单次调用是 `{slow['tool']}` 的 {_fmt(slow['maxMs'])} ms，"
                           f"平均 {slow['avgMs']} ms（见「工具」表）。")

    if comp["total"]:
        if comp["unsettled"]:
            toolish = sum(1 for u in comp["unsettled"] if u["stopReason"] == "toolUse")
            obs.append(f"**{comp['settled']}/{comp['total']} 个会话收敛**（收敛率 {comp['rate']}）；"
                       f"{len(comp['unsettled'])} 个没有 `agent_settled`，其中 {toolish} 个最后一条 stopReason 是 `toolUse`"
                       f"（见「完成度」表）。")
        else:
            obs.append(f"**{comp['total']} 个会话全部收敛**，收敛率 {comp['rate']}（见「完成度」表）。")

    if R["topSessions"] and grand["totalTokens"]:
        first = R["topSessions"][0]
        obs.append(f"最大消耗会话 `{_short_id(first['sessionId'])}` 占全部 token 的 "
                   f"{_pct(first['totalTokens'], grand['totalTokens'])}"
                   f"（{_fmt(first['totalTokens'])}），cwd {_code(first['cwd'])}（见「Top 10 会话」表）。")

    if R["byPerson"]:
        p = R["byPerson"][0]
        obs.append(f"按人看 `{p['label']}` 消耗最多：{_fmt(p['tokens']['totalTokens'])} token / "
                   f"{p['sessionCount']} 个会话，工具失败率 {p['failRate']}（见「按人」表）。")

    cp = R["contextPressure"]
    if cp["compacts"]:
        obs.append(f"发生 {cp['compacts']} 次压缩，tokensBefore 最大 {_fmt(cp['tokensBeforeMax'])}、"
                   f"中位 {_fmt(cp['tokensBeforeMedian'])}（见「上下文压力」表）。")
    if cp["growing"]:
        obs.append(f"{len(cp['growing'])} 个会话压缩 ≥2 次后 cacheRead 仍在涨，值得看上下文是否失控。")

    sub = R.get("subagents")
    if sub and sub["enabled"] and sub["exists"] and sub["totals"]["runs"]:
        t = sub["totals"]
        line = (f"子代理共 {_fmt(t['runs'])} 个 run，审计侧已标记 {_fmt(t['auditedRuns'])} 个、"
                f"占全部消耗 {sub['auditedShare']}（见「子代理」表）。")
        if sub["metaOnlyTotal"]:
            line += (f" 另有 {_fmt(sub['metaOnlyTotal'])} token 只在 meta.json 里，"
                     f"审计侧看不到，未计入总 token。")
        obs.append(line)

    if ov["skippedLines"]:
        obs.append(f"跳过 {_fmt(ov['skippedLines'])} 行（空行或坏 JSON），已计入概览，未静默吞。")
    if ov["incompleteSessions"]:
        obs.append(f"{ov['incompleteSessions']} 个会话只有 turn_start/assistant_usage 没有 `session` 事件，标为「不完整」。")
    if ov["seqGaps"]:
        obs.append(f"按 `sessionId`+`ts` 判到 {ov['seqGaps']} 处 seq 缺口，疑似丢行（见概览）。")
    if R["cost"]:
        c = R["cost"]
        if c.get("total") is not None:
            obs.append(f"按 `{Path(c['pricesFile']).name}` 折算，总金额 {c['total']}"
                       f"（单位：{c['unit'] or '价目表未声明'}，见「成本」表）。")

    while len(obs) < 3:
        obs.append(f"样本很小：{ov['sessions']} 个会话、{_fmt(ov['events'])} 条事件，"
                   f"以上比例仅供参考（见概览）。")
        if len(obs) >= 3:
            break
    return obs[:5]


# --------------------------------------------------------------------------- #
# 渲染
# --------------------------------------------------------------------------- #
def _token_headers(first="") -> list:
    h = ["input", "cacheRead", "cacheWrite", "output", "reasoning", "total", "cacheRead 占比"]
    return ([first] if first else []) + h


def _token_row(key, d, pct):
    return [key, _fmt(d.get("input")), _fmt(d.get("cacheRead")), _fmt(d.get("cacheWrite")),
            _fmt(d.get("output")), _fmt(d.get("reasoning")), _fmt(d.get("totalTokens")), pct]


def render_subagents(sub) -> list:
    """「子代理」段（§5）。只做标签化：meta 侧数字单列，不进总 token。"""
    L = ["## 3. 子代理", ""]
    if sub is None or not sub["enabled"]:
        L.append("> `--no-subagents`：未扫描子代理产物。")
        L.append("")
        return L
    if not sub["exists"]:
        L.append(f"> 子代理产物目录不存在：`{sub['sessionsDir']}`（`--sessions-dir` 可指定）。")
        L.append("")
        return L

    rows = []
    for r in sub["rows"]:
        m, a = r["metaUsage"], r["auditUsage"]
        has_meta = any(m[k] for k in TOKEN_KEYS) or r["metaTurns"]
        has_audit = any(a[k] for k in TOKEN_KEYS) or r["auditTurns"]
        # 数字列取「审计侧优先」——已入审计的 run 其 token 本来就在概览总量里，
        # 若这里填 meta 会打出 0（子代理进程没加载审计扩展时 meta 才有数），与合计行自相矛盾。
        # 口径列显式标出这行数字取自哪侧；「仅 meta」部分的数字看合计行，不混进同一格。
        if has_audit:
            nums, src, turns = a, "审计", r["auditTurns"]
        elif has_meta:
            nums, src, turns = m, "meta", r["metaTurns"]
        else:
            nums, src, turns = dict.fromkeys(TOKEN_KEYS, 0), "—", 0
        if has_meta and has_audit:
            # 两侧都有数字才逐项比对；只一侧有数字无从对账，记「—」不评好坏
            if r["mismatch"]:
                recon = "✗ " + "，".join(f"{k} 审计={_fmt(a[k])} meta={_fmt(m[k])}"
                                        for k in TOKEN_KEYS if a[k] != m[k])
            elif r["usageMatched"]:
                # 顺序依赖：mismatch 先判，所以「指纹配对」分支只会在本组两侧全等时走到。
                # 配对成功的判定本身就是指纹逐项相等，这里的 ✓ 与文档"逐项全等"同义。
                recon = f"✓ 指纹配对 {r['usageMatched']} 个"
            else:
                recon = "✓"
        else:
            recon = "—"
        rows.append([r["role"], _code(r["model"]), _fmt(r["runs"]), src,
                     _fmt(nums["input"]), _fmt(nums["cacheRead"]), _fmt(nums["cacheWrite"]),
                     _fmt(nums["output"]), _fmt(turns), r["side"], recon])
    L.append(md_table(["角色", "模型", "run 数", "数字口径", "input", "cacheRead", "cacheWrite",
                       "output", "turns", "审计侧", "对账"],
                      rows or [["(无)", "-", "0", "-", "-", "-", "-", "-", "-", "-", "-"]]))
    t = sub["totals"]
    mo, au = t["metaOnly"], t["audit"]
    L.append("")
    L.append(md_table(["合计", "run 数", "input", "cacheRead", "cacheWrite", "output", "口径"], [
        ["审计侧已标记为子代理", _fmt(t["auditedRuns"]), _fmt(au["input"]), _fmt(au["cacheRead"]),
         _fmt(au["cacheWrite"]), _fmt(au["output"]), "含在概览总 token 里"],
        ["仅 meta(未入审计)", _fmt(t["metaOnlyRuns"]), _fmt(mo["input"]), _fmt(mo["cacheRead"]),
         _fmt(mo["cacheWrite"]), _fmt(mo["output"]), "**不并进总 token**"],
    ]))
    L.append("")
    L.append(f"总 {_fmt(t['runs'])} 个 run：子代理占全部消耗 **{sub['auditedShare']}**"
             f"（审计侧子代理 {_fmt(sum(au.values()))} / 全部 {_fmt(sub['auditTotalTokens'])}）。")

    # 子代理归因覆盖率(§5.3 第 6 条)——必须成行上报，覆盖不全不许说「全部归因完成」
    attr = _dict(sub.get("attribution"))
    by_path = _dict(attr.get("byPath"))
    if attr:
        total_n, hit = _num(attr.get("total")), _num(attr.get("hit"))
        detail = " / ".join(f"{ATTR_PATH_LABEL[k]}:{_fmt(by_path.get(k, 0))}" for k in ATTR_PATHS)
        L.append("")
        L.append(f"子代理归因:命中 {hit}/{total_n} ({_pct(hit, total_n)})（{detail}）")
        rows = []
        for a in sub.get("attributed") or []:
            rows.append([_short_id(a["runId"]), a.get("agent") or "-",
                         _code(a.get("model")), _short_id(a.get("parentSessionId")),
                         "-" if a.get("parentTurnIndex") is None else _fmt(a["parentTurnIndex"]),
                         _code(a.get("attrPath"))])
        if rows:
            L.append("")
            L.append(md_table(["run", "角色", "模型", "父会话", "发起轮次", "归因路径"], rows))
        if total_n > hit:
            L.append("")
            L.append(f"> 未归因 {_fmt(total_n - hit)} 个 run —— 三条路径都没命中"
                     "（子代理产物可能早于本机保留的会话文件，或父会话不在 "
                     "`~/.pi/agent/sessions/` 下）。这些 run **不算作已归因**。")
    if sub.get("usageMatchedRuns"):
        st = _dict(sub.get("stats"))
        L.append("")
        L.append(f"> 其中 {_fmt(sub['usageMatchedRuns'])} 个 run 的 meta 与 run-0 目录 **runId 对不上**，"
                 f"靠「角色+模型+五个数字」指纹唯一命中配对（`matchBy=usage`）；"
                 f"另有 未命中 {_fmt(st.get('fingerprintMiss', 0))} / 歧义放弃 {_fmt(st.get('fingerprintAmbiguous', 0))} 个。"
                 f"指纹配对是**启发式**，不保证与 runId join 等价。")
    st = _dict(sub.get("stats"))
    if st.get("zeroTurns"):
        L.append("")
        L.append(f"> 另有 {_fmt(st['zeroTurns'])} 个 run 的 meta `turns=0` 且 token 全 0"
                 f"（子代理启动即失败/被中断），**不进指纹配对**，也无法与审计侧对账。")
    if sub["metaOnlyTotal"]:
        L.append("")
        L.append(f"⚠ 另有 {_fmt(sub['metaOnlyTotal'])} token 只存在于 meta.json，审计侧看不到"
                 f"（子代理进程没有加载审计扩展）——这部分**不计入概览总 token**。")
    L.append("")
    L.append("> 口径：两处产物优先按 `runId` 合并去重；`runId` 对不上时用 usage 指纹兜底（见下）。"
             "角色/模型取 `subagent-artifacts/*_meta.json`；"
             "「审计侧」数字取审计日志里子会话 `sessionId` 的 `assistant_usage`（`run-0/session.jsonl` 首行 `id`）。"
             "同一子代理**只数一次**，不把 meta 的 usage 再加一遍。")
    L.append("")
    return L


def render_context_composition(cc) -> list:
    """「上下文构成」段（docs/audit-report.md §9）。缺数据只写一行提示，不算错。"""
    L = ["## 6. 上下文构成", ""]
    rows = _list(cc.get("rows"))
    if not rows:
        L.append("暂无可用的 `context_sample` 事件（该事件自阶段 3 起才写入，老日志没有）。")
        L.append("")
        return L

    ratio = cc.get("ratio")
    ratio_txt = "-" if not ratio else f"{ratio:.4f}"
    table = []
    for r in rows:
        table.append([
            _short_id(r["sessionId"]),
            _fmt(r["turns"]),
            _fmt(r["fixedTaxChars"]),
            _fmt(r["toolChars"]),
            _fmt(r["firstGrowth"]),
            _fmt(r["lastGrowth"]),
            "-" if r["avgInputCache"] is None else _fmt(round(r["avgInputCache"])),
            "-" if r["fixedTaxSharePct"] is None else f"{r['fixedTaxSharePct']:.1f}%",
        ])
    L.append(md_table(["会话", "轮数", "固定税(字符)", "工具定义(字符)", "首轮增长(字符)",
                       "末轮增长(字符)", "每轮平均 input+缓存读", "固定税估算占比"], table))
    L.append("")
    if cc.get("totalRows", 0) > len(rows):
        L.append(f"（共 {cc['totalRows']} 个会话有 `context_sample`，本表只列前 {len(rows)} 个）")
        L.append("")

    L.append("口径：")
    L.append("")
    L.append("- **固定税** = `sections` 合计 + `toolDefs.chars`（每轮完全相同的部分）")
    L.append("- **增长** = `messages.charsByRole` 合计 − 该轮 `system` 部分（system 里已含 `sections`；"
             "首轮末尾 = 用户输入，末轮末尾 = 用户输入 + 历史 + 工具回灌）")
    L.append(f"- **字符 → token 换算**：本表用同一批日志算出的比例 **{ratio_txt}** "
             "（=`contextTokens` ÷ 该轮总字符，取中位）。**表里带「估算」的列都是这个比例换算来的，不是 token 实测值。**")
    L.append("- **对账**：`contextTokens` 应 ≈ 该轮 `assistant_usage.usage.input + cacheRead`（同一次请求的两种口径）。")
    mr = cc.get("maxReconcilePct")
    if mr is None:
        L.append("  本批日志里可对账的轮次为 0，无法给出偏差。")
    elif mr > 2:
        L.append(f"  ⚠ 对账偏差 {mr:.2f}%（超过 2%）—— 说明 `contextTokens` 与计费口径不是同一件事，别互相换算。")
    else:
        L.append(f"  本批日志最大偏差 {mr:.2f}%，在 2% 以内。")
    L.append("")
    return L


def render_markdown(R, args) -> str:
    ov = R["overview"]
    L = []
    L.append("# pi 审计报表")
    L.append("")
    src = "、".join(f"`{s['dir']}`" + (f"（{s['label']}）" if s["label"] else "") for s in R["sources"])
    L.append(f"- 生成时间：{R['generatedAt']}")
    L.append(f"- 数据源：{src}")
    L.append("")

    # 1 概览
    L.append("## 1. 概览")
    L.append("")
    L.append(md_table(["项", "值"], [
        ["时间范围", f"{ov['since'] or '不限'} ~ {ov['until'] or '不限'}"],
        ["日志文件数", _fmt(ov["files"])],
        ["总行数", _fmt(ov["totalLines"])],
        ["跳过行数 skippedLines", _fmt(ov["skippedLines"])],
        ["会话数", _fmt(ov["sessions"])],
        ["事件数", _fmt(ov["events"])],
        ["不完整会话数", _fmt(ov["incompleteSessions"])],
        ["seq 缺口数", _fmt(ov["seqGaps"])],
        ["总 token", _fmt(ov["totalTokens"])],
        ["其中 reasoning", _fmt(ov["tokens"]["reasoning"])],
    ]))
    L.append("")
    L.append("事件类型分布：")
    L.append("")
    L.append(md_table(["事件类型", "条数"],
                      [[f"`{k}`", _fmt(v)] for k, v in ov["eventTypes"].items()] or [["(无)", "0"]]))
    L.append("")

    # 2 token 分布
    L.append("## 2. token 分布")
    L.append("")
    L.append("### 2.1 按天")
    L.append("")
    L.append(md_table(_token_headers("日期"),
                      [_token_row(d["day"], d, d["cacheReadPct"]) for d in R["tokensByDay"]] or [["(无数据)"]]))
    L.append("")
    L.append("### 2.2 按模型")
    L.append("")
    L.append(md_table(_token_headers("模型"),
                      [_token_row(m["model"], m, m["cacheReadPct"]) for m in R["tokensByModel"]] or [["(无数据)"]]))
    mm = _dict(R.get("modelMap"))
    if mm:
        before, after = _num(mm.get("rowsBefore")), _num(mm.get("rowsAfter"))
        if before != after:
            # 表尾上报归并（§2.1 第 2 条）——行名取**档位别名**，报告要回答「哪个档位在烧 token」
            pairs_txt = "；".join(f"`{g['from']}` → `{g['to']}`" for g in mm.get("groups") or [])
            note = f"> 已归并 {_fmt(before - after)} 行（{before} → {after}）：{pairs_txt}。"
            amb = _dict(_dict(mm.get("info")).get("ambiguous"))
            if amb:
                note += (" 歧义 " + _fmt(len(amb)) + " 组（同一别名映射到多个真实名，取出现次数最多的）："
                         + "；".join(f"`{k}` → `{_dict(v).get('picked')}`" for k, v in amb.items()) + "。")
            L.append("")
            L.append(note)
        unmapped = mm.get("unmapped") or []
        if unmapped:
            # 未命中映射的名字单独成行并在表尾计数上报，不许静默归入「(未知模型)」(§2.1 第 4 条)
            L.append("")
            L.append(f"> 未命中映射 {_fmt(len(unmapped))} 个模型名（单独成行，未归入「(未知模型)」）："
                     + "、".join(_code(m) for m in unmapped) + "。")
        if not _num(_dict(mm.get("info")).get("withResponseModel")):
            L.append("")
            L.append("> 本机会话 jsonl 里没有任何 `responseModel`，别名归并未生效（该字段缺失时不做归并，见 §5.4）。")
    L.append("")
    L.append("### 2.3 Top 10 会话")
    L.append("")
    rows = []
    for s in R["topSessions"]:
        rows.append([_short_id(s["sessionId"]), s["type"], _code(s["cwd"]), _code(s["model"]),
                     _fmt(s["input"]), _fmt(s["cacheRead"]), _fmt(s["cacheWrite"]),
                     _fmt(s["output"]), _fmt(s["reasoning"]), _fmt(s["totalTokens"]), s["cacheReadPct"],
                     "是" if s["settled"] else "否"])
    L.append(md_table(["会话", "类型", "cwd", "模型", "input", "cacheRead", "cacheWrite",
                       "output", "reasoning", "total", "cacheRead 占比", "收敛"], rows or [["(无数据)"]]))
    L.append("")

    # 3 子代理
    L.extend(render_subagents(R.get("subagents")))

    # 4 按人
    if R["byPerson"] is not None:
        L.append("## 4. 按人")
        L.append("")
        rows = []
        for p in R["byPerson"]:
            t = p["tokens"]
            rows.append([p["label"], _fmt(p["sessionCount"]), _fmt(t["input"]), _fmt(t["cacheRead"]),
                         _fmt(t["cacheWrite"]), _fmt(t["output"]), _fmt(t["reasoning"]),
                         _fmt(t["totalTokens"]), p["cacheReadPct"], _fmt(p["toolCalls"]),
                         f"{_fmt(p['toolErrors'])}/{_fmt(p['toolResults'])}", p["failRate"]])
        L.append(md_table(["人", "会话数", "input", "cacheRead", "cacheWrite", "output",
                           "reasoning", "total", "cacheRead 占比", "工具调用", "失败/结果", "失败率"], rows))
        L.append("")

    # 5 工具
    L.append("## 5. 工具")
    L.append("")
    rows = []
    for t in R["tools"]:
        rows.append([f"`{t['tool']}`", _fmt(t["calls"]), _fmt(t["ok"]), _fmt(t["errors"]), t["failRate"],
                     "-" if t["avgMs"] is None else _fmt(t["avgMs"]),
                     "-" if t["maxMs"] is None else _fmt(t["maxMs"]),
                     _fmt(t["resultChars"])])
    L.append(md_table(["工具", "调用次数(tool_call)", "成功", "失败", "失败率",
                       "平均耗时(ms)", "最长耗时(ms)", "结果字符数"], rows or [["(无数据)"]]))
    L.append("")
    calls = sum(t["calls"] for t in R["tools"])
    results = sum(t["results"] for t in R["tools"])
    if calls != results:
        L.append(f"> 注：`tool_call` {_fmt(calls)} 条 ≠ `tool_result` {_fmt(results)} 条（异常路径下两者可能不等，"
                 f"失败率分母只取 `tool_result`）。")
        L.append("")

    # 6 上下文构成（阶段 3）
    L.extend(render_context_composition(R["contextComposition"]))

    # 7 skill 命中
    L.append("## 7. skill 命中")
    L.append("")
    rows = []
    for sk in R["skills"]:
        rows.append([sk["name"] or "-", _fmt(sk["sessionCount"]), _fmt(sk["hits"]),
                     f"`{sk['filePath']}`", sk["source"] or sk["origin"] or "-"])
    L.append(md_table(["skill", "命中会话数", "命中次数", "filePath", "来源包与版本"],
                      rows or [["(无数据)"]]))
    L.append("")
    L.append("每会话 skillCount（`session.skillCount` vs 去重后 filePath 数）：")
    L.append("")
    L.append(md_table(["会话", "session.skillCount", "filePath 去重数", "不完整"],
                      [[_short_id(s["sessionId"]),
                        "-" if s["skillCount"] is None else _fmt(s["skillCount"]),
                        _fmt(s["filePathCount"]), "是" if s["incomplete"] else "否"]
                       for s in R["skillCounts"]] or [["(无数据)", "-", "-", "-"]]))
    L.append("")
    L.append("> 口径：`session.skills[].filePath` 为权威键，跨会话按 filePath 去重计数；"
             "命中次数 = 出现条数。来源取自 `sourceInfo.source`。")
    L.append("")

    # 8 完成度
    L.append("## 8. 完成度")
    L.append("")
    c = R["completion"]
    L.append(md_table(["项", "值"], [
        ["总会话数", _fmt(c["total"])],
        ["有 agent_settled 的会话", _fmt(c["settled"])],
        ["收敛率", c["rate"]],
        ["未收敛会话数", _fmt(len(c["unsettled"]))],
    ]))
    L.append("")
    if c["unsettled"]:
        L.append("未收敛清单：")
        L.append("")
        L.append(md_table(["会话", "cwd", "最后事件", "stopReason", "不完整"],
                          [[_short_id(u["sessionId"]), _code(u["cwd"]), _code(u["lastEvent"]),
                            _code(u["stopReason"]),
                            "是" if u["incomplete"] else "否"] for u in c["unsettled"]]))
        L.append("")

    # 9 上下文压力
    L.append("## 9. 上下文压力")
    L.append("")
    cp = R["contextPressure"]
    L.append(md_table(["项", "值"], [
        ["压缩次数(compact)", _fmt(cp["compacts"])],
        ["发生过压缩的会话数", _fmt(cp["sessionsWithCompact"])],
        ["tokensBefore 最大", "-" if cp["tokensBeforeMax"] is None else _fmt(cp["tokensBeforeMax"])],
        ["tokensBefore 中位", "-" if cp["tokensBeforeMedian"] is None else _fmt(cp["tokensBeforeMedian"])],
        ["压缩后仍在涨的会话数", _fmt(len(cp["growing"]))],
    ]))
    L.append("")
    if cp["details"]:
        L.append(md_table(["会话", "reason", "tokensBefore", "ts"],
                          [[_short_id(d["sessionId"]), _code(d["reason"]),
                            _fmt(d["tokensBefore"]), d["ts"]] for d in cp["details"]]))
        L.append("")
    if cp["growing"]:
        L.append("压缩后 cacheRead 仍单调上涨（压缩次数 ≥ 2）：")
        L.append("")
        L.append(md_table(["会话", "压缩次数", "cacheRead 首个", "cacheRead 最新"],
                          [[_short_id(g["sessionId"]), _fmt(g["compacts"]),
                            _fmt(g["cacheReadFirst"]), _fmt(g["cacheReadLast"])] for g in cp["growing"]]))
        L.append("")

    # 10 成本
    if R["cost"] is not None:
        L.append("## 10. 成本（折算）")
        L.append("")
        cost = R["cost"]
        if cost.get("error"):
            L.append(f"价目表读取失败：`{cost['error']}`，本段跳过。")
            L.append("")
        else:
            L.append(f"- 价目表来源：`{cost['pricesFile']}`")
            L.append(f"- 价格说明：{cost['note'] or '（价目表未写 note）'}")
            L.append(f"- 单位：{cost['unit'] or '价目表未声明单位（请按 note 理解）'}")
            L.append(f"- 单价口径：每 {cost['perTokens']} token（价目表里的价格 × token 数 ÷ {cost['perTokens']}）")
            if cost.get("warning"):
                L.append(f"- ⚠️ {cost['warning']}")
            L.append("")
            rows = []
            for m in cost["models"]:
                rows.append([m["model"], _fmt(m["input"]), _fmt(m["cacheRead"]),
                             _fmt(m["cacheWrite"]), _fmt(m["output"]), _fmt(m["totalTokens"]),
                             "无价目" if m["amount"] is None else m["amount"]])
            L.append(md_table(["模型", "input", "cacheRead", "cacheWrite", "output",
                               "total", "金额"], rows))
            L.append("")
            if cost["total"] is not None:
                L.append(f"**合计：{cost['total']}**（单位：{cost['unit'] or '价目表未声明'}）")
                L.append("")
            L.append("> ⚠️ 混算警告：金额只用 `assistant_usage.usage` 的四字段乘单价得出（计费 token 口径）；"
                     "本报表里的 `结果字符数`、`systemPromptChars` 等是**字符口径**，两者不可互相换算，也不参与计费。")
            L.append("")

    # 11 观察
    L.append("## 11. 观察")
    L.append("")
    for i, o in enumerate(R["observations"], 1):
        L.append(f"{i}. {o}")
    L.append("")

    # 单会话原文预览
    if args.show_args:
        L.append("## 附：单会话原文预览（--show-args）")
        L.append("")
        L.append("> ⚠️ 以下为日志原文（含命令与路径），仅在 `--session` 模式下打印。")
        L.append("")
        rows = []
        for ev in args._preview_events:
            txt = ev.get("argsPreview") or ev.get("promptPreview")
            if txt is None:
                continue
            rows.append([ev.get("ts"), f"`{ev.get('event')}`", ev.get("toolName") or "-",
                         f"`{txt}`"])
        L.append(md_table(["ts", "事件", "工具", "原文"], rows or [["(无)"]]) if rows else "（无原文可打印）")
        L.append("")

    return "\n".join(L).rstrip() + "\n"


def to_json_data(R) -> dict:
    """--json 模式：id 给全，去掉内部 set。"""
    def clean(o):
        if isinstance(o, dict):
            return {k: clean(v) for k, v in o.items() if not isinstance(v, set)}
        if isinstance(o, (list, tuple)):
            return [clean(v) for v in o]
        if isinstance(o, set):
            return sorted(clean(v) for v in o)
        return o

    out = clean(R)
    if out.get("byPerson") is not None:
        for p in out["byPerson"]:
            p.pop("sessions", None)
    return out


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def self_test() -> int:
    """内建对账断言（spec §8.1）：审计侧逐条相加 == 预期基线。日志不在就 SKIP。"""
    baseline = {"input": 431, "cacheRead": 34304, "cacheWrite": 0,
                "output": 80, "reasoning": 15, "totalTokens": 34815}
    log = DEFAULT_DIR / "2026-09-21.jsonl"
    if not log.exists():
        print(f"SKIP: 找不到 {log}（对账基线依赖本机日志）")
        return 0
    events, _, _ = load_events(log, None)
    events = [e for e in events if str(e.get("sessionId") or "").startswith("01a0c209")]
    assert events, "--session 01a0c209 在日志里没有命中"
    sessions, _, _ = aggregate(events)
    assert len(sessions) == 1, f"应只命中 1 个会话，实际 {len(sessions)}"
    s = next(iter(sessions.values()))
    for k, want in baseline.items():
        got = s["tokens"][k]
        assert got == want, f"{k}: 期望 {want}，实际 {got}"
    assert sum(s["events"].values()) == 13, f"事件数应为 13，实际 {sum(s['events'].values())}"
    assert s["hasSessionEvent"] == 1, "session 事件应为 1 条"
    assert s["skillCount"] == 16 and len(s["skills"]) == 16, "skillCount 与 filePath 去重数都应为 16"
    assert s["settled"] == 1, "agent_settled 应为 1 次"
    assert s["seqGaps"] == 0, "该会话 seq 应连续"
    t = s["tools"]["bash"]
    assert (t["calls"], t["results"], t["errors"]) == (1, 1, 0), f"bash 应为 1 调用 0 失败，实际 {t}"

    # —— 子代理段（阶段 1）：拿本机真实产物验「合并去重 + 标签化 + 不进总量」
    all_events, _, _ = load_events(log, None)
    sessions_all, _, _ = aggregate(all_events)
    runs, _, ok = scan_subagents(default_sessions_dir(), sessions_all)
    if not ok or not runs:
        print(f"SKIP: 子代理产物目录没有数据（{default_sessions_dir()}）")
        return 0
    # 占比要用**整个日志文件**的口径，不能只看上面那一个会话
    assert all(r["hasMeta"] or r["hasRun0"] for r in runs.values()), "每个 run 至少得有一侧产物"
    sub, sid_types = build_subagents(sessions_all, runs, True, default_sessions_dir(),
                                     attribute_subagents(runs, default_sessions_dir()))
    assert sub["totals"]["runs"] == len(runs) - sub["usageMatchedRuns"], "run 数与扫描结果不求一致"
    for sid, kind in sid_types.items():
        assert kind.startswith("子代理:"), f"{sid[:8]} 类型应为 子代理:*，实际 {kind}"
    # meta 侧的 token 一点都不能进总量：总量仍是审计全集
    assert sub["auditTotalTokens"] == sum(x["tokens"]["totalTokens"] for x in sessions_all.values()), \
        "子代理段不得改变概览总 token"

    # —— 别名归并（阶段 2，§5.1 / §5.2 第 3 条）——
    # 先扫一遍会话，把 provider 名单采出来 —— `_norm_meta_model` 靠它剥 `newapi/` 前缀，
    # `newapi/tier-power` 这类 2 段名单靠「段数≥3」剥不掉（§2.2）。
    sessions_dir = default_sessions_dir()
    families, pairs, mstats = scan_session_models(sessions_dir)
    assert "newapi" in KNOWN_PROVIDERS, \
        f"未从数据采到 provider 名单（{sorted(KNOWN_PROVIDERS)}）—— 前缀剥除会失效"

    # ① 静态 fixture：归一化规则逐条验（§2.2 的 5 种输入形态）
    for raw, want in (("newapi/tier-power", "tier-power"),
                      ("newapi/z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"),
                      ("zai/glm-5.3-flash", "z-ai/glm-5.3-flash"),
                      ("zai-org/glm-5.3-flash", "z-ai/glm-5.3-flash"),
                      ("newapi/deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash")):
        got = _norm_meta_model(raw)
        assert got == want, f"_norm_meta_model({raw!r}) = {got!r}，期望 {want!r}"

    # ② 别名归并守恒 + 行数变少（§5.2 第 3 条）——归并前后总量逐字节相等
    before_rows = merged_rows = None
    if families:
        _, _, bymodel_all = aggregate(all_events)
        before_rows = len(bymodel_all)
        merged_rows = merge_model_buckets(bymodel_all, families)
        sum_before = sum(sum(b[k] for k in USAGE_KEYS) for b in bymodel_all.values())
        sum_after = sum(sum(b[k] for k in USAGE_KEYS) for b in merged_rows.values())
        assert sum_before == sum_after, \
            f"别名归并改变了总量：{sum_before} != {sum_after}（归并只能改分组，不能改总量）"
        assert len(merged_rows) <= before_rows, \
            f"归并后的行数不应变多：{before_rows} -> {len(merged_rows)}"
        # 未命中映射的名字必须单独成行，不许被归进「(未知模型)」
        assert "(未知模型)" not in merged_rows, "未命中映射的模型被归入「(未知模型)」了（§2.1 第 4 条）"
        # 上面那条依赖真实数据（本机日志可能全都命中映射），故另造一台合成用例
        # **直接验归并函数本身** —— 负向验证过：把 merge 的默认值换成「(未知模型)」这条就会红。
        probe = {"tier-std": dict.fromkeys(USAGE_KEYS, 1),
                 "某/未声明的模型": dict.fromkeys(USAGE_KEYS, 2)}
        probe_out = merge_model_buckets(probe, {"tier-std": "tier-std"})
        assert "某/未声明的模型" in probe_out, \
            f"未命中映射的名字被吞掉了（§2.1 第 4 条）：{sorted(probe_out)}"
        assert "(未知模型)" not in probe_out, "未命中映射的模型被归入「(未知模型)」了（§2.1 第 4 条）"
        # 守恒也要能在合成用例上成立（不依赖日志内容）
        assert sum(sum(b.values()) for b in probe_out.values()) == sum(sum(b.values()) for b in probe.values()), \
            "合成用例下归并改变了总量"
        # meta.model 剥前缀后必须能在归并映射里命中，不许有 `newapi/` 残留
        for r in runs.values():
            if isinstance(r.get("model"), str) and r["model"]:
                nm = _norm_meta_model(r["model"]) or ""
                assert "newapi/" not in nm, f"meta.model 残留 provider 前缀：{r['model']}"

    # ③ 子代理归因（§5.3 第 5 条）：hit + unattributed == total 必须成立，且两次跑结果一致
    assert sub["attribution"]["hit"] + sub["attribution"]["unattributed"] == sub["attribution"]["total"], \
        f"归因覆盖数字不自洽：{sub['attribution']}"
    for r in runs.values():
        if r.get("agent") is not None:
            assert isinstance(r["agent"], str) and r["agent"], f"meta.agent 应为非空角色名，实际 {r['agent']!r}"
    runs2, _, _ = scan_subagents(sessions_dir, sessions_all)
    attr2 = attribute_subagents(runs2, sessions_dir)
    assert attr2["hit"] == sub["attribution"]["hit"], \
        f"两次归因的命中数不一致：{attr2['hit']} vs {sub['attribution']['hit']}（应为确定性运算）"
    # 子代理 token 不进总量（§5.2 第 4 条）
    assert sub["auditTotalTokens"] == sum(x["tokens"]["totalTokens"] for x in sessions_all.values()), \
        "加了归因字段后概览 totalTokens 被改变了"

    print(f"PASS: 对账基线全部一致 {json.dumps(baseline, ensure_ascii=False)}；"
          f"子代理 {sub['totals']['runs']} 个 run（其中 {sub['usageMatchedRuns']} 个靠指纹配对），"
          f"审计侧占比 {sub['auditedShare']}，"
          f"仅 meta 未入审计 {sub['metaOnlyTotal']:,} token（未计入总量）；"
          f"别名归并 {before_rows if families else '-'} -> {merged_rows and len(merged_rows) or '-'} 行、总量守恒；"
          f"子代理归因 {sub['attribution']['hit']}/{sub['attribution']['total']}")
    return 0


def main(argv=None) -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

    args = parse_args(argv)
    if args.self_test:
        return self_test()
    args._since = _parse_day(args.since, "--since")
    args._until = _parse_day(args.until, "--until")
    if not args._since and not args._until and not args.all_days:
        today = datetime.now().astimezone().date()  # 默认只算今天(§2)
        args._since = args._until = today
    args._preview_events = []

    if args.show_args and not args.session:
        print("[warn] --show-args 只在 --session 模式下有效，已忽略", file=sys.stderr)
        args.show_args = False  # 不采集不渲染，正文原文不外泄(§6)

    entries = resolve_dirs(args)
    missing = [p for p, _ in entries if not p.is_dir()]
    for p in missing:
        print(f"[提示] 日志目录不存在：{p}", file=sys.stderr)

    files, stats = [], {"files": 0, "lines": 0, "skipped": 0}
    events = []
    for path, label in entries:
        found = discover_files(path, args._since, args._until)
        stats["files"] += len(found)
        for f in found:
            files.append(f)
            evs, lines, skipped = load_events(f, label)
            events.extend(evs)
            stats["lines"] += lines
            stats["skipped"] += skipped
    # 文件名预筛之外的文件（子代理段要全量口径时用来补齐；常见情况为空，零额外开销）
    _seen_files = set(files)
    extra_files = [(f, label) for path, label in entries
                   for f in discover_files(path, None, None) if f not in _seen_files]

    if not files:
        where = "、".join(str(p) for p, _ in entries)
        print(f"[提示] 在 {where} 没找到匹配的日志文件（日期范围 "
              f"{args._since or '不限'} ~ {args._until or '不限'}），没有可统计的数据。")
        return 0

    # 子代理段的审计侧一律用**全量**口径（不受 --since/--until/--session 影响）：
    # 子代理产物本身不按日期过滤，若审计侧只取当前范围，范围外的子代理会被误标「未入审计」，
    # 而占比分子又被 --session 削到 0、分母仍是全量——同一页里两个口径打架。
    unfiltered = events

    # 日期过滤(按 ts 本地时区切天)
    if args._since or args._until:
        kept = []
        for ev in events:
            d = _local_date(_parse_ts(ev.get("ts")))
            if d is None:
                kept.append(ev)
                continue
            if args._since and d < args._since:
                continue
            if args._until and d > args._until:
                continue
            kept.append(ev)
        events = kept

    if args.session:
        prefix = args.session
        events = [e for e in events if str(e.get("sessionId") or "").startswith(prefix)]
        if not events:
            print(f"[提示] --session {prefix} 在当前数据范围内没有命中任何会话（退出码 0）。")
            return 0

    sessions, daily, bymodel = aggregate(events)
    if args.no_subagents or (unfiltered is events and not extra_files):
        all_sessions = sessions
    else:
        all_events = list(unfiltered)
        for f, label in extra_files:
            evs, _, _ = load_events(f, label)
            all_events.extend(evs)
        all_sessions = aggregate(all_events)[0]
    if args.session and len(sessions) > 1:
        print(f"[提示] 前缀 {args.session} 命中 {len(sessions)} 个会话，全部纳入统计。", file=sys.stderr)

    # 子代理产物：与审计日志完全独立的另一路扫描（--no-subagents 关掉）
    sessions_dir = Path(args.sessions_dir) if args.sessions_dir else default_sessions_dir()
    # provider 名单必须先采 —— `_norm_meta_model` 靠它剥 `newapi/` 前缀（§2.2），
    # 而下面的 `scan_subagents`（指纹配对）与表归并都要用它。
    families, pairs, sess_stats = scan_session_models(sessions_dir)
    manual = None
    if args.model_map:
        try:
            doc = json.loads(Path(args.model_map).read_text(encoding="utf-8"))
            if not isinstance(doc, dict):
                raise ValueError("顶层必须是对象")
            manual = doc
        except (OSError, ValueError) as exc:
            print(f"[提示] 读不了 --model-map {args.model_map}：{exc} —— 已回退到自动推导", file=sys.stderr)
    # `--model-map` 给定时**完全替代**自动推导（§2.1 第 3 条）；它只声明别名→真实名，
    # 族映射由 pairs 里未受它影响的名字补全。
    model_map, modelmap_info = build_model_map(pairs, manual)
    if manual is not None:
        families = families_from_map(model_map, families)
    modelmap_info["sessionFiles"] = sess_stats["files"]
    modelmap_info["sessionMessages"] = sess_stats["assistantMsgs"]
    modelmap_info["withResponseModel"] = sess_stats["withResponseModel"]
    modelmap_info["providers"] = sess_stats["providers"]

    subagents, sid_types = None, {}
    if not args.no_subagents:
        # 指纹兜底配对依赖审计侧 usage 才能去重，所以扫描也用全量会话（否则过滤后配不上，同一 run 会算两次）
        runs, sub_stats, ok = scan_subagents(sessions_dir, all_sessions)
        attr_stats = attribute_subagents(runs, sessions_dir)   # 挂父会话/轮次（§2.4）
        subagents, sid_types = build_subagents(all_sessions, runs, True, sessions_dir, attr_stats)
        subagents["stats"] = sub_stats
        if not ok:
            print(f"[提示] 子代理产物目录不存在：{sessions_dir}（子代理段跳过）", file=sys.stderr)
        elif not runs:
            print(f"[提示] {sessions_dir} 下没扫到子代理产物（子代理段为空）", file=sys.stderr)

    if args.show_args:
        args._preview_events = [e for e in events
                                if e.get("argsPreview") is not None or e.get("promptPreview") is not None]

    R = build_data(args, entries, sessions, daily, bymodel, stats, events, subagents, sid_types,
                   families, modelmap_info)

    if args.json:
        text = json.dumps(to_json_data(R), ensure_ascii=False, indent=2) + "\n"
    else:
        text = render_markdown(R, args)

    if args.out:
        try:
            Path(args.out).write_text(text, encoding="utf-8")
        except OSError as exc:
            print(f"[错误] 写不了 {args.out}：{exc}", file=sys.stderr)
            return 0
        print(f"已写入 {args.out}（{len(text.splitlines())} 行，退出码 0）", file=sys.stderr)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
