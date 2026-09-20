# pi-workflow

团队 pi 基线。装一次，所有人拿到同一套 skills、prompts、extensions。

## 成员怎么用（三步）

1. 装 pi（已装跳过）
2. 在项目根目录执行：

   ```bash
   pi install -l git:github.com/kurumi1ksllq/pi-workflow@v1.1.2
   ```

   `-l` = 写进项目设置 `.pi/settings.json`（不是你的个人全局设置）

3. 把 `.pi/settings.json` 提交进项目仓库

   克隆下来的包 pi 自己会挡：它往 `.pi/git/` 里放了一个 `.gitignore`（内容 `*` 加 `!.gitignore`），
   安装产物不会被误提交。想双保险就在项目 `.gitignore` 里再补一条 `.pi/git/`。

之后新成员 clone 项目 → 启动 pi → 弹出信任提示点同意 → **缺失的包自动装齐**，不用手动跑任何命令。

> 首次启动会问"是否信任这个项目"。拒绝的话 `.pi/settings.json` 不加载、包不会装。
> 这不是 bug，是 pi 的安全闸 —— 项目级扩展会在你机器上执行代码。

## 源怎么写（在 pi 0.85.1 上直接调解析器实测）

**推荐写法，`git:` 前缀不能省：**

```
git:github.com/<org>/pi-workflow@v1.1.2
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

1. 改完 skill / prompt / extension，本地验证
2. **把 `package.json` 的 `version` 改成这次的版本号**（扩展读它，会显示在注入段里；
   忘了改就会出现"装的是 v1.2.0、上下文里写 v1.1.0"这种自相矛盾）
3. 提交并打 tag，两者版本号必须一致：

   ```bash
   git add -A && git commit -m "add xxx skill"
   git tag v1.1.0
   git push && git push --tags
   ```

4. 更新各项目的 `.pi/settings.json` 里的 ref，以及本文件「成员怎么用」里的版本号
5. 通知成员升级

带 ref 的写法是**钉死的** —— `pi update` 不会偷偷把成员的版本挪走，
只会在成员 pull 到新 ref 后把本地 clone 对齐过去。想回滚就改回旧 tag。

## 成员如何更新基线（重要，实测过）

**pi 不会自动更新已装的包，`pi update` 也不会。** 实测三种方式全都没用 ——
启动 pi、`pi update --extensions`、`pi update --all`，装完就冻结在那一刻。

唯一有效的更新动作 —— **重跑 install 带新版本号**：

```bash
# 项目负责人：改项目里的 ref → commit → push
# 每个成员：
pi install [-l] git:github.com/kurumi1ksllq/pi-workflow@<新版本>
```

`pi install` 会把已有的 clone 切到指定版本，**不需要删目录**。
（`pi update` 不行 —— 它不会换版本，也不会对齐你手改过的 ref。）

所以：

- **ref 一律锁 tag**（`@v1.3.5`）。不写 ref 也一样不会自动更新，
  只会让你不知道队友此刻跑的是哪一版
- 别用 `pi update --all` 更新扩展 —— 它会顺带升级 pi 本身
- **确认自己更新成功**：在 pi 里问「团队基线是哪一版」，或敲 `/team-baseline`。
  注入段里带版本号（读的是 git tag，不会和实际版本对不上）

## 推完之后怎么验证

别等成员踩了才发现问题。在一个空目录里模拟成员从零装一次：

```bash
mkdir pi-check && cd pi-check
pi install -l --approve "git:github.com/kurumi1ksllq/pi-workflow@v1.1.2"
pi list --approve
```

`pi list` 的 Project packages 里能看到这个包，就说明远程源、ref、包结构三样都对。
验证完删掉 `pi-check` 即可。

## 目录

| 路径 | 内容 |
| --- | --- |
| `skills/` | 按需加载的能力包。`00-core/` 全员共享，其余按角色分目录 |
| `prompts/` | 斜杠命令，`review.md` → `/review` |
| `extensions/` | `team-baseline.ts` —— 引导扩展，把规范注入上下文、把 MCP 基线补进项目 |
| `team/` | 扩展的数据源：`RULES.md`（规范）+ `mcp.template.json`（MCP 基线）+ `packages.json`（第三方包清单） |
| `docs/` | 怎么写各类资源。**说明文档一律放这里，别放 skills/** |

## 扩展做了什么（成员不用管，但该知道）

`team-baseline` 扩展在每次会话做两件事：

1. **把 `team/RULES.md` 注入系统提示** —— pi 原生不加载包内的 AGENTS.md，这是绕过办法
2. **项目缺 `.mcp.json` 时从包里补一份** —— 绝不覆盖已有的

所以改团队规范 = 改 `team/RULES.md` 然后发新版；改 MCP 基线 = 填 `team/mcp.template.json`。

在 pi 里敲 `/team-baseline` 可以看到当前基线来自哪个版本、哪些生效了。

## 边界

- 这里只放**团队共识**。个人试验装在自己全局（`~/.pi/agent/settings.json`）或用 `pi -e` 临时跑，验证过再迁进来
- 项目专属的约定不写这，写各项目仓库根的 `AGENTS.md` —— pi 启动时自动拼接加载
- 谁都不该在 `.pi/settings.json` 里手写源，统一用 `pi install -l`，避免路径和 ref 写法不一致
