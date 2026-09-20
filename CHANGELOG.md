# 变更记录

## v1.3.1
- 文档补「成员如何更新基线」：实测 pi 不会自动更新已装的包

## v1.3.0
- 版本标识改读 git tag（不再依赖手工同步 `package.json` 的 version）


## v1.2.1
- 哨兵模板去掉部署说明（那段会进上下文白占 token）

## v1.2.0
- 不静默失效：自检报警（stderr）+ 注入段版本标识 + 项目侧哨兵模板
- `package.json` 版本号与 tag 对齐

## v1.1.3
- MCP 同步改挂 `before_agent_start`（`session_start` 在 print 模式不触发）

## v1.1.2
- 补全 extensions 说明：RULES.md 机制、自证开关、失效场景

## v1.1.0
- 引入 `team-baseline` 引导扩展：注入团队规范 + 同步 MCP 基线

## v1.0.0
- 初始版本：3 个分层 skill + `/review` prompt
