import { expect, test } from 'bun:test'
import type { InboundMessage } from '../../../src/application/pipeline/InboundMessage.ts'
import { PermissionVerdictStep } from '../../../src/application/pipeline/PermissionVerdictStep.ts'
import { ALICE, FakeChatGateway } from '../../fakes.ts'
import { en, incoming, permissionHarness } from '../permissionHarness.ts'

async function setup(inputPreview = '{"command":"ls"}') {
  const h = permissionHarness()
  await h.relay.execute(incoming({ inputPreview }))
  const chat = new FakeChatGateway()
  const step = new PermissionVerdictStep(h.resolve, chat, en, h.logger)
  const passed: InboundMessage[] = []
  const send = (text: string) =>
    step.handle(
      {
        chatId: ALICE.id,
        messageId: '1',
        chatKind: 'private',
        sender: ALICE,
        text,
        sentAt: 0,
      },
      async (m) => void passed.push(m),
    )
  return { ...h, chat, passed, send }
}

test.each([['yes abcde'], ['y abcde'], ['  Yes ABCDE  '], ['si abcde'], ['Sí abcde']])(
  '%p approves and is not forwarded',
  async (text) => {
    const h = await setup()
    await h.send(text)
    expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'allow' }])
    expect(h.passed).toEqual([])
    expect(h.chat.sent.map((s) => s.text)).toEqual([en.permissionFeedback('approved')])
  },
)

test.each([['no abcde'], ['n abcde'], ['NO abcde']])('%p denies', async (text) => {
  const h = await setup()
  await h.send(text)
  expect(h.verdicts.sent).toEqual([{ requestId: 'abcde', behavior: 'deny' }])
  expect(h.passed).toEqual([])
})

test.each([
  ['yes'],
  ['approve abcde'],
  ['yes abcde please'],
  ['yes abcdl'],
  ['yes abcdL'],
  ['no puedo'], // looks like a verdict, names no request: it is a normal message
  ['yes zzzzz'],
])('%p goes on to the session', async (text) => {
  const h = await setup()
  await h.send(text)
  expect(h.passed.map((m) => m.text)).toEqual([text])
  expect(h.verdicts.sent).toEqual([])
})

test('high risk cannot be approved by text: the sender is told to use the buttons', async () => {
  const h = await setup('{"command":"rm -rf /"}')
  await h.send('yes abcde')
  expect(h.verdicts.sent).toEqual([])
  expect(h.chat.sent.map((s) => s.text)).toEqual([en.permissionFeedback('use_button')])
  expect(h.passed).toEqual([])
})
