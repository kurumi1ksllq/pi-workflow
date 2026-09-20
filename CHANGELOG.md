# 变更记录

## v1.6.3
- 修 `scripts/simulate-member.sh`：原本少了一次启动，`pi list` 只能看到包名、没有安装路径
  （pi 装缺失的包发生在**启动**时，不是 `pi list` 时）。判据改成「三项 packages 都带路径 +
  隔离目录 `npm/node_modules` 里确实有那两个包」
- README 的验证判据同步改准

## v1.6.2
- README 重写过期流程：改成**全员全局装**（不带 `-l`）、第三方包清单落全局设置、发版走脚本
- `scripts/release.sh` 顺手对齐 README / ONBOARDING 里的版本号，这两份文档不用再手工改版本
- 加 `scripts/simulate-member.sh`：在隔离目录里模拟新成员从零装，一条命令验完三条链路
- ONBOARDING 补「v1.5.x → v1.6.x 升级顺序」（先 `pi remove npm:pi-rtk-optimizer` 再升级）
- CHANGELOG 补齐 v1.3.7 起的空缺（v1.3.7 ~ v1.6.1）

## v1.6.1
- rtk 优先补到 **npm 全局 bin 目录** —— Windows 上 `~/.local/bin` 默认不在 PATH，补了也找不到（实测）
- rtk 相关提示文案不再写死路径

## v1.6.0
- 扩展自动补 rtk 二进制（`pi-rtk-optimizer` 的依赖），清单加回该扩展

## v1.5.2
- 清单暂时去掉 `pi-rtk-optimizer` —— 它需要独立的 rtk 二进制，成员装上会一直刷警告

## v1.5.1
- 第一次装基线时明确提示「再启动一次 pi」，说明为什么（pi 的包安装发生在扩展加载之前）

## v1.5.0
- **行为变更**：团队全员**全局装**，清单从项目 `.pi/settings.json` 改到全局 `~/.pi/agent/settings.json`
- ONBOARDING 改全局流程

## v1.4.4
- onboarding 补「提交自动补上的包」步骤（v1.5.0 起不再需要）

## v1.4.3
- 团队包清单加入 `pi-context-view` / `pi-rtk-optimizer`

## v1.4.2
- 整合包清单机制：包统一走 `team/packages.json`，项目模板只留设置项

## v1.4.1
- 文档说明团队第三方包清单机制

## v1.4.0
- 团队包清单自动同步到各项目

## v1.3.7
- onboarding 改用启动资源列表验收

## v1.3.6
- 加 `team-baseline-feedback` skill：教 pi 判断基线问题该上报还是本地改，**不自动提 issue**
- 加 `scripts/release.sh`：发版时自动同步 `package.json` 的 version（根治版本号不一致）
- `package.json` version 补到与 tag 一致


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
