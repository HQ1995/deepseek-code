import assert from 'node:assert/strict';

const PREFIX = 'NATIVE_GOAL_E2E_';
const DEADLINE = 15_000;
const MAX_ROUNDS = 3;

function textOf(message) {
  if (typeof message?.content === 'string') return message.content;
  return (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
}

// Route only the latest user message. Old goal prompts in resumed history must
// never hijack a later ordinary request. Native wrapup notices are user messages.
export function goalReply(body) {
  const messages = body.messages ?? [];
  const userIndex = messages.findLastIndex(message => message.role === 'user');
  const prompt = textOf(messages[userIndex]);
  const scenario = prompt.match(/\bNATIVE_GOAL_E2E_(LIFECYCLE|ROUNDS|COMPLETE)\b/)?.[1];
  if (!scenario) return undefined;
  const round = Number(prompt.match(/\bRound: (\d+)\//)?.[1] ?? 0);
  if (round > MAX_ROUNDS) throw new Error(`Goal ${scenario} exceeded ${MAX_ROUNDS} admitted rounds`);
  if (prompt.includes('<goal_complete>')) {
    assert.equal(scenario, 'COMPLETE', 'Only completion scenario may receive native wrapup');
    return { text: 'NATIVE_GOAL_COMPLETION_VERIFIED: two native rounds ran; get_goal supplied the exact revision used by update_goal.' };
  }
  if (!prompt.includes('<goal_round>')) return undefined;
  assert.ok(round > 0, 'Native goal prompt must contain a positive round number');
  if (scenario === 'LIFECYCLE') return { text: `NATIVE_GOAL_LIFECYCLE_HELD_${round}`, hold: true };
  if (round === 1) return { text: `NATIVE_GOAL_${scenario}_ROUND_ONE_FINISHED` };
  if (scenario === 'ROUNDS') return { text: `NATIVE_GOAL_ROUNDS_HELD_${round}`, hold: true };

  // Match result IDs to actual calls in this round, never an earlier round's CAS.
  const suffix = messages.slice(userIndex + 1);
  const calls = new Map(suffix.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call.function]));
  const results = suffix.filter(message => message.role === 'tool');
  const updated = results.find(message => calls.get(message.tool_call_id)?.name === 'update_goal');
  if (updated) {
    const value = JSON.parse(textOf(updated));
    assert.equal(value.goal?.phase, 'complete', 'Native update_goal did not complete the goal');
    return { text: 'NATIVE_GOAL_COMPLETION_VERIFIED: native update_goal confirmed completion.' };
  }
  const read = results.findLast(message => calls.get(message.tool_call_id)?.name === 'get_goal');
  if (!read) return { name: 'get_goal', arguments: {} };
  const { goal } = JSON.parse(textOf(read));
  assert.ok(goal?.id && Number.isSafeInteger(goal.revision), 'get_goal must provide a real id and revision');
  assert.ok(goal.objective.includes(`${PREFIX}COMPLETE`), 'get_goal returned another scenario objective');
  assert.equal(goal.phase, 'active', 'Completion requires the actual active goal');
  return { name: 'update_goal', arguments: { goal_id: goal.id, revision: goal.revision, action: 'complete' } };
}

export async function goalAcceptance(ui) {
  async function observed(label, predicate) {
    await ui.waitState(state => {
      assert.ok(!state.goal || state.goal.roundsStarted <= MAX_ROUNDS, `${label}: native round upper bound exceeded`);
      return predicate(state);
    }, label, DEADLINE);
    const state = await ui.state();
    assert.ok(predicate(state), `${label}: native state changed before assertion: ${JSON.stringify(state)}`);
    await ui.artifact(`goal-${label}`, { state, screen: await ui.capture() });
    return state;
  }
  async function visible(pattern, label) {
    await ui.wait(pattern, DEADLINE);
    assert.match(await ui.capture(), pattern, label);
  }
  async function quiet(label, goal) {
    // Bounded observation across multiple ticks, not one idle snapshot.
    for (let tick = 0; tick < 8; tick++) {
      await ui.settle(250);
      const state = await ui.state();
      assert.equal(state.status, 'idle', `${label}: automatic execution restarted`);
      assert.equal(state.goal?.id, goal.id, `${label}: goal identity changed`);
      assert.equal(state.goal?.revision, goal.revision, `${label}: durable revision changed`);
      assert.equal(state.goal?.phase, goal.phase, `${label}: durable phase changed`);
      assert.equal(state.goal?.roundsStarted, goal.roundsStarted, `${label}: another round was admitted`);
      assert.equal(state.goal?.activation, 'disarmed', `${label}: continuation became armed`);
    }
    await ui.artifact(`goal-${label}`, { state: await ui.state(), screen: await ui.capture() });
  }
  let clears = 0;
  async function clear() {
    await ui.send('/goal clear');
    await visible(/Goal cleared\./, 'Clear command must report success');
    await observed(`cleared-${++clears}`, state => !state.goal && state.status === 'idle');
    await ui.send('/goal');
    await visible(/No goal is currently set\./, 'Empty /goal must report no current goal');
  }

  await ui.send(`/goal ${PREFIX}LIFECYCLE`);
  await visible(/NATIVE_GOAL_LIFECYCLE_HELD_1/, 'Create must start the first real goal round');
  const created = await observed('created', state => state.goal?.objective === `${PREFIX}LIFECYCLE` && state.goal.phase === 'active' && state.goal.activation === 'armed' && state.goal.roundsStarted === 1 && state.status !== 'idle');
  await ui.send('/goal pause');
  await visible(/Goal paused/, 'Pause command must report success');
  const paused = await observed('paused-current-turn', state => state.status === 'idle' && state.goal?.id === created.goal.id && state.goal.phase === 'paused' && state.goal.activation === 'disarmed');
  assert.equal(paused.goal.revision, created.goal.revision + 1, 'Host pause must persist exactly one native pause and abort the held turn');
  assert.equal(paused.goal.roundsStarted, created.goal.roundsStarted, 'Host pause must not admit another round');
  await ui.key('C-c');
  await observed('paused-cancelled', state => state.status === 'idle' && state.goal?.phase === 'paused');
  await quiet('paused-no-continuation', paused.goal);

  await ui.send(`/goal edit ${PREFIX}LIFECYCLE edited`);
  await visible(/Goal updated/, 'Edit command must report success');
  const edited = await observed('edited', state => state.goal?.id === created.goal.id && state.goal.objective === `${PREFIX}LIFECYCLE edited` && state.goal.phase === 'paused');
  assert.ok(edited.goal.revision > paused.goal.revision, 'Editing must advance the same goal revision');
  await ui.send('/goal resume');
  await visible(/NATIVE_GOAL_LIFECYCLE_HELD_2/, 'Resume must admit the next real round');
  const resumed = await observed('resumed', state => state.goal?.id === created.goal.id && state.goal.phase === 'active' && state.goal.activation === 'armed' && state.goal.roundsStarted === 2);
  await ui.key('C-c');
  // Alpha host cancellation pauses the goal; activation is separate from durable phase.
  const cancelled = await observed('within-round-cancelled', state => state.status === 'idle' && state.goal?.id === resumed.goal.id && state.goal.phase === 'paused' && state.goal.activation === 'disarmed');
  assert.equal(cancelled.goal.revision, resumed.goal.revision + 1, 'Cancellation must persist exactly one native pause');
  assert.equal(cancelled.goal.roundsStarted, resumed.goal.roundsStarted, 'Cancellation must not admit another round');
  await quiet('cancel-no-continuation', cancelled.goal);
  await ui.restart();
  const restored = await observed('restored-paused-disarmed', state => state.status === 'idle' && state.goal?.id === cancelled.goal.id && state.goal.phase === 'paused' && state.goal.activation === 'disarmed');
  assert.deepEqual(restored.goal, cancelled.goal, 'Fresh leader must replay the same native goal identity, revision, counters, and objective');
  await quiet('restore-no-continuation', restored.goal);
  await ui.send('/goal');
  await visible(/Activation: disarmed/, 'Restored status must show disarmed activation');
  await ui.key('C-c');
  await quiet('disarmed-idle-cancel-is-noop', restored.goal);
  await clear();

  await ui.send(`/goal ${PREFIX}ROUNDS`);
  await visible(/NATIVE_GOAL_ROUNDS_HELD_2/, 'A finished first round must automatically continue into round two');
  const rounds = await observed('second-round-running', state => state.goal?.objective === `${PREFIX}ROUNDS` && state.goal.roundsStarted === 2 && state.goal.activation === 'armed' && state.status !== 'idle');
  await ui.key('C-c');
  const stopped = await observed('second-round-cancelled', state => state.status === 'idle' && state.goal?.id === rounds.goal.id && state.goal.activation === 'disarmed');
  assert.equal(stopped.goal.roundsStarted, 2, 'Ctrl+C must prevent admission of round three');
  await quiet('second-round-no-continuation', stopped.goal);
  await clear();

  await ui.send(`/goal ${PREFIX}COMPLETE`);
  await visible(/NATIVE_GOAL_COMPLETION_VERIFIED/, 'Completion must return from real goal tools to the terminal');
  const completed = await observed('completed', state => state.status === 'idle' && state.goal?.objective === `${PREFIX}COMPLETE` && state.goal.phase === 'complete' && state.goal.activation === 'disarmed');
  assert.equal(completed.goal.roundsStarted, 2, 'Completion must happen in the second native round');
  await visible(/Goal complete\./, 'Live completion must display its one-shot celebration');
  await quiet('complete-no-continuation', completed.goal);
  await ui.restart();
  const hydrated = await observed('completed-hydrated', state => state.status === 'idle' && state.goal?.id === completed.goal.id && state.goal.phase === 'complete');
  assert.deepEqual(hydrated.goal, completed.goal, 'Completed hydration must preserve the exact native goal');
  await quiet('completed-hydration-no-continuation', hydrated.goal);
  assert.doesNotMatch(await ui.capture(), /Goal complete\./, 'Fresh completed hydration must not repeat the one-shot celebration');
  await ui.send('/goal');
  await visible(/Status: complete/, 'Completed goal remains inspectable after fresh hydration');
  await clear();
}
