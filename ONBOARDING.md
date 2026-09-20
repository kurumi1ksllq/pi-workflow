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
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.6.2
```

**注意没有 `-l`。** 这是全局安装，装到 `~/.pi/agent/`，
之后你在**任何目录**跑 pi 都带着团队基线 —— **不绑定任何具体项目**。

### ⚠️ 然后再启动一次 pi（**这一步别漏**）

```bash
pi
```

你会看到一行提示：

```
[team-baseline] 已把团队清单里的扩展写进配置 —— 请退出再启动一次 pi，它们会被装上
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
- 敲 `/team-baseline` 看自检报告（只在交互模式有输出）
- `Ctrl+O` 展开完整启动信息
- `pi list` 的 **User packages** 里应有三项：`pi-workflow@v1.6.2`、`pi-context-view`、`pi-rtk-optimizer`

**没生效就按顺序查**：第 2 步的凭据配了吗 → `pi list` 里有 `pi-workflow@v1.6.2` 吗

## 你会自动获得什么

| 内容 | 怎么用 |
| --- | --- |
| 团队规范 | 已在上下文里，不用管 |
| 4 个 skill | pi 自己判断该用时加载 |
| `/review` | 敲它审查当前 diff |
| 团队统一装的扩展 | 启动时自动补进你的全局设置，重启后生效 |
| rtk 命令压缩 | 同上，扩展顺手把缺的 `rtk` 二进制补到 PATH 里的目录 |
| MCP 基线 | 在已接入基线的项目里自动补 `.mcp.json` |

## 从 v1.5.x 升到 v1.6.x

顺序别反：

```bash
pi remove npm:pi-rtk-optimizer          # 1. 清掉旧版清单遗留的那个扩展（如果它在你设置里）
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.6.2   # 2. 换版本
pi                                       # 3. 启动：扩展补 rtk + 重写清单
pi                                       # 4. 再启动一次：清单里的包才装上
```

- 不第 1 步会怎样：老版本的 `pi-rtk-optimizer` 在，但机器上没 `rtk`，
  它每次启动都刷 `rtk binary unavailable` 警告。清掉后由 v1.6.x 自动补 rtk，警告消失
- `pi remove` 不影响团队包本身，只是从你的全局设置里摘掉这一项

## 之后怎么更新基线

**重跑一次 install，带上新版本号：**

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@<新版本>
```

`pi install` 会把已有的那份切到新版本，不用删任何目录。

⚠️ **别用 `pi update`** —— 实测它不会换版本，也不会对齐你手改过的 ref。

## 你自己的东西放哪

| 想干什么 | 放哪 |
| --- | --- |
| 私人 skill / 扩展 | 直接 `pi install npm:xxx`（全局，只有你自己有） |
| 临时试一个包 | `pi -e npm:xxx` |
| 项目专属约定 | 项目仓库根的 `AGENTS.md` |

⚠️ **想让全团队都用某个扩展，别自己装了就算** —— 告诉维护者，
让他写进团队清单（`team/packages.json`），这样所有人都会自动补上。

---

## 附（可选，只对要塞进项目仓库的东西）

如果某个项目想让**没装全局基线的人** clone 下来也能用，可以在项目根的 `AGENTS.md`
里追加团队包里的 `templates/project-AGENTS.md` —— 那是一段自检提醒，
pi 原生就会加载它，基线扩展万一没跑，它会指示模型主动报告。

> ⚠️ 要**追加进已有的 `AGENTS.md`**，**别新建 `AGENTS.override.md`** ——
> 同一个目录只认一个文件，新建会把项目原有的规范整段顶掉，且不报任何错。
