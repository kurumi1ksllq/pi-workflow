# pi-workflow

团队 pi 基线。装一次，所有人拿到同一套 skills、prompts、extensions。

## 成员怎么用（三步）

1. 装 pi（已装跳过）
2. 在项目根目录执行，把 `<org>` 换成实际组织名：

   ```bash
   pi install -l git:github.com/<org>/pi-workflow@v1.0.0
   ```

   `-l` = 写进项目设置 `.pi/settings.json`（不是你的个人全局设置）

3. 提交 `.pi/settings.json`，并在项目 `.gitignore` 里加上：

   ```
   .pi/git/
   .pi/npm/
   ```

之后新成员 clone 项目 → 启动 pi → 弹出信任提示点同意 → **缺失的包自动装齐**，不用手动跑任何命令。

> 首次启动会问"是否信任这个项目"。拒绝的话 `.pi/settings.json` 不加载、包不会装。
> 这不是 bug，是 pi 的安全闸 —— 项目级扩展会在你机器上执行代码。

## 发版流程（维护者）

1. 改完 skill / prompt / extension，本地验证
2. 打 tag 并发出去：

   ```bash
   git add -A && git commit -m "add xxx skill"
   git tag v1.1.0
   git push && git push --tags
   ```

3. 更新各项目的 `.pi/settings.json`：把 `@v1.0.0` 改成 `@v1.1.0`
4. 通知成员 pull

`@v1.1.0` 这种带 ref 的写法是**钉死的** —— `pi update` 不会偷偷把成员的版本挪走，
只会在成员 pull 到新 ref 后把本地 clone 对齐过去。想回滚就改回旧 tag。

## 目录

| 路径 | 内容 |
| --- | --- |
| `skills/` | 按需加载的能力包，pi 靠 description 判断何时加载 |
| `prompts/` | 斜杠命令，`review.md` → `/review` |
| `extensions/` | TypeScript 扩展，有完整系统权限，必须 review |

## 边界

- 这里只放**团队共识**。个人试验装在自己全局（`~/.pi/agent/settings.json`）或用 `pi -e` 临时跑，验证过再迁进来
- 项目专属的约定不写这，写各项目仓库根的 `AGENTS.md` —— pi 启动时自动拼接加载
- 谁都不该在 `.pi/settings.json` 里手写源，统一用 `pi install -l`，避免路径和 ref 写法不一致
