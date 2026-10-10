# prompts：怎么写

放 `.md` 文件，文件名就是命令名。`prompts/review.md` → 在 pi 里敲 `/review` 展开，
`prompts/init.md` → `/init`。

适合放团队反复用的固定问法：code review、进新/老项目都重新通读并补齐整套文档、写 commit、起分支、排查某类 bug。

两个团队命令：

- `/review` —— 审查当前 diff
- `/init` —— 通读项目，按「项目文档」标准（见注入的团队规范）读取旧文档、合并、补齐并升版整套文档：
  `README.md` / `CHANGELOG.md` / `AGENTS.md` + `docs/` 下的设计/工程/状态/接口/运维。
  **不是初始化，也不覆盖重写** —— 已有文档一律逐条合并升版。

跟 skill 的区别：prompt 是你主动敲的，skill 是 pi 自己判断该用才加载的。
