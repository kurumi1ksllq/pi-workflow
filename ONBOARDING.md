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
pi install git:github.com/kurumi1ksllq/pi-workflow@v1.5.0
```

**注意没有 `-l`。** 这是全局安装，装到 `~/.pi/agent/`，
之后你在**任何目录**跑 pi 都带着团队基线 —— **不绑定任何具体项目**。

装完之后不用再做任何事：pi 每次启动会自动检查团队清单，把你缺的包补上。

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

**没生效就按顺序查**：第 2 步的凭据配了吗 → `pi list` 里有 `pi-workflow@v1.5.0` 吗

## 你会自动获得什么

| 内容 | 怎么用 |
| --- | --- |
| 团队规范 | 已在上下文里，不用管 |
| 4 个 skill | pi 自己判断该用时加载 |
| `/review` | 敲它审查当前 diff |
| 团队统一装的扩展 | 启动时自动补进你的全局设置，重启后生效 |
| MCP 基线 | 在已接入基线的项目里自动补 `.mcp.json` |

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
