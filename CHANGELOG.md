# 变更记录

## v1.7.0
- 团队包现在同步**三类东西**，不再只有第三方包清单：
  - **扩展清单**（`team/packages.json`）：补齐到 8 个第三方包 + ponytail，全部钉版本/commit
  - **共享设置**（`team/agent-settings.json`）：`subagents` 的模型路由（reviewer / researcher / oracle）
    与 `compaction` 参数，由扩展**只补缺**地并进全局 `settings.json` —— 成员自己设过的键一个都不动
  - **扩展自己的配置**（`team/extensions/<扩展名>.json`）：补到 `<agent dir>/extensions/<扩展名>/config.json`，
    目标已存在就完全不动（`pi-rtk-optimizer` 那份默认配置随包分发）
- 团队规范补两节：**语言**（一律中文回答）与**子代理自动委派**（scout / reviewer / researcher / oracle 的触发条件）
- 离线测扩到七个场景：新增「共享设置只补缺」「扩展配置只补不覆盖」「模板 `_` 说明键不泄漏」
- `simulate-member.sh` 判据改准（改查 list 路径、settings 里的 subagents/compaction、扩展配置落点），
  并支持传分支名 —— 发版前可以先验 `main`

## v1.6.7
- 文档：发版流程那段的版本号说明改准（版本标识优先读设置里钉的 ref，不是 `git describe`）

## v1.6.6
- 加 `scripts/test-extension.mjs`：离线测扩展逻辑（钉版本替换、追加、不动私有条目 + 幂等、
  版本标识优先设置里的 ref），不用启动 pi / 不用 provider / 不碰本机 `~/.pi/agent`
- 发版脚本连 README 里 `simulate-member.sh vX.Y.Z` 的版本号一起改写（之前漏了这处，已经漂了一次）
- README / docs 补「先跑离线测、再跑全链路」

## v1.6.5
- 修**版本标识**：注入段里的版本号改成优先读 pi 设置里钉的 ref（`git:...#@vX.Y.Z`），
  `git describe` 降为备选。原因：pi 升级已存在的 clone 时只 `git fetch origin <ref>`、
  **不建本地 tag**（实测 `installGit`），升级过基线的成员 clone 里的 tag 是旧的，
  describe 会给出 `v1.4.4-8-g8c8c540` 这种误导值 ——「不知道队友跑的是哪一版」的老问题换个形式回来了
- 离线 mock 加场景验证：设置里写 `@v9.9.9` 时注入段必须显示 v9.9.9（仓库 tag 仍是 v1.6.4）

## v1.6.4
- **第三方包清单一律钉版本号**（`npm:pi-context-view@0.6.0` / `npm:pi-rtk-optimizer@0.9.0`）
  —— 不带版本的条目在 pi 眼里不是 pinned，启动会弹「Package Updates Available」，
  各人升到不同版本就不是同一套了
- 扩展同步清单时多一条规则：清单里是钉版本的、成员设置里是同一个包但不带版本 → **替换成钉版本那条**
  （升级路径；别的条目一律不动）。离线 mock 测过：替换 / 追加 / 不动私有条目 / 幂等 四条都通过
- ONBOARDING 加「看到 Package Updates Available 怎么办」：别跑 `pi update --extensions`，
  升级基线拿钉版本的清单
- README / docs/extensions.md 同步说明钉版本的理由

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
