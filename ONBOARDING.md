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

```bash
git clone <项目地址>
cd <项目>
```

## 4. 启动 pi，同意信任

```bash
pi
```

首次会问「是否信任此项目」—— **同意**。

同意之后不用再做任何事，pi 会自动把团队基线装齐。

## 5. 确认基线生效

**在 pi 里直接问它**：

```
团队基线是哪一版？
```

答出形如 `pi-workflow v1.3.2` 就是生效了。

（也可以敲 `/team-baseline` 看自检报告 —— 这个命令只在交互模式有输出。）

**没生效就按顺序查**：

1. 第 4 步的信任点了同意吗
2. `pi list` 的 Project packages 里有没有 `git:github.com/kurumi1ksllq/pi-workflow@<版本>`
3. 第 2 步的凭据配好了吗

## 你会自动获得什么

| 内容 | 怎么用 |
| --- | --- |
| 团队规范 | 已在上下文里，不用管 |
| 3 个 skill（提交规范 / 接口审查 / 界面审查） | pi 自己判断该用时加载 |
| `/review` | 敲它审查当前 diff |
| MCP 基线 | 项目缺 `.mcp.json` 时自动补上 |

## 之后怎么更新基线

**pi 不会自动更新已装的包，`pi update` 也不会。** 项目负责人升级后：

```bash
git pull
rm -rf .pi/git/github.com/kurumi1ksllq/pi-workflow
pi
```

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
pi install -l git:github.com/kurumi1ksllq/pi-workflow@v1.3.2
# 把团队包里的 templates/project-AGENTS.md 追加进项目已有的 AGENTS.md
git add .pi/settings.json AGENTS.md
git commit -m "chore: 接入团队 pi 基线"
git push
```

> ⚠️ 哨兵内容要**追加进已有的 `AGENTS.md`**。
> **千万别新建 `AGENTS.override.md`** —— 同一个目录只认一个文件，
> 那会把项目原有的规范整段顶掉，且不会报任何错。
