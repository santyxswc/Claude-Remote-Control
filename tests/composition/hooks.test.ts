/** The hook listener follows polling: only the poller listens, and it retries a busy endpoint. */
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { openState, type StateStores } from '../../src/adapters/storage/openState.ts'
import { messagesFor } from '../../src/application/i18n/messages.ts'
import type {
  HookEventSource,
  HookListenResult,
  HookPayloadHandler,
} from '../../src/application/ports/HookEventSource.ts'
import {
  buildHookListener,
  createSessionTracking,
  HOOK_LISTEN_RETRY_MS,
  type HookListener,
} from '../../src/composition/hooks.ts'
import { buildPermissions } from '../../src/composition/permissions.ts'
import {
  FakeChatGateway,
  FakeClock,
  FakePromptGateway,
  FakeVerdicts,
  ManualEvery,
  MemoryLogger,
} from '../fakes.ts'
import { makeTempDir, removeTempDir } from '../tempDir.ts'

class FakeHookSource implements HookEventSource {
  results: HookListenResult[] = []
  handler: HookPayloadHandler | undefined
  starts = 0
  stops = 0

  async start(handler: HookPayloadHandler): Promise<HookListenResult> {
    this.starts += 1
    const result = this.results.shift() ?? 'listening'
    if (result === 'listening') this.handler = handler
    return result
  }

  async stop(): Promise<void> {
    this.stops += 1
    this.handler = undefined
  }
}

let dir: string
let state: StateStores
let source: FakeHookSource
let timers: ManualEvery
let listener: HookListener

beforeEach(() => {
  dir = makeTempDir()
  const clock = new FakeClock()
  state = openState(dir, {}, clock)
  source = new FakeHookSource()
  timers = new ManualEvery()
  const logger = new MemoryLogger()
  const messages = messagesFor('en')
  const chat = new FakeChatGateway()
  const prompts = new FakePromptGateway()
  listener = buildHookListener({
    state,
    source,
    chat,
    tracking: createSessionTracking(clock),
    permissions: buildPermissions({
      state,
      outbound: Object.assign(chat, {
        sendPrompt: prompts.sendPrompt.bind(prompts),
        editPrompt: prompts.editPrompt.bind(prompts),
        answerCallback: prompts.answerCallback.bind(prompts),
      }),
      verdicts: new FakeVerdicts(),
      messages,
      clock,
      logger,
      canRelay: () => true,
    }),
    messages,
    clock,
    logger,
    every: timers.every,
  })
})

afterEach(async () => {
  await listener.stop()
  state.db.close()
  removeTempDir(dir)
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

test('listens while polling, stops when polling stops', async () => {
  listener.onPollingStarted()
  await flush()
  expect(source.handler).toBeDefined()
  listener.onPollingStopped()
  await flush()
  expect(source.handler).toBeUndefined()
})

test('an endpoint still held by another live process is retried until it is free', async () => {
  source.results = ['in_use', 'in_use']
  listener.onPollingStarted()
  await flush()
  expect(timers.intervals()).toEqual([HOOK_LISTEN_RETRY_MS])
  timers.tick(HOOK_LISTEN_RETRY_MS)
  await flush()
  expect(source.handler).toBeUndefined()
  timers.tick(HOOK_LISTEN_RETRY_MS)
  await flush()
  expect(source.handler).toBeDefined()
  expect(source.starts).toBe(3)
  expect(timers.intervals()).toEqual([])
})

test('the retry ends when polling ends', async () => {
  source.results = ['in_use']
  listener.onPollingStarted()
  await flush()
  listener.onPollingStopped()
  expect(timers.intervals()).toEqual([])
})
