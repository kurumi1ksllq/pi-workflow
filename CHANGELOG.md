# 变更记录

## v1.13.0
- **`team/RULES.md` 安全红线新增一条：不要按进程名杀 node**。pi 自身就是 `node.exe`
  （npm shim 跑 `dist/bundle/cli.js`），所以 `Get-Process node | Stop-Process -Force`、
  `taskkill /IM node.exe /F` 会把**宿主 pi 一起杀掉** —— 无报错、无崩溃记录、TUI 定格、进程静默消失，
  看起来就像「pi 突然没了」，和 pi-lens 的 ENOSYS（会写 `crashes.json`、会打
  `pi exiting due to uncaughtException`）完全是两条路，容易误诊。起因是成员机器上 agent 自己写出的
  「先杀干净再跑」回归扫描命令把自己带走了。清理残留子进程改按命令行特征过滤
  （`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*特征*' }`）。
- **`scripts/test-extension.mjs` 加一条断言**：注入段必须包含这条红线，被误删时测试变红。
  负向验证过（抽掉该句 → 测试 exit 1；还原 → 全绿）。

## v1.12.0
- **修一个会静默烧光免费档的默认值坑（`defaultModel` 写成了 `provider/id` 形式）**。
  现象：全团队默认会话实际跑在 `tier-free` 上，一天把 2 个账户的免费额度（每账户每天 **100 次请求**）打满，
  上游报 `You've used all 100 free Ling 3.0 Flash Sante requests for today`。
  根因：pi 的 `defaultModel` **只认裸模型 id**（配 `defaultProvider` 消歧）。写成 `newapi/tier-std` 时
  解析不到、**不报错**，直接静默回退到 `models.json` 里**列表的第一个**档位 —— 而模板把
  `tier-free` 放在了首位。这个错误不会自己暴露，只会表现为「额度莫名其妙没了」。
- **`team/models.template.json` 的档位顺序反了回来：`tier-std` 打头、`tier-free` 挪到末尾**。
  顺序本身就是语义（见上一条），文件里的 `_档位顺序（别改）` 说明键写清了原因。
- **新增一次性迁移 `migrateBrokenDefaultModel()`**：把本机 `<defaultProvider>/<id>` 形式的前缀剥掉。
  判据收得很紧 —— **只有前缀正好等于该成员的 `defaultProvider` 时才改**；`defaultProvider` 缺失、
  或填的是别的 provider 前缀时一律不动（那两种情况判断不了他想要什么）。复用「重启 pi 生效」提示。
- **`team/agent-settings.json` 新增 `defaultProvider` / `defaultModel` 两个键**（裸 id）：
  新成员直接拿到正确的默认档；已有成员**只在缺这两个键时**被补上，自己设过的一律不动。
- **`healthCheck()` 多一条机械闸**：模板里任一 provider 的 `models` **首位是免费档**（id 含 `free`）
  就在启动时报警 —— 凭据红线那套「不靠记性」的同一思路。
- 测试：`scripts/test-extension.mjs` 加场景 11（前缀被剥掉 + 无关键不被碰 + 幂等 + 不属于 defaultProvider
  的前缀不许剥 + 成员自设 defaultProvider 不被覆盖 + 模板首位不是免费档 + 模板 defaultModel 是裸 id），11 个场景全绿。
- 实测（pi 0.87.0）：改前同一命令跑 `tier-free`，改后跑 `tier-std`；上游 429 复现与消失都已确认。

## v1.11.0
- **团队模型配置纳入同步（新数据源 `team/models.template.json` → 成员的 `~/.pi/agent/models.json`）**。
  为什么需要：`team/agent-settings.json` 里的 subagents 路由用的是**档位别名**（`tier-power` / `tier-max`），
  而别名只在成员的 `models.json` 里定义了对应 provider + 档位才解析得出来 —— 团队里只有维护者一个人配过网关，
  新成员装完基线派出去的 reviewer 会拿到一个解析不了的模型名。以前 `ONBOARDING.md` 只说「不走团队网关就删掉那几项」，
  走团队网关怎么配 `models.json` 没写，是个空白。
- **合并规则比 settings 更细：按 provider 合并，provider 内部按 model id 追加**。不能直接复用 `mergeMissing`
  ——（对象深合并里）数组是整体当一个值，于是「provider 已存在」等于整个 `models` 数组永不更新，
  团队以后往网关注册新档位，成员的配置永远补不上。现在的语义：provider 缺就整段补；
  provider 已在则只补它缺的字段（`baseUrl` / `api` / `apiKey`）；已有档位定义一律不动（成员可能自己调过上下文长度）；
  模板里有、他那儿没有的档位追加；成员自建的 provider / 档位一律不碰。
- **凭据红线机械化**：模板进的是**公开**仓库，`apiKey` 只允许环境变量引用（`$NEWAPI_API_KEY`）或命令。
  `healthCheck()` 里加了一条扫描 —— 模板出现明文 `apiKey` 会在启动时报警，不靠记性。
  成员侧自己导出 `NEWAPI_API_KEY`，或用 pi 的 `/login` 给 `newapi` 这个 provider 存一份 key（两条路实测都通）。
- **`_` 开头的说明键不进配置文件**：模板自己解释自己，写进成员文件的只有生效的键（和 `agent-settings.json` 同一条规矩）。
- 实测记录（隔离 `PI_CODING_AGENT_DIR`，pi 0.87.0）：
  - 扩展在加载时改写的 `models.json` **本次启动即生效**（负例验过：把 baseUrl 改成 `127.0.0.1:1`，
    同一次启动直接 `Connection error.`）—— 所以这一条不像包清单那样非要启动两次。
  - 全链路验过：新成员装完基线 → `subagents` 路由里的 `tier-power` 真解析到
    `newapi/tier-power`（子代理运行的 model 字段与子会话的 `model_change` 都是它），档位别名端到端可用。
  - **`defaultModel` 取裸模型 id**（`"tier-std"` + `"defaultProvider": "newapi"`）。写成
    `"newapi/tier-std"` 解析不到、**静默回退到列表里第一个模型**（不报错，最容易误认为生效）；
    `enabledModels` 同理只认裸 id / glob。扩展不碰这三个键 —— 默认用哪档是成员自己的选择。
- 测试：`scripts/test-extension.mjs` 加场景 10（10 项断言：只补缺、已有档位不动、追加缺档位、
  成员自建 provider 保留、说明键不泄漏、模板无明文 key、幂等、成员 models.json 坏掉时不许碰），10 个场景全绿。
  `scripts/simulate-member.sh` 第 6 步加 models.json 判据，且**不再把本机的 models.json 拷进隔离目录**
  （拷进去等于把现场做好，验不出这条链路）；改为放一份「成员自建 provider」当干扰项，顺手验只补缺。

## v1.10.0
- **subagents 模型路由改用网关档位别名**：`team/agent-settings.json` 里 `reviewer` / `researcher` / `oracle`
  的目标模型从真实模型名（`z-ai/glm-5.3-flash`、`gpt-5.6-sol`）改成档位别名（`tier-power`、`tier-max`）。
  原因：网关侧已把真实模型名从渠道 `models` 里移除（请求真实名现在返回 403/503），
  旧版模板给成员写进去的配置**是坏的**；同时档位别名让网关换后端模型时团队侧零改动。
- **新增一次性迁移 `migrateStaleModels()`**（`team-baseline` 扩展）：`mergeMissing` 是「只补缺」，
  永远不会改掉成员机器上已写入的旧真实模型名 —— 那些值正好在已知旧名表里才改写，成员自己填的模型一律不动。
  迁移幂等（第二次启动不再改动设置），随 `syncAgentSettings()` 一起跑，复用原有的「重启 pi 生效」提示。
- 文档同步：`ONBOARDING.md` 的「前提」段、`docs/extensions.md` 的共享设置示例改成档位别名。
- 测试：`scripts/test-extension.mjs` 加场景 9（旧真实名被迁移 + 成员自填模型不被碰 + 迁移幂等），9 个场景全绿。

## v1.9.0
- **自动更新：装一次就自动跟远端最新 tag**（维护者只管 `release.sh` 打 tag + push，成员零动作）。
  `team-baseline` 扩展每次启动（默认 1 小时最多查一次远端）比对远端最新 `vX.Y.Z` tag 与包目录的 HEAD，
  落后就 `git fetch` + `reset --hard` 到新 tag，并**同时改写 settings 里的 ref** —— 这一步不能省：
  实测带 ref 的源在 `pi update --extensions` 时会被 `git reset --hard <ref>` 拉回去，只更新 clone 不改 ref 等于白干
- **只敢动 pi 自己 clone 的包目录**：clone 必须在 `<agent dir>/git/` 下、settings 里有团队包条目、origin 指向本仓库；
  开发副本（维护者工作区）永远不碰。有未提交的跟踪文件改动时**拒绝动手**并说明原因；
  多实例并发用锁文件挡住（5 分钟自动过期）
- **钉分支/commit 时不跟 tag**（那是有意的固定，比如「发版前先验 main」）；`PI_BASELINE_SELF_UPDATE=off` 整体关掉；
  `PI_BASELINE_UPDATE_TTL_HOURS` 调查询间隔（`0` = 每次查）；网络/git 失败一律静默，不影响启动
- **更新在下次启动生效**（本会话用的还是旧版内容），终端给一行提示；`/team-baseline` 多一行「自动更新：…」，
  `PI_BASELINE_DEBUG` 的诊断文件也写 `selfUpdate=`
- **文档纠错**：以前写的「`pi update --extensions` 不会更新」只对钉 tag 成立 —— 实测带 ref 的源会被
  reconcile 回配置的 ref、不写 ref 的源会 `fetch --prune` + `reset --hard @{upstream}` 真前进
  （pi 0.86.1 源码 + 隔离 agent 目录实测）；pi 自己始终只提示、不自动应用
- 测试：新增 `scripts/test-self-update.mjs`（离线、秒级、不联网 —— 造本地 bare 仓库当远端、按 pi 目录约定搓 clone、
  直接 import clone 里的扩展）覆盖 5 个场景；`test-extension.mjs` 加场景 8（挑最新 tag 的版本比较，1.10.0 要赢过 1.9.9）；
  `simulate-member.sh` 加第 7 步（把 origin 换成带假 tag 的本地 bare 仓库 → 启动 → 断言自动切到新 tag、
  settings 的 ref 跟着改）
- README / ONBOARDING 的「成员如何更新基线」整节重写

## v1.8.0
- **新增审计日志扩展 `extensions/audit-log.ts`**：给每个会话留一份结构化流水 ——
  token（input / cacheRead / cacheWrite / output / reasoning）、工具调用（名字 / 参数预览 / 耗时 / 成败）、
  加载的 skill（`filePath` + 来源包与版本）、压缩点 `tokensBefore`、收敛标记 `agent_settled`。
  只落本机 `~/.pi/agent/audit/logs/<日期>.jsonl`，**不联网、对模型完全不可见**；
  出口唯一、异常全吞（只写 stderr 且每类一次）、只有 `appendFileSync` 级写，不阻塞 agent 循环
- **扩展带总开关**：`~/.pi/agent/extensions/audit-log/config.json` 里 `enabled:false` 立刻停止记录，
  不用卸包。配置优先读用户目录（包自己的 clone 会被 `pi update` 覆盖，改 clone 留不住）；
  模板 `team/extensions/audit-log.json` 由基线扩展首次启动补一份
- **敏感字段落盘前脱敏**：Authorization/Bearer、`sk-` 类前缀、`password=` 这类 kv、URL userinfo、长 opaque 串。
  不抄 toolResult / thinking 全文，只留字符数 + sha256 + `toolCallId`（回联 session jsonl 的 join 键）
- **新增报表脚本 `scripts/pi_audit_report.py`**：一条命令出 Markdown（按天 / 按模型 / 按人 token 分布、
  工具与失败率、skill 命中、收敛率、上下文压力、可选成本折算），末尾给只从统计里推的中文观察。
  纯标准库、离线、无匹配数据也退出码 0
- 文档：`docs/audit-log.md`（字段表 / 口径 / 已知缺口）、`docs/audit-report.md`（报表用法与口径）
- 测试：`scripts/test-audit-extension.mjs` 离线 mock 覆盖 9 组场景 —— 脱敏、100KB 参数截断、
  异常吞掉且每类只报一次、追加不覆盖、16/60 个 skill 时不爆 8192 且 `filePath` 不被切断、
  总开关与配置优先级。不用启动 pi、不用 provider
- 真机对账：审计侧与 session jsonl 的 `usage` 逐项 **0 差**（pi 0.86.1）

## v1.7.2
- **修发版脚本的误提交**：v1.7.1 用的 `git add -A` 把工作区里 pi 正在开发的
  `extensions/audit-log.ts`（534 行）和 `scripts/test-audit-extension.mjs`（275 行）一起提交推了出去。
  两份文件已移出仓库并加进 `.gitignore`（本地保留），`release.sh` 改成只 `git add -u`，
  遇到未跟踪文件列出警告、不提交（要发的新文件先手动 `git add`）
- 教训：**发版别用 `git add -A`** —— 工作区不等于本次改动，别人的半成品会一起出门；
  而且 `extensions/` 下的文件 pi 会直接加载，等于给全员装未 review 的代码

## v1.7.1
- 团队清单里的 ponytail 改钉**发布 tag** `v4.10.0`（原来钉的是它 main 上那个 release 提交；
  两者内容一致，bin 一样，但 tag 更好读、更好升级）
- ONBOARDING 补一句前提：共享设置里的 `subagents` 模型名指向团队网关，不走网关的人把那几项删掉/换掉
- `docs/audit-log-spec.md` 移出仓库并加进 `.gitignore`（给 pi 的本地需求书，不进公开仓库；本地文件保留）

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
