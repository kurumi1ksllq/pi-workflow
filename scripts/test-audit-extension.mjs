// 离线 mock 测试 audit-log 扩展 —— 不用启动 pi、不用 provider、不碰本机 ~/.pi/agent
//
// 跑法：node scripts/test-audit-extension.mjs
//
// 覆盖（对应 docs/audit-log-spec.md §6.1）：
//   1. before_agent_start（带 mock systemPromptOptions.skills）→ session 事件，skills[] 与输入一致
//   2. tool_execution_start + tool_execution_end → 两条记录，durationMs 是数字，isError 透传
//   3. 参数里塞 Authorization: Bearer sk-... 和 password=hunter2 → 落盘不含原串
//   4. 100KB 的 args → 该字段被截断、truncated:true、整行 ≤ 8192 字节
//   5. ctx 没有 sessionManager（或它抛异常）→ 不崩，sessionId/sessionFile 为 null，仍写出记录
//   6. handler 抛异常 → 被吞掉并写 stderr
//   7. 同一天跑两次 → 追加不覆盖，行数累加
//   8. skill 多 / sessionFile 深时 session 行不爆 8192，filePath 不被切断
//   9. 总开关：<agent dir>/extensions/audit-log/config.json 写 enabled:false → 一条都不写；用户目录优先于扩展同级目录
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, "..", "extensions", "audit-log.ts");
const problems = [];
const check = (ok, message) => {
	if (!ok) problems.push(message);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-audit-ext-test-"));
process.env.PI_AUDIT_DIR = tmp;
process.env.PI_CODING_AGENT_DIR = path.join(tmp, "agent"); // 防扩展写到真的 ~/.pi/agent

const logsDir = tmp;
const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const logFile = path.join(logsDir, `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.jsonl`);

const loadFresh = async () => {
	// 缓存破坏：同一路径 import 两次会拿到模块缓存
	const mod = await import(pathToFileURL(EXT).href + "?run=" + Date.now() + Math.random());
	const handlers = {};
	mod.default({ on: (n, f) => (handlers[n] = f), registerCommand: () => {}, registerTool: () => {} });
	return handlers;
};

const readLines = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean) : []);
const readRecords = () => readLines().map((l) => JSON.parse(l));

const ctx = {
	cwd: "E:\\hermes\\pi-audit-test",
	sessionManager: { getSessionId: () => "01a0c1d9-b367-706c-8af4-9c14ee51c09c", getSessionFile: () => "E:\\sessions\\x.jsonl" },
	model: { id: "deepseek/deepseek-v4.1-flash", provider: "newapi" },
};

const handlers = await loadFresh();

// —— 场景 1：before_agent_start → session 事件 ——
const skills = [
	{
		name: "commit-convention",
		description: "写 git commit message 时使用",
		filePath: "C:\\Users\\admin\\.pi\\agent\\git\\github.com\\kurumi1ksllq\\pi-workflow\\skills\\00-core\\commit-convention\\SKILL.md",
		baseDir: "C:\\Users\\admin\\.pi\\agent\\git\\github.com\\kurumi1ksllq\\pi-workflow",
		sourceInfo: { path: "C:\\x", source: "git:pi-workflow", scope: "user", origin: "package" },
	},
	{ name: "ponytail", description: "最懒可行解", filePath: "C:\\y\\SKILL.md", baseDir: "C:\\y", sourceInfo: null },
];
await handlers.before_agent_start(
	{ type: "before_agent_start", prompt: "hi", systemPrompt: "SYSTEM-PROMPT-TEXT", systemPromptOptions: { skills } },
	ctx,
);
{
	const recs = readRecords();
	const s = recs.find((r) => r.event === "session");
	check(!!s, "没写出 session 事件（场景 1）");
	check(s?.skills?.length === 2, `skills[] 条数不对：${s?.skills?.length}（场景 1）`);
	check(s?.skills?.[0]?.name === "commit-convention", "skills[0].name 不一致（场景 1）");
	check(s?.skills?.[0]?.filePath === skills[0].filePath, "skills[0].filePath 不一致（场景 1）");
	check(s?.skillCount === 2, "skillCount 不对（场景 1）");
	check(s?.systemPromptChars === "SYSTEM-PROMPT-TEXT".length, "systemPromptChars 不对（场景 1）");
	check(/^[0-9a-f]{64}$/.test(s?.systemPromptSha256 ?? ""), "systemPromptSha256 不是 sha256（场景 1）");
	check(s?.sessionId === "01a0c1d9-b367-706c-8af4-9c14ee51c09c", "sessionId 没取到（场景 1）");
	check(s?.piVersion !== undefined, "缺 piVersion 字段（场景 1）");
}

// —— 场景 2：tool_execution_start + tool_execution_end ——
const args = { command: "echo hello", description: "跑一次" };
await handlers.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args }, ctx);
await new Promise((r) => setTimeout(r, 15));
await handlers.tool_execution_end(
	{ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: { content: [{ type: "text", text: "hello\n" }] }, isError: false },
	ctx,
);
{
	const recs = readRecords();
	const call = recs.find((r) => r.event === "tool_call" && r.toolCallId === "call_1");
	const res = recs.find((r) => r.event === "tool_result" && r.toolCallId === "call_1");
	check(!!call && !!res, "没写出 tool_call / tool_result 两条（场景 2）");
	check(typeof res?.durationMs === "number" && res.durationMs >= 0, "durationMs 不是数字（场景 2）");
	check(res?.isError === false, "isError 没透传 false（场景 2）");
	check(typeof res?.resultChars === "number" && res.resultChars > 0, "resultChars 不对（场景 2）");
	check(/^[0-9a-f]{64}$/.test(res?.resultSha256 ?? ""), "resultSha256 不是 sha256（场景 2）");
	check(/^[0-9a-f]{64}$/.test(call?.argsSha256 ?? ""), "argsSha256 不是 sha256（场景 2）");
	check(call?.argsPreview?.includes("echo hello"), "argsPreview 没记内容（场景 2）");
}

// 错误工具：isError 透传 true，turnErrors 计数
await handlers.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: "exit 1" } }, ctx);
await handlers.tool_execution_end({ type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", result: "boom", isError: true }, ctx);
{
	const res = readRecords().find((r) => r.event === "tool_result" && r.toolCallId === "call_2");
	check(res?.isError === true, "isError 没透传 true（场景 2）");
}

// —— 场景 3：脱敏 ——
const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD"; // 47 字符
const dirtyArgs = {
	command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com -d "password=hunter2"`,
	note: `mysql://root:sup3rs3cret@db.internal:3306/app`,
	misc: "apikey=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
};
await handlers.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_3", toolName: "bash", args: dirtyArgs }, ctx);
{
	const rec = readRecords().find((r) => r.event === "tool_call" && r.toolCallId === "call_3");
	const line = JSON.stringify(rec);
	check(!line.includes(secret), "落盘含 sk- 原串（场景 3）");
	check(!line.includes("hunter2"), "落盘含 password 原串（场景 3）");
	check(!line.includes("sup3rs3cret"), "落盘含 URL userinfo 原串（场景 3）");
	check(!line.includes("Bearer sk-"), "落盘含 Bearer <token>（场景 3）");
	check(!line.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"), "落盘含 apikey 原串（场景 3）");
	check(line.includes("<redacted:"), "没有任何 <redacted:...> 标记（场景 3）");
}

// 全文件兜底：任何一行都不许出现明文凭据
{
	const all = fs.readFileSync(logFile, "utf8");
	for (const bad of [secret, "hunter2", "sup3rs3cret", "Bearer sk-", "password=", "apikey="]) {
		check(!all.includes(bad), `整个日志文件里出现明文「${bad}」（场景 3）`);
	}
}

// —— 场景 4：100KB args 截断 ——
const huge = { command: "x".repeat(100 * 1024) };
await handlers.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_4", toolName: "write", args: huge }, ctx);
{
	const line = readLines().find((l) => l.includes("call_4"));
	const rec = JSON.parse(line);
	check(Buffer.byteLength(line, "utf8") <= 8192, `整行超过 8192 字节：${Buffer.byteLength(line, "utf8")}（场景 4）`);
	check(rec.truncated === true, "超长字段没标 truncated:true（场景 4）");
	check(rec.argsPreview.length <= 2000, `argsPreview 没按 maxFieldChars 截断：${rec.argsPreview.length}（场景 4）`);
}

// —— 场景 5：ctx 缺 sessionManager / getter 抛异常 ——
const before5 = readLines().length;
await handlers.tool_execution_end({ type: "tool_execution_end", toolCallId: "call_9", toolName: "bash", result: "ok", isError: false }, { cwd: "E:\\x" });
await handlers.tool_execution_end(
	{ type: "tool_execution_end", toolCallId: "call_10", toolName: "bash", result: "ok", isError: false },
	{
		cwd: "E:\\x",
		sessionManager: {
			getSessionId: () => {
				throw new Error("no session id");
			},
			getSessionFile: () => {
				throw new Error("no session file");
			},
		},
	},
);
{
	const recs = readRecords();
	const r9 = recs.find((r) => r.toolCallId === "call_9");
	const r10 = recs.find((r) => r.toolCallId === "call_10");
	check(readLines().length === before5 + 2, "ctx 不完整时记录没写出来（场景 5）");
	check(r9 && r9.sessionId === null && r9.sessionFile === null, "缺 sessionManager 时字段不是 null（场景 5）");
	check(r10 && r10.sessionId === null && r10.sessionFile === null, "getter 抛异常时应该写 null（场景 5）");
}

// —— 场景 6：handler 抛异常被吞掉 + 写 stderr（每类只报一次）——
{
	// 用全新模块：前几轮已经写过 session 事件，before_agent_start 会提前 return，摸不到会炸的 getter
	const handlersErr = await loadFresh();
	const stderrChunks = [];
	const orig = process.stderr.write.bind(process.stderr);
	process.stderr.write = (chunk, ...rest) => {
		stderrChunks.push(String(chunk));
		return orig(chunk, ...rest);
	};
	try {
		// getter 抛出：扩展读 event.systemPrompt / message.usage 时就会炸，只有 try/catch 能拦住
		const boom = () => {
			throw new Error("mock-explosion");
		};
		const badStart = { type: "before_agent_start", prompt: "x", systemPromptOptions: { skills: [] } };
		Object.defineProperty(badStart, "systemPrompt", { get: boom });
		const badMsg = { type: "message_end" };
		Object.defineProperty(badMsg, "message", { get: boom });

		for (let i = 0; i < 3; i++) {
			await handlersErr.before_agent_start(badStart, ctx);
			await handlersErr.message_end(badMsg, ctx);
			// event 全 null / ctx 全 null
			await handlersErr.tool_execution_start(null, null);
			await handlersErr.turn_end(null, null);
			await handlersErr.session_shutdown(null, null);
		}
	} finally {
		process.stderr.write = orig;
	}
	const joined = stderrChunks.join("");
	check(joined.includes("[audit-log]"), `异常没写 stderr，实际是「${joined.slice(0, 200)}」（场景 6）`);
	check(joined.includes("before_agent_start") && joined.includes("message_end"), `stderr 没报出出错的 handler 名：「${joined}」（场景 6）`);
	// 每类错误只报一次：同一 handler 炸了 3 次，stderr 只应有 1 行
	for (const name of ["before_agent_start", "message_end"]) {
		const hits = joined.split(`[audit-log] ${name}:`).length - 1;
		check(hits === 1, `${name} 报了 ${hits} 次，应该只报一次（场景 6）`);
	}
}

// —— 场景 7：同一天再跑一次 → 追加不覆盖 ——
const linesBefore = readLines().length;
check(linesBefore > 0, "第一轮没写出任何记录（场景 7）");
const handlers2 = await loadFresh();
await handlers2.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_12", toolName: "bash", args: { command: "echo twice" } }, ctx);
{
	const linesAfter = readLines().length;
	check(linesAfter === linesBefore + 1, `第二轮不是追加而是覆盖：${linesBefore} -> ${linesAfter}（场景 7）`);
	check(readRecords().some((r) => r.toolCallId === "call_12"), "第二轮的记录找不到（场景 7）");
	// seq 是进程内计数器：新进程从 1 重新开始，靠 (sessionId, ts, seq) 排序
	check(readRecords().filter((r) => r.seq === 1).length >= 1, "新进程的 seq 没从 1 开始（场景 7）");
}

// —— 公共字段完整性 ——
{
	const recs = readRecords();
	const required = ["v", "ts", "event", "sessionId", "sessionFile", "cwd", "piVersion", "model", "provider", "seq"];
	for (const key of required) {
		check(recs.every((r) => key in r), `有记录缺公共字段 ${key}`);
	}
	check(recs.every((r) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(r.ts)), "ts 不是带本地偏移的 ISO8601");
	check(
		recs.every((r) => !Number.isNaN(Date.parse(r.ts))),
		"ts 不可解析",
	);
	// seq 是**进程内**计数器，跨进程不单调（这正是丢行检测要配合 sessionId/ts 的原因）
	let prevSeq = 0;
	let resets = 0;
	for (const r of recs) {
		if (r.seq <= prevSeq) resets += 1;
		prevSeq = r.seq;
	}
	check(resets >= 1, "同一天跑了两个进程，seq 应该有重置点（用于验证进程边界）");
	check(
		recs.every((r) => Number.isInteger(r.seq) && r.seq >= 1),
		"seq 不是从 1 开始的正整数",
	);
	check(!fs.readFileSync(logFile, "utf8").startsWith("\uFEFF"), "文件带 BOM");
}

// —— 场景 8：技能多时，session 行不能爆 8192，且 filePath 必须完整（真机踩过的坑）——
{
	// 用真名字长度的临时技能，filePath 真实存在，才能断言「没被截断」
	const longRoot = path.join(tmp, "git", "github.com", "kurumi1ksllq", "pi-workflow", "skills", "00-core");
	const mkSkill = (i) => {
		const dir = path.join(longRoot, `skill-${i}`);
		fs.mkdirSync(dir, { recursive: true });
		const filePath = path.join(dir, "SKILL.md");
		fs.writeFileSync(filePath, "# x", "utf8");
		return {
			name: `skill-${i}`,
			// descLen=100 是关键：该长度下旧实现 fits() 放行(7617<=7792)，叠加长 sessionFile 后真落盘 8337>8192
			description: "x".repeat(100),
			filePath,
			baseDir: longRoot,
			sourceInfo: { path: filePath, source: "git:github.com/kurumi1ksllq/pi-workflow@v1.7.0", scope: "user", origin: "package", baseDir: longRoot },
		};
	};

	// 8a：16 个（本机真实数量）必须全记下，且不靠兜底截断
	{
		const h = await loadFresh();
		await h.before_agent_start(
			{ type: "before_agent_start", prompt: "x", systemPrompt: "P", systemPromptOptions: { skills: Array.from({ length: 16 }, (_, i) => mkSkill(i)) } },
			ctx,
		);
		const line = readLines().find((l) => JSON.parse(l).event === "session" && JSON.parse(l).skillCount === 16);
		const rec = JSON.parse(line);
		check(Buffer.byteLength(line, "utf8") <= 8192, `16 个技能时 session 行超了：${Buffer.byteLength(line, "utf8")}（场景 8a）`);
		check(rec.truncated !== true, "16 个技能时不该靠兜底截断（会把 filePath 切断）（场景 8a）");
		check(rec.skills.length === 16 && rec.skillsOmitted === undefined, `16 个技能被丢成了 ${rec.skills.length} 条（场景 8a）`);
		check(rec.skills.every((s) => fs.existsSync(s.filePath)), "filePath 在磁盘上不存在（说明被截断了）（场景 8a）");
		check(rec.skills.every((s) => typeof s.baseDir === "string" && s.baseDir.length > 0), "baseDir 不能少（spec §3 要求每条 skill 带 baseDir）（场景 8a）");
		check(rec.skills.every((s) => !("path" in (s.sourceInfo ?? {}))), "sourceInfo.path 不该记（重复且占字节）（场景 8a）");
	}

	// 8b：60 个 → 按完整条目丢弃，留下的每条 filePath 仍真实存在
	{
		const h = await loadFresh();
		await h.before_agent_start(
			{ type: "before_agent_start", prompt: "x", systemPrompt: "P", systemPromptOptions: { skills: Array.from({ length: 60 }, (_, i) => mkSkill(i)) } },
			ctx,
		);
		const line = readLines().find((l) => JSON.parse(l).event === "session" && JSON.parse(l).skillCount === 60);
		const rec = JSON.parse(line);
		check(Buffer.byteLength(line, "utf8") <= 8192, `60 个技能时 session 行超了：${Buffer.byteLength(line, "utf8")}（场景 8b）`);
		check(rec.skills.length >= 1 && rec.skills.length < 60, `skillsOmitted 没生效：保留 ${rec.skills.length} 条（场景 8b）`);
		check(rec.skillsOmitted === 60 - rec.skills.length, "skillsOmitted 数字不对（场景 8b）");
		check(rec.skills.every((s) => fs.existsSync(s.filePath)), "保留了 skills，但 filePath 在磁盘上不存在（说明被截断了）（场景 8b）");
	}
	// 8c：sessionFile 特别长（深路径项目编码）时，尺寸判断仍必须准。
	// 旧实现用「MAX_LINE_BYTES - 400」估余量，但公共字段实际能吃掉 400+ 字节，
	// 于是 fits() 放行、真落盘超限、兜底截断把 filePath 切断。
	{
		const h = await loadFresh();
		const deepCtx = {
			...ctx,
			sessionManager: {
				getSessionId: () => ctx.sessionManager.getSessionId(),
				// 这个长度是关键：该 case 下旧实现 fits() 认为“能装下（7426 ≤ 7792）”，
				// 但真正落盘是 8334 字节 → 兜底截断把 filePath 切断。
				// 换成短 sessionFile，这个用例就抓不到旧 bug 了。
				getSessionFile: () => `C:\\Users\\admin\\.pi\\agent\\sessions\\--E--hermes--${"some-very-deep-nested-monorepo-package-name-".repeat(20)}--\\2026-09-21T02-59-04-838Z_01a0c1e7-2005-7332-9d6c-15e109050874.jsonl`,
			},
		};
		await h.before_agent_start(
			{ type: "before_agent_start", prompt: "x", systemPrompt: "P", systemPromptOptions: { skills: Array.from({ length: 16 }, (_, i) => mkSkill(i)) } },
			deepCtx,
		);
		const line = readLines().find((l) => {
			const r = JSON.parse(l);
			return r.event === "session" && typeof r.sessionFile === "string" && r.sessionFile.includes("some-very-deep-nested");
		});
		const rec = JSON.parse(line);
		// 先确认这个场景真的足够长（否则用例会退化成恒真）
		check(Buffer.byteLength(rec.sessionFile, "utf8") > 520, `深路径 sessionFile 不够长（${Buffer.byteLength(rec.sessionFile, "utf8")} 字节），这条断言抓不到旧 bug（场景 8c）`);
		check(Buffer.byteLength(line, "utf8") <= 8192, `深路径长 sessionFile 时 session 行超了：${Buffer.byteLength(line, "utf8")}（场景 8c）`);
		check(rec.truncated !== true, "深路径长 sessionFile 时靠兜底截断了（filePath 会被切断）（场景 8c）");
		check(rec.skills.length >= 1, "深路径时一条 skill 都没留下（场景 8c）");
		check(rec.skills.every((s) => fs.existsSync(s.filePath)), "filePath 在磁盘上不存在（说明被截断了）（场景 8c）");
		check(
			rec.skills.length < 16 ? rec.skillsOmitted === 16 - rec.skills.length : rec.skillsOmitted === undefined,
			"skillsOmitted 与实际丢弃数不一致（场景 8c）",
		);
	}
}

// —— 场景 9：总开关 ——
// 用户目录 <agent dir>/extensions/audit-log/config.json 里 enabled:false → 一条都不写；
// 且它优先于扩展同级目录的旧位置（团队分发后扩展本体在包 clone 里，改那里留不住）
{
	const userCfgDir = path.join(process.env.PI_CODING_AGENT_DIR, "extensions", "audit-log");
	const userCfg = path.join(userCfgDir, "config.json");
	const legacyCfg = path.join(here, "..", "extensions", "audit-log.config.json");
	fs.mkdirSync(userCfgDir, { recursive: true });
	try {
		// 旧位置故意留着 enabled:true —— 用户目录若没被优先读，就会写出记录
		fs.writeFileSync(legacyCfg, JSON.stringify({ enabled: true }), "utf8");
		fs.writeFileSync(userCfg, JSON.stringify({ enabled: false }), "utf8");

		const before9 = readLines().length;
		const hOff = await loadFresh();
		await hOff.before_agent_start({ type: "before_agent_start", prompt: "x", systemPrompt: "P", systemPromptOptions: { skills: [] } }, ctx);
		await hOff.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_off", toolName: "bash", args: { command: "echo nope" } }, ctx);
		await hOff.tool_execution_end({ type: "tool_execution_end", toolCallId: "call_off", toolName: "bash", result: "x", isError: false }, ctx);
		check(readLines().length === before9, `enabled:false 时仍在写日志（${before9} -> ${readLines().length}）（场景 9）`);
		check(!readLines().some((l) => l.includes("call_off")), "enabled:false 时写进了 call_off（场景 9）");

		// 打开后立刻恢复落盘
		fs.writeFileSync(userCfg, JSON.stringify({ enabled: true }), "utf8");
		const dOn = readLines().length;
		const hOn = await loadFresh();
		await hOn.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_on", toolName: "bash", args: { command: "echo yes" } }, ctx);
		check(readLines().length === dOn + 1, "enabled:true 时没恢复写日志（场景 9）");

		// 坏配置（非对象 / 类型不对）不影响主流程，仍按默认（开）写
		fs.writeFileSync(userCfg, "[1,2,3]", "utf8");
		const dBad = readLines().length;
		const hBad = await loadFresh();
		await hBad.tool_execution_start({ type: "tool_execution_start", toolCallId: "call_bad", toolName: "bash", args: {} }, ctx);
		check(readLines().length === dBad + 1, "坏配置时应该走默认（开）并继续写（场景 9）");
	} finally {
		fs.rmSync(legacyCfg, { force: true });
		fs.rmSync(userCfg, { force: true });
	}
}

// —— 红线：不许改写会话 ——
{
	const handlers3 = await loadFresh();
	const r1 = await handlers3.before_agent_start({ systemPrompt: "BASE", systemPromptOptions: { skills: [] } }, ctx);
	check(r1 === undefined, "before_agent_start 返回了东西 —— 审计必须对模型不可见");
	const r2 = await handlers3.tool_execution_start({ toolCallId: "c", toolName: "bash", args: {} }, ctx);
	check(r2 === undefined, "tool_execution_start 返回了东西");
	const r3 = await handlers3.input({ text: "hi", source: "interactive" }, ctx);
	check(r3 === undefined, "input 返回了东西");
}

console.log("临时审计目录：", tmp);
console.log("工具有效事件：", JSON.stringify(readRecords().filter((r) => r.event.startsWith("tool_")).map((r) => [r.event, r.toolCallId, r.truncated ?? false])));
console.log("脱敏后 argsPreview：", readRecords().find((r) => r.toolCallId === "call_3")?.argsPreview);
console.log("100KB 那次：整行字节数 =", Buffer.byteLength(readLines().find((l) => l.includes("call_4")), "utf8"), "，truncated =", readRecords().find((r) => r.toolCallId === "call_4")?.truncated);
console.log("总行数：", readLines().length);
console.log(problems.length === 0 ? "\n全部通过 ✓" : "\n问题：\n- " + problems.join("\n- "));

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(problems.length === 0 ? 0 : 1);
