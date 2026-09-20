---
name: commit-convention
description: 'Use when 写 git commit message 或整理提交记录。团队统一的提交信息格式。'
---

# 提交信息规范

## 格式

```
<类型>(<范围>): <做了什么>

<为什么，不是怎么做的>
```

类型只用这几个：`feat` `fix` `refactor` `perf` `docs` `test` `chore` `build`。

## 规则

- 标题不超过 50 字符，结尾不加句号
- 标题写"做了什么"，正文写"为什么"——怎么做的看 diff 就够了
- 一次提交只做一件事。顺手改的别塞进来，另开一个提交
- 破坏了对外接口，正文里写 `BREAKING CHANGE:` 开头的一段

## 例

```
fix(auth): token 过期后没有触发刷新

刷新逻辑只在 401 响应时走，但网关对过期 token 返回 403，
导致用户被静默登出。改成 401 和 403 都触发刷新。
```
