/**
 * vr-mover.test.js
 *
 * In-browser unit tests for the vr-mover.js library.
 * No build step required — open tests.html in any modern browser.
 *
 * Test harness: tiny assert / test / run helpers at the top.
 * Tests mirror the C# logic ported in vr-mover.js.
 */

import {
  TimingCore,
  ContextManager,
  StreamingAPIExtractor,
  OperatingRound,
  Apis,
  parseArgs,
  LLMCore,
  timing,
} from './vr-mover.js';

// ---------------------------------------------------------------------------
// Micro test harness
// ---------------------------------------------------------------------------

let _passed = 0;
let _failed = 0;
const _results = [];

function assert(condition, message) {
  if (!condition) throw new Error(message ?? 'Assertion failed');
}

function assertEqual(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertApprox(a, b, msg, epsilon = 0.001) {
  if (Math.abs(a - b) > epsilon) {
    throw new Error(msg ?? `Expected ~${b}, got ${a}`);
  }
}

async function test(name, fn) {
  try {
    await fn();
    _passed++;
    _results.push({ name, ok: true });
  } catch (err) {
    _failed++;
    _results.push({ name, ok: false, error: err.message });
  }
}

export async function run() {
  // Reset between runs — otherwise clicking "Run All" twice doubles every count
  _passed = 0;
  _failed = 0;
  _results.length = 0;

  // ---------------------------------------------------------------------------
  // TimingCore
  // ---------------------------------------------------------------------------

  await test('TimingCore: nowMs returns non-negative number', () => {
    const t = new TimingCore();
    assert(t.nowMs() >= 0, 'nowMs should be >= 0');
  });

  await test('TimingCore: nowMs is monotonically non-decreasing', async () => {
    const t = new TimingCore();
    const a = t.nowMs();
    await new Promise(r => setTimeout(r, 10));
    const b = t.nowMs();
    assert(b >= a, `Expected b (${b}) >= a (${a})`);
  });

  await test('TimingCore: nowSec is nowMs/1000', () => {
    const t = new TimingCore();
    assertApprox(t.nowSec() * 1000, t.nowMs(), 'nowSec * 1000 ≈ nowMs', 2);
  });

  await test('TimingCore: now100ns is a BigInt', () => {
    const t = new TimingCore();
    assert(typeof t.now100ns() === 'bigint', 'now100ns should be BigInt');
  });

  await test('TimingCore: singleton timing is available', () => {
    assert(timing instanceof TimingCore, 'timing should be TimingCore instance');
  });

  // ---------------------------------------------------------------------------
  // StreamingAPIExtractor
  // ---------------------------------------------------------------------------

  await test('StreamingAPIExtractor: single complete chunk', () => {
    const ex = new StreamingAPIExtractor();
    const { calls } = ex.receiveChunk('CREATE("Chair");');
    assertEqual(calls.length, 1, 'Should produce 1 call');
    assertEqual(calls[0][0], 'CREATE');
    assertEqual(calls[0][1], '"Chair"');
  });

  await test('StreamingAPIExtractor: call split across two chunks', () => {
    const ex = new StreamingAPIExtractor();
    const r1 = ex.receiveChunk('CRE');
    assertEqual(r1.calls.length, 0, 'No complete calls yet');
    const r2 = ex.receiveChunk('ATE("Chair");');
    assertEqual(r2.calls.length, 1);
    assertEqual(r2.calls[0][0], 'CREATE');
    assertEqual(r2.calls[0][1], '"Chair"');
  });

  await test('StreamingAPIExtractor: multiple calls in one chunk', () => {
    const ex = new StreamingAPIExtractor();
    const { calls } = ex.receiveChunk('CREATE("Chair");\nMOVE("crt", x=1.0, y=0, z=2.5);');
    assertEqual(calls.length, 2);
    assertEqual(calls[0][0], 'CREATE');
    assertEqual(calls[1][0], 'MOVE');
  });

  await test('StreamingAPIExtractor: partial trailing buffer preserved', () => {
    const ex = new StreamingAPIExtractor();
    ex.receiveChunk('CREATE("Chair");\nMOVE("crt", x=1');
    // Partial MOVE not yet emitted
    const { calls } = ex.receiveChunk(', y=0, z=2.5);');
    assertEqual(calls.length, 1);
    assertEqual(calls[0][0], 'MOVE');
  });

  await test('StreamingAPIExtractor: reset clears buffer and record', () => {
    const ex = new StreamingAPIExtractor();
    ex.receiveChunk('CREATE("Chair");');
    ex.reset();
    assertEqual(ex.fullRecord(), '', 'fullRecord should be empty after reset');
    const { calls } = ex.receiveChunk('MOVE("id", x=1);');
    assertEqual(calls.length, 1, 'Should work normally after reset');
  });

  await test('StreamingAPIExtractor: fullRecord accumulates all chunks', () => {
    const ex = new StreamingAPIExtractor();
    ex.receiveChunk('CREATE');
    ex.receiveChunk('("Chair");');
    assert(ex.fullRecord().includes('CREATE'), 'fullRecord should include all text');
  });

  await test('StreamingAPIExtractor: FORWARD call with named args', () => {
    const ex = new StreamingAPIExtractor();
    const { calls } = ex.receiveChunk('FORWARD("crt", z=1);');
    assertEqual(calls[0][0], 'FORWARD');
    assertEqual(calls[0][1], '"crt", z=1');
  });

  // ---------------------------------------------------------------------------
  // parseArgs / Apis
  // ---------------------------------------------------------------------------

  await test('parseArgs: named args MOVE', () => {
    const r = parseArgs('"crt", x=10, y=0, z=3');
    assertEqual(r.id, 'crt');
    assertEqual(r.x, 10);
    assertEqual(r.y, 0);
    assertEqual(r.z, 3);
  });

  await test('parseArgs: positional SCALE', () => {
    const r = parseArgs('"id", 1.5, 1.5, 1.5');
    assertEqual(r.id, 'id');
    assertEqual(r.x, 1.5);
    assertEqual(r.y, 1.5);
    assertEqual(r.z, 1.5);
  });

  await test('parseArgs: negative value', () => {
    const r = parseArgs('"obj", x=-2.5, z=1');
    assertEqual(r.x, -2.5);
    assertEqual(r.z, 1);
  });

  await test('parseArgs: single id only', () => {
    const r = parseArgs('"Chair"');
    assertEqual(r.id, 'Chair');
    assert(!('x' in r), 'No x should be present');
  });

  await test('parseArgs: unquoted id tolerated', () => {
    const r = parseArgs('crt, x=1, z=2');
    assertEqual(r.id, 'crt');
    assertEqual(r.x, 1);
    assertEqual(r.z, 2);
  });

  await test('parseArgs: two instances do not share regex state', () => {
    // Interleave two extractors to ensure per-instance scan state
    const ex1 = new StreamingAPIExtractor();
    const ex2 = new StreamingAPIExtractor();
    ex1.receiveChunk('CREATE("Cha');
    const r2 = ex2.receiveChunk('MOVE("a", x=1);');
    assertEqual(r2.calls.length, 1, 'ex2 should match independently');
    const r1 = ex1.receiveChunk('ir");');
    assertEqual(r1.calls.length, 1, 'ex1 should complete its own call');
    assertEqual(r1.calls[0][0], 'CREATE');
  });

  await test('Apis.CREATE: extracts id', () => {
    assertEqual(Apis.CREATE('"Chair"'), { id: 'Chair' });
  });

  await test('Apis.DELETE: extracts id', () => {
    assertEqual(Apis.DELETE('"obj-123"'), { id: 'obj-123' });
  });

  await test('Apis.MESSAGE: extracts content', () => {
    assertEqual(Apis.MESSAGE('"Hello world"'), { content: 'Hello world' });
  });

  await test('Apis.MOVE: delegates to parseArgs', () => {
    const r = Apis.MOVE('"crt", x=1, y=0, z=2');
    assertEqual(r.id, 'crt');
    assertEqual(r.x, 1);
  });

  await test('Apis.SCALE: positional floats', () => {
    const r = Apis.SCALE('"obj", 2, 2, 2');
    assertEqual(r.x, 2);
    assertEqual(r.y, 2);
    assertEqual(r.z, 2);
  });

  // ---------------------------------------------------------------------------
  // ContextManager
  // ---------------------------------------------------------------------------

  await test('ContextManager: system prompt is first message', () => {
    const cm = new ContextManager('System msg', 5);
    assertEqual(cm.messages()[0], { role: 'system', content: 'System msg' });
  });

  await test('ContextManager: fewshot pair pinned after system', () => {
    const cm = new ContextManager('Sys', 5, 'UserEx', 'AssistEx');
    const msgs = cm.messages();
    assertEqual(msgs[1], { role: 'user', content: 'UserEx' });
    assertEqual(msgs[2], { role: 'assistant', content: 'AssistEx' });
  });

  await test('ContextManager: insertUser adds user message', () => {
    const cm = new ContextManager('Sys', 5);
    cm.insertUser('Hello');
    const msgs = cm.messages();
    assert(msgs.some(m => m.role === 'user' && m.content === 'Hello'));
  });

  await test('ContextManager: insertAssistant fills assistant side', () => {
    const cm = new ContextManager('Sys', 5);
    cm.insertUser('Hello');
    cm.insertAssistant('World');
    const msgs = cm.messages();
    assert(msgs.some(m => m.role === 'assistant' && m.content === 'World'));
  });

  await test('ContextManager: insertAssistant append mode', () => {
    const cm = new ContextManager('Sys', 5);
    cm.insertUser('Q');
    cm.insertAssistant('Part1', false);
    cm.insertAssistant('Part2', true);
    const msgs = cm.messages();
    const asst = msgs.find(m => m.role === 'assistant');
    assert(asst.content.includes('Part1') && asst.content.includes('Part2'), 'Should concat');
  });

  await test('ContextManager: rolling window maxLen=2', () => {
    const cm = new ContextManager('Sys', 2);
    for (let i = 0; i < 5; i++) {
      cm.insertUser(`U${i}`);
      cm.insertAssistant(`A${i}`);
    }
    const msgs = cm.messages();
    // System + last 2 pairs = 1 + 4 = 5 messages
    assertEqual(msgs.length, 5);
    // Oldest pair rolled off
    assert(!msgs.some(m => m.content === 'U0'), 'U0 should be rolled off');
    assert(msgs.some(m => m.content === 'U4'), 'U4 should be present');
  });

  await test('ContextManager: fewshot pinned even with rolling window', () => {
    const cm = new ContextManager('Sys', 1, 'UserEx', 'AssistEx');
    cm.insertUser('Q1');
    cm.insertAssistant('A1');
    cm.insertUser('Q2');
    cm.insertAssistant('A2');
    const msgs = cm.messages();
    // System + fewshot(2) + 1 pair = 5 messages
    assert(msgs.some(m => m.content === 'UserEx'), 'fewshot user pinned');
    assert(msgs.some(m => m.content === 'AssistEx'), 'fewshot assistant pinned');
    assert(msgs.some(m => m.content === 'Q2'), 'latest Q present');
    assert(!msgs.some(m => m.content === 'Q1'), 'Q1 rolled off');
  });

  await test('ContextManager: pairCount tracks insertions', () => {
    const cm = new ContextManager('Sys', 5);
    assertEqual(cm.pairCount, 0);
    cm.insertUser('Q1');
    assertEqual(cm.pairCount, 1);
    cm.insertUser('Q2');
    assertEqual(cm.pairCount, 2);
  });

  // ---------------------------------------------------------------------------
  // OperatingRound
  // ---------------------------------------------------------------------------

  await test('OperatingRound: starts empty', () => {
    const r = new OperatingRound();
    assert(r.empty);
    assertEqual(r.confirmedText, '');
  });

  await test('OperatingRound: addText accumulates confirmedText', () => {
    const r = new OperatingRound();
    r.addText({ text: 'Move the chair' });
    r.addText({ text: 'to the left' });
    assertEqual(r.confirmedText, 'Move the chair to the left');
    assert(!r.empty);
  });

  await test('OperatingRound: addHit returns sequential ids', () => {
    const r = new OperatingRound();
    const id1 = r.addHit({ position: { x: 1, y: 0, z: 1 } });
    const id2 = r.addHit({ position: { x: 2, y: 0, z: 2 } });
    assertEqual(id1, 'h-1');
    assertEqual(id2, 'h-2');
  });

  await test('OperatingRound: addDrawing returns sequential ids', () => {
    const r = new OperatingRound();
    const id1 = r.addDrawing({ points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] });
    const id2 = r.addDrawing({ points: [{ x: 2, z: 2 }] });
    assertEqual(id1, 'l-1');
    assertEqual(id2, 'l-2');
  });

  await test('OperatingRound: removeHit withdraws hit', () => {
    const r = new OperatingRound();
    const id = r.addHit({ position: { x: 1, y: 0, z: 1 } });
    assertEqual(r._hits.length, 1);
    r.removeHit(id);
    assertEqual(r._hits.length, 0);
  });

  await test('OperatingRound: buildRequestText no markers', () => {
    const r = new OperatingRound();
    r.addText({ text: 'move the chair' });
    const { userRequest, userRequestWithActions } = r.buildRequestText();
    assertEqual(userRequest, 'move the chair');
    assertEqual(userRequestWithActions, 'move the chair');
  });

  await test('OperatingRound: buildRequestText appends markers when no timing', () => {
    const r = new OperatingRound();
    r.addText({ text: 'put a table here', startMs: 0, endMs: 0 });
    r.addHit({ position: { x: 1, y: 0, z: 1 } });
    const { userRequestWithActions } = r.buildRequestText();
    assert(userRequestWithActions.includes('[<h-1>]'), 'Should include hit marker');
  });

  await test('OperatingRound: timed marker inserted after the spoken word', () => {
    const r = new OperatingRound();
    // 5 words over 1000–6000ms → word end-times: 2000, 3000, 4000, 5000, 6000
    r.addText({ text: 'put a chair here please', startMs: 1000, endMs: 6000 });
    r.addHit({ position: { x: 1, y: 0, z: 1 }, timeMs: 4500 }); // during "here"
    const { userRequestWithActions } = r.buildRequestText();
    assertEqual(userRequestWithActions, 'put a chair here [<h-1>] please');
  });

  await test('OperatingRound: marker after speech goes after last word', () => {
    const r = new OperatingRound();
    r.addText({ text: 'move it there', startMs: 1000, endMs: 2000 });
    r.addHit({ position: { x: 1, y: 0, z: 1 }, timeMs: 9999 });
    const { userRequestWithActions } = r.buildRequestText();
    assertEqual(userRequestWithActions, 'move it there [<h-1>]');
  });

  await test('OperatingRound: markers across multiple speech segments', () => {
    const r = new OperatingRound();
    r.addText({ text: 'put a chair', startMs: 1000, endMs: 2500 });  // ends: 1500, 2000, 2500
    r.addText({ text: 'over there',  startMs: 3000, endMs: 4000 });  // ends: 3500, 4000
    r.addHit({ position: { x: 1, y: 0, z: 1 }, timeMs: 3600 }); // during "there"
    const { userRequestWithActions } = r.buildRequestText();
    assertEqual(userRequestWithActions, 'put a chair over there [<h-1>]');
  });

  await test('OperatingRound: serialize returns valid JSON', () => {
    const r = new OperatingRound();
    r.addText({ text: 'test' });
    const json = r.serialize();
    const parsed = JSON.parse(json);
    assert('user_request' in parsed, 'Should have user_request');
    assert('objects' in parsed, 'Should have objects');
    assert('hit_points' in parsed, 'Should have hit_points');
  });

  await test('OperatingRound: serialize includes hit points', () => {
    const r = new OperatingRound();
    r.addText({ text: 'place here' });
    r.addHit({ object: 'WallX', position: { x: 9.94, y: 1.4, z: 6.18 },
                normal: { x: -1, y: 0, z: 0 } });
    const parsed = JSON.parse(r.serialize());
    assertEqual(parsed.hit_points.points.length, 1);
    assertEqual(parsed.hit_points.points[0].hit_id, 'h-1');
    assertEqual(parsed.hit_points.points[0].object, 'WallX');
  });

  await test('OperatingRound: removeDrawing withdraws drawing', () => {
    const r = new OperatingRound();
    const id = r.addDrawing({ points: [{ x: 0, z: 0 }, { x: 1, z: 1 }] });
    assertEqual(r._drawings.length, 1);
    r.removeDrawing(id);
    assertEqual(r._drawings.length, 0);
  });

  await test('OperatingRound: serialize honours requestTextOverride', () => {
    const r = new OperatingRound();
    r.addText({ text: 'this text is ignored by the override' });
    r.addHit({ position: { x: 1, y: 0, z: 1 } });
    const parsed = JSON.parse(r.serialize({
      requestTextOverride: 'put a picture here [<h-1>] please',
    }));
    assertEqual(parsed.user_request_with_actions_inserted,
                'put a picture here [<h-1>] please');
    assertEqual(parsed.user_request, 'put a picture here please');
  });

  await test('OperatingRound: requestTextOverride strips start/end tokens too', () => {
    const r = new OperatingRound();
    r.addText({ text: 'x' });
    const parsed = JSON.parse(r.serialize({
      requestTextOverride: 'rotate along [<l-1>start] [<l-1>end] this line',
    }));
    assertEqual(parsed.user_request, 'rotate along this line');
  });

  // ---------------------------------------------------------------------------
  // LLMCore (with mocked fetch)
  // ---------------------------------------------------------------------------

  /** Build a fake ReadableStream of SSE chunks */
  function makeFakeSSEStream(calls) {
    const lines = calls.map(c => `data: ${JSON.stringify(c)}\n\n`);
    lines.push('data: [DONE]\n\n');
    const encoder = new TextEncoder();
    let idx = 0;
    return new ReadableStream({
      pull(controller) {
        if (idx >= lines.length) { controller.close(); return; }
        controller.enqueue(encoder.encode(lines[idx++]));
      },
    });
  }

  function makeFakeStreamResponse(content) {
    const words = content.split(' ');
    const chunks = words.map((w, i) => ({
      choices: [{ delta: { content: (i === 0 ? w : ' ' + w) } }],
    }));
    chunks.push({ usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 } });
    return {
      ok: true,
      body: makeFakeSSEStream(chunks),
    };
  }

  await test('LLMCore: constructor throws without required opts', () => {
    let threw = false;
    try { new LLMCore({}); } catch { threw = true; }
    assert(threw, 'Should throw without required opts');
  });

  await test('LLMCore: invokeChat fires onCall for each API call', async () => {
    const llmContent = 'CREATE("Chair");\nMOVE("crt", x=1.0, y=0.05, z=2.0);';
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => makeFakeStreamResponse(llmContent);

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'You are a test assistant.',
    });

    const calls = [];
    const round = new OperatingRound();
    round.addText({ text: 'put a chair here' });

    await llm.invokeChat(round, { onCall: (fn, args) => calls.push({ fn, args }) });
    globalThis.fetch = origFetch;

    assert(calls.length >= 1, `Expected >= 1 call, got ${calls.length}`);
    assert(calls.some(c => c.fn === 'CREATE'), 'Should have CREATE call');
  });

  await test('LLMCore: invokeChat returns timing report', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => makeFakeStreamResponse('CREATE("Chair");');

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'Test.',
    });

    const round = new OperatingRound();
    round.addText({ text: 'test' });
    const report = await llm.invokeChat(round, {});
    globalThis.fetch = origFetch;

    assert('requestSentAt' in report, 'report.requestSentAt');
    assert('totalMs' in report, 'report.totalMs');
    assert(report.totalMs >= 0, 'totalMs >= 0');
  });

  await test('LLMCore: invokeChat sends correct request body shape', async () => {
    let capturedBody;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return makeFakeStreamResponse('MESSAGE("ok");');
    };

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o-mini',
      systemPrompt: 'Test.',
      maxTokens: 512,
      streaming: true,
    });

    const round = new OperatingRound();
    round.addText({ text: 'hello' });
    await llm.invokeChat(round, {});
    globalThis.fetch = origFetch;

    assertEqual(capturedBody.model, 'gpt-4o-mini');
    assertEqual(capturedBody.max_tokens, 512);
    assert(capturedBody.stream === true, 'stream should be true');
    assert(Array.isArray(capturedBody.messages), 'messages should be array');
    assert(capturedBody.messages[0].role === 'system', 'first message should be system');
    assert('stream_options' in capturedBody, 'stream_options should be present when streaming');
  });

  await test('LLMCore: context is updated after invokeChat', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => makeFakeStreamResponse('CREATE("Table");');

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'Test.',
    });

    const round = new OperatingRound();
    round.addText({ text: 'add a table' });
    await llm.invokeChat(round, {});
    globalThis.fetch = origFetch;

    // After the call, context should have user + assistant messages
    const msgs = llm.context.messages();
    assert(msgs.some(m => m.role === 'user'), 'Should have user message in context');
    assert(msgs.some(m => m.role === 'assistant'), 'Should have assistant message in context');
  });

  await test('LLMCore: onError called on HTTP error', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => 'Unauthorized' });

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'bad-key',
      model: 'gpt-4o',
      systemPrompt: 'Test.',
    });

    let errorCaught = false;
    const round = new OperatingRound();
    round.addText({ text: 'test' });
    await llm.invokeChat(round, { onError: () => { errorCaught = true; } });
    globalThis.fetch = origFetch;

    assert(errorCaught, 'onError should be called on HTTP error');
  });

  await test('LLMCore: updateConfig(contextLength) keeps system prompt + fewshot', async () => {
    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'SysP',
      userFewshot: 'FewU',
      assistantFewshot: 'FewA',
    });
    llm.updateConfig({ contextLength: 3 });
    const msgs = llm.context.messages();
    assertEqual(msgs[0], { role: 'system', content: 'SysP' });
    assertEqual(msgs[1], { role: 'user', content: 'FewU' });
    assertEqual(msgs[2], { role: 'assistant', content: 'FewA' });
  });

  await test('LLMCore: updateConfig(systemPrompt) swaps prompt, keeps fewshot', async () => {
    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'OldSys',
      userFewshot: 'FewU',
      assistantFewshot: 'FewA',
      contextLength: 4,
    });
    llm.context.insertUser('old conversation');
    llm.context.insertAssistant('old reply');
    llm.updateConfig({ systemPrompt: 'NewSys' });
    const msgs = llm.context.messages();
    assertEqual(msgs[0], { role: 'system', content: 'NewSys' });
    assertEqual(msgs[1], { role: 'user', content: 'FewU' });
    assertEqual(msgs[2], { role: 'assistant', content: 'FewA' });
    assertEqual(msgs.length, 3, 'conversation history should start fresh');
  });

  await test('LLMCore: invokeChatText works without a round', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => makeFakeStreamResponse('MESSAGE("Hello");');

    const llm = new LLMCore({
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
      systemPrompt: 'Test.',
    });

    const messages = [];
    await llm.invokeChatText('Hi there', {
      onMessage: (content) => messages.push(content),
    });
    globalThis.fetch = origFetch;

    assert(messages.length > 0, 'Should receive at least one MESSAGE call');
  });

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------

  return { passed: _passed, failed: _failed, results: _results };
}
