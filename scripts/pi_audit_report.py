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
# 「审计侧」列的三个取值（docs/audit-report.md §5）
SUBAGENT_AUDITED = "已入审计(标记为子代理)"
SUBAGENT_NOT_AUDITED = "未入审计"
SUBAGENT_META_ONLY = "仅 meta"


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


def _norm_meta_model(model):
    """meta.model 带 provider 前缀(`newapi/deepseek/x`)，审计侧的 `model` 不带。
    只在拿不到审计侧模型时兜底：剥掉第一段。拿得到审计侧就以审计侧为准。"""
    if not isinstance(model, str) or not model:
        return None
    parts = model.split("/")
    return "/".join(parts[1:]) if len(parts) >= 3 else model


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
            "matchBy": None,
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
        "tokens": {k: 0 for k in USAGE_KEYS},
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
    daily = defaultdict(lambda: {k: 0 for k in USAGE_KEYS})
    bymodel = defaultdict(lambda: {k: 0 for k in USAGE_KEYS})

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


def build_subagents(audit_sessions, runs, enabled, sessions_dir):
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
            "metaUsage": {k: 0 for k in TOKEN_KEYS}, "metaTurns": 0,
            "auditUsage": {k: 0 for k in TOKEN_KEYS}, "auditTurns": 0,
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
        "metaOnly": {k: 0 for k in TOKEN_KEYS}, "metaOnlyRuns": 0,
        "audit": {k: 0 for k in TOKEN_KEYS}, "auditedRuns": 0,
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
    }, type_by_sid


# --------------------------------------------------------------------------- #
# 报表数据
# --------------------------------------------------------------------------- #
def build_data(args, entries, sessions, daily, bymodel, stats, events, subagents=None, sid_types=None):
    R = {"generatedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
         "sources": [], "overview": {}, "tokensByDay": [], "tokensByModel": [],
         "topSessions": [], "byPerson": None, "tools": [], "skills": [],
         "completion": {}, "contextPressure": {},
         "cost": None, "observations": []}

    for path, label in entries:
        R["sources"].append({"dir": str(path), "label": label})

    grand = {k: 0 for k in USAGE_KEYS}
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
    for model in sorted(bymodel, key=lambda m: -bymodel[m]["totalTokens"]):
        m = bymodel[model]
        R["tokensByModel"].append({"model": model, **m, "cacheReadPct": _pct(m["cacheRead"], m["totalTokens"])})

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
        persons = defaultdict(lambda: {"tokens": {k: 0 for k in USAGE_KEYS},
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
            if len(series) >= 2 and all(b >= a for a, b in zip(series, series[1:])) and series[-1] > series[0]:
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
            nums, src, turns = {k: 0 for k in TOKEN_KEYS}, "—", 0
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

    # 7 skill 命中
    L.append("## 6. skill 命中")
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
    L.append("## 7. 完成度")
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
    L.append("## 8. 上下文压力")
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
        L.append("## 9. 成本（折算）")
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
    L.append("## 10. 观察")
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
    sub, sid_types = build_subagents(sessions_all, runs, True, default_sessions_dir())
    assert sub["totals"]["runs"] == len(runs) - sub["usageMatchedRuns"], "run 数与扫描结果不求一致"
    for sid, kind in sid_types.items():
        assert kind.startswith("子代理:"), f"{sid[:8]} 类型应为 子代理:*，实际 {kind}"
    # meta 侧的 token 一点都不能进总量：总量仍是审计全集
    assert sub["auditTotalTokens"] == sum(x["tokens"]["totalTokens"] for x in sessions_all.values()), \
        "子代理段不得改变概览总 token"
    print(f"PASS: 对账基线全部一致 {json.dumps(baseline, ensure_ascii=False)}；"
          f"子代理 {sub['totals']['runs']} 个 run（其中 {sub['usageMatchedRuns']} 个靠指纹配对），"
          f"审计侧占比 {sub['auditedShare']}，"
          f"仅 meta 未入审计 {sub['metaOnlyTotal']:,} token（未计入总量）")
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
    subagents, sid_types = None, {}
    if not args.no_subagents:
        # 指纹兜底配对依赖审计侧 usage 才能去重，所以扫描也用全量会话（否则过滤后配不上，同一 run 会算两次）
        runs, sub_stats, ok = scan_subagents(sessions_dir, all_sessions)
        subagents, sid_types = build_subagents(all_sessions, runs, True, sessions_dir)
        subagents["stats"] = sub_stats
        if not ok:
            print(f"[提示] 子代理产物目录不存在：{sessions_dir}（子代理段跳过）", file=sys.stderr)
        elif not runs:
            print(f"[提示] {sessions_dir} 下没扫到子代理产物（子代理段为空）", file=sys.stderr)

    if args.show_args:
        args._preview_events = [e for e in events
                                if e.get("argsPreview") is not None or e.get("promptPreview") is not None]

    R = build_data(args, entries, sessions, daily, bymodel, stats, events, subagents, sid_types)

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
