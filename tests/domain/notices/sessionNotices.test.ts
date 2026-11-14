import { expect, test } from 'bun:test'
import { attentionTrigger, projectName } from '../../../src/domain/notices/sessionNotices.ts'

test('notification types that ask for the owner', () => {
  expect(attentionTrigger('idle_prompt')).toBe('idle')
  expect(attentionTrigger('permission_prompt')).toBe('permission')
  expect(attentionTrigger('elicitation_dialog')).toBe('other')
  expect(attentionTrigger('elicitation_url_dialog')).toBe('other')
  expect(attentionTrigger('agent_needs_input')).toBe('other')
  expect(attentionTrigger(undefined)).toBe('other')
})

test('other and unknown types send nothing', () => {
  for (const type of ['auth_success', 'elicitation_complete', 'agent_completed', 'new_kind']) {
    expect(attentionTrigger(type)).toBeUndefined()
  }
})

test('project name is the last directory segment on any OS', () => {
  expect(projectName('/home/me/code/my-app')).toBe('my-app')
  expect(projectName('/home/me/code/my-app/')).toBe('my-app')
  expect(projectName('C:\\Users\\me\\PARA BACKUP\\Claude-Remote-Control')).toBe(
    'Claude-Remote-Control',
  )
  expect(projectName('C:\\')).toBeUndefined()
  expect(projectName('/')).toBeUndefined()
  expect(projectName(undefined)).toBeUndefined()
  expect(projectName(`/x/${'a'.repeat(200)}`)).toHaveLength(80)
})

test('the project name shown in a notice is sanitized', () => {
  expect(projectName('/home/me/evil\u{202e}\u001b[2Kname')).toBe('evil [2Kname')
})
