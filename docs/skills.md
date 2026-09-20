# skills：怎么写

pi 的加载规则（`loadSkillsFromDir` 的官方语义）：

- 目录里有 `SKILL.md` → 当成一个 skill，**不再往里递归**
- 否则 → 把该目录下的直接 `.md` 子文件当 skill 加载
- 递归子目录去找 `SKILL.md`

所以 **`skills/` 下只放真 skill**。教程、模板、README 一律放 `docs/`，
否则会被当成 skill 塞进每个人的系统提示。

## 加一个新 skill

新建 `skills/<分组>/<技能名>/SKILL.md`，照下面的模板写。

```markdown
---
name: your-skill-name
description: 'Use when <什么情况下该用>. <一句话说明它做什么>.'
---

# <技能名>

## 什么时候用

<具体到能判断的触发条件>

## 步骤

1. <一步一个动作>
2. <一步一个动作>

## 坑

- <踩过的具体问题>
```

要点：

- frontmatter 的 `description` 第一句必须是 `Use when <触发条件>`，pi 靠它判断何时加载
- 正文写步骤，不写背景介绍
- 一个 skill 只干一件事
- `disable-model-invocation: true` 能让它只作为 `/skill:<name>` 手动命令存在，不进上下文

## 分组

| 目录 | 给谁 |
| --- | --- |
| `00-core/` | 全员：写代码时都该遵守的东西 |
| `backend/` `frontend/` `data/` … | 对应角色，按需订阅 |

判断一个 skill 该放哪：**它影响别人的产出吗？** 影响就进 core，不影响就进角色目录。
