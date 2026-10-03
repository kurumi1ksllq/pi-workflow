# 团队公告｜pi 团队工作流,一条命令装好

> 可直接转发给成员。

## 一、安装(全局,一次)

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.15.2
```

**注意没有 `-l`** —— 全局安装,落到 `~/.pi/agent/settings.json`,之后在任何项目目录跑 pi 都带着团队基线,不绑定具体项目。

装完**退出、再启动一次 pi**(列表里的扩展第二次启动才装上):

```bash
pi
```

看到 `[team-baseline] 请退出再启动一次 pi` 之类的提示,照做即可。**只在第一次装、以及以后往清单里加包时需要这两下。**

### 前置:先配好模型凭据(不能跳)

不配的话 pi 直接报 `No API key found` 退出,基线会装到一半中断。敲 `pi` 进去用 `/login`,或退出后:

```bash
export NEWAPI_API_KEY=sk-...
```

`pi --list-models` 应能看到 `newapi` 下的 `tier-*` 档位。

### 装完自动拿到什么

团队规范、4 个 skill、`/review`,外加两个常用命令(见下)。日常更新**不用管** —— 每次启动自动比对远端最新版,落后会提示「已自动更新 vX → vY,重启生效」。

装完想确认状态:在 pi 里敲 `/team-baseline`。

---

## 二、`/audit` —— 审计报表

看谁在烧 token、工具失败率、skill 命中、会话收敛率。任意项目目录下都能跑。

```
/audit                        # 全部历史
/audit --since 2026-09-20     # 从某天起
/audit --since 2026-09-20 --until 2026-09-25
/audit --label 张三           # 给这份日志打人名,进「按人」表
```

- 报表落盘 `~/.pi/agent/audit/reports/pi-audit-<日期>-<参数指纹>.md`
- 同参数重跑覆盖同一份,不同参数各留一份,不会互相覆盖
- 需要本机有 **Python 3**(命令自动探测 `python` / `python3` / `py`)

**看团队汇总**(维护者视角):把各人 `~/.pi/agent/audit/logs/` 拷到一处,按人分组:

```bash
python scripts/pi_audit_report.py --dir <甲的logs> --label 甲 --dir <乙的logs> --label 乙 --all-days --out 团队.md
```

`--label` 必须**紧跟**在对应的 `--dir` 后面。单机跑的「按人」表只有一行是正常的。

---

## 三、`/handoff` —— 会话交接

长会话越跑越贵、上下文越滚越大。`/handoff` 把当前会话的机械记录抽成素材,开一个新会话,让新会话读懂旧档 + 素材后**在保留旧内容的前提下整理续写**交接文档,再接着干。

```
/handoff 接着补单元测试    # 抽素材 + 切新会话,整理续写文档并接着干
/handoff --doc-only 只整理  # 同上,但新会话只整理文档、不开发
/handoff                   # 下一步留空,整理完停下问你
```

- 落点:项目根 `docs/.handoff.md`(点文件);改落点设环境变量 `HANDOFF_FILE`
- 素材:落点同目录的 `.handoff-material.md`,新会话整理完可删
- 阈值提醒:上下文过 **70%** 自动提醒该交接了(每档只提一次,不刷屏);`HANDOFF_THRESHOLD` 改,设 `>100` 关提醒
- 边界:只写本机文件、绝不联网;**必须人工敲** —— 只有斜杠命令能开新会话(pi 不让模型自行清空上下文)

---

**一句话版:** `pi install git:github.com/kurumi1ksllq/pi-workflow@v1.15.2` → 启动两次 → 完事。日常更新自动跟,不用管。有装不上的、报表是空的、要往清单里加东西,找维护者。
