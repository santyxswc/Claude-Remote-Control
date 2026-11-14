import { expect, test } from 'bun:test'
import { DevChatGateway, type DevReply } from '../../../src/adapters/dev/DevChatGateway.ts'

test('delivers replies to every subscriber until it unsubscribes', async () => {
  const gateway = new DevChatGateway()
  const first: DevReply[] = []
  const second: DevReply[] = []
  const unsubscribeFirst = gateway.subscribe((reply) => first.push(reply))
  gateway.subscribe((reply) => second.push(reply))

  await gateway.sendText('dev', 'one')
  unsubscribeFirst()
  await gateway.sendText('dev', 'two')

  expect(first).toEqual([{ chat_id: 'dev', text: 'one' }])
  expect(second).toEqual([
    { chat_id: 'dev', text: 'one' },
    { chat_id: 'dev', text: 'two' },
  ])
})

test('sending with no subscriber succeeds and goes nowhere', async () => {
  await expect(new DevChatGateway().sendText('dev', 'unseen')).resolves.toEqual({
    parts: 1,
    redactions: 0,
  })
})
