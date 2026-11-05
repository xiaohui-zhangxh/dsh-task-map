#!/usr/bin/env node
/**
 * make-fixtures.mjs —— 从真实 DSH 会话日志生成脱敏裁剪 fixture（M1 / W1.4a）
 *
 * 做什么：
 *   1) 把真实会话 `session.v4.jsonl.zstd` **复制**到仓库外的快照目录（源会话只读，绝不修改）；
 *   2) 用 `zstd -dc` 解压追加式多帧 zstd（Node 内置解压只解第一帧，不能用）；
 *   3) 解析 JSONL（容忍最后一行不完整：丢弃并记录）；
 *   4) 按白名单保留事件类型，逐类型裁剪/脱敏/截断 -> `test/fixtures/<slug>.jsonl`；
 *   5) 记录源/快照/fixture 的 sha256 与事件计数 -> `test/fixtures/MANIFEST.json`。
 *
 * 硬约束：
 *   - 源会话只读；所有产物只写 test/fixtures/ 与快照目录（仓库外）；
 *   - 不保留原始工具参数/工具输出/assistant 正文，避免泄露敏感内容；
 *   - 输出可复现：同一快照字节 -> 同一 fixture 字节（仅 MANIFEST.parsedAt 随时间变化）。
 *
 * 用法：
 *   node tools/make-fixtures.mjs
 *   TASK_MAP_SNAPSHOT_DIR=/tmp/snap node tools/make-fixtures.mjs
 *   DSH_SESSIONS_ROOT=~/.dsh/sessions node tools/make-fixtures.mjs
 *
 * 依赖：系统 `zstd` 命令（macOS: brew install zstd）。
 */

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

/** 快照目录默认在仓库外（不要提交）。 */
const DEFAULT_SNAPSHOT_DIR = '~/tmp/e2e-work/snapshots';
const SNAPSHOT_DIR = path.resolve(process.env.TASK_MAP_SNAPSHOT_DIR || DEFAULT_SNAPSHOT_DIR);
const SESSIONS_ROOT = path.resolve(
  process.env.DSH_SESSIONS_ROOT || path.join(os.homedir(), '.dsh', 'sessions'),
);

/** 3 个黄金会话（见交接文件 §6）。 */
const SESSIONS = [
  {
    slug: 'baklib-feishu-sso',
    projectDir: '--workspace-baklib--',
    sessionId: 'session-a1c3d78d-eaa0-405e-807d-3c037524a987',
  },
  {
    slug: 'p2p-athena-port',
    projectDir: '--workspace-hermes-workspaces--',
    sessionId: 'session-886d1772-1e3c-4283-8703-58d74949bf8a',
  },
  {
    slug: 'athena-plan-board',
    projectDir: '--workspace-hermes-workspaces--',
    sessionId: 'session-7959b49b-7cde-41fa-8cf1-8156e91ae060',
  },
];

/** 保留的事件类型（其余全部丢弃并计入 droppedTypes）。`session` 只保留首行头。 */
export const KEEP_TYPES = Object.freeze([
  'session',
  'session/title',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'team/task',
  'team/member',
  'todo/write',
  'tool/call',
  'tool/result',
  'job/registered',
  'job/settled',
  'approval/asked',
  'approval/decided',
  'subagent/catalog',
  'subagent/descriptor',
  'assistant/message',
  'deliverables/presented',
  'command/run',
  'command/done',
  'session/end-seed',
  'goal/change',
]);
const KEEP_SET = new Set(KEEP_TYPES);

const MAX_FIXTURE_BYTES = 1024 * 1024; // 单文件 < 1MB
const MAX_TOOL_ARGUMENTS_TOOL = 'task_map_record_relation'; // 唯一保留 argumuments 的工具

// ------------------------------ 小工具 ------------------------------

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function fail(msg) {
  console.error(`[make-fixtures] ERROR: ${msg}`);
  process.exit(1);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 统一脱敏：先按会话 cwd 归一化，再兜底处理剩余的 /Users/<user>/... 绝对路径。 */
function sanitizeText(text, cwdRaw) {
  if (typeof text !== 'string') return text;
  let out = text;
  const cwd = typeof cwdRaw === 'string' ? cwdRaw.replace(/\/+$/, '') : '';
  if (cwd) {
    const base = path.basename(cwd);
    out = out.replace(new RegExp(`${escapeRegExp(cwd)}(?![A-Za-z0-9._-])`, 'g'), `/workspace/${base}`);
  }
  // 兜底：/Users/<username>/<top> -> /workspace/<top>
  out = out.replace(/\/Users\/([^/\s"'`]+)\/([^/\s"'`]+)/g, (_m, _user, top) => `/workspace/${top}`);
  // 只剩裸用户名时：/Users/<username> -> /workspace
  out = out.replace(/\/Users\/([^/\s"'`]+)/g, '/workspace');
  return out;
}

function truncate(s, max) {
  if (typeof s !== 'string') return s;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 按 key 顺序从 src 拷贝存在的字段（缺失不补）；transform 可选。 */
function copyFields(src, fields) {
  const out = {};
  if (!isPlainObject(src)) return out;
  for (const field of fields) {
    const key = Array.isArray(field) ? field[0] : field;
    const transform = Array.isArray(field) ? field[1] : undefined;
    if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
    const value = src[key];
    if (value === undefined) continue;
    out[key] = transform ? transform(value) : value;
  }
  return out;
}

function sanitizeDeep(value, cwd) {
  if (typeof value === 'string') return sanitizeText(value, cwd);
  if (Array.isArray(value)) return value.map((item) => sanitizeDeep(item, cwd));
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) out[key] = sanitizeDeep(val, cwd);
    return out;
  }
  return value;
}

/** 交付物路径相对化：尽量相对会话 cwd；无法相对化则脱敏。 */
function relativizePath(rawPath, cwdRaw) {
  const p = sanitizeText(rawPath, cwdRaw);
  const cwd = typeof cwdRaw === 'string' ? cwdRaw.replace(/\/+$/, '') : '';
  if (cwd && typeof rawPath === 'string' && rawPath.startsWith(`${cwd}/`)) {
    return rawPath.slice(cwd.length + 1);
  }
  return p;
}

// ------------------------------ 快照与解压 ------------------------------

function snapshotAndDecompress(session) {
  const sourcePath = path.join(
    SESSIONS_ROOT,
    session.projectDir,
    session.sessionId,
    'session.v4.jsonl.zstd',
  );
  if (!fs.existsSync(sourcePath)) {
    fail(`真实会话不存在：${sourcePath}\n  请确认 DSH_SESSIONS_ROOT（当前 ${SESSIONS_ROOT}）`);
  }

  // 1) 复制快照（源会话只读；避免会话仍在追加写入时读到撕裂数据）
  const snapshotZstdPath = path.join(SNAPSHOT_DIR, `${session.slug}.session.v4.jsonl.zstd`);
  const snapshotJsonlPath = path.join(SNAPSHOT_DIR, `${session.slug}.jsonl`);
  fs.copyFileSync(sourcePath, snapshotZstdPath);
  const zstdBuf = fs.readFileSync(snapshotZstdPath);

  // 2) zstd -dc 解压（追加式多帧 zstd；Node zlib 只解第一帧，不能用）
  const res = spawnSync('zstd', ['-dc', snapshotZstdPath], {
    maxBuffer: 512 * 1024 * 1024,
    encoding: null,
  });
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      fail('未找到 `zstd` 命令。请先安装：brew install zstd');
    }
    fail(`执行 zstd -dc 失败：${res.error.message}`);
  }
  if (res.status !== 0) {
    fail(`zstd -dc 退出码 ${res.status}：${String(res.stderr || '').slice(0, 800)}`);
  }
  const jsonlBuf = res.stdout;
  fs.writeFileSync(snapshotJsonlPath, jsonlBuf);

  return {
    sourcePath,
    snapshotZstdPath,
    snapshotJsonlPath,
    sourceZstdSha256: sha256(zstdBuf),
    snapshotJsonlSha256: sha256(jsonlBuf),
    jsonlBuf,
  };
}

/** 解析 JSONL：容忍最后一行不完整（丢弃并记录），其它坏行直接报错。 */
function parseJsonl(buf) {
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let lastNonEmpty = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim()) lastNonEmpty = i;
  }
  const events = [];
  const incompleteTail = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      if (i === lastNonEmpty) {
        incompleteTail.push({ lineNo: i + 1, bytes: Buffer.byteLength(line) });
        continue;
      }
      fail(`JSONL 第 ${i + 1} 行解析失败（非末行，不静默丢弃）：${err.message}`);
    }
  }
  return { events, incompleteTail };
}

// ------------------------------ 逐类型裁剪 ------------------------------

/** session 头行：保留 type,version,id,createdAt,cwd(脱敏),agentPreset,isSeeded,delegationDepth，删其他。 */
function trimSessionHeader(ev, ctx) {
  return copyFields(ev, [
    'type',
    'version',
    'id',
    'createdAt',
    ['cwd', (v) => sanitizeText(v, v)],
    'agentPreset',
    'isSeeded',
    'delegationDepth',
  ]);
}

const S = (ctx, v) => sanitizeText(v, ctx.cwdRaw);
const T = (ctx, max) => (v) => truncate(sanitizeText(v, ctx.cwdRaw), max);

function trimEventData(ev, ctx) {
  const type = ev.type;
  const d = isPlainObject(ev.data) ? ev.data : {};
  switch (type) {
    case 'team/task': {
      const task = isPlainObject(d.task) ? d.task : {};
      const data = copyFields(d, ['version', ['teamId', (v) => S(ctx, v)]]);
      data.task = copyFields(task, [
        ['id', (v) => S(ctx, v)],
        'revision',
        ['subject', T(ctx, 200)],
        ['description', T(ctx, 300)],
        'status',
        ['blockedBy', (v) => (Array.isArray(v) ? v.map((x) => S(ctx, x)) : v)],
        [
          'writeScopes',
          (v) => (Array.isArray(v) ? v.slice(0, 20).map((x) => S(ctx, x)) : v),
        ],
        ['ownerId', (v) => S(ctx, v)],
      ]);
      return data;
    }
    case 'team/member': {
      const member = isPlainObject(d.member) ? d.member : {};
      const data = copyFields(d, ['version', ['teamId', (v) => S(ctx, v)]]);
      data.member = copyFields(member, [
        ['id', (v) => S(ctx, v)],
        ['name', T(ctx, 120)],
        ['description', T(ctx, 120)],
        'provider',
        'context',
        'phase',
      ]);
      return data;
    }
    case 'todo/write': {
      const todos = Array.isArray(d.todos) ? d.todos : [];
      return {
        todos: todos.slice(0, 100).map((todo) => {
          const t = isPlainObject(todo) ? todo : {};
          return copyFields(t, [['content', T(ctx, 120)], 'status']);
        }),
      };
    }
    case 'turn/start':
      return copyFields(d, ['turn']);
    case 'turn/end': {
      const data = copyFields(d, ['turn']);
      const reason = copyFields(d.reason, ['kind']);
      if (Object.keys(reason).length > 0) data.reason = reason;
      return data;
    }
    case 'step/start':
    case 'step/end':
      return copyFields(d, ['turn', 'step']);
    case 'tool/call': {
      const data = copyFields(d, ['turn', 'step', 'callId', 'name']);
      // 唯一例外：关系记录工具的参数需要保留（关系层数据源）
      if (data.name === MAX_TOOL_ARGUMENTS_TOOL && Object.prototype.hasOwnProperty.call(d, 'arguments')) {
        data.arguments = isPlainObject(d.arguments) || Array.isArray(d.arguments)
          ? sanitizeDeep(d.arguments, ctx.cwdRaw)
          : S(ctx, d.arguments);
      }
      return data;
    }
    case 'tool/result': {
      const data = copyFields(d, ['turn', 'step']);
      const msg = isPlainObject(d.message) ? d.message : {};
      const message = copyFields(msg, [['toolCallId', (v) => S(ctx, v)]]);
      if (msg.isError === true) message.isError = true; // 仅保留错误信号，false 不落盘
      data.message = message;
      if (Object.prototype.hasOwnProperty.call(d, 'error') && d.error !== undefined) {
        data.error = sanitizeDeep(d.error, ctx.cwdRaw);
      }
      return data; // data.meta 一律删除
    }
    case 'job/registered':
    case 'job/settled': {
      const fields = ['jobId', 'kind', 'startedAt'];
      if (type === 'job/settled') fields.push('finishedAt', 'status');
      const data = copyFields(d, fields);
      const toolCall = copyFields(d.toolCall, ['callId', 'rootCallId']);
      if (Object.keys(toolCall).length > 0) data.toolCall = toolCall;
      return data; // label/owner/detail/cause/producerReported 一律删除
    }
    case 'approval/asked':
      return copyFields(d, ['id', 'toolName', 'callId']); // reason 删除
    case 'approval/decided':
      return copyFields(d, ['id', 'outcome']);
    case 'subagent/catalog':
      return copyFields(d, [
        'version',
        ['childId', (v) => S(ctx, v)],
        'childCreatedAt',
        'mode',
        ['label', T(ctx, 120)],
      ]);
    case 'subagent/descriptor':
      return copyFields(d, [
        'version',
        ['childId', (v) => S(ctx, v)],
        'mode',
        'provider',
        ['label', T(ctx, 120)],
        'agentModel',
        'agentProvider',
      ]);
    case 'assistant/message': {
      const data = copyFields(d, ['turn', 'step']);
      const usage = copyFields(d.usage, [
        'inputTokens',
        'outputTokens',
        'cacheReadTokens',
        'cacheWriteTokens',
        'totalTokens',
      ]);
      if (Object.keys(usage).length > 0) data.usage = usage;
      return data; // message/stream/source 删除
    }
    case 'session/title':
      return copyFields(d, [['title', T(ctx, 120)]]);
    case 'deliverables/presented': {
      const data = copyFields(d, ['turn', ['callId', (v) => S(ctx, v)]]);
      const files = Array.isArray(d.files) ? d.files : [];
      data.files = files.slice(0, 50).map((file) => {
        const f = isPlainObject(file) ? file : {};
        const out = {};
        if (Object.prototype.hasOwnProperty.call(f, 'path')) {
          out.path = relativizePath(f.path, ctx.cwdRaw);
        }
        if (Object.prototype.hasOwnProperty.call(f, 'description')) {
          out.description = truncate(sanitizeText(f.description, ctx.cwdRaw), 120);
        }
        return out;
      });
      return data;
    }
    case 'command/run':
      return copyFields(d, ['commandId', 'name']);
    case 'command/done':
      return copyFields(d, ['kind', ['text', T(ctx, 120)]]);
    case 'session/end-seed':
      return copyFields(d, ['inherited']);
    case 'goal/change': {
      const data = copyFields(d, ['operation']);
      const goal = copyFields(d.goal, ['id', 'phase']);
      if (Object.keys(goal).length > 0) data.goal = goal;
      return data;
    }
    default:
      return null;
  }
}

// ------------------------------ 主流程 ------------------------------

function buildFixture(session) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });

  const snap = snapshotAndDecompress(session);
  const { events, incompleteTail } = parseJsonl(snap.jsonlBuf);

  const headerEvent = events.find((ev) => ev && ev.type === 'session');
  if (!headerEvent) fail(`${session.slug}: 快照首部缺少 session 头事件（文件损坏？）`);
  const ctx = { cwdRaw: typeof headerEvent.cwd === 'string' ? headerEvent.cwd : '' };

  const outLines = [];
  const droppedTypes = Object.create(null);
  const keptTypes = new Set();
  let keptEvents = 0;

  for (const ev of events) {
    const type = ev && ev.type;
    if (!KEEP_SET.has(type)) {
      droppedTypes[type] = (droppedTypes[type] || 0) + 1;
      continue;
    }
    let lineObj;
    if (type === 'session') {
      if (ev !== headerEvent) {
        // 只保留首行头；其余 session 事件按丢弃处理
        droppedTypes.session = (droppedTypes.session || 0) + 1;
        continue;
      }
      lineObj = trimSessionHeader(ev, ctx);
    } else {
      lineObj = { type: ev.type, seq: ev.seq, time: ev.time, data: trimEventData(ev, ctx) };
    }
    outLines.push(JSON.stringify(lineObj));
    keptEvents += 1;
    if (typeof type === 'string') keptTypes.add(type);
  }

  const fixtureBuf = Buffer.from(`${outLines.join('\n')}\n`, 'utf8');
  if (fixtureBuf.length >= MAX_FIXTURE_BYTES) {
    fail(
      `${session.slug}: fixture ${fixtureBuf.length} bytes 超过 1MB 上限，请收紧裁剪规则`,
    );
  }
  const fixturePath = path.join(FIXTURE_DIR, `${session.slug}.jsonl`);
  fs.writeFileSync(fixturePath, fixtureBuf);

  // 标题：最后一个 session/title（与 golden 口径一致）
  let title = null;
  for (const ev of events) {
    if (ev && ev.type === 'session/title' && isPlainObject(ev.data) && typeof ev.data.title === 'string') {
      title = ev.data.title;
    }
  }

  const entry = {
    slug: session.slug,
    sessionId: session.sessionId,
    sourceProject: session.projectDir,
    sourcePath: `<DSH_SESSIONS_ROOT>/${session.projectDir}/${session.sessionId}/session.v4.jsonl.zstd`,
    sourceZstdSha256: snap.sourceZstdSha256,
    snapshotJsonlSha256: snap.snapshotJsonlSha256,
    fixtureSha256: sha256(fixtureBuf),
    rawEventCount: events.length,
    keptEventCount: keptEvents,
    droppedTypes: Object.fromEntries(
      Object.entries(droppedTypes).sort(([a], [b]) => a.localeCompare(b)),
    ),
    keptTypes: [...keptTypes].sort(),
    bytes: fixtureBuf.length,
    title: title === null ? null : truncate(sanitizeText(title, ctx.cwdRaw), 120),
    cwdSanitized: sanitizeText(ctx.cwdRaw, ctx.cwdRaw),
    incompleteTailLines: incompleteTail.length,
    incompleteTailDetail: incompleteTail,
    parsedAt: new Date().toISOString(),
  };

  return { entry, eventsCount: events.length, keptEvents, dropped: events.length - keptEvents };
}

function main() {
  console.log(`[make-fixtures] 快照目录：${SNAPSHOT_DIR}`);
  console.log(`[make-fixtures] 会话根目录：${SESSIONS_ROOT}`);
  const entries = [];
  for (const session of SESSIONS) {
    const { entry, dropped } = buildFixture(session);
    entries.push(entry);
    const kb = (entry.bytes / 1024).toFixed(1);
    console.log(
      `[${entry.slug}] raw ${entry.rawEventCount} → kept ${entry.keptEventCount}（丢弃 ${dropped}）` +
        ` | ${kb} KB | fixture sha256 ${entry.fixtureSha256.slice(0, 12)}` +
        (entry.incompleteTailLines > 0 ? ` | ⚠ 末行不完整 ${entry.incompleteTailLines} 条` : ''),
    );
  }

  const manifest = {
    format: 1,
    generatedBy: 'tools/make-fixtures.mjs',
    sessions: entries,
    snapshotDirNote:
      '快照目录默认 ~/tmp/e2e-work/snapshots' +
      '（仓库外，不提交；可用环境变量 TASK_MAP_SNAPSHOT_DIR 覆盖）。' +
      '每个会话落盘两份：<slug>.session.v4.jsonl.zstd（源的字节级副本）与 <slug>.jsonl（zstd -dc 解压结果）；' +
      'handcalc.py 校验 <slug>.jsonl 的 sha256 与 snapshotJsonlSha256 一致。',
  };
  const manifestPath = path.join(FIXTURE_DIR, 'MANIFEST.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`[make-fixtures] MANIFEST -> ${manifestPath}`);
  console.log('[make-fixtures] OK');
}

main();
