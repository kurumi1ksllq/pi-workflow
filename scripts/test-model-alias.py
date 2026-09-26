#!/usr/bin/env python3
"""别名归并与守恒性的离线测试（spec §5.5 第 8 条）。

**不读真实日志、不启动 pi、不联网** —— 全部数据在内存里造，跑完就完。
覆盖 spec §2.2 归一化表的全部 5 种输入形态，以及 §5.2 第 3 条的守恒断言。

跑法：

    python scripts/test-model-alias.py

全绿 exit 0；任一断言失败 exit 1 并打出具体用例。
"""

from __future__ import annotations

import contextlib
import importlib.util
import sys
from collections import Counter
from pathlib import Path

REPORT = Path(__file__).resolve().parent / "pi_audit_report.py"

FAIL = []


def check(cond, msg):
    if cond:
        print(f"  ok   {msg}")
    else:
        print(f"  FAIL {msg}")
        FAIL.append(msg)


def load_report():
    """按路径加载同目录的报表脚本（不进 sys.path，不依赖 cwd）。"""
    spec = importlib.util.spec_from_file_location("pi_audit_report_under_test", REPORT)
    assert spec is not None and spec.loader is not None, f"加载不了 {REPORT}"
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main() -> int:
    with contextlib.suppress(AttributeError, ValueError):
        sys.stdout.reconfigure(encoding="utf-8")
    r = load_report()

    # provider 名单要由数据采出来（不硬编码）—— 测试里手工喂一份，等价于真机扫到的结果
    r.KNOWN_PROVIDERS.update({"newapi", "commandcode"})

    print("1. 归一化（§2.2 表的 5 种输入形态）")
    for raw, want in (
        ("newapi/tier-power", "tier-power"),                    # 2 段 + provider 前缀
        ("newapi/z-ai/glm-5.3-flash", "z-ai/glm-5.3-flash"),    # 3 段，剥第一段
        ("zai/glm-5.3-flash", "z-ai/glm-5.3-flash"),            # 拼法漂移
        ("zai-org/glm-5.3-flash", "z-ai/glm-5.3-flash"),        # 拼法漂移
        ("newapi/zai-org/glm-5.3-flash", "z-ai/glm-5.3-flash"),  # 两道一起上
        ("tier-free", "tier-free"),                              # 无前缀，原样
        ("inclusionai/ling-3.0-flash-sante:free",
         "inclusionai/ling-3.0-flash-sante:free"),               # 带 `:` 的真实名不动
        (None, None),                                            # 空值
        ("", None),
    ):
        got = r._norm_meta_model(raw)
        check(got == want, f"_norm_meta_model({raw!r}) -> {got!r}（期望 {want!r}）")

    print("2. 别名映射推导：同别名多个真实名时取出现次数最多的（§2.1 第 2 条）")
    pairs = Counter({
        ("tier-std", "deepseek/deepseek-v4.1-flash"): 100,
        ("tier-power", "zai/glm-5.3-flash"): 30,
        ("tier-power", "zai-org/glm-5.3-flash"): 7,      # 少数派：拼法漂移，归一后同一目标
        ("tier-free", "inclusionai/ling-3.0-flash-sante:free"): 5,
        ("tier-orphan", None): 9,                         # responseModel 为 null
    })
    mapping, info = r.build_model_map(pairs)
    check(mapping.get("tier-std") == "deepseek/deepseek-v4.1-flash", "tier-std 映射到 deepseek 真名")
    check(mapping.get("tier-power") == "z-ai/glm-5.3-flash",
          f"tier-power 取出现次数最多的目标（实际 {mapping.get('tier-power')!r}）")
    check("tier-orphan" not in mapping, "responseModel 为 null 的别名不做归并（§5.4）")

    print("3. 真歧义（两个不同真实名）——取多数并在表里注明（§2.1 第 2 条）")
    amb_pairs = Counter({
        ("tier-x", "vendor-a/model-1"): 40,
        ("tier-x", "vendor-b/model-2"): 10,
    })
    amb_map, amb_info = r.build_model_map(amb_pairs)
    check(amb_map.get("tier-x") == "vendor-a/model-1", "取出现次数多的那个")
    check("tier-x" in amb_info.get("ambiguous", {}), "歧义被记进 info['ambiguous']")
    check(amb_info["ambiguous"]["tier-x"]["others"] == {"vendor-b/model-2": 10}, "歧义里记下少数派")

    print("4. 人工映射完全替代自动推导（§2.1 第 3 条）")
    manual_map, manual_info = r.build_model_map(pairs, {"tier-std": "some/other-model"})
    check(manual_map.get("tier-std") == "some/other-model", "人工值覆盖自动推导")
    check(manual_info.get("source") == "manual", "info 标为 manual")
    check(manual_map.get("tier-power") is None, "人工映射下不保留自动推导的条目（完全替代）")

    print("5. 族映射：行名取**档位别名**，不是上游真名（§0 动机）")
    fam_pairs = Counter({
        ("tier-std", "deepseek/deepseek-v4.1-flash"): 100,
        ("deepseek/deepseek-v4.1-flash", None): 40,      # 审计侧见过的真名
        ("tier-power", "zai/glm-5.3-flash"): 30,
        ("z-ai/glm-5.3-flash", None): 12,
    })
    fam_map, fam_info = r.build_model_map(fam_pairs)
    families = r.families_from_map(fam_map, {})
    check(families.get("tier-std") == "tier-std", "别名归到别名自己")
    check(families.get("deepseek/deepseek-v4.1-flash") == "tier-std", "真名归到别名")
    check(families.get("z-ai/glm-5.3-flash") == "tier-power", "漂移真名归到别名")
    check(families.get("zai/glm-5.3-flash") is None, "未声明的名字不凭空出现")

    print("6. 守恒性：归并只改分组，不改总量（§5.2 第 3 条）")
    buckets = {
        "tier-std": {"input": 100, "cacheRead": 200, "cacheWrite": 0, "output": 50,
                     "reasoning": 10, "totalTokens": 350},
        "deepseek/deepseek-v4.1-flash": {"input": 7, "cacheRead": 9, "cacheWrite": 1, "output": 3,
                                         "reasoning": 2, "totalTokens": 20},
        "z-ai/glm-5.3-flash": {"input": 5, "cacheRead": 5, "cacheWrite": 0, "output": 5,
                               "reasoning": 5, "totalTokens": 15},
        "unmapped-model": {"input": 1, "cacheRead": 0, "cacheWrite": 0, "output": 1,
                           "reasoning": 0, "totalTokens": 2},
    }
    fams = {"tier-std": "tier-std", "deepseek/deepseek-v4.1-flash": "tier-std",
            "z-ai/glm-5.3-flash": "z-ai/glm-5.3-flash"}
    merged = r.merge_model_buckets(buckets, fams)
    sum_before = sum(sum(b.values()) for b in buckets.values())
    sum_after = sum(sum(b.values()) for b in merged.values())
    check(sum_before == sum_after, f"归并前后总量逐字节相等（{sum_before} == {sum_after}）")
    check(len(merged) < len(buckets), f"归并后行数变少（{len(buckets)} -> {len(merged)}）")
    check(merged["tier-std"]["input"] == 107, "同族数字逐项相加（100 + 7）")
    check("unmapped-model" in merged, "未命中映射的名字单独成行，不被吞掉（§2.1 第 4 条）")
    check("(未知模型)" not in merged, "未命中不许归入「(未知模型)」")

    print("7. 幂等：归并两次结果不变（跑多次报表不会漂）")
    merged2 = r.merge_model_buckets(merged, fams)
    check(merged2 == merged, "对已归并的桶再归并一次，结果不变")

    print("8. `--model-map` 给了不存在的档位名——忽略该条目，其余照用（§5.4）")
    stale = r.build_model_map(pairs, {"tier-std": "vendor/m1", "tier-不存在的档位": "vendor/m2"})
    check(stale[0].get("tier-std") == "vendor/m1", "有效条目照用")
    check(stale[0].get("tier-不存在的档位") == "vendor/m2",
          "无效档位名只是本次用不上，不该报错中断（退出码 0 由 main 保证）")

    print("9. `responseModel` 全为 null —— 不归并、原样保留（§5.4）")
    none_map, none_info = r.build_model_map(Counter({("m1", None): 5, ("m2", None): 3}))
    check(none_map == {}, "全部 null 时映射为空（不编造归并）")
    fams_none = r.families_from_map({}, {k: k for k in ("m1", "m2")})
    check(fams_none == {"m1": "m1", "m2": "m2"}, "族映射退化成恒等，两个名字各自成行")

    print()
    if FAIL:
        print(f"✗ {len(FAIL)} 项失败：")
        for f in FAIL:
            print(f"  - {f}")
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
