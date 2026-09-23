/**
 * context-thrift — 削减 pi 会话里被反复重发、且每次调用都要重发的上下文。
 *
 * 问题(实测):pi 每次调用 LLM 都把整段历史 + 固定税重新序列化。821 次调用的真实会话
 * 归因(`analyze-01a0c3b2.py`,对账偏差 +0.0%)里两大块与本扩展相关:
 *
 *   - 历史 assistant 的 `thinking` 块(CoT + 签名)占 29.3% —— OpenAI 兼容上游入参根本不用它,纯死重
 *   - 固定税(系统提示 + 16 个工具定义)占 16.5%,与轮数无关:单次就 60,591 字符 ≈ 15,148 token
 *
 * 做法:
 *   1. 阶段一 — 在 `context` 事件剥掉历史 assistant 的 thinking 块
 *   2. 阶段二 — 在 `context_with_system` 事件按需裁剪工具声明(§toolPruning)
 *   3. 阶段二 — 历史工具输出降级为占位符(§toolOutputStub,默认关,见下)
 *
 * 为什么 keepRecent 默认 0(全量剥离 thinking):
 *   任何「保留最近 N 条」的滑动边界都会让前缀每轮变一次 —— 刚被保留的那条下轮就被剥掉,
 *   前缀从该点起变化 → 打掉 prompt cache。全量剥离是幂等确定性变换:同一段历史每轮剥离
 *   结果字节一致 → 缓存前缀稳定。实测(fork 727 轮会话,同档位):cacheRead 63,872 →
 *   42,752(-33%),且未缓存 input 未上升(232 → 196)。同一理由,`toolOutputStub` 默认关。
 *
 * 为什么工具裁剪默认关(R4):
 *   裁错工具会让 agent 直接失去能力(把 `edit` 裁掉它就只会读不会写),这类故障用户很难
 *   自己定位。先以 `enabled: false` 交付,由使用者逐步开启。
 *
 * 为什么改工具声明必须挂 `context_with_system`(2026-09-23 探针实测):
 *   `context` handler 看不到 system 消息(runner 用 `filter(m => m.role !== "system")` 剥掉);
 *   `context_with_system` 的返回值则**直接发出**。工具声明的真源是 `messages[0].toolsAdded`
 *   (结构化数组),payload 的 `tools[]` 就是它渲染出来的。实测:把 toolsAdded 从 16 项改成 6 项,
 *   payload 的 tools 从 37,799 字节降到 22,825 字节(剩下的 22,825 里 18,022 就是 `subagent` 一个)。
 *   提示词里的 <tools> 列表同步不了(见 pruneTools 注释),这是已知缺口。
 *
 * 只对 OpenAI 兼容系生效:Anthropic 系要求回传 thinking 签名,剥了会报错。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const EXT = "context-thrift";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const CONFIG_PATH = join(AGENT_DIR, "extensions", EXT, "config.json");
const STATS_PATH = join(AGENT_DIR, "extensions", EXT, "stats.jsonl");

/** 占位符前缀。带标记是为了让第二次调用一定能识别出「已经降级过」→ 保证幂等。 */
const STUB_MARK = "[context-thrift: 已省略";

export type ToolPruningConfig = {
  /** 默认关。R4:裁错工具会让 agent 静默失去能力。 */
  enabled: boolean;
  /** 保留的工具总数上限(含 keep 与最近用过的)。 */
  maxTools: number;
  /** 必须保留的工具名。名单里当天不存在的名字直接忽略,不报错。 */
  keep: string[];
};

export type ToolOutputStubConfig = {
  /** 默认关 —— 滑动边界会打掉 prompt cache,实测确认收益 > 缓存损失后再开。 */
  enabled: boolean;
  /** 保留最近 N 条工具结果原样。滑动边界,见文件头「为什么 keepRecent 默认 0」。 */
  keepRecentResults: number;
  /** 触发降级的字符阈值(低于它不动)。 */
  minChars: number;
};

export type ThriftConfig = {
  /** 总开关。false = 一条都不改。只在 thriftMessages 这一个出口判。 */
  enabled: boolean;
  /** 保留最近 N 条 assistant 的思考。0 = 全量剥离(缓存最友好,推荐)。 */
  keepRecent: number;
  /** @deprecated 用 toolOutputStub。行为不变,保留兼容。 */
  stubToolResults: boolean;
  /** @deprecated 用 toolOutputStub.minChars。仅配合 stubToolResults。 */
  stubMinChars: number;
  toolPruning: ToolPruningConfig;
  toolOutputStub: ToolOutputStubConfig;
  /** 是否把每次调用的削减量写进 stats.jsonl。 */
  logStats: boolean;
};

const DEFAULT_KEEP_TOOLS = ["bash", "read", "edit", "write", "grep", "ls", "todo", "subagent"];

const DEFAULTS: ThriftConfig = {
  enabled: true,
  keepRecent: 0,
  stubToolResults: false,
  stubMinChars: 20000,
  toolPruning: { enabled: false, maxTools: 12, keep: [...DEFAULT_KEEP_TOOLS] },
  toolOutputStub: { enabled: false, keepRecentResults: 2, minChars: 2000 },
  logStats: false,
};

/** 只对这些 api 改写。Anthropic/Bedrock 系要求回传签名,不能碰。 */
const STRIPPABLE_APIS = new Set([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-responses-lazy",
]);

/** 逐键类型校验,只吃认识且类型对得上的键 —— 用户配置里多写/写错键都不该让扩展崩掉。 */
function mergeKnown<T extends Record<string, unknown>>(base: T, raw: unknown): T {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const out = { ...base } as Record<string, unknown>;
  for (const k of Object.keys(base)) {
    const v = (raw as Record<string, unknown>)[k];
    if (v === undefined) continue;
    const want = base[k];
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      out[k] = mergeKnown(want as Record<string, unknown>, v);
    } else if (typeof v === typeof want) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadConfig(): ThriftConfig {
  let cfg: ThriftConfig = {
    ...DEFAULTS,
    toolPruning: { ...DEFAULTS.toolPruning, keep: [...DEFAULTS.toolPruning.keep] },
    toolOutputStub: { ...DEFAULTS.toolOutputStub },
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      cfg = mergeKnown(cfg, JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
      // 只留非空字符串,免得配置里塞进 null/数字把裁剪逻辑带偏
      cfg.toolPruning.keep = cfg.toolPruning.keep.filter((n) => typeof n === "string" && n.length > 0);
      cfg.toolPruning.maxTools = Math.max(1, Math.floor(cfg.toolPruning.maxTools));
      cfg.toolOutputStub.keepRecentResults = Math.max(0, Math.floor(cfg.toolOutputStub.keepRecentResults));
      cfg.toolOutputStub.minChars = Math.max(0, Math.floor(cfg.toolOutputStub.minChars));
    } catch {
      /* 配置坏掉时用默认值,不抛 —— 别让扩展把会话搞崩 */
    }
  }
  // 环境变量逃生门:PI_CONTEXT_THRIFT_ENABLED=0 关掉
  const env = process.env.PI_CONTEXT_THRIFT_ENABLED;
  if (env === "0" || env === "false") cfg.enabled = false;
  if (env === "1" || env === "true") cfg.enabled = true;
  return cfg;
}

/** 纯函数:剥掉历史 assistant 的 thinking 块。离线可测。 */
export function stripThinking(
  messages: any[],
  keepRecent: number,
): { messages: any[]; thinkChars: number; sigChars: number; touched: number; keptChars: number } {
  const assistantIdx = messages
    .map((m: any, i: number) => (m?.role === "assistant" && Array.isArray(m.content) ? i : -1))
    .filter((i: number) => i >= 0);
  const keepFrom = Math.max(0, assistantIdx.length - Math.max(0, keepRecent));
  let thinkChars = 0;
  /** 签名一起剥掉,但它通常内嵌同一份正文(见 README「口径」),所以不能和 thinkChars 相加 */
  let sigChars = 0;
  let touched = 0;
  let keptChars = 0;

  for (let a = 0; a < assistantIdx.length; a++) {
    const m = messages[assistantIdx[a]];
    if (a >= keepFrom) {
      for (const b of m.content) {
        if (b?.type === "thinking") keptChars += (b.thinking ?? "").length;
      }
      continue;
    }
    const before = m.content.length;
    m.content = m.content.filter((b: any) => {
      if (b?.type !== "thinking") return true;
      thinkChars += (b.thinking ?? "").length;
      sigChars += (b.thinkingSignature ?? "").length;
      return false;
    });
    if (m.content.length !== before) touched++;
  }
  return { messages, thinkChars, sigChars, touched, keptChars };
}

/** 工具结果里 text 段的总字符数(非 text 段不计入 stash)。 */
function textLen(m: any): number {
  if (!Array.isArray(m?.content)) return 0;
  return m.content.reduce((a: number, b: any) => a + (b?.type === "text" ? (b.text ?? "").length : 0), 0);
}

/** 把一条工具结果的所有 text 段替换成占位符。返回省下的字符数。 */
function replaceWithStub(m: any): number {
  let n = 0;
  for (const b of m.content) {
    if (b?.type !== "text") continue;
    const len = (b.text ?? "").length;
    n += len;
    b.text = `${STUB_MARK} ${len} 字符的工具输出(完整内容在会话 .jsonl 里);需要时重新执行该工具]`;
  }
  return n;
}

/** @deprecated 用 stubHistoricalToolOutputs。行为不变,保留兼容(R6)。 */
export function stubToolOutputs(messages: any[], minChars: number): { stubChars: number; touched: number } {
  let stubChars = 0;
  let touched = 0;
  for (const m of messages) {
    if (m?.role !== "toolResult") continue;
    if (textLen(m) < minChars) continue;
    stubChars += replaceWithStub(m);
    touched++;
  }
  return { stubChars, touched };
}

/**
 * 纯函数:只降级**历史**工具输出,最近 keepRecentResults 条原样保留。
 *
 * 幂等性:已被降级的条目带有 STUB_MARK,第二次调用直接跳过 —— 否则 minChars 调小时
 * 会把占位符本身再降级一次,前缀就每轮都变。
 */
export function stubHistoricalToolOutputs(
  messages: any[],
  keepRecentResults: number,
  minChars: number,
): { stubChars: number; touched: number } {
  const idx: number[] = [];
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "toolResult") idx.push(i);
  const keepFrom = Math.max(0, idx.length - Math.max(0, keepRecentResults));
  let stubChars = 0;
  let touched = 0;
  for (let a = 0; a < keepFrom; a++) {
    const m = messages[idx[a]];
    if (!Array.isArray(m.content)) continue;
    if (m.content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith(STUB_MARK))) continue;
    if (textLen(m) < minChars) continue;
    stubChars += replaceWithStub(m);
    touched++;
  }
  return { stubChars, touched };
}

/** 从 transcript 里收集「实际用过」的工具名,最近用过的排前面。 */
export function collectUsedTools(messages: any[]): string[] {
  const seen: string[] = [];
  const add = (n: unknown) => {
    if (typeof n !== "string" || !n) return;
    const at = seen.indexOf(n);
    if (at >= 0) seen.splice(at, 1);
    seen.push(n);
  };
  for (const m of messages) {
    if (m?.role === "toolResult") add(m.toolName);
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) if (b?.type === "toolCall") add(b.name);
  }
  return seen.reverse();
}

/**
 * 纯函数:决定保留哪些工具声明。
 * 优先级 keep 名单 → 最近用过,再按原声明顺序输出、截到 maxTools。
 * keep 里当天不存在的工具名直接忽略;未知工具名不因为「不在 keep 里」被无条件裁掉。
 */
export function planToolPruning(
  declared: string[],
  keep: string[],
  usedNames: string[],
  maxTools: number,
): { kept: string[]; dropped: string[] } {
  const wanted = new Set(keep.filter((n) => declared.includes(n)));
  const usedOrder = usedNames.filter((n) => declared.includes(n));
  const cap = Math.max(1, Math.floor(maxTools));
  const kept: string[] = [];
  const take = (n: string) => {
    if (kept.length >= cap || kept.includes(n)) return;
    kept.push(n);
  };
  for (const n of declared) if (wanted.has(n)) take(n);
  for (const n of usedOrder) take(n);
  if (kept.length === declared.length) return { kept: declared, dropped: [] };
  const dropped = declared.filter((n) => !kept.includes(n));
  return { kept: declared.filter((n) => kept.includes(n)), dropped };
}

/**
 * 裁剪 `messages[0]` 的工具声明。任何形状不符(不是 system / toolsAdded 非数组 / content 不是字符串)
 * 都原样放行 —— R3。
 *
 * 已知缺口(2026-09-23 探针实测,不是推测):提示词里的 <tools> 列表**同步不了**。
 * 探针把 `messages[0].sections.tools` 换成 "REPLACED"(赋值成功,descriptor 是可写的普通属性),
 * 但发出去的 payload 里 system 文本仍旧 23,359 字符、列着 14 个工具 —— 因为 payload 的
 * `messages[0]` 连 `sections` 字段都没有,pi 是从自己的 AgentSession 状态重新渲染提示词的,
 * 这个拼接出来的 transcript 改不动它。所以被裁掉的工具在提示词里仍然写着 ——
 * 模型可能以为自己还能调(toolPruning 默认关,也正因此)。
 *
 * 真要同步提示词得走 `before_agent_start` 的 `systemPromptOptions.selectedTools`(另一个事件,
 * 拿不到历史 transcript),不在本阶段范围内;所以这里不留死代码。
 */
export function pruneTools(
  messages: any[],
  cfg: ToolPruningConfig,
  usedNames: string[],
): { kept: string[]; dropped: string[]; droppedChars: number; touched: boolean } {
  const empty = { kept: [] as string[], dropped: [] as string[], droppedChars: 0, touched: false };
  const m0 = messages?.[0];
  if (!m0 || m0.role !== "system") return empty;
  if (!Array.isArray(m0.toolsAdded) || m0.toolsAdded.length === 0) return empty;
  if (typeof m0.content !== "string") return empty; // §5.3:不是 pi 认得的形状,不猜

  const declared = m0.toolsAdded.map((t: any) => t?.name).filter((n: any) => typeof n === "string");
  if (declared.length !== m0.toolsAdded.length) return empty; // 有名字不是字符串,整体不碰
  const { kept, dropped } = planToolPruning(declared, cfg.keep, usedNames, cfg.maxTools);
  if (dropped.length === 0) return empty;

  const droppedSet = new Set(dropped);
  let droppedChars = 0;
  m0.toolsAdded = m0.toolsAdded.filter((t: any) => {
    if (!droppedSet.has(t.name)) return true;
    droppedChars += JSON.stringify(t).length;
    return false;
  });
  return { kept, dropped, droppedChars, touched: true };
}

/**
 * 唯一出口:所有对 messages 的改写都从这里走。
 * 总开关只在这里判一次 —— 每个 handler 各判一次,漏一个就是「关了还在改」(§2.3)。
 * 返回 undefined 表示「没有任何改动」,调用方就不该返回新数组。
 */
export function thriftMessages(
  messages: any[],
  cfg: ThriftConfig,
  api?: string,
): { messages: any[]; stats: Record<string, number | string[]> } | undefined {
  if (!cfg.enabled) return undefined;
  if (!Array.isArray(messages)) return undefined;
  if (api && !STRIPPABLE_APIS.has(api)) return undefined;

  const s = stripThinking(messages, cfg.keepRecent);
  // 签名内嵌同一份正文,只算一次:取两者较大值(实测与 payload 字节减少量吻合,误差 <3%)
  const thinkChars = Math.max(s.thinkChars, s.sigChars);

  let legacyChars = 0;
  if (cfg.stubToolResults) legacyChars = stubToolOutputs(messages, cfg.stubMinChars).stubChars;

  let histChars = 0;
  let histTouched = 0;
  if (cfg.toolOutputStub.enabled) {
    const r = stubHistoricalToolOutputs(messages, cfg.toolOutputStub.keepRecentResults, cfg.toolOutputStub.minChars);
    histChars = r.stubChars;
    histTouched = r.touched;
  }

  let prune = { kept: [] as string[], dropped: [] as string[], droppedChars: 0, touched: false };
  if (cfg.toolPruning.enabled) prune = pruneTools(messages, cfg.toolPruning, collectUsedTools(messages));

  const savedChars = thinkChars + legacyChars + histChars + prune.droppedChars;
  if (savedChars <= 0) return undefined;
  return {
    messages,
    stats: {
      assistantTouched: s.touched,
      thinkChars: s.thinkChars,
      sigChars: s.sigChars,
      stubChars: legacyChars + histChars,
      histTouched,
      prunedDropped: prune.dropped,
      prunedKept: prune.kept,
      savedChars,
    },
  };
}

export default function (pi: any) {
  const CONFIG = loadConfig();
  let lastSaved = 0;
  let lastCalls = 0;

  const note = (o: Record<string, unknown>) => {
    if (!CONFIG.logStats) return;
    try {
      mkdirSync(dirname(STATS_PATH), { recursive: true });
      appendFileSync(STATS_PATH, JSON.stringify({ ts: new Date().toISOString(), ...o }) + "\n");
    } catch {
      /* 写不进去就算了,不影响主流程 */
    }
  };

  // 唯一改写点。两个事件都只是「取 messages → 交给 thriftMessages → 放行」,不自己判开关。
  const run = (messages: any[], api?: string) => {
    try {
      const out = thriftMessages(messages, CONFIG, api);
      if (!out) return undefined;
      const saved = Math.round(Number(out.stats.savedChars) / 4);
      if (saved > 0) {
        lastSaved = saved;
        lastCalls++;
      }
      note({ messages: messages.length, savedTokensEst: saved, ...out.stats });
      return { messages: out.messages };
    } catch {
      return undefined; // R3:改写失败必须让请求照常发出
    }
  };

  pi.on("context", async (event: any, ctx: any) => run(event?.messages, ctx?.model?.api));

  // 工具声明只在 context_with_system 这一层可改:该层能看到 system 消息,返回值直接发出(实测)
  pi.on("context_with_system", async (event: any, ctx: any) => run(event?.messages, ctx?.model?.api));

  // 启动时把开关状态打到 stderr —— "没报错"不等于"加载了"
  pi.on("session_start", async (_e: any, ctx: any) => {
    const state = CONFIG.enabled ? "on" : "off";
    try {
      process.stderr.write(
        `[${EXT}] ${state} keepRecent=${CONFIG.keepRecent} stub=${CONFIG.stubToolResults} ` +
          `prune=${CONFIG.toolPruning.enabled ? `on(max=${CONFIG.toolPruning.maxTools})` : "off"} ` +
          `histStub=${CONFIG.toolOutputStub.enabled ? `on(keep=${CONFIG.toolOutputStub.keepRecentResults})` : "off"}\n`,
      );
    } catch {
      /* ignore */
    }
    try {
      ctx?.ui?.setStatus?.(EXT, CONFIG.enabled ? `thrift${lastSaved ? ` ↓${lastSaved}` : ""}` : "thrift off");
    } catch {
      /* print / json 模式没有 UI */
    }
  });

  pi.registerCommand?.("thrift", {
    description: "context-thrift:显示剥离统计与开关状态",
    handler: async (ctx: any, args?: string) => {
      const say = (m: string) => {
        try {
          ctx?.ui?.notify?.(m, "info");
        } catch {
          process.stdout.write(m + "\n");
        }
      };
      if (args?.trim() === "stats") {
        say(
          `context-thrift:本次运行改写 ${lastCalls} 次调用,最近一次省约 ${lastSaved} tokens;` +
            `配置 ${CONFIG_PATH}`,
        );
        return;
      }
      say(
        CONFIG.enabled
          ? `context-thrift 已启用(keepRecent=${CONFIG.keepRecent}, stubToolResults=${CONFIG.stubToolResults}, ` +
              `toolPruning=${CONFIG.toolPruning.enabled}, toolOutputStub=${CONFIG.toolOutputStub.enabled});` +
              `改配置改 ${CONFIG_PATH} 后重启 pi 生效`
          : `context-thrift 已禁用;配置文件 ${CONFIG_PATH}`,
      );
    },
  });
}
