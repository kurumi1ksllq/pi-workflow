# 新成员上手指南

照着走，十分钟能开始干活。**第 2 步不能跳。**

## 1. 装 pi

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

验证：`pi --version`

## 2. 配好模型凭据（**不能跳过**）

这一步是**个人的**，不从团队仓库同步 —— 每人配自己的。

```bash
pi
# 进去后敲 /login 走 OAuth，或者退出后用环境变量，例如：
export DEEPSEEK_API_KEY=...
```

验证：`pi auth check --provider <你的provider>`

> ⚠️ **不配会怎样**：`pi` 直接报 `No API key found` 退出，
> 团队基线包会装到**一半中断**（实测过）。后面几步全都白做。

## 3. 装团队基线（**全局**，一次装完所有项目通用）

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.13.4
```

**注意没有 `-l`。** 这是全局安装，装到 `~/.pi/agent/`，
之后你在**任何目录**跑 pi 都带着团队基线 —— **不绑定任何具体项目**。

### ⚠️ 然后再启动一次 pi（**这一步别漏**）

```bash
pi
```

你会看到几行提示，长这样：

```
[team-baseline] 已把团队清单里的扩展写进配置 —— 请退出再启动一次 pi，它们会被装上
[team-baseline] 已把团队共享设置补进 ~/.pi/agent/settings.json（只补了缺的键，你的手改没动）—— **重启 pi 生效**
[team-baseline] 已补上扩展默认配置：pi-rtk-optimizer（已有配置的扩展一律没动）—— **重启 pi 生效**
```

**按提示做：退出，再启动一次。** 第二次启动时清单里的扩展才会真正装上
（pi 的包安装发生在扩展加载之前，所以天生差这一步 —— 只在第一次装的时候需要）。

以后再往清单里加包，也是同样的两下：启动、看到提示、再启动一次。

同一批提示里还会有这句，不用管它，是自动装了 `rtk`：

```
[team-baseline] 已把 rtk 装好（PATH 里能找到）—— **重启 pi** 后命令压缩就会生效
```

## 4. 确认生效

启动 `pi`，看最上面打印的资源列表：

```
[Skills]
  api-review, commit-convention, team-baseline-feedback, ui-review

[Prompts]
  /review

[Extensions]
  kurumi1ksllq/pi-workflow:team-baseline.ts
```

**看到这三段就是生效了。** 这几段只在有内容时才显示，缺 `[Skills]` 或 `[Prompts]` 说明没装上。

其他确认方式：

- 在 pi 里问「团队基线是哪一版」
- 敲 `/team-baseline` 看自检报告（只在交互模式有输出）：清单同步、共享设置、扩展配置各补了什么都会列出来
- `Ctrl+O` 展开完整启动信息
- `pi list` 的 **User packages** 里应含 `pi-workflow@v1.13.4` 与清单里的那些包，且每项都带安装路径

**没生效就按顺序查**：第 2 步的凭据配了吗 → `pi list` 里有 `pi-workflow@v1.13.4` 吗

## 你会自动获得什么

| 内容 | 怎么用 |
| --- | --- |
| 团队规范 | 已在上下文里，不用管 |
| 4 个 skill | pi 自己判断该用时加载 |
| `/review` | 敲它审查当前 diff |
| 团队统一装的扩展 | 启动时自动补进你的全局设置，重启后生效 |
| 共享的扩展设置 | `subagents` 模型路由、`compaction` 这些团队一致的设置，扩展**只补缺**地并进你的全局设置 —— 你设过的键不会被覆盖 |
| 模型配置（网关 + 档位） | 网关地址和三个常用档位别名（`tier-std` / `tier-power` / `tier-max`，各自 **512k 上下文**）自动补进你的 `~/.pi/agent/models.json`，最后附一个仅供探测的 `tier-free`（256k）。**key 不在里面**（`apiKey` 写的是 `$NEWAPI_API_KEY` 引用）—— 你自己导出这个环境变量，或者用 pi 的 `/login` 给 `newapi` 存一份 key。已经有同名 provider 或同名档位就不动你的（唯一的例外：档位窗口还停在旧模板值时会给你刷成新版，你手改过的值不动） |
| 扩展默认配置 | 像 `pi-rtk-optimizer` 这种把配置放自己目录的扩展，首次启动时从包里补一份默认配置；你调过之后就不动 |
| rtk 命令压缩 | 同上，扩展顺手把缺的 `rtk` 二进制补到 PATH 里的目录 |
| MCP 基线 | 在已接入基线的项目里自动补 `.mcp.json` |
| 审计日志 | 每个会话自动留一份结构化流水（token / 工具调用 / 加载的 skill / 收敛标记），落在你本机 `~/.pi/agent/audit/logs/`。**只写本地文件、不联网**，想关就把 `~/.pi/agent/extensions/audit-log/config.json` 里的 `enabled` 改成 `false` |
| 上下文瘦身（`context-thrift`） | 每次模型调用前剥掉「历史消息里重放出来的推理链」—— 上游本来就会忽略它，纯属每轮白交的 token（实测占某会话上下文 **29.3%**）。**默认已开**，同会话 A/B 省 **33%**。想关就把 `~/.pi/agent/extensions/context-thrift/config.json` 里的 `enabled` 改成 `false`，或启动前 `PI_CONTEXT_THRIFT_ENABLED=0 pi`。第三层「工具声明裁剪」默认关着，要开看包内 README（**别裁 `subagent`**） |
| 审计报表 | `python scripts/pi_audit_report.py`，一条命令出 Markdown 报表（详见包内 `docs/audit-report.md`） |

> ⚠️ **前提**：上面「共享的扩展设置」里的 `subagents` 模型路由用的是**团队网关的档位别名**
> （`tier-power`、`tier-max`，不是真实模型名 —— 网关换后端模型时这边不用动）。
> 走团队网关的话这些档位名能直接解析（网关地址与档位定义自动补进 `models.json`，见上一行）。
> 你要是不走团队网关（比如用自己买的 API），那几个档位名对你无效 ——
> 把这几项从自己的 `~/.pi/agent/settings.json` 里删掉，或换成你自己的模型。
> 扩展不会把它们补回来：共享设置是**只补缺**，你设过的（甚至故意留空的处理方式）它都不动。
>
> 走团队网关的话，网关地址和档位定义（`models.json` 里那段 `newapi`）**是自动补的**，你只需要把
> key 给它：二选一 ——
>
> ```bash
> export NEWAPI_API_KEY=sk-...          # ① 环境变量（模板里 apiKey 就写的这个引用）
> # ② 或者在 pi 里敲 /login，给 newapi 这个 provider 存一份 key（落在 auth.json，优先级更高）
> ```
>
> 配完敲 `pi --list-models`，应能看到 `newapi` 下的四个 `tier-*`。想默认用某个档位，
> `~/.pi/agent/settings.json` 里写 `"defaultModel": "tier-std"`（**裸模型 id**，
> 配合 `"defaultProvider": "newapi"` 消歧）—— 实测写成 `newapi/tier-std` 反而解析不到，
> 会静默回退到列表里的第一个模型（团队模板已把 `tier-free` 挪到末尾，就是为了不让这种笔误
> 落到每天只有 100 次请求的免费档上）。基线扩展会帮你把这种笔误改回裸 id，
> 其余情况不碰这两个键 —— 是你自己的选择。
>
> ⚠️ **`tier-free` 只用来做连通性/冒烟探测**：它每账户每天只有 **100 次请求**，一次批量任务就能烧光，
> 当天剩下的时间整个免费档都不可用。日常干活用 `tier-std`，不要把它设成默认值。

## 从 v1.6.x 升到 v1.7.x

这一版起，基线还会往你的全局设置里补**团队共享设置**（`subagents` / `compaction`）和
**扩展默认配置**。都是"只补缺"：你已经设过的键、你调过的扩展配置，一律不动。

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.13.4   # 1. 换版本
pi                                                           # 2. 启动：提示补了什么
pi                                                           # 3. 再启动一次：新清单里的包装上
```

## 从 v1.5.x 升到 v1.6.x

顺序别反：

```bash
pi remove npm:pi-rtk-optimizer          # 1. 清掉旧版清单遗留的那个扩展（如果它在你设置里）
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.13.4   # 2. 换版本
pi                                       # 3. 启动：扩展补 rtk + 重写清单
pi                                       # 4. 再启动一次：清单里的包才装上
```

- 不第 1 步会怎样：老版本的 `pi-rtk-optimizer` 在，但机器上没 `rtk`，
  它每次启动都刷 `rtk binary unavailable` 警告。清掉后由 v1.6.x 自动补 rtk，警告消失
- `pi remove` 不影响团队包本身，只是从你的全局设置里摘掉这一项

## 启动时看到「Package Updates Available」

**别急着按它说的跑 `pi update --extensions`** —— 那条会把你机器上的第三方包升到最新，
和团队其他人就不一样了。

团队清单里的包都钉了版本，正常情况下这个提示不该出现。出现了说明你手上那份清单是旧的：

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.13.4   # 1. 换到钉版本的清单
pi                                                           # 2. 启动：扩展把不带版本的旧条目换成钉版本
pi                                                           # 3. 再启动一次：按钉的版本装齐
```

之后再看到这个提示，说明清单本身漏了版本号 —— 告诉维护者补上。

## 之后怎么更新基线：不用管

**装一次就自动跟。** 基线扩展每次启动 pi 时（最多一小时查一次远端）比对远端最新版本，
落后就自己把包目录切过去，终端会提示：

```
[team-baseline] 团队基线已自动更新：v1.8.0 → v1.9.0 —— **重启 pi 生效**
```

看到这句，退出再启动一次就是新版。没看到就说明你已经是最新的，什么都不用做。

想确认自己在哪一版：在 pi 里敲 `/team-baseline`（会有一行「自动更新：✓ 已是最新 tag vX.Y.Z」）。

自动更新不生效的少数情况 —— 都只影响你自己，按提示手动来一次即可：

| 情况 | 怎么办 |
| --- | --- |
| 你的版本太老（早于 v1.9.0，包里还没有自动更新逻辑） | 手动跑一次：`pi install git:github.com/kurumi1ksllq/pi-workflow@v1.13.4` 之后就不用管了 |
| 提示「包目录里有未提交的改动 —— 没敢动」 | 你改过包目录里的文件；`git -C ~/.pi/agent/git/github.com/kurumi1ksllq/pi-workflow status` 看一眼，不需要就 `git checkout -- .` 还原，下次启动会自动跟上 |
| 网络长期连不上 GitHub | 连上后重启 pi 即可；也可以手动 `pi install ...@<版本>` |
| 你不想自动跟 | 设环境变量 `PI_BASELINE_SELF_UPDATE=off` |

⚠️ **别用 `pi update --all`** 更新扩展 —— 它会顺带升级 pi 本身。

## 你自己的东西放哪

| 想干什么 | 放哪 |
| --- | --- |
| 私人 skill / 扩展 | 直接 `pi install npm:xxx`（全局，只有你自己有） |
| 临时试一个包 | `pi -e npm:xxx` |
| 项目专属约定 | 项目仓库根的 `AGENTS.md` |
| 调某个扩展的配置 | 它自己的配置文件，比如 `~/.pi/agent/extensions/pi-rtk-optimizer/config.json` —— 调过之后团队更新不会再动它 |

⚠️ **想让全团队都用某个扩展，别自己装了就算** —— 告诉维护者，
让他写进团队清单（`team/packages.json`），这样所有人都会自动补上。

⚠️ **想让全团队统一某条设置**（模型路由、压缩参数等）—— 也告诉维护者，
写进 `team/agent-settings.json`，而不是让每个人都手动改一遍。

---

## 附（可选，只对要塞进项目仓库的东西）

如果某个项目想让**没装全局基线的人** clone 下来也能用，可以在项目根的 `AGENTS.md`
里追加团队包里的 `templates/project-AGENTS.md` —— 那是一段自检提醒，
pi 原生就会加载它，基线扩展万一没跑，它会指示模型主动报告。

> ⚠️ 要**追加进已有的 `AGENTS.md`**，**别新建 `AGENTS.override.md`** ——
> 同一个目录只认一个文件，新建会把项目原有的规范整段顶掉，且不报任何错。
