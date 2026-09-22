# pi-workflow

团队 pi 基线。全局装一次，所有人拿到同一套 skills、prompts、extensions、团队规范，
外加同一批第三方扩展、同一套扩展设置。

## 成员怎么用（两步）

1. 装 pi（已装跳过）
2. 全局装基线：

   ```bash
   pi install git:github.com/kurumi1ksllq/pi-workflow@v1.10.0
   ```

   **注意没有 `-l`** —— 这是全局安装，落到 `~/.pi/agent/settings.json`，
   之后你在任何目录跑 pi 都带着团队基线，**不绑定任何具体项目**。

3. 第一次装完**再启动一次 pi**。终端会提示「请退出再启动一次 pi」，照做：

   引导扩展会把团队清单里的第三方包写进你的全局设置，而 pi 的包安装发生在扩展加载**之前**，
   所以清单里的包要第二次启动才装上。只在第一次装基线、以及以后往清单里加包时需要。

给成员的完整版（含凭据配置、验收方式）在 [`ONBOARDING.md`](ONBOARDING.md)，**可直接转发**。

## 源怎么写（在 pi 0.85.1 上直接调解析器实测）

**推荐写法，`git:` 前缀不能省：**

```
git:github.com/<org>/pi-workflow@v1.10.0
```

省掉前缀 pi 会当本地目录，报 `Path does not exist: ...\github.com\org\pi-workflow` ——
这个报错极具误导性，不是文件不存在，是源没被识别成 git。

实测可用：

| 写法 | 结果 |
| --- | --- |
| `git:github.com/org/repo@v1.0.0` | ✅ 推荐 |
| `git:git@github.com:org/repo@v1.0.0` | ✅ SSH |
| `git:gitee.com/org/repo@v1.0.0` | ✅ 国内直连稳 |
| `git:gitlab.公司域名.com/team/repo@v1.0.0` | ✅ 自建 GitLab |
| `git:192.168.1.5:8080/team/repo@v1.0.0` | ✅ 内网 IP 带端口也行 |
| `https://github.com/org/repo@v1.0.0` | ✅ 协议 URL 可省 `git:` |
| `git://host/path` | ❌ 不要用，见下 |

**`git://` 是陷阱。** `git://127.0.0.1:9418/repo` 会被 pi 的 `git:` 前缀判断吃掉
（`git://` 字面上就以 `git:` 开头），剥掉前缀剩 `//127.0.0.1:9418/repo`，解析失败，
然后**静默降级成本地路径**。官方文档声称支持 `git://`，实测不支持。

锁版本还是跟最新（pi 0.86.1 源码 + 隔离 agent 目录实测）：

| 想要 | 写法 | `pi update --extensions` 行为 |
| --- | --- | --- |
| 钉死 | `...@v1.0.0`（tag 或 commit） | 把 clone **拉回配置的这个 ref**（不会前进，换 tag 才会动） |
| 跟最新 | `git:github.com/org/repo`（不写 ref） | `git fetch --prune origin <默认分支>` + `reset --hard @{upstream}`，真前进 |

pi 自己**不会自动应用**更新 —— 启动时只在交互模式弹一句「Package Updates Available」等人手动敲命令，
钉了 tag 的源连这句提示都不弹。所以团队基线自带一套自动更新（见「成员如何更新基线」），
写法定为**钉 tag**：一个 tag = 一次发版，回滚就把 tag 指回旧 commit。

## 发版流程（维护者）

一条命令：

```bash
./scripts/release.sh v1.6.2 "docs: 修 README 过期流程（全员全局装）"
```

脚本做四件事：① 把 `package.json` 的 version **和 README/ONBOARDING 里的版本号**一起对齐 →
② 提交 → ③ 打 tag → ④ 推 main 和 tag。

- 版本标识以 **git tag** 为准 —— 扩展注入的版本号优先读你设置里钉的那个 ref，
  `git describe` 只做备选（踩过两次：一次是 tag 里包的 `package.json` version 忘了改；
  一次是 pi 升级已有 clone 时只 `git fetch <ref>`、不建本地 tag，describe 会报成 v1.4.4-8-gXXXX）
- 文档里的安装命令由脚本统一改写（`pi-workflow@vX.Y.Z` 和 `simulate-member.sh vX.Y.Z`），所以**别再手工改版本号**，照抄当前版本就行
- 发版后**不用逐个通知**：成员下次启动 pi 会自动跟上（见「成员如何更新基线」）；
  但发版后仍要**先在干净目录验一遍**（见「推完之后怎么验证」）

## 成员如何更新基线：不用管，装一次就自动跟

**成员零动作。** 基线扩展在每次启动 pi 时（默认 1 小时最多查一次远端）比对远端的**最新 vX.Y.Z tag**
与本地包目录的 HEAD：落后就 `git fetch` + `reset --hard` 到新 tag，并把 `~/.pi/agent/settings.json`
里的源一起改写成新标签。维护者这边只需要 `./scripts/release.sh` 打 tag + push。

- **更新本次会话不生效** —— pi 在扩展加载前就把资源列表收完了。终端会提示
  「团队基线已自动更新：v1.8.0 → v1.9.0 —— 重启 pi 生效」，下次启动才是新版
- **代价是一秒多的网络时间、且一小时只查一次**（`PI_BASELINE_UPDATE_TTL_HOURS=0` = 每次查）；
  网络不通、git 不在 PATH 一律静默跳过，绝不影响启动
- **不想自动跟**：设 `PI_BASELINE_SELF_UPDATE=off`；或把设置里的源钉成分支（`pi-workflow@main`）
  —— 钉分支/commit 的写法自动更新**不会碰**，适合「发版前先验主干」
- **确认自己在哪一版**：在 pi 里敲 `/team-baseline`（会显示「自动更新：✓ 已是最新 tag vX.Y.Z」），
  或直接问「团队基线是哪一版」。注入段里带版本号，读的是设置里钉的那个 ref
- **为什么它必须自己改设置里的 ref**：带 ref 的源在 `pi update --extensions` 时会被
  `git reset --hard <ref>` 拉回去 —— 只更新 clone 不改 ref，成员随手一次 update 就打回旧版
- **回滚**：`git tag -f vX.Y.Z <旧 commit>` + `git push -f origin vX.Y.Z`，成员下次启动自动退回去
- **包目录里别手改文件**（`~/.pi/agent/git/github.com/kurumi1ksllq/pi-workflow/`）：
  自动更新发现有未提交的跟踪文件改动会**拒绝动手**（怕丢东西），并在终端说明原因

自动更新覆盖不到时（版本太老、要跳到指定版本、网络长期不通）手动兜底：

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@<版本>
```

`pi install` 会把已有的那份切到指定版本，**不需要删目录**。别用 `pi update --all` ——
它会顺带升级 pi 本身。

## 推完之后怎么验证

**改完扩展先跑离线测（秒级，不用网络）**：

```bash
node scripts/test-extension.mjs
```

它离线跑扩展的全部同步逻辑，覆盖九条踩过坑的规则：钉版本替换不带版本的旧条目、缺的包追加、
别人的私有条目与无关设置项不动 + 幂等、版本标识优先用设置里钉的 ref、
共享设置只补缺（成员自己设过的键不被覆盖）、扩展配置只补不覆盖、
模板里 `_` 开头的说明键不写进设置、自动更新挑最新 tag 的版本比较（1.10.0 要赢过 1.9.9）、
模型配置按 provider 合并（已有档位不动 / 缺的档位追加 / 成员自建 provider 不碰 / 模板无明文 key / 幂等）。
挂了会 exit 1。

**自动更新那条链路单独验（也是离线，秒级）**：

```bash
node scripts/test-self-update.mjs
```

它造一个本地 bare 仓库当「远端」，按 pi 的目录约定搓出 clone，然后直接 import clone 里的扩展 ——
覆盖面：落后一个 tag 会自动更新（clone + settings 的 ref 一起动）、已是最新时不动、
包目录有未提交改动时拒绝动手、钉分支时不跟 tag、开发副本完全不碰。

**发版前再跑一次全链路（要网络，约一两分钟）** —— 别等成员踩了才发现问题。
一行命令，在隔离目录里模拟一个**全新成员**：

```bash
bash scripts/simulate-member.sh v1.10.0
```

它做的事：造一个独立的 agent 配置目录（不碰你本机的 `~/.pi/agent`）+
从 PATH 里摘掉 rtk（模拟没装过 rtk 的机器），然后走 `install` → 第一次启动 → 第二次启动 →
`pi list`，把包装到哪、rtk 落在哪、共享设置有没有写进去都打出来。

**判据**：`User packages` 里每一项都**带安装路径**（`pi-workflow` + 清单里的那些包）、
隔离目录的 `npm/node_modules` 里确实有它们、rtk 能被 `command -v` 找到、
隔离目录的 `settings.json` 里出现 `subagents` 与 `compaction`、
`extensions/pi-rtk-optimizer/config.json` 存在、`models.json` 里出现 `newapi` + 四个档位
（且 `apiKey` 是 `$` 环境变量引用，成员自建的 provider 还在）、
最后一步把 origin 换成带假 tag 的本地远端后**下次启动自动跟上了新 tag**。
只看到包名没有路径 = 还在设置里没装上 —— 少了第二次启动。

> 脚本**不把本机 `models.json` 拷进隔离目录**（只拷 `auth.json`）—— 拷了就等于把现场做好，
> 验不出「模型配置同步」这条链路。它改为在隔离目录里放一份「成员自建 provider」当干扰项，
> 顺便验「只补缺、不动他已有的东西」。真成员机器上那文件要么不存在、要么就是他自己那份。

手工等价流程：

```bash
SB='C:\Users\<你>\pi-check-agent'   # 隔离的 agent 目录，Windows 路径写法
PI_CODING_AGENT_DIR="$SB" pi install git:github.com/kurumi1ksllq/pi-workflow@v1.11.0
# 隔离目录不带凭据，启动前把 auth.json 拷进去（models.json 别拷：那正是要验的同步目标）
PI_CODING_AGENT_DIR="$SB" pi -p ok    # 第一次：扩展写清单 + 补 rtk + 补共享设置 + 补模型配置
PI_CODING_AGENT_DIR="$SB" pi list     # 应看到清单里的包都带路径
```

`pi list` 里能看到这些包，就说明远程源、ref、包结构、扩展几条链路都对。验证完删掉那个目录即可。

## 加第三方包之前先确认一件事

**这个包有没有外部依赖？** `pi install` 只能装 npm 包本身，
装不了它需要的独立二进制/系统工具。

踩过的例子：`pi-rtk-optimizer` 需要单独的 `rtk` 二进制，而 **rtk 不在 pi 的包体系里**
（官方 `@rtk-ai/rtk` 没发 npm 包；而且实测 `pi install npm:xxx` 装的包，
它的命令行**不会**进 PATH，所以就算有 npm 包也没用）。

**这个坑的解法**：包里带一份 `tools/rtk.exe`，扩展启动时检测 `where rtk`，
缺了就复制到 **npm 全局 bin 目录**（用 npm 装过 pi 的人，该目录必然在 PATH），
复制完再用 `where` 验一次。全自动，成员无感。

**新增带外部依赖的包时照这个模式办**：把二进制放 `tools/`，扩展里加一段补装逻辑。

**所以加包前先看一眼它的 README**，确认：

| 情况 | 能不能进清单 |
| --- | --- |
| 纯 npm 包，自带依赖 | ✅ 可以 |
| 需要额外装 CLI / 二进制 | ⚠️ 先想清楚成员怎么装；装不上就别加 |

## 三个清单，分工别搞混

| 要同步什么 | 写哪 | 谁来落地 |
| --- | --- | --- |
| **第三方 pi 包**（要团队一起装的扩展） | `team/packages.json`，**一律写死版本号**（`npm:foo@1.2.3` / `git:host/org/repo@<tag 或 commit>`） | 扩展补进**全局** `~/.pi/agent/settings.json`；旧的同名条目（不带版本）会被替换成钉版本的 |
| **共享的全局设置**（`subagents` 模型路由、`compaction` 等） | `team/agent-settings.json` | 扩展**只补缺**地并进全局 `settings.json`：成员自己设过的键一个都不动 |
| **团队模型配置**（网关地址 + 档位别名） | `team/models.template.json`，**`apiKey` 只能写 `$环境变量`** | 扩展按 provider 合并进全局 `models.json`：provider 缺就整段补，已在则只补缺的字段、按 id 追加缺的档位，已有的档位定义与成员自建的 provider 一律不动 |
| **扩展自己的配置文件**（`pi-rtk-optimizer` 这类把配置放自己目录的） | `team/extensions/<扩展名>.json` | 扩展补到 `<agent dir>/extensions/<扩展名>/config.json`，**目标存在就完全不动** |
| **项目级设置**（compaction 等） | 各项目 `.pi/settings.json`，可从 `templates/project-settings.json` 抄 | 项目负责人手工放一次 |
| 团队自己的 skill / prompt / 扩展 / 规范 | 包内对应目录 | 升级团队包 |

团队是**全员全局装**，所以第三方包清单和共享设置都落到全局 —— 不依赖任何项目仓库。

**为什么必须写死版本号**：不带版本的条目在 pi 眼里不是 pinned，启动时会弹
「Package Updates Available」，各人点一下就升到不同版本，团队就不是同一套了。
写了版本之后 pi 启动会比对已装版本并自动装齐，提示也不再出现。
升级第三方包 = 改 `team/packages.json` 里的版本号 → 发版。

**共享设置为什么是"只补缺"**：成员可能自己关掉 compaction、给某个 agent 换过模型 ——
覆盖等于让人不敢在自己机器上动任何设置。要"全员强制一致"时也别去覆盖，
改模板 + 发版，让所有人的**空缺**被补上。

**模型配置为什么单独一个清单**：`team/agent-settings.json` 里的 subagents 路由写的是**档位别名**
（`tier-power` / `tier-max`），别名只有在成员的 `models.json` 里定义了对应 provider + 档位才解析得出来。
没有这一步，新成员派出去的 reviewer 会拿到一个解析不了的模型名。合并规则比 settings 更细
（provider 内按 model id 追加），因为**数组在对象深合并里是整体当一个值** —— 只按 provider 粒度判"已存在"
就等于以后往网关注册新档位时成员的配置永远补不上。

⚠️ **`team/models.template.json` 里绝不能写明文 `apiKey`** —— 仓库是公开的。写环境变量引用
（`"apiKey": "$NEWAPI_API_KEY"`），成员自己导出，或用 pi 的 `/login` 给这个 provider 存一份 key。
`healthCheck()` 会扫描模板里的明文 key 并在启动时报错，这条不靠记性。

**别在两处写包** —— `team/packages.json` 是唯一入口。项目 `.pi/settings.json` 里手写的包不会被它覆盖，
但重复了容易搞不清谁负责。

## 目录

| 路径 | 内容 |
| --- | --- |
| `skills/` | 按需加载的能力包。`00-core/` 全员共享，其余按角色分目录 |
| `prompts/` | 斜杠命令，`review.md` → `/review` |
| `extensions/` | `team-baseline.ts`（引导扩展：注入规范、补 MCP 基线、同步包清单、补共享设置、补模型配置、补扩展配置、补 rtk、自动跟最新 tag）+ `audit-log.ts`（审计日志，见下节） |
| `team/` | 扩展的数据源：`RULES.md`（规范）+ `mcp.template.json`（MCP 基线）+ `packages.json`（第三方包清单）+ `agent-settings.json`（共享设置补丁）+ `models.template.json`（网关与档位别名，不含 key）+ `extensions/`（各扩展的默认配置） |
| `tools/` | `rtk.exe`，`pi-rtk-optimizer` 需要的二进制，随包分发 |
| `templates/` | 项目级配置模板 `project-settings.json`、项目侧哨兵 `project-AGENTS.md` |
| `scripts/` | `release.sh`（发版）、`simulate-member.sh`（从零装验证）、`test-extension.mjs`（基线扩展离线测）、`test-self-update.mjs`（自动更新链路离线测）、`test-audit-extension.mjs`（审计扩展离线测）、`pi_audit_report.py`（审计报表） |
| `docs/` | 怎么写各类资源 + `audit-log.md`（审计字段与口径）、`audit-report.md`（报表用法）。**说明文档一律放这里，别放 skills/** |
| `ONBOARDING.md` | 给成员的上手指南，**可直接转发** |
| `CHANGELOG.md` | 变更记录 |

## 扩展做了什么（成员不用管，但该知道）

`team-baseline` 扩展在每次会话做八件事：

1. **把 `team/RULES.md` 注入系统提示** —— pi 原生不加载包内的 AGENTS.md，这是绕过办法
2. **项目缺 `.mcp.json` 时从包里补一份** —— 绝不覆盖已有的；只在有 `.pi/` 的目录里动手
3. **把 `team/packages.json` 里的包补进全局设置** —— 只补不删、幂等；补了会提示重启
4. **把 `team/agent-settings.json` 只补缺地并进全局设置** —— 成员自己设过的键不动
5. **把 `team/models.template.json` 按 provider 并进全局 `models.json`** —— 缺的 provider 整段补，
   已在则只补缺的字段 + 按 id 追加缺的档位；已有的档位定义、成员自建的 provider 一律不动
6. **把 `team/extensions/<扩展名>.json` 补到扩展自己的配置位置** —— 目标已存在就完全不动
7. **缺 rtk 时从 `tools/` 补一份到 npm 全局 bin** —— 补完用 `where` 验一次
8. **跟远端最新 tag 对齐**（放在最后，本会话仍用旧版）—— 落后就 fetch + reset --hard，
   并把 settings 里的 ref 一起改写；有未提交改动则拒绝动手（细节见「成员如何更新基线」）

所以改团队规范 = 改 `team/RULES.md` 然后发新版；改 MCP 基线 = 填 `team/mcp.template.json`；
改全员共享设置 = 改 `team/agent-settings.json`；改网关/档位 = 改 `team/models.template.json`。

在 pi 里敲 `/team-baseline` 可以看到当前基线来自哪个版本、哪些生效了、
本次启动各自补了什么。

## 审计日志（会话可追溯）

`extensions/audit-log.ts` 给每个会话留一份结构化流水：花了多少 token、调了哪些工具、成败与耗时、
加载了哪些 skill、会话有没有收敛。**只落本机文件，不联网、不上传，对模型完全不可见。**

| 产物 | 路径 |
| --- | --- |
| 流水 | `~/.pi/agent/audit/logs/<日期>.jsonl`（一事件一行，追加写，进程被杀也留痕） |
| 报表 | `python scripts/pi_audit_report.py` → Markdown（按天/按模型/按人 token 分布、工具与失败率、skill 命中、收敛率、上下文压力） |
| 配置 | `~/.pi/agent/extensions/audit-log/config.json`（首次启动从包里补一份默认的；调过之后团队更新不再动） |

不想要就关掉，立刻一条都不写，不用卸包：

```bash
echo '{"enabled": false}' > ~/.pi/agent/extensions/audit-log/config.json
```

口径与缺口见 `docs/audit-log.md`，报表用法见 `docs/audit-report.md`。
两条注意：按天的文件里**混着当天所有会话**，统计前先按 `sessionId` 过滤；
审计日志是**索引 + 指标**，需要工具输出原文时用 `toolCallId` 回联 session jsonl。

## 边界

- 这里只放**团队共识**。个人试验装在自己全局（`~/.pi/agent/settings.json`）或用 `pi -e` 临时跑，验证过再迁进来
- 项目专属的约定不写这，写各项目仓库根的 `AGENTS.md` —— pi 启动时自动拼接加载
- **凭据一律不进这个仓库**（公开仓库）：`team/agent-settings.json` 里只能出现模型名，
  不能出现 key、token、网关的账号密码 —— 那些是各人自己配的
- 别手工编辑 `~/.pi/agent/settings.json` 里的包源，统一用 `pi install`（不带 `-l`），避免路径和 ref 写法不一致
