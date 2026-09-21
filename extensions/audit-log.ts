/**
 * audit-log —— pi 会话审计日志扩展（随团队包分发）
 *
 * 定位：审计日志 = 索引 + 指标；session jsonl 才是内容。
 * 只记 toolCallId / 字符数 / sha256，需要原文时用 toolCallId 回 session jsonl join。
 * 因此**不抄** toolResult 全文、thinking 全文、system prompt 全文。
 *
 * 三条硬约束（改这个文件别破）：
 *   1. 对模型完全不可见：不返回 systemPrompt、不改 tool input/result、不 sendMessage、不 registerTool
 *   2. 绝不抛异常出 handler：全部包 try/catch，异常写 stderr（每类只报一次，不刷屏）
 *   3. 绝不阻塞、绝不联网：只有 appendFileSync 级别的本地写
 *
 * 总开关：`<agent dir>/extensions/audit-log/config.json` 里写 `{"enabled": false}` 即整体关闭
 * （关闭后不写任何文件、不报错；团队包按约定把模板发到这个位置，成员改这里不会被包更新覆盖）。
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SCHEMA_VERSION = 1;
const MAX_LINE_BYTES = 8192;
const DEFAULT_MAX_FIELD_CHARS = 2000;
const PROMPT_PREVIEW_CHARS = 500;
const SKILL_DESC_CHARS = 200;

/** 这些键的值是我们自己算的摘要，不参与脱敏（否则 64 位 hex 会被兜底规则打成 <redacted>） */
const HASH_KEY_RE = /sha256$/i;

// —— 进程内状态（handler 之间共享）——
let seq = 0;
const ensuredDirs = new Set<string>();
const reportedErrors = new Set<string>();
const toolStarts = new Map<string, number>();
let sessionWritten = false;
let sessionStartReason: string | null = null;
let currentTurnIndex = 0;
let turnCalls = 0;
let turnErrors = 0;
let lastStopReason: string | null = null;
let runTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0 };
let pendingTruncated = false;
let cachedConfig: { enabled: boolean; maxFieldChars: number; recordFullPrompt: boolean } | null = null;

/** pi 版本：从运行中的入口往上找 package.json。找不到写 null，不猜。 */
const PI_VERSION = (() => {
	try {
		let dir = process.argv[1] ? path.dirname(process.argv[1]) : "";
		for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i++) {
			try {
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
				if (pkg?.name === "@earendil-works/pi-coding-agent") return typeof pkg.version === "string" ? pkg.version : null;
			} catch {
				/* 继续往上找 */
			}
			dir = path.dirname(dir);
		}
	} catch {
		/* 拿不到就 null */
	}
	return null;
})();

// —— 基础设施 ——

function reportOnce(key: string, err: unknown): void {
	if (reportedErrors.has(key)) return;
	reportedErrors.add(key);
	try {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`[audit-log] ${key}: ${msg}\n`);
	} catch {
		/* stderr 都写不了就算了 */
	}
}

/** 每个 handler 都过这里：异常一律吞掉，绝不中断 agent 循环 */
function guard(name: string, fn: (event: any, ctx: any) => void): (event: any, ctx: any) => void {
	return (event, ctx) => {
		try {
			fn(event ?? {}, ctx);
		} catch (err) {
			reportOnce(name, err);
		}
	};
}

function selfDir(): string | null {
	try {
		return path.dirname(fileURLToPath(import.meta.url));
	} catch {
		return null;
	}
}

/** 配置文件查找顺序（**第一个存在的说了算**，不合并）：
 *   1. `<agent dir>/extensions/audit-log/config.json` —— 团队成员改这个：
 *      团队包按约定把模板发到这里，而包自己的 clone 会被 `pi update` 覆盖，改 clone 里的配置留不住
 *   2. `<扩展同目录>/audit-log.config.json` —— 本机单独装扩展时的位置（向后兼容）
 * 读一次缓存。文件不存在 / 坏 JSON / 字段类型不对 → 走默认值，只往 stderr 报一次。 */
function configFiles(): string[] {
	const files: string[] = [];
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	files.push(path.join(agentDir, "extensions", "audit-log", "config.json"));
	const dir = selfDir();
	if (dir) files.push(path.join(dir, "audit-log.config.json"));
	return files;
}

function getConfig(): { enabled: boolean; maxFieldChars: number; recordFullPrompt: boolean } {
	if (cachedConfig) return cachedConfig;
	cachedConfig = { enabled: true, maxFieldChars: DEFAULT_MAX_FIELD_CHARS, recordFullPrompt: false };
	try {
		for (const file of configFiles()) {
			if (!fs.existsSync(file)) continue;
			const raw = JSON.parse(fs.readFileSync(file, "utf8"));
			if (typeof raw?.enabled === "boolean") cachedConfig.enabled = raw.enabled;
			if (typeof raw?.maxFieldChars === "number" && raw.maxFieldChars > 0) cachedConfig.maxFieldChars = Math.floor(raw.maxFieldChars);
			if (typeof raw?.recordFullPrompt === "boolean") cachedConfig.recordFullPrompt = raw.recordFullPrompt;
			break;
		}
	} catch (err) {
		reportOnce("config", err);
	}
	return cachedConfig;
}

function auditDir(): string {
	const env = process.env.PI_AUDIT_DIR;
	if (typeof env === "string" && env.trim() !== "") return env;
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	return path.join(agentDir, "audit", "logs");
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, "0");

/** ISO8601 带本地偏移，例如 2026-09-21T10:31:02.123+08:00 */
function isoLocal(d: Date): string {
	const offset = -d.getTimezoneOffset();
	const sign = offset >= 0 ? "+" : "-";
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
		`${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`
	);
}

/** 本地日期文件名，按天分文件 */
function dayFile(d: Date): string {
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.jsonl`;
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** skill 的 sourceInfo 只留溯源必需项：
 *  带完整 path/baseDir 时，16 个 skill 的 session 行会涨到 8.5KB 以上，被兜底截断后 filePath 就断了
 *  （对账要求 filePath 完整可验证）。路径信息由顶层 filePath 承担。*/
function slimSourceInfo(info: unknown): Record<string, unknown> | null {
	if (!info || typeof info !== "object") return null;
	const it = info as Record<string, unknown>;
	const out: Record<string, unknown> = {};
	for (const key of ["source", "scope", "origin"]) {
		if (typeof it[key] === "string") out[key] = it[key];
	}
	return Object.keys(out).length > 0 ? out : null;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function clip(s: string, limit: number): string {
	return s.length > limit ? s.slice(0, limit) : s;
}

function safeStringify(value: unknown): string {
	try {
		const out = JSON.stringify(value);
		return typeof out === "string" ? out : "null";
	} catch {
		return "null";
	}
}

/** toolResult 的"字符数"口径：字符串就它本身，否则 JSON 序列化 */
function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === undefined) return "";
	return safeStringify(value);
}

// —— 脱敏（§4 硬要求）——

/** 兜底规则：长度 ≥32 的 base64/hex 串。单个字符类重复，线性扫描，不会回溯。 */
function redactLongTokens(s: string): string {
	return s.replace(/[A-Za-z0-9_+=-]{32,}/g, (tok) => (/\d/.test(tok) ? "<redacted:long-b64>" : tok));
}

const REDACT_RULES: Array<[string, RegExp, string]> = [
	// 1. Authorization 头 / Bearer token（含 bash 里 -H、--header 的写法）
	["auth-header", /authorization\s*[:=]\s*(?:bearer\s+)?[^\s"',;}\]]+/gi, "<redacted:auth-header>"],
	["bearer", /\bbearer\s+[^\s"',;}\]]+/gi, "<redacted:bearer>"],
	// 3. key=value / key: value 形态：连键名一起抹掉，否则 grep "password=" 仍有明文命中
	["credential-kv", /(?:api[_-]?key|apikey|password|passwd|secret|token)\s*[\\"']*\s*[:=]\s*[\\"']*[^\s\\"',;}\]]+/gi, "<redacted:credential-kv>"],
	// 2. 已知前缀的长串
	["token-prefix", /\b(?:sk[-_][A-Za-z0-9_-]{8,}|xoxb-[A-Za-z0-9-]{8,}|ghp_[A-Za-z0-9]{8,}|gho_[A-Za-z0-9]{8,}|AKIA[A-Z0-9]{12,})\b/g, "<redacted:token-prefix>"],
	// 4. URL 里的 userinfo
	["url-userinfo", /([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s:/@]+@/gi, "$1<redacted:url-userinfo>@"],
];

function redactStructure(s: string): string {
	let out = s;
	for (const [, re, rep] of REDACT_RULES) out = out.replace(re, rep);
	return out;
}

/** 路径/ID 这类结构字段：跑凭据规则，但不跑"长 hex/base64"兜底（否则正常路径会被打掉）*/
const STRUCTURE_KEY_RE = /^(?:filePath|baseDir|path|cwd|sessionFile|toolCallId|sessionId|model|provider|note)$/;

function redact(s: string): string {
	let out = redactStructure(s);
	// 5. 兜底：≥32 位的 hex / base64 串
	out = out.replace(/\b[0-9a-fA-F]{32,}\b/g, "<redacted:long-hex>");
	return redactLongTokens(out);
}

/** 预览字段：脱敏 -> 按 maxFieldChars 截断。超长时置本轮 truncated 标记。 */
function preview(value: unknown, limit = getConfig().maxFieldChars): string | null {
	const raw = typeof value === "string" ? value : safeStringify(value);
	let out: string;
	try {
		out = redact(raw);
	} catch (err) {
		reportOnce("redact", err);
		out = "<redacted:error>";
	}
	if (Number.isFinite(limit) && out.length > limit) {
		pendingTruncated = true;
		return out.slice(0, limit);
	}
	return out;
}

// —— 记录组装 ——

function walkStrings(node: unknown, fn: (parent: any, key: string, value: string) => void, depth = 0): void {
	if (depth > 4 || !node || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walkStrings(item, fn, depth + 1);
		return;
	}
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (typeof value === "string") fn(node, key, value);
		else if (value && typeof value === "object") walkStrings(value, fn, depth + 1);
	}
}

/** §4：写盘前对**所有**字符串字段过一遍脱敏（摘要字段除外） */
function redactRecord(rec: Record<string, unknown>): void {
	try {
		walkStrings(rec, (parent, key, value) => {
			if (HASH_KEY_RE.test(key)) return;
			parent[key] = STRUCTURE_KEY_RE.test(key) ? redactStructure(value) : redact(value);
		});
	} catch (err) {
		reportOnce("redact-record", err);
	}
}

/** 单行 8192 字节兜底：反复砍最长的字符串值；仍超则退化成最小记录 */
function fitLine(rec: Record<string, unknown>): string {
	let line = safeStringify(rec);
	const bytes = () => Buffer.byteLength(line, "utf8");
	if (bytes() <= MAX_LINE_BYTES) return line;
	rec.truncated = true;
	for (let pass = 0; pass < 16 && bytes() > MAX_LINE_BYTES; pass++) {
		// 先整体对折所有长值（几何收敛），实在不行再按最长值逐个丢弃
		let touched = false;
		walkStrings(rec, (parent, key, value) => {
			if (value.length > 64) {
				parent[key] = value.slice(0, Math.max(64, Math.floor(value.length / 2)));
				touched = true;
			}
		});
		if (!touched) {
			let hit: { parent: any; key: string; value: string } | null = null;
			walkStrings(rec, (parent, key, value) => {
				if (!hit || value.length > (hit as any).value.length) hit = { parent, key, value };
			});
			const target = hit as { parent: any; key: string; value: string } | null;
			if (!target) break;
			delete target.parent[target.key];
		}
		line = safeStringify(rec);
	}
	if (bytes() > MAX_LINE_BYTES) {
		line = safeStringify({
			v: SCHEMA_VERSION,
			ts: rec.ts,
			event: rec.event,
			sessionId: rec.sessionId,
			seq: rec.seq,
			truncated: true,
			note: "line_over_limit",
		});
	}
	return line;
}

function emit(rec: Record<string, unknown>): void {
	try {
		// 总开关：关掉就在唯一的出口处一并断掉，所有事件类型都受影响，不需要逐个 handler 判断
		if (!getConfig().enabled) return;
		const line = fitLine(rec);
		const file = path.join(auditDir(), dayFile(new Date()));
		const dir = path.dirname(file);
		if (!ensuredDirs.has(dir)) {
			fs.mkdirSync(dir, { recursive: true });
			ensuredDirs.add(dir);
		}
		// 追加写、不缓冲：进程被 kill 也留下已发生的事件
		fs.appendFileSync(file, `${line}\n`, { encoding: "utf8" });
	} catch (err) {
		reportOnce("write", err);
	}
}

/** ctx 里所有取值都可能抛（mock / 老版本 / 临时 session），逐个兜住 */
function safeCtx(ctx: any): { sessionId: string | null; sessionFile: string | null; cwd: string | null; model: string | null; provider: string | null } {
	const out = { sessionId: null as string | null, sessionFile: null as string | null, cwd: null as string | null, model: null as string | null, provider: null as string | null };
	try {
		const id = ctx?.sessionManager?.getSessionId?.();
		if (typeof id === "string" && id) out.sessionId = id;
	} catch {
		/* 拿不到就 null */
	}
	try {
		const f = ctx?.sessionManager?.getSessionFile?.();
		if (typeof f === "string" && f) out.sessionFile = f;
	} catch {
		/* 同上 */
	}
	try {
		if (typeof ctx?.cwd === "string" && ctx.cwd) out.cwd = ctx.cwd;
	} catch {
		/* 同上 */
	}
	try {
		const model = ctx?.model;
		if (model && typeof model.id === "string") out.model = model.id;
		if (model && typeof model.provider === "string") out.provider = model.provider;
	} catch {
		/* 同上 */
	}
	return out;
}

/** 单行真实字节数：把公共字段也一起算上。
 *  实测公共字段（ts/sessionFile/cwd/event...）能吃掉 400+ 字节，
 *  所以尺寸判断不能再靠估余量，必须量“即将落盘的那条记录”。*/
const lineBytes = (rec: Record<string, unknown>): number => Buffer.byteLength(safeStringify(rec), "utf8");

/** 组装完整记录（含公共字段）。
 *  量尺寸和真落盘必须走同一个函数，否则两边的字段一漂移，尺寸判断就失效了。*/
function commonRecord(event: string, ctx: any, fields: Record<string, unknown>): Record<string, unknown> {
	const c = safeCtx(ctx);
	return {
		v: SCHEMA_VERSION,
		ts: isoLocal(new Date()),
		event,
		sessionId: c.sessionId,
		sessionFile: c.sessionFile,
		cwd: c.cwd,
		piVersion: PI_VERSION,
		model: c.model,
		provider: c.provider,
		seq: seq + 1,
		...fields,
	};
}

/** 组装 + 定稿。尺寸判断与真落盘**共用这一个函数**：
 *  量到的东西必须就是写出去的东西，否则两边的差异（`truncated` 字段、脱敏后的长度）
 *  就是下一个“判断放行、真落盘超限”的坑。*/
function finishRecord(event: string, ctx: any, fields: Record<string, unknown>): Record<string, unknown> {
	const rec = commonRecord(event, ctx, fields);
	if (pendingTruncated) rec.truncated = true;
	redactRecord(rec);
	return rec;
}

function write(event: string, ctx: any, fields: Record<string, unknown>): void {
	try {
		const rec = finishRecord(event, ctx, fields);
		pendingTruncated = false;
		seq += 1;
		emit(rec);
	} catch (err) {
		pendingTruncated = false;
		reportOnce(`record:${event}`, err);
	}
}

// —— 阶段 2：配置指纹（改配置到底省没省）——

/** `<agent dir>/settings.json` 的摘要：只留字符数与 sha256，绝不记内容。 */
function settingsDigest(): { chars: number; sha256: string | null } {
	try {
		const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
		const file = path.join(agentDir, "settings.json");
		if (!fs.existsSync(file)) return { chars: 0, sha256: null };
		const raw = fs.readFileSync(file, "utf8");
		return { chars: raw.length, sha256: sha256(raw) };
	} catch (err) {
		reportOnce("settings-digest", err);
		return { chars: 0, sha256: null };
	}
}

/** 配置指纹：8 个要素按固定顺序规范化后 JSON 序列化，sha256 取前 12 位。
 *  要素：packageRefs 的 source / selectedTools / model / scopedModels / thinkingLevel / mode /
 *        settings 的 sha256 / skills 的 filePath。
 *  只覆盖「配置身份」，**不含尺寸类字段**（snippetChars、contextFiles 的字符数）——
 *  那些会随无关改动漂移，混进来指纹就失去可比性。*/
function configFingerprint(f: {
	packageSources: string[]; toolNames: string[]; model: string | null; models: string[];
	thinkingLevel: string | null; mode: string | null; settingsSha: string | null; skillFiles: string[];
}): string {
	// 用 JSON.stringify 而非 join 拼接：元素含逗号（Windows 路径合法）时 join 会让
	// ["a,b"] 与 ["a","b"] 拼出同一串，指纹撞车。JSON 带引号与转义，无歧义。
	const parts = [
		f.packageSources.slice().sort(),
		f.toolNames.slice().sort(),
		f.model ?? "",
		f.models,
		f.thinkingLevel ?? "",
		f.mode ?? "",
		f.settingsSha ?? "",
		f.skillFiles.slice().sort(),
	];
	return sha256(JSON.stringify(parts)).slice(0, 12);
}

/** 阶段 2 的 config 对象：全部只记名称 / 尺寸 / 哈希，不记正文
 *  （contextFiles 只留文件名与字符数，不留全路径与内容；settings 不留内容）。*/
function buildConfig(event: any, ctx: any): Record<string, unknown> {
	const opts = event?.systemPromptOptions ?? {};
	const rawSkills = Array.isArray(opts.skills) ? opts.skills : [];
	const refCount = new Map<string, number>();
	const skillFiles: string[] = [];
	for (const s of rawSkills) {
		const src = s?.sourceInfo?.source;
		if (typeof src === "string" && src) refCount.set(src, (refCount.get(src) ?? 0) + 1);
		if (typeof s?.filePath === "string") skillFiles.push(s.filePath);
	}
	const packageRefs = [...refCount.entries()]
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
		.map(([source, skills]) => ({ source, skills }));

	const toolNames = (Array.isArray(opts.selectedTools) ? opts.selectedTools : []).filter(
		(t: unknown): t is string => typeof t === "string",
	);
	const snippets = opts.toolSnippets && typeof opts.toolSnippets === "object" ? opts.toolSnippets : {};
	let snippetChars = 0;
	for (const v of Object.values(snippets)) if (typeof v === "string") snippetChars += v.length;

	const contextFiles = (Array.isArray(opts.contextFiles) ? opts.contextFiles : []).map((f: any) => ({
		name: typeof f?.path === "string" ? path.basename(f.path) : null,
		chars: typeof f?.content === "string" ? f.content.length : 0,
	}));

	const model = ctx?.model && typeof ctx.model.id === "string" ? ctx.model.id : null;
	const models = (Array.isArray(ctx?.scopedModels) ? ctx.scopedModels : [])
		.map((m: any) => m?.model?.id)
		.filter((id: unknown): id is string => typeof id === "string")
		.sort();
	const thinkingLevel = typeof ctx?.thinkingLevel === "string" ? ctx.thinkingLevel : null;
	const mode = typeof ctx?.mode === "string" ? ctx.mode : null;
	const settings = settingsDigest();

	return {
		packageRefs,
		tools: { count: toolNames.length, names: toolNames, snippetChars },
		contextFiles,
		model,
		models,
		thinkingLevel,
		mode,
		settings,
		fingerprint: configFingerprint({
			packageSources: [...refCount.keys()],
			toolNames,
			model,
			models,
			thinkingLevel,
			mode,
			settingsSha: settings.sha256,
			skillFiles,
		}),
	};
}

// —— 扩展本体 ——

export default function (pi: ExtensionAPI): void {
	// 只在交互模式下能拿到的 session 起始原因；核心信息仍写在 before_agent_start（print 模式下 session_start 不触发）
	pi.on("session_start", guard("session_start", (event) => {
		sessionStartReason = typeof event?.reason === "string" ? event.reason : null;
	}));

	pi.on("before_agent_start", guard("before_agent_start", (event, ctx) => {
		if (sessionWritten) return;
		sessionWritten = true;
		const systemPrompt = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
		const rawSkills = Array.isArray(event?.systemPromptOptions?.skills) ? event.systemPromptOptions.skills : [];
		// description 是最不重要的字段（filePath 才是权威，用来回联会话），
		// 所以先压描述（CJK 描述一个字符 3 字节，200 字符就能吃掉半行），装不下才丢条目
		const buildSkills = (descCap: number) => rawSkills.map((s: any) => ({
			name: typeof s?.name === "string" ? s.name : null,
			description: clip(typeof s?.description === "string" ? s.description : "", descCap),
			filePath: typeof s?.filePath === "string" ? s.filePath : null,
			baseDir: typeof s?.baseDir === "string" ? s.baseDir : null,
			sourceInfo: slimSourceInfo(s?.sourceInfo),
		}));
		const base = {
			reason: sessionStartReason,
			skillCount: rawSkills.length,
			systemPromptChars: systemPrompt.length,
			systemPromptSha256: sha256(systemPrompt),
		};
		// 用和 write() 完全相同的组装+定稿流程来量尺寸（finishRecord），不拍脑袋估余量：
		// 公共字段实测能吃掉 400+ 字节，再加上 truncated 标记和脱敏后的长度变化，
		// 估余量迟早把 filePath 牺牲掉
		// 阶段 2：配置指纹。尺寸与 skills 一起量，否则加入 config 后尺寸判断会失准
		const config = buildConfig(event, ctx);
		const measure = (skills: unknown[], extra?: Record<string, unknown>, ctx2 = ctx): number =>
			lineBytes(finishRecord("session", ctx2, { ...base, config, ...(extra ?? {}), skills }));
		let descCap = SKILL_DESC_CHARS;
		let skills = buildSkills(descCap);
		for (const cap of [80, 40, 16, 0]) {
			if (measure(skills) <= MAX_LINE_BYTES) break;
			descCap = cap;
			skills = buildSkills(cap);
		}
		// 描述压到 0 还装不下，才按完整条目丢弃（绝不靠兜底截断，那会把 filePath 切断）。
		// 丢弃时连 skillsOmitted 一起量：那个字段自己也占字节，漏算就可能刚好超限
		while (skills.length > 0 && measure(skills, { skillsOmitted: rawSkills.length - skills.length }) > MAX_LINE_BYTES) {
			skills = skills.slice(0, skills.length - 1);
		}
		write("session", ctx, {
			...base,
			config,
			skills,
			...(descCap < SKILL_DESC_CHARS ? { descriptionChars: descCap } : {}),
			...(skills.length < rawSkills.length ? { skillsOmitted: rawSkills.length - skills.length } : {}),
		});
	}));

	pi.on("agent_start", guard("agent_start", () => {
		// 本 run 的用量累计从这里开始
		runTokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, totalTokens: 0 };
	}));

	pi.on("input", guard("input", (event, ctx) => {
		const text = typeof event?.text === "string" ? event.text : "";
		const cfg = getConfig();
		write("user_input", ctx, {
			chars: text.length,
			sha256: sha256(text),
			source: typeof event?.source === "string" ? event.source : null,
			promptPreview: preview(text, cfg.recordFullPrompt ? Number.POSITIVE_INFINITY : PROMPT_PREVIEW_CHARS),
		});
	}));

	pi.on("user_bash", guard("user_bash", (event, ctx) => {
		write("user_bash", ctx, {
			commandPreview: preview(typeof event?.command === "string" ? event.command : "", PROMPT_PREVIEW_CHARS),
			excludeFromContext: event?.excludeFromContext === true,
		});
	}));

	pi.on("turn_start", guard("turn_start", (event, ctx) => {
		currentTurnIndex = typeof event?.turnIndex === "number" ? event.turnIndex : currentTurnIndex + 1;
		turnCalls = 0;
		turnErrors = 0;
		write("turn_start", ctx, { turnIndex: currentTurnIndex });
	}));

	pi.on("tool_execution_start", guard("tool_execution_start", (event, ctx) => {
		const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : null;
		if (toolCallId) toolStarts.set(toolCallId, Date.now());
		turnCalls += 1;
		write("tool_call", ctx, {
			toolName: typeof event?.toolName === "string" ? event.toolName : null,
			toolCallId,
			argsPreview: preview(event?.args),
			argsSha256: sha256(safeStringify(event?.args)),
		});
	}));

	pi.on("tool_execution_end", guard("tool_execution_end", (event, ctx) => {
		const toolCallId = typeof event?.toolCallId === "string" ? event.toolCallId : null;
		const started = toolCallId ? toolStarts.get(toolCallId) : undefined;
		if (toolCallId) toolStarts.delete(toolCallId);
		const isError = event?.isError === true;
		if (isError) turnErrors += 1;
		const text = textOf(event?.result);
		write("tool_result", ctx, {
			toolName: typeof event?.toolName === "string" ? event.toolName : null,
			toolCallId,
			isError,
			durationMs: typeof started === "number" ? Date.now() - started : 0,
			resultChars: text.length,
			resultSha256: sha256(text),
		});
	}));

	pi.on("message_end", guard("message_end", (event, ctx) => {
		const message = event?.message;
		if (!message || message.role !== "assistant") return;
		const usage = message.usage ?? {};
		const content = Array.isArray(message.content) ? message.content : [];
		let thinkingChars = 0;
		let textChars = 0;
		let hasThinking = false;
		for (const item of content) {
			if (item?.type === "thinking") {
				hasThinking = true;
				thinkingChars += typeof item.thinking === "string" ? item.thinking.length : 0;
			} else if (item?.type === "text") {
				textChars += typeof item.text === "string" ? item.text.length : 0;
			}
		}
		runTokens.input += num(usage.input);
		runTokens.cacheRead += num(usage.cacheRead);
		runTokens.cacheWrite += num(usage.cacheWrite);
		runTokens.output += num(usage.output);
		runTokens.reasoning += num(usage.reasoning);
		runTokens.totalTokens += num(usage.totalTokens);
		lastStopReason = typeof message.stopReason === "string" ? message.stopReason : null;
		write("assistant_usage", ctx, {
			usage: {
				input: num(usage.input),
				cacheRead: num(usage.cacheRead),
				cacheWrite: num(usage.cacheWrite),
				output: num(usage.output),
				reasoning: typeof usage.reasoning === "number" ? usage.reasoning : null,
				totalTokens: num(usage.totalTokens),
			},
			cost: usage.cost ?? null,
			stopReason: lastStopReason,
			hasThinking,
			thinkingChars,
			textChars,
		});
	}));

	pi.on("turn_end", guard("turn_end", (event, ctx) => {
		write("turn_end", ctx, {
			turnIndex: typeof event?.turnIndex === "number" ? event.turnIndex : currentTurnIndex,
			toolCalls: turnCalls,
			toolErrors: turnErrors,
			lastStopReason,
		});
	}));

	pi.on("agent_end", guard("agent_end", (event, ctx) => {
		const messages = Array.isArray(event?.messages) ? event.messages : [];
		write("agent_end", ctx, { messageCount: messages.length, turnTokens: { ...runTokens } });
	}));

	// 「本轮真的收敛了（不再重试/压缩/续跑）」的权威标记
	pi.on("agent_settled", guard("agent_settled", (_event, ctx) => {
		write("agent_settled", ctx, {});
	}));

	pi.on("session_compact", guard("session_compact", (event, ctx) => {
		const entry = event?.compactionEntry ?? {};
		write("compact", ctx, {
			reason: typeof event?.reason === "string" ? event.reason : null,
			tokensBefore: num(entry.tokensBefore),
			summaryChars: typeof entry.summary === "string" ? entry.summary.length : 0,
			fromExtension: event?.fromExtension === true,
			willRetry: event?.willRetry === true,
		});
	}));

	pi.on("model_select", guard("model_select", (event, ctx) => {
		write("model_select", ctx, {
			from: typeof event?.previousModel?.id === "string" ? event.previousModel.id : null,
			to: typeof event?.model?.id === "string" ? event.model.id : null,
			source: typeof event?.source === "string" ? event.source : null,
		});
	}));

	pi.on("thinking_level_select", guard("thinking_level_select", (event, ctx) => {
		write("thinking_level", ctx, {
			from: typeof event?.previousLevel === "string" ? event.previousLevel : null,
			to: typeof event?.level === "string" ? event.level : null,
		});
	}));

	pi.on("session_shutdown", guard("session_shutdown", (event, ctx) => {
		write("shutdown", ctx, { reason: typeof event?.reason === "string" ? event.reason : null });
	}));
}
