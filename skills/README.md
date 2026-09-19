# skills/

pi 会自动发现这个目录下所有含 `SKILL.md` 的文件夹，以及顶层散落的 `.md`。
不用注册，push 上去同事 pull 完就有了。

## 加一个新 skill

新建 `skills/<名字>/SKILL.md`，照抄 `_template/SKILL.md`。

要点：
- frontmatter 的 `description` 第一句必须是 `Use when <触发条件>`，pi 靠它判断什么时候加载
- 正文写步骤，不要写背景介绍
- 一个 skill 只干一件事
