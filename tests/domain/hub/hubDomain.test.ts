import { describe, expect, test } from 'bun:test'
import { isThreadId, parseTarget, topicTarget } from '../../../src/domain/hub/conversationTarget.ts'
import { isWithinProject, projectKey } from '../../../src/domain/hub/projectKey.ts'
import { RecentSet } from '../../../src/domain/hub/RecentSet.ts'
import {
  baseTopicName,
  MAX_TOPIC_NAME_LENGTH,
  uniqueTopicName,
} from '../../../src/domain/hub/topicName.ts'

describe('conversation targets', () => {
  test('a topic round-trips; a plain chat id stays a plain chat', () => {
    expect(topicTarget('-1001234567890', '42')).toBe('-1001234567890/42')
    expect(parseTarget('-1001234567890/42')).toEqual({ chatId: '-1001234567890', threadId: '42' })
    expect(parseTarget('5000000001')).toEqual({ chatId: '5000000001', threadId: undefined })
  })

  test.each(['-100/0', '-100/x', '-100/', 'abc/1', '-100/1/2', '/1', '-100/01'])(
    '%p is not a topic: treated as an opaque chat',
    (reference) => {
      expect(parseTarget(reference)).toEqual({ chatId: reference, threadId: undefined })
    },
  )

  test('only decimal ids make a target', () => {
    expect(() => topicTarget('-100', '0')).toThrow()
    expect(() => topicTarget('x', '1')).toThrow()
    expect(() => topicTarget('-100', '1/2')).toThrow()
    expect(isThreadId('7')).toBe(true)
    expect(isThreadId('07')).toBe(false)
  })
})

describe('topic names', () => {
  test('the project name, sanitized and bounded; never empty', () => {
    expect(baseTopicName('my-app')).toBe('my-app')
    expect(baseTopicName('evil\u202Ename\u0007')).not.toMatch(/[\u202E\u0007]/)
    expect(baseTopicName('  ')).toBe('session')
    expect(baseTopicName(undefined)).toBe('session')
    expect(baseTopicName('x'.repeat(500)).length).toBeLessThanOrEqual(64)
  })

  test('a taken name gets the first free suffix, ignoring case', () => {
    expect(uniqueTopicName('app', [])).toBe('app')
    expect(uniqueTopicName('app', ['APP'])).toBe('app (2)')
    expect(uniqueTopicName('app', ['app', 'app (2)'])).toBe('app (3)')
    expect(uniqueTopicName('x'.repeat(64), ['x'.repeat(64)]).length).toBeLessThanOrEqual(
      MAX_TOPIC_NAME_LENGTH,
    )
  })
})

describe('project keys', () => {
  test('separators and trailing slashes do not matter; case only where the OS ignores it', () => {
    expect(projectKey('C:\\Users\\me\\App\\', true)).toBe('c:/users/me/app')
    expect(projectKey('/home/me//App/', false)).toBe('/home/me/App')
    expect(projectKey('/', false)).toBe('/')
  })

  test('a directory inside the project belongs to it; a sibling with the same prefix does not', () => {
    expect(isWithinProject('/home/me/app', '/home/me/app')).toBe(true)
    expect(isWithinProject('/home/me/app', '/home/me/app/src')).toBe(true)
    expect(isWithinProject('/home/me/app', '/home/me/app-2')).toBe(false)
    expect(isWithinProject('/home/me/app', '/home/me')).toBe(false)
  })
})

test('a recent set keeps only its newest members', () => {
  const set = new RecentSet(2)
  set.add('a')
  set.add('b')
  set.add('a')
  set.add('c')
  expect(set.has('a')).toBe(true)
  expect(set.has('b')).toBe(false)
  expect(set.has('c')).toBe(true)
  expect(set.size).toBe(2)
  expect(set.delete('a')).toBe(true)
  expect(set.size).toBe(1)
})
