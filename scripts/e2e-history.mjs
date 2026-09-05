import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PREFIX = 'DSCODE_HISTORY_ACCEPTANCE ';
const STANDARD = [
  'ask_user_question', 'bash', 'create_goal', 'edit', 'exit_plan_mode',
  'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list',
  'job_output', 'list_agents', 'ralph', 'read', 'read_image', 'send_message',
  'skill', 'subagent', 'subagent_fork', 'todo_write', 'update_goal',
  'web_fetch', 'web_search', 'workflow', 'write',
].sort();
const HISTORY = [
  'session_search', 'session_event_search', 'session_trace',
  'session_event_trace', 'session_event_read',
];
const ROSTER = [...STANDARD, ...HISTORY].sort();

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => part.text ?? '').join('\n');
  return '';
}

function fixture(body) {
  const messages = body.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role !== 'user') continue;
    const match = text(messages[index].content).match(/DSCODE_HISTORY_ACCEPTANCE (\{[^\n]*\})/u);
    if (match) return { spec: JSON.parse(match[1]), messages: messages.slice(index + 1) };
  }
}

// Only model replies are scripted; the installed runtime executes every tool.
// Each acceptance turn is bounded to one tool call and one final response.
export function historyReply(body) {
  const active = fixture(body);
  if (!active) return undefined;
  const { spec, messages } = active;
  if (spec.seed) return { text: spec.marker };
  if (messages.some(message => message.role === 'tool')) return { text: `HISTORY_DONE:${spec.case}` };
  if (messages.some(message => message.tool_calls?.length)) return { text: `HISTORY_MISSING_TOOL_RESULT:${spec.case}` };
  return { name: spec.name, arguments: spec.arguments };
}

export async function historyAcceptance({ runHeadless, readRequests, scratch, artifactDir }) {
  await mkdir(scratch, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  const root = await mkdtemp(join(scratch, 'history-'));
  const cwd = join(root, 'same-workspace');
  const otherCwd = join(root, 'other-workspace');
  await mkdir(cwd);
  await mkdir(otherCwd);
  // Supply no checkout config, preset YAML, or production session files.
  assert.deepEqual(await readdir(cwd), []);
  assert.deepEqual(await readdir(otherCwd), []);
  const token = randomUUID().replaceAll('-', '');
  const marker = `HISTORY_SAME_${token}`;
  const otherMarker = `HISTORY_OTHER_${token}`;
  const evidence = { cwd, otherCwd, marker, otherMarker, seeds: [], cases: [] };
  const artifact = join(artifactDir, `history-${token}.json`);
  const save = () => writeFile(artifact, `${JSON.stringify(evidence, null, 2)}\n`);
  const prompt = spec => `${PREFIX}${JSON.stringify(spec)}`;

  async function seed(workspace, value) {
    const offset = (await readRequests()).length;
    const result = await runHeadless({ cwd: workspace, preset: 'standard', prompt: prompt({ seed: true, marker: value }) });
    assert.equal(result.text, value, 'seed must complete through the actual headless runtime');
    assert.ok(result.sessionId, 'seed must return its real durable session id');
    const requests = (await readRequests()).slice(offset).filter(body => fixture(body)?.spec.marker === value);
    assert.ok(requests.length, 'seed must reach the gateway');
    for (const body of requests) assert.deepEqual((body.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort(), STANDARD);
    evidence.seeds.push({ workspace, result, requests });
    await save();
    return result.sessionId;
  }

  async function invoke(label, workspace, name, args) {
    const spec = { case: `${token}:${label}`, name, arguments: args };
    const offset = (await readRequests()).length;
    const result = await runHeadless({ cwd: workspace, preset: 'history', prompt: prompt(spec) });
    const requests = (await readRequests()).slice(offset).filter(body => fixture(body)?.spec.case === spec.case);
    const calls = new Map();
    const results = new Map();
    for (const body of requests) {
      assert.deepEqual((body.tools ?? []).map(tool => tool.function?.name ?? tool.name).sort(), ROSTER,
        `${label}: installed history roster must equal standard plus precisely five official tools`);
      for (const message of fixture(body).messages) {
        for (const call of message.tool_calls ?? []) calls.set(call.id, call);
        if (message.role === 'tool') results.set(message.tool_call_id, text(message.content));
      }
    }
    evidence.cases.push({ label, name, arguments: args, result, requests, toolResults: [...results] });
    await save();
    assert.equal(result.text, `HISTORY_DONE:${spec.case}`, `${label}: actual tool round must finish`);
    assert.equal(requests.length, 2, `${label}: bounded one-tool workflow must make two model requests`);
    assert.equal(calls.size, 1, `${label}: exactly one real tool invocation required`);
    const [id, call] = [...calls][0];
    assert.equal(call.function.name, name);
    assert.deepEqual(JSON.parse(call.function.arguments), args);
    assert.equal(results.size, 1, `${label}: real tool result must reach the model`);
    assert.ok(results.has(id), `${label}: tool result must match the issued call id`);
    return results.get(id);
  }

  try {
    const sameId = await seed(cwd, marker);
    const otherId = await seed(otherCwd, otherMarker);
    assert.notEqual(sameId, otherId);
    evidence.sameId = sameId;
    evidence.otherId = otherId;
    const found = await invoke('same-durable-search', cwd, 'session_search', { query: marker, availability: ['persisted'] });
    assert.ok(found.includes(`Session ${sameId}`) && found.includes(marker), 'same-cwd durable marker must be retrieved');
    assert.match(found, /Availability: persisted/u, 'fresh runtime must query persisted history');
    assert.ok(!found.includes(otherId) && !found.includes(otherMarker));
    const hidden = await invoke('other-workspace-search-hidden', cwd, 'session_search', { query: otherMarker });
    assert.match(hidden, /No prior session matches found\./u);
    assert.ok(!hidden.includes(otherId) && !hidden.includes(otherMarker));

    const events = await invoke('same-event-search', cwd, 'session_event_search', { session_id: sameId, query: marker });
    assert.ok(events.includes(`Session ${sameId}`) && events.includes(marker));
    const seqMatch = events.match(/\bseq (\d+) \|/u);
    assert.ok(seqMatch, 'event sequence must come from the real search result');
    const seq = Number(seqMatch[1]);
    const lineage = await invoke('same-session-lineage', cwd, 'session_trace', { session_id: sameId });
    assert.ok(lineage.includes(`Session ${sameId}`));
    assert.match(lineage, /Ancestors \(nearest first\):/u);
    assert.match(lineage, /Descendants:/u);
    assert.ok(!lineage.includes(otherId) && !lineage.includes(otherMarker));
    const eventTrace = await invoke('same-event-lineage', cwd, 'session_event_trace', { session_id: sameId, seq });
    assert.ok(eventTrace.includes(`Session ${sameId}`) && eventTrace.includes(`Target: seq ${seq} |`));
    assert.match(eventTrace, /Replacement chain:/u);
    assert.match(eventTrace, /Events cited directly as sources:/u);
    const raw = await invoke('same-event-read', cwd, 'session_event_read', { session_id: sameId, seq, before: 1, after: 1 });
    assert.ok(raw.includes(marker) && raw.includes(`Target event seq ${seq}:`));
    const eventJson = raw.match(/```json\n([\s\S]*?)\n```/u);
    assert.ok(eventJson, 'event read must return a full raw event');
    assert.equal(JSON.parse(eventJson[1]).seq, seq);

    // Establish that the denied target exists and is readable in its own workspace.
    const foreignEvents = await invoke('other-own-workspace-event-search', otherCwd, 'session_event_search', { session_id: otherId, query: otherMarker });
    assert.ok(foreignEvents.includes(otherMarker) && foreignEvents.includes(`Session ${otherId}`));
    const foreignSeq = foreignEvents.match(/\bseq (\d+) \|/u);
    assert.ok(foreignSeq);
    const otherSeq = Number(foreignSeq[1]);
    const foreignRaw = await invoke('other-own-workspace-event-read', otherCwd, 'session_event_read', { session_id: otherId, seq: otherSeq });
    assert.ok(foreignRaw.includes(otherMarker));

    for (const [label, args] of [
      ['explicit-other-id-filter', { query: otherMarker, session_ids: [otherId] }],
      ['explicit-other-parent-filter', { query: otherMarker, parent_session_ids: [otherId] }],
    ]) {
      const denied = await invoke(label, cwd, 'session_search', args);
      assert.match(denied, /No prior session matches found\./u);
      assert.ok(!denied.includes(otherId) && !denied.includes(otherMarker));
    }
    for (const [name, args] of [
      ['session_event_search', { session_id: otherId, query: otherMarker }],
      ['session_trace', { session_id: otherId }],
      ['session_event_trace', { session_id: otherId, seq: otherSeq }],
      ['session_event_read', { session_id: otherId, seq: otherSeq, before: 1, after: 1 }],
    ]) {
      const denied = await invoke(`deny-other-${name}`, cwd, name, args);
      assert.match(denied, /SESSION_QUERY_TOOL_UNAUTHORIZED|session target is outside the caller workspace/u,
        `${name}: access must fail by authorization, not missing data`);
      assert.ok(!denied.includes(otherId) && !denied.includes(otherMarker), `${name}: denial must not disclose target data`);
    }
    evidence.passed = true;
    await save();
    return { artifact, sameId, otherId, cases: evidence.cases.map(entry => entry.label), toolRoster: ROSTER };
  } catch (error) {
    evidence.failure = error.stack ?? String(error);
    await save();
    throw error;
  }
}
