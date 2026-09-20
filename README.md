# pi-workflow

团队 pi 基线。全局装一次，所有人拿到同一套 skills、prompts、extensions、团队规范。

## 成员怎么用（两步）

1. 装 pi（已装跳过）
2. 全局装基线：

   ```bash
   pi install git:github.com/kurumi1ksllq/pi-workflow@v1.6.4
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
git:github.com/<org>/pi-workflow@v1.6.4
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

锁版本还是跟最新：

| 想要 | 写法 | `pi update --extensions` 行为 |
| --- | --- | --- |
| 锁死 | `...@v1.0.0`（tag 或 commit） | 跳过，永远不动，只能手动改 ref |
| 跟最新 | `git:github.com/org/repo`（不写 ref） | 拉远端默认分支最新 |

带 ref 一律被标记为 pinned。团队分发先用锁死的，出问题好回滚，稳定了再谈自动跟。

## 发版流程（维护者）

一条命令：

```bash
./scripts/release.sh v1.6.2 "docs: 修 README 过期流程（全员全局装）"
```

脚本做四件事：① 把 `package.json` 的 version **和 README/ONBOARDING 里的版本号**一起对齐 →
② 提交 → ③ 打 tag → ④ 推 main 和 tag。

- 版本标识以 **git tag** 为准 —— 扩展注入的版本号读的是 `git describe`，不读 `package.json`
  （踩过：tag 里包的 `package.json` version 忘了改，上下文里写的版本和实际装的对不上）
- 文档里的 `pi-workflow@vX.Y.Z` 由脚本统一改写，所以**别再手工改版本号**，写 `@v1.6.2` 这种具体值就行
- 发版后通知成员升级（见下一节），并**先在干净目录验一遍**（见「推完之后怎么验证」）

## 成员如何更新基线（重要，实测过）

**pi 不会自动更新已装的包，`pi update` 也不会。** 实测三种方式全都没用 ——
启动 pi、`pi update --extensions`、`pi update --all`，装完就冻结在那一刻。

唯一有效的更新动作 —— **重跑 install 带新版本号**：

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@<新版本>
```

`pi install` 会把已有的 clone 切到指定版本，**不需要删目录**。
（`pi update` 不行 —— 它不会换版本，也不会对齐你手改过的 ref。）

所以：

- **ref 一律锁 tag**（`@vX.Y.Z`）。不写 ref 也一样不会自动更新，
  只会让你不知道队友此刻跑的是哪一版
- 别用 `pi update --all` 更新扩展 —— 它会顺带升级 pi 本身
- **确认自己更新成功**：在 pi 里问「团队基线是哪一版」，或敲 `/team-baseline`。
  注入段里带版本号（读的是 git tag，不会和实际版本对不上）

## 推完之后怎么验证

别等成员踩了才发现问题。一行命令，在隔离目录里模拟一个**全新成员**：

```bash
bash scripts/simulate-member.sh v1.6.2
```

它做的事：造一个独立的 agent 配置目录（不碰你本机的 `~/.pi/agent`）+
从 PATH 里摘掉 rtk（模拟没装过 rtk 的机器），然后走 `install` → 第一次启动 → 第二次启动 →
`pi list`，把包装到哪、rtk 落在哪都打出来。

**判据**：`User packages` 三项都**带安装路径**（`pi-workflow`、`pi-context-view`、`pi-rtk-optimizer`）、
隔离目录的 `npm/node_modules` 里有那两个包、rtk 能被 `command -v` 找到。
只看到包名没有路径 = 还在设置里没装上 —— 少了第二次启动。

手工等价流程：

```bash
SB='C:\Users\<你>\pi-check-agent'   # 隔离的 agent 目录，Windows 路径写法
PI_CODING_AGENT_DIR="$SB" pi install git:github.com/kurumi1ksllq/pi-workflow@v1.6.4
# 隔离目录不带凭据，启动前把 auth.json / models.json 拷进去
PI_CODING_AGENT_DIR="$SB" pi -p ok    # 第一次：扩展写清单 + 补 rtk
PI_CODING_AGENT_DIR="$SB" pi list     # 应看到三项
```

`pi list` 里能看到这些包，就说明远程源、ref、包结构、扩展三条链路都对。验证完删掉那个目录即可。

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

## 两个清单，分工别搞混

| 要同步什么 | 写哪 | 谁来落地 |
| --- | --- | --- |
| **第三方 pi 包**（要团队一起装的扩展） | `team/packages.json`，**一律写死版本号**（`npm:foo@1.2.3`） | 扩展补进**全局** `~/.pi/agent/settings.json`；旧的同名条目（不带版本）会被替换成钉版本的 |
| **项目级设置**（compaction 等） | 各项目 `.pi/settings.json`，可从 `templates/project-settings.json` 抄 | 项目负责人手工放一次 |
| 团队自己的 skill / prompt / 扩展 / 规范 | 包内对应目录 | 升级团队包 |

团队是**全员全局装**，所以第三方包清单落到全局设置 —— 不依赖任何项目仓库。

**为什么必须写死版本号**：不带版本的条目在 pi 眼里不是 pinned，启动时会弹
「Package Updates Available」，各人点一下就升到不同版本，团队就不是同一套了。
写了版本之后 pi 启动会比对已装版本并自动装齐，提示也不再出现。
升级第三方包 = 改 `team/packages.json` 里的版本号 → 发版。

**别在两处写包** —— `team/packages.json` 是唯一入口。项目 `.pi/settings.json` 里手写的包不会被它覆盖，
但重复了容易搞不清谁负责。

## 目录

| 路径 | 内容 |
| --- | --- |
| `skills/` | 按需加载的能力包。`00-core/` 全员共享，其余按角色分目录 |
| `prompts/` | 斜杠命令，`review.md` → `/review` |
| `extensions/` | `team-baseline.ts` —— 引导扩展：注入规范、补 MCP 基线、同步包清单、补 rtk |
| `team/` | 扩展的数据源：`RULES.md`（规范）+ `mcp.template.json`（MCP 基线）+ `packages.json`（第三方包清单） |
| `tools/` | `rtk.exe`，`pi-rtk-optimizer` 需要的二进制，随包分发 |
| `templates/` | 项目级配置模板 `project-settings.json`、项目侧哨兵 `project-AGENTS.md` |
| `scripts/` | `release.sh`（发版）、`simulate-member.sh`（从零装验证） |
| `docs/` | 怎么写各类资源。**说明文档一律放这里，别放 skills/** |
| `ONBOARDING.md` | 给成员的上手指南，**可直接转发** |
| `CHANGELOG.md` | 变更记录 |

## 扩展做了什么（成员不用管，但该知道）

`team-baseline` 扩展在每次会话做四件事：

1. **把 `team/RULES.md` 注入系统提示** —— pi 原生不加载包内的 AGENTS.md，这是绕过办法
2. **项目缺 `.mcp.json` 时从包里补一份** —— 绝不覆盖已有的；只在有 `.pi/` 的目录里动手
3. **把 `team/packages.json` 里的包补进全局设置** —— 只补不删、幂等；补了会提示重启
4. **缺 rtk 时从 `tools/` 补一份到 npm 全局 bin** —— 补完用 `where` 验一次

所以改团队规范 = 改 `team/RULES.md` 然后发新版；改 MCP 基线 = 填 `team/mcp.template.json`。

在 pi 里敲 `/team-baseline` 可以看到当前基线来自哪个版本、哪些生效了。

## 边界

- 这里只放**团队共识**。个人试验装在自己全局（`~/.pi/agent/settings.json`）或用 `pi -e` 临时跑，验证过再迁进来
- 项目专属的约定不写这，写各项目仓库根的 `AGENTS.md` —— pi 启动时自动拼接加载
- 别手工编辑 `~/.pi/agent/settings.json` 里的包源，统一用 `pi install`（不带 `-l`），避免路径和 ref 写法不一致
