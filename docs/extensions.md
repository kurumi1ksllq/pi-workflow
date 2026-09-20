# extensions：怎么写

放 `.ts` / `.js` 文件，pi 启动时自动加载。**只扫这个目录下的直接文件，不递归子目录**
（`foo/index.ts` 那种子目录形式只在 `.pi/extensions/` 下有效，包里不认）。

⚠️ 扩展有完整系统权限，跑的是任意代码。**进这个目录前必须走过 code review。**

只有 pi 原生做不到的东西才写扩展（注入上下文、新工具、斜杠命令、快捷键、TUI 组件）。
能用 skill 表达的就写 skill —— 可读、可 review、可回滚。

## 当前内容：team-baseline.ts

这个扩展是为了补 pi 的四个边界，不是随手加的：

| 边界 | pi 原生行为 | 这个扩展做什么 |
| --- | --- | --- |
| 包内的 `AGENTS.md` | 不加载（只扫 cwd 祖先链 + `~/.pi/agent/`） | 把 `team/RULES.md` 追加进系统提示 |
| MCP 配置 | 没有"从包里读"的入口 | 项目缺 `.mcp.json` 时，从 `team/mcp.template.json` 补一份 |
| 第三方包清单 | 包里的设置文件不会被读 | 把 `team/packages.json` 里的包补进**全局** `~/.pi/agent/settings.json` |
| 包的外部依赖 | `pi install` 只装 npm 包本身，命令行不进 PATH | 缺 `rtk` 时从包内 `tools/` 补到 npm 全局 bin |

关键技巧：扩展用 `import.meta.url` 定位自己，就能反推出团队包根目录，从而读到包里任何文件。

在 pi 里敲 `/team-baseline` 可以看到当前基线来源与同步状态。

## 重要：RULES.md 不是 pi 认识的文件

pi 原生只认这几个文件名，而且只在 **cwd 祖先链 + `~/.pi/agent/`** 里找：

```
AGENTS.override.md / AGENTS.md / AGENTS.MD / CLAUDE.md / CLAUDE.MD
```

`team/RULES.md` **不在其中** —— pi 完全不知道它存在。它能生效，100% 靠这个扩展
去读它、拼到系统提示后面。**「加载」这个动作是扩展做的，不是 pi 做的。**

所以：

- 文件名可以随便改（改扩展里的路径即可），`RULES.md` 只是我们自己的约定
- 没有 pi 层面的校验，**扩展不跑 = 规范静默失效**
- 想用 pi 原生认可的形态，就得叫 `AGENTS.md` 并放在**各项目仓库根**（包里那个不算）
  —— 代价是每个项目一份，会漂移

## 自己验证注入（不用信别人说的）

```bash
PI_BASELINE_DEBUG=1 pi
```

跑完看 `.pi/team-baseline.debug.txt`，里面是**拼接之后的完整系统提示**：
开头是 pi 的原生提示，往下翻能看到「## 团队基线规范」那一段 —— 那就是注进去的。

## 团队要一起用的第三方包：team/packages.json

你在自己机器上装了个好用的 pi 包，想让全团队都装上 —— 填进 `team/packages.json` 就行：

```json
{
  "packages": [
    "npm:pi-mcp-adapter@1.4.0",
    "npm:pi-web-access@0.29.0"
  ]
}
```

**一律写死版本号。** 不带版本的条目（`npm:foo`）在 pi 眼里不是 pinned —— 启动会弹
「Package Updates Available」，成员各点一下就升到不同版本，团队就不是同一套了。
带上精确版本后 pi 启动时比对已装版本、不符就自动装齐，提示也不会再出现。

扩展在启动时做三件事（**只补不删、不动已有的、重复调用安全**）：

1. 清单里有、设置里没有的包 → 追加
2. 清单里是钉版本的、设置里是同一个包但不带版本 → **替换成钉版本的那条**（升级路径）
3. 别的条目（成员自己的私有包、写法不一致的）→ 一律不动

补完在 stderr 提示一条。所以流程是：

1. 你把包名+版本填进 `team/packages.json` → 打 tag → 推
2. 成员升级、启动一次 pi → 看到「请退出再启动一次」→ 退出、再启动 → 包才装上
   （pi 的包安装发生在扩展加载**之前**，所以天生差这一步）
3. 升级第三方包：改这里的版本号 → 发版 → 成员重启两次，启动时自动换成新版本

⚠️ 三点注意：

- **别在这里放私人工具**（比如你自己为了省 token 装的那些）。团队清单是"全团队都得用"的东西，
  放进去等于替所有人做决定
- 原生不支持的工具要一起装，得先解决"成员怎么装"—— 见下面 rtk 那节
- 清单里的包**一律钉版本**；成员手里是旧的不带版本条目时，扩展会替换掉它（这条改动是 v1.6.4 加的）

## 内置二进制：tools/ + 扩展补装（rtk 的例子）

`pi-rtk-optimizer` 需要独立的 `rtk` 二进制，而**它不在 pi 的包体系里**：
官方 `@rtk-ai/rtk` 没发 npm 包，而且实测 `pi install npm:xxx` 装的包，
它带的命令行**不会**进 PATH。所以这一步只能是扩展做：

1. 二进制随包分发：`tools/rtk.exe`
2. 启动时 `where rtk`（Linux/macOS 用 `which`）—— 在就直接返回
3. 不在就把 `tools/` 里那份复制到**npm 全局 bin 目录**（`%APPDATA%\npm` / `~/.local/bin`），
   再 `where` 验一次

**为什么是 npm 全局 bin**：那个目录在 PATH 里是必然的（用 npm 装过 pi 的人都有），
而 Windows 上 `~/.local/bin` **默认不在 PATH** —— 一开始装那儿，装了等于白装（实测踩过）。

新加带外部依赖的包就照这个模式：二进制进 `tools/`，扩展里加一段补装逻辑 + `where` 验证。

> npm 装 `pi-rtk-optimizer` 时会打一条 `1 package had install scripts blocked` 警告。
> 无害 —— 它的 postinstall 只在 `/.pi/agent/extensions/` 路径下才干活，装到
> `agent/npm/node_modules` 时本来就会自己退出。别为这条警告改 npm 策略。

## 装法：团队一律全局

| 装法 | 命令 | 落在哪 | 用途 |
| --- | --- | --- | --- |
| **全局（团队标准）** | `pi install <源>` | `~/.pi/agent/settings.json` | 一次装，本机所有项目通用，不绑项目 |
| 项目级 | `pi install -l <源>` | 项目 `.pi/settings.json`（进 git） | 只在需要"没装全局的人 clone 下来也有"时才用 |

**三姐 2026-09-20 拍板：团队全员全局装，不绑项目。** 所以文档、清单、
验证流程都按全局那条走，别再写成项目级。

⚠️ 全局装之后，MCP 同步只在**已接入基线的目录**里动手（目录下有 `.pi/` 才算），
不会往随便什么目录塞 `.mcp.json`。

## 不静默失效（三层保障）

扩展自己没法报告"我没被加载" —— 不在运行就没法说话。所以做成三层：

| 层 | 覆盖什么 | 机制 |
| --- | --- | --- |
| 1. 扩展内自检 | 规范缺失、MCP 模板非法 | 启动时写 **stderr**（print / json / rpc 都可见），交互模式额外 notify |
| 2. 注入段带版本号 | 不知道自己跑的是哪版 | 注入文本里有 `（来源：pi-workflow vX.Y.Z）`，问模型就能问出来 |
| 3. 项目侧哨兵 | **扩展完全没加载**（项目未信任等） | 各项目仓库根放 `templates/project-AGENTS.md` —— pi 原生加载它，扩展挂了它会提醒模型主动报告 |

第 2 层的版本号**优先读 pi 设置里钉的那个 ref**（`git:...#@v1.6.5`），不是 `git describe`。
原因：pi 升级一个已存在的 clone 时只跑 `git fetch origin <ref>`，**不会在 clone 里建本地 tag**
（实测 `dist/core/package-manager.js` 的 `installGit`）。于是升级过基线的成员，clone 里的 tag 停在旧版本，
`git describe` 会给出 `v1.4.4-8-g8c8c540` 这种误导值。设置里那个 ref 才是权威答案。

第 3 层是关键：**用必然加载的东西，去检测可能没加载的东西**。

主动确认基线在正常工作：

- 在 pi 里敲 `/team-baseline` —— 这条命令能跑出来，本身就说明扩展在运行
- 或看 `.pi/team-baseline.debug.txt`（`PI_BASELINE_DEBUG=1` 时生成）

## 各事件什么时候触发（踩过的坑）

| 事件 | 交互模式 | print 模式（`-p` / `--mode json` / rpc） |
| --- | --- | --- |
| `before_agent_start` | ✅ | ✅ |
| `session_start` | ✅ | ❌ **不触发** |

所以**核心逻辑必须挂在 `before_agent_start`**。MCP 同步一开始挂在 `session_start`，
结果 print 模式下静默不生效 —— 这个坑踩过一次，别改回去。
`session_start` 只用来做交互模式下的额外提示。

包清单和 rtk 的同步是**在扩展加载时**（顶层代码）跑的，比 `before_agent_start` 更早 ——
必须这么早，晚了就赶不上 pi 检查缺哪些包。

## 什么时候会静默失效

| 情况 | 现象 |
| --- | --- |
| 项目没被信任 | 项目资源不加载、扩展不跑，什么都不发生，**没有提示**（全局装的包不受影响） |
| 扩展文件本身加载失败 | 同上 |
| `team/RULES.md` 被删或改名 | 扩展会 notify 一条提示，规范没注入 |

前两种没有提示 —— 改完包之后先跑 `bash scripts/simulate-member.sh <版本>`，
通过再通知团队。

## 改这里要注意

- 改了 `team-baseline.ts` 就是改全团队的行为，**必须 review**
- 扩展跑在成员机器上，别在这里放网络请求、密钥读取、文件删除
- 写的 `.mcp.json` 只在不存在时补，**绝不覆盖**成员已有的配置 —— 这条不能改
- 往用户机器写可执行文件只有一处（补 rtk），写的必须是包里自带的那份，别改成去网上下

## team/ 目录

扩展的数据源，不是 pi 的资源类型（不会被自动扫描）：

| 文件 | 作用 |
| --- | --- |
| `team/RULES.md` | 团队规范正文，注入每次会话的系统提示。**改这里 = 改全团队** |
| `team/mcp.template.json` | MCP 基线。`mcpServers` 为空时扩展不动作；填了才会往项目里补 |
| `team/packages.json` | 第三方 pi 包清单，补进全局设置。唯一入口，别在项目里手写包 |
