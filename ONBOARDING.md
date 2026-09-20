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

## 3. clone 项目

**项目负责人会把下面这一行直接发给你** —— 复制粘贴即可，URL 和目录名都已经是实际值，
一个字符都不用改：

```bash
git clone https://github.com/<org>/<repo>.git && cd <repo> && pi
```

（`git clone` 会自动创建跟仓库同名的目录，所以 `cd` 后面是什么是确定的，不用你自己推）

### 私有仓库要先配认证

团队项目如果是私有的，clone 前得让 git 能证明你是你：

```bash
gh auth login          # 推荐，一次搞定 GitHub 的 HTTPS 认证
```

不配的话 `git clone` 会卡在认证提示或直接失败 —— 这跟第 2 步的模型凭据一样，
是**每个成员各自要做**的前置。

## 4. 启动 pi，同意信任

```bash
pi
```

首次会问「是否信任此项目」—— **同意**。

同意之后不用再做任何事，pi 会自动把团队基线装齐。

如果 `git status` 显示 `.pi/settings.json` 有改动，那是团队清单自动补的 ——
**不用管，也别自己提交**，项目负责人会统一提交。

## 5. 确认基线生效

**看 `pi` 启动时打印的资源列表** —— 最直接，一眼就够：

```
[Skills]
  api-review, commit-convention, team-baseline-feedback, ui-review

[Prompts]
  /review

[Extensions]
  kurumi1ksllq/pi-workflow:team-baseline.ts
```

**看到这三段就是生效了。**

注意这几段**只在有内容时才显示** —— 缺 `[Skills]` 或 `[Prompts]` 段，说明基线没装上去。
（你以前如果装过私人包，`[Extensions]` 里会多出它们，那是你自己的，不影响。）

其他确认方式：

- 在 pi 里问「团队基线是哪一版」→ 答出 `v1.3.7` 之类
- 敲 `/team-baseline` 看自检报告（只在交互模式有输出）
- `Ctrl+O` 展开完整启动信息

**没生效就按顺序查**：

1. 第 4 步的信任点了同意吗
2. `pi list` 的 Project packages 里有没有 `git:github.com/kurumi1ksllq/pi-workflow@<版本>`
3. 第 2 步的凭据配好了吗

## 你会自动获得什么

| 内容 | 怎么用 |
| --- | --- |
| 团队规范 | 已在上下文里，不用管 |
| 4 个 skill（提交规范 / 接口审查 / 界面审查 / 基线反馈） | pi 自己判断该用时加载 |
| `/review` | 敲它审查当前 diff |
| MCP 基线 | 项目缺 `.mcp.json` 时自动补上 |

## 之后怎么更新基线

**重跑一次 install，带上新版本号就行：**

```bash
pi install git:github.com/kurumi1ksllq/pi-workflow@<新版本>
```

`pi install` 会把已有的那份切到新版本，不用删任何目录（实测：v1.3.4 → v1.3.5 → v1.3.4 来回切都正常）。

⚠️ **别用 `pi update`** —— 实测它不会把已装的包换版本，也不会对齐你手改过的 ref。
换版本只有 `pi install` 这一条路。

然后用第 5 步的方式确认版本号变了。

## 你自己的东西放哪

| 想干什么 | 放哪 |
| --- | --- |
| 私人 skill / 扩展 | `~/.pi/agent/`（个人全局，不影响别人） |
| 临时试一个包 | `pi -e npm:xxx` |
| 项目专属约定 | 项目仓库根的 `AGENTS.md` |

⚠️ **别把个人试验写进 `.pi/settings.json`** —— 那是提交进仓库、全团队共享的。

---

## 附：给项目负责人

要把一个新项目接入团队基线，在项目根目录执行一次：

```bash
pi install -l git:github.com/kurumi1ksllq/pi-workflow@v1.3.5
# 把团队包里的 templates/project-AGENTS.md 追加进项目已有的 AGENTS.md
git add .pi/settings.json AGENTS.md
git commit -m "chore: 接入团队 pi 基线"
git push
```

> ⚠️ 哨兵内容要**追加进已有的 `AGENTS.md`**。
> **千万别新建 `AGENTS.override.md`** —— 同一个目录只认一个文件，
> 那会把项目原有的规范整段顶掉，且不会报任何错。

### 接入之后还有一步：提交被自动补上的包

第一次跑完 `pi`，`.pi/settings.json` 会被自动补上团队清单（`team/packages.json`）里的包：

```bash
git add .pi/settings.json
git commit -m "chore: 同步团队 pi 包清单"
git push
```

**别漏了这一步。** 不提交的话，每个成员 clone 下来都会各自补一份，
`git status` 永远是脏的 —— 能用，但没人知道该不该提交。

以后再往清单里加包，重复这个动作就行。
