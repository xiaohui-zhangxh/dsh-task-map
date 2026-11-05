#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""handcalc.py —— M1 / W1.4b 独立手算黄金值（Python 标准库，不读 lib/derive.js）

输入：`make-fixtures.mjs` 落盘的**解压快照** `<slug>.jsonl`（真实会话冻结副本）。
      默认目录同 make-fixtures：~/tmp/e2e-work/snapshots
      （可用 --snapshots 或环境变量 TASK_MAP_SNAPSHOT_DIR 覆盖）。
输出：docs/golden-values.json（ensure_ascii=False, indent=2, sort_keys=True）。

口径：严格按 M1 下发 SPEC 逐条实现；所有时间戳保持原始毫秒整数，所有求和为整数毫秒。
自校验：读取 test/fixtures/MANIFEST.json，逐会话比对快照 sha256（以及 fixture sha256），不一致退出非 0。

用法：
  python3 tools/handcalc.py
  python3 tools/handcalc.py --snapshots /tmp/snap
"""

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SNAPSHOT_DIR = '~/tmp/e2e-work/snapshots'
MANIFEST_PATH = REPO_ROOT / 'test' / 'fixtures' / 'MANIFEST.json'
FIXTURE_DIR = REPO_ROOT / 'test' / 'fixtures'
GOLDEN_PATH = REPO_ROOT / 'docs' / 'golden-values.json'

# 与 tools/make-fixtures.mjs 完全一致的保留事件类型（`session` 只作头行）
KEEP_TYPES = frozenset([
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
])

USAGE_FIELDS = (
    ('inputTokens', 'input'),
    ('outputTokens', 'output'),
    ('cacheReadTokens', 'cacheRead'),
    ('cacheWriteTokens', 'cacheWrite'),
    ('totalTokens', 'total'),
)


def fail(msg):
    print('[handcalc] ERROR: %s' % msg, file=sys.stderr)
    sys.exit(1)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def sanitize_cwd(cwd_raw):
    """与 fixture 生成规则一致：cwd -> /workspace/<basename>。"""
    if not isinstance(cwd_raw, str) or cwd_raw == '':
        return ''
    return '/workspace/' + os.path.basename(cwd_raw.rstrip('/'))


def parse_snapshot(path):
    """解析快照 JSONL（容错：仅允许末行不完整，其余坏行直接报错）。"""
    text = path.read_text(encoding='utf-8')
    lines = text.split('\n')
    last_non_empty = -1
    for idx, line in enumerate(lines):
        if line.strip():
            last_non_empty = idx
    events = []
    skipped_tail = 0
    for idx, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError as exc:
            if idx == last_non_empty:
                skipped_tail += 1
                continue
            fail('%s 第 %d 行 JSON 解析失败（非末行）：%s' % (path.name, idx + 1, exc))
    if skipped_tail:
        print('[handcalc] WARN %s: 丢弃末行不完整事件 %d 条' % (path.name, skipped_tail),
              file=sys.stderr)
    return events


def event_data(ev):
    data = ev.get('data')
    return data if isinstance(data, dict) else {}


def fold_tasks(events):
    """按文件顺序折叠 team/task 全量快照（口径见 SPEC 第 2 条）。"""
    tasks = {}  # 保持首次出现顺序；输出时 sort_keys 会重排
    for ev in events:
        if ev.get('type') != 'team/task':
            continue
        data = event_data(ev)
        task = data.get('task')
        if not isinstance(task, dict) or task.get('id') is None:
            continue
        tid = task['id']
        at = ev.get('time')
        status = task.get('status')
        rec = tasks.get(tid)
        if rec is None:
            rec = {
                'id': tid,
                'createdAt': at,
                'phases': [{'status': status, 'at': at}],
                'startedAt': None,
                'completedAt': None,
                'updatedAt': at,
                'blockedBy': [],
                'writeScopes': [],
                'subject': '',
                'revision': None,
                'ownerId': None,
                'status': status,
            }
            tasks[tid] = rec
        else:
            if status != rec['status']:
                rec['phases'].append({'status': status, 'at': at})
            rec['status'] = status
        # 首次出现某状态的时间（不因后续快照回退而改变）
        if status == 'in_progress' and rec['startedAt'] is None:
            rec['startedAt'] = at
        if status == 'completed' and rec['completedAt'] is None:
            rec['completedAt'] = at
        rec['updatedAt'] = at
        rec['blockedBy'] = list(task.get('blockedBy') or [])
        rec['writeScopes'] = list(task.get('writeScopes') or [])
        rec['subject'] = task.get('subject') or ''
        rec['revision'] = task.get('revision')
        if task.get('ownerId'):
            rec['ownerId'] = task['ownerId']
    return tasks


def fold_members(events):
    """team/member 按 id 取最后一次 name（口径见 SPEC 第 17 条）。"""
    members = {}
    for ev in events:
        if ev.get('type') != 'team/member':
            continue
        member = event_data(ev).get('member')
        if not isinstance(member, dict) or member.get('id') is None:
            continue
        if 'name' in member:
            members[member['id']] = member.get('name')
    return members


def owner_of(owner_id, session_id, members):
    if owner_id is None:
        return None, False
    if owner_id == session_id:
        return 'Lead', True
    if owner_id in members:
        return members[owner_id], False
    return owner_id, False


def fold_turns(events):
    """turn/start 与 turn/end 按 data.turn 配对（口径见 SPEC 第 6 条）。"""
    records = []
    index = {}
    for ev in events:
        typ = ev.get('type')
        if typ not in ('turn/start', 'turn/end'):
            continue
        data = event_data(ev)
        turn = data.get('turn')
        if typ == 'turn/start':
            if turn in index:
                # 重复 start：保留首次 start，不新增记录
                continue
            rec = {'turn': turn, 'start': ev.get('time'), 'end': None}
            index[turn] = rec
            records.append(rec)
        else:
            rec = index.get(turn)
            if rec is None:
                rec = {'turn': turn, 'start': None, 'end': ev.get('time')}
                index[turn] = rec
                records.append(rec)
            elif rec['end'] is None:
                rec['end'] = ev.get('time')
    return records


def paired_ms(events, tool_name):
    """工具调用与 tool/result 按 callId 配对求和；未配对不计时长（口径见 SPEC 第 9/10 条）。"""
    calls = {}
    total = 0
    for ev in events:
        typ = ev.get('type')
        if typ == 'tool/call':
            data = event_data(ev)
            if data.get('name') == tool_name:
                calls[data.get('callId')] = ev.get('time')
        elif typ == 'tool/result':
            data = event_data(ev)
            message = data.get('message') if isinstance(data.get('message'), dict) else {}
            call_id = message.get('toolCallId')
            if call_id in calls:
                total += ev.get('time') - calls.pop(call_id)
    return total


def approval_ms(events):
    asked = {}
    total = 0
    for ev in events:
        typ = ev.get('type')
        if typ == 'approval/asked':
            asked[event_data(ev).get('id')] = ev.get('time')
        elif typ == 'approval/decided':
            approval_id = event_data(ev).get('id')
            if approval_id in asked:
                total += ev.get('time') - asked.pop(approval_id)
    return total


def compute_session(slug, events):
    header = None
    for ev in events:
        if ev.get('type') == 'session':
            header = ev
            break
    if header is None:
        fail('%s: 快照缺少 session 头行' % slug)

    session_id = header.get('id')
    session_created = header.get('createdAt')
    cwd_raw = header.get('cwd') or ''
    cwd = sanitize_cwd(cwd_raw)

    filtered = [ev for ev in events if ev.get('type') in KEEP_TYPES and ev.get('type') != 'session']

    # 1) 标题：最后一个 session/title；lastEventTime：过滤后事件最大 time
    title = None
    last_event_time = None
    for ev in filtered:
        typ = ev.get('type')
        if typ == 'session/title':
            candidate = event_data(ev).get('title')
            if isinstance(candidate, str):
                title = candidate
        at = ev.get('time')
        if isinstance(at, int) and (last_event_time is None or at > last_event_time):
            last_event_time = at
    wall_clock = last_event_time - session_created if last_event_time is not None else None

    # 2) 任务折叠 + 成员映射
    tasks = fold_tasks(filtered)
    members = fold_members(filtered)

    # 3) 负责人映射
    owners = {}
    for tid, rec in tasks.items():
        owners[tid] = owner_of(rec['ownerId'], session_id, members)

    # 4) 排序与排名
    order = [
        rec['id']
        for rec in sorted(tasks.values(), key=lambda r: (r['createdAt'], r['id']))
    ]
    started_sorted = sorted(
        (r for r in tasks.values() if r['startedAt'] is not None),
        key=lambda r: (r['startedAt'], r['createdAt'], r['id']),
    )
    completed_sorted = sorted(
        (r for r in tasks.values() if r['completedAt'] is not None),
        key=lambda r: (r['completedAt'], r['createdAt'], r['id']),
    )
    start_rank = {r['id']: idx + 1 for idx, r in enumerate(started_sorted)}
    done_rank = {r['id']: idx + 1 for idx, r in enumerate(completed_sorted)}

    # 5) 任务指标
    out_tasks = {}
    for tid, rec in tasks.items():
        started = rec['startedAt']
        completed = rec['completedAt']
        queue_ms = started - rec['createdAt'] if started is not None else None
        exec_ms = completed - started if started is not None and completed is not None else None

        ready_at = None
        blocked_wait_ms = None
        ready_delay_ms = None
        if rec['blockedBy']:
            blocker_completed = []
            all_done = True
            for blocker_id in rec['blockedBy']:
                blocker = tasks.get(blocker_id)
                if blocker is None or blocker['completedAt'] is None:
                    all_done = False
                    break
                blocker_completed.append(blocker['completedAt'])
            if all_done:
                ready_at = max(blocker_completed)
                blocked_wait_ms = ready_at - rec['createdAt']
                ready_delay_ms = started - ready_at if started is not None else None

        owner, owner_is_lead = owners[tid]
        out_tasks[tid] = {
            'status': rec['status'],
            'createdAt': rec['createdAt'],
            'startedAt': started,
            'completedAt': completed,
            'updatedAt': rec['updatedAt'],
            'owner': owner,
            'ownerIsLead': owner_is_lead,
            'blockedBy': list(rec['blockedBy']),
            'startRank': start_rank.get(tid),
            'doneRank': done_rank.get(tid),
            'phases': rec['phases'],
            'execMs': exec_ms,
            'queueMs': queue_ms,
            'blockedWaitMs': blocked_wait_ms,
            'readyAt': ready_at,
            'readyDelayMs': ready_delay_ms,
        }

    # 6) 回合与首轮前等待
    turns = fold_turns(filtered)
    if turns and turns[0]['start'] is not None:
        pre_turn_ms = turns[0]['start'] - session_created
    else:
        pre_turn_ms = None
    pre_turn_restored = pre_turn_ms is not None and pre_turn_ms < 0

    # 7) 人工空闲：相邻 turn 的 prev.end -> next.start
    idle_segments = []
    human_idle_ms = 0
    for prev, nxt in zip(turns, turns[1:]):
        if prev['end'] is None or nxt['start'] is None:
            continue
        gap = nxt['start'] - prev['end']
        if gap > 0:
            idle_segments.append({
                'afterTurn': prev['turn'],
                'start': prev['end'],
                'end': nxt['start'],
                'ms': gap,
            })
            human_idle_ms += gap

    # 8) waits 层求和（跳过 null）
    queue_ms_sum = sum(t['queueMs'] for t in out_tasks.values() if t['queueMs'] is not None)
    blocked_ms_sum = sum(
        t['blockedWaitMs'] for t in out_tasks.values() if t['blockedWaitMs'] is not None
    )
    ready_delay_ms_sum = sum(
        t['readyDelayMs'] for t in out_tasks.values() if t['readyDelayMs'] is not None
    )
    task_exec_ms_sum = sum(t['execMs'] for t in out_tasks.values() if t['execMs'] is not None)

    # 9/10) 代理等待、用户问答、审批等待
    wait_agent_ms = paired_ms(filtered, 'wait_agent')
    ask_user_ms = paired_ms(filtered, 'ask_user_question')
    approval_wait_ms = approval_ms(filtered)

    # 11) 任务交接间隔
    handoffs = []
    for prev in tasks.values():
        if prev['completedAt'] is None:
            continue
        candidates = [
            r
            for r in tasks.values()
            if r['startedAt'] is not None and r['startedAt'] > prev['completedAt']
        ]
        if not candidates:
            continue
        nxt = min(candidates, key=lambda r: (r['startedAt'], r['createdAt'], r['id']))
        handoffs.append({
            'from': prev['id'],
            'to': nxt['id'],
            'gapMs': nxt['startedAt'] - prev['completedAt'],
        })
    handoffs.sort(key=lambda h: (h['gapMs'], h['from'], h['to']))
    max_handoff_ms = max((h['gapMs'] for h in handoffs), default=None)

    # 12) token 用量
    usage = {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 0}
    for ev in filtered:
        if ev.get('type') != 'assistant/message':
            continue
        raw_usage = event_data(ev).get('usage')
        if not isinstance(raw_usage, dict):
            continue
        for src_key, dst_key in USAGE_FIELDS:
            usage[dst_key] += int(raw_usage.get(src_key) or 0)

    # 13) counters
    counters = {
        'toolCalls': 0,
        'jobs': 0,
        'approvals': 0,
        'subagents': 0,
        'todoWrites': 0,
        'teammates': 0,
        'waitAgents': 0,
        'askUsers': 0,
    }
    # 14) spans 辅助集合
    call_ids = set()
    result_call_ids = set()
    job_ids = set()
    settled_job_ids = set()
    asked_ids = set()
    decided_ids = set()
    error_count = 0
    killed_count = 0

    for ev in filtered:
        typ = ev.get('type')
        data = event_data(ev)
        if typ == 'todo/write':
            counters['todoWrites'] += 1
        elif typ == 'job/registered':
            counters['jobs'] += 1
            job_ids.add(data.get('jobId'))
        elif typ == 'job/settled':
            settled_job_ids.add(data.get('jobId'))
            if data.get('status') == 'killed':
                killed_count += 1
        elif typ == 'approval/asked':
            counters['approvals'] += 1
            asked_ids.add(data.get('id'))
        elif typ == 'approval/decided':
            decided_ids.add(data.get('id'))
        elif typ == 'subagent/catalog':
            counters['subagents'] += 1
        elif typ == 'tool/call':
            counters['toolCalls'] += 1
            call_ids.add(data.get('callId'))
            name = data.get('name')
            if name == 'spawn_teammate':
                counters['teammates'] += 1
            elif name == 'wait_agent':
                counters['waitAgents'] += 1
            elif name == 'ask_user_question':
                counters['askUsers'] += 1
        elif typ == 'tool/result':
            message = data.get('message') if isinstance(data.get('message'), dict) else {}
            result_call_ids.add(message.get('toolCallId'))
            if data.get('error') or message.get('isError'):
                error_count += 1

    spans = {
        'tool': counters['toolCalls'],
        'job': counters['jobs'],
        'approval': counters['approvals'],
        'openCount': (
            len(call_ids - result_call_ids)
            + len(job_ids - settled_job_ids)
            + len(asked_ids - decided_ids)
        ),
        'errorCount': error_count,
        'killedCount': killed_count,
    }

    # 15) 任务状态统计（按最终 status）
    task_stats = {'total': len(out_tasks), 'pending': 0, 'in_progress': 0, 'completed': 0, 'failed': 0}
    for task in out_tasks.values():
        status = task['status']
        if status in task_stats and status != 'total':
            task_stats[status] += 1

    # 16) 关系记录（本三会话预计为空）
    relations = []
    for ev in filtered:
        if ev.get('type') != 'tool/call':
            continue
        data = event_data(ev)
        if data.get('name') != 'task_map_record_relation':
            continue
        arguments = data.get('arguments')
        if isinstance(arguments, str):
            try:
                parsed = json.loads(arguments)
            except json.JSONDecodeError:
                print('[handcalc] WARN %s: task_map_record_relation 参数不是合法 JSON，跳过 seq=%s'
                      % (slug, ev.get('seq')), file=sys.stderr)
                continue
        elif isinstance(arguments, dict):
            parsed = arguments
        else:
            continue
        if not isinstance(parsed, dict):
            continue
        relations.append({
            'parent': parsed.get('parent_task'),
            'children': parsed.get('children'),
            'kind': parsed.get('kind'),
            'recordedAt': ev.get('time'),
            'seq': ev.get('seq'),
        })

    # 17) 成员映射
    agents = {member_id: name for member_id, name in members.items()}

    waits = {
        'preTurnMs': pre_turn_ms,
        'preTurnRestored': pre_turn_restored,
        'humanIdleMs': human_idle_ms,
        'idleSegments': idle_segments,
        'queueMs': queue_ms_sum,
        'blockedMs': blocked_ms_sum,
        'readyDelayMs': ready_delay_ms_sum,
        'taskExecMs': task_exec_ms_sum,
        'waitAgentMs': wait_agent_ms,
        'askUserMs': ask_user_ms,
        'approvalMs': approval_wait_ms,
        'wallClockMs': wall_clock,
        'maxHandoffMs': max_handoff_ms,
        'handoffs': handoffs,
    }

    return {
        'slug': slug,
        'sessionId': session_id,
        'title': title,
        'cwd': cwd,
        'sessionCreatedAt': session_created,
        'taskCount': len(out_tasks),
        'order': order,
        'tasks': out_tasks,
        'waits': waits,
        'turns': turns,
        'usage': usage,
        'counters': counters,
        'spans': spans,
        'taskStats': task_stats,
        'relations': relations,
        'agents': agents,
        'leadSessionId': session_id,
    }


def main():
    parser = argparse.ArgumentParser(description='独立手算 3 个真实会话的黄金指标')
    parser.add_argument('--snapshots', default=None,
                        help='解压快照目录（默认 $TASK_MAP_SNAPSHOT_DIR 或内置路径）')
    args = parser.parse_args()

    snapshot_dir = Path(
        args.snapshots
        or os.environ.get('TASK_MAP_SNAPSHOT_DIR')
        or DEFAULT_SNAPSHOT_DIR
    )
    if not snapshot_dir.is_dir():
        fail('快照目录不存在：%s（请先运行 node tools/make-fixtures.mjs）' % snapshot_dir)
    if not MANIFEST_PATH.is_file():
        fail('MANIFEST 不存在：%s（请先运行 node tools/make-fixtures.mjs）' % MANIFEST_PATH)

    manifest = json.loads(MANIFEST_PATH.read_text(encoding='utf-8'))
    sessions_meta = manifest.get('sessions') or []
    if not sessions_meta:
        fail('MANIFEST.sessions 为空')

    golden_sessions = {}
    snapshot_hashes = {}
    fixture_hashes = {}

    for meta in sessions_meta:
        slug = meta.get('slug')
        snapshot_path = snapshot_dir / ('%s.jsonl' % slug)
        if not snapshot_path.is_file():
            fail('缺少解压快照：%s（请先运行 node tools/make-fixtures.mjs）' % snapshot_path)

        # 自校验：快照 sha256 与 MANIFEST 一致
        actual_snapshot_sha = sha256_file(snapshot_path)
        expected_snapshot_sha = meta.get('snapshotJsonlSha256')
        if actual_snapshot_sha != expected_snapshot_sha:
            fail('%s 快照 sha256 不一致：实际 %s != MANIFEST %s'
                 % (slug, actual_snapshot_sha, expected_snapshot_sha))
        snapshot_hashes[slug] = actual_snapshot_sha

        # 额外自校验：fixture sha256 与 MANIFEST 一致
        fixture_path = FIXTURE_DIR / ('%s.jsonl' % slug)
        if fixture_path.is_file():
            actual_fixture_sha = sha256_file(fixture_path)
            expected_fixture_sha = meta.get('fixtureSha256')
            if actual_fixture_sha != expected_fixture_sha:
                fail('%s fixture sha256 不一致：实际 %s != MANIFEST %s'
                     % (slug, actual_fixture_sha, expected_fixture_sha))
            fixture_hashes[slug] = actual_fixture_sha
        else:
            print('[handcalc] WARN 缺少 fixture %s，仅记录 MANIFEST 中的哈希' % fixture_path,
                  file=sys.stderr)
            fixture_hashes[slug] = meta.get('fixtureSha256')

        events = parse_snapshot(snapshot_path)
        session = compute_session(slug, events)
        golden_sessions[slug] = session

        waits = session['waits']
        print('[handcalc] %s: tasks=%d turns=%d wallClock=%.1fmin preTurn=%s'
              % (slug, session['taskCount'], len(session['turns']),
                 (waits['wallClockMs'] or 0) / 60000.0,
                 '%.1fmin' % (waits['preTurnMs'] / 60000.0) if waits['preTurnMs'] is not None else 'null'),
              file=sys.stderr)
        print('[handcalc]   tasks all completed=%s | queue=%.1fmin exec=%.1fmin waitAgent=%.1fmin '
              'askUser=%.1fmin approval=%.1fs'
              % (all(t['status'] == 'completed' for t in session['tasks'].values()),
                 waits['queueMs'] / 60000.0, waits['taskExecMs'] / 60000.0,
                 waits['waitAgentMs'] / 60000.0, waits['askUserMs'] / 60000.0,
                 waits['approvalMs'] / 1000.0),
              file=sys.stderr)

    golden = {
        'format': 1,
        'source': {
            'snapshotSha256': snapshot_hashes,
            'fixtureSha256': fixture_hashes,
        },
        'sessions': golden_sessions,
    }
    GOLDEN_PATH.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN_PATH.write_text(
        json.dumps(golden, ensure_ascii=False, indent=2, sort_keys=True) + '\n',
        encoding='utf-8',
    )
    print('[handcalc] OK -> %s' % GOLDEN_PATH, file=sys.stderr)


if __name__ == '__main__':
    main()
