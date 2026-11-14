import { expect, test } from 'bun:test'
import { isAffirmative, messagesFor, parseLocale } from '../../src/application/i18n/messages.ts'

test('Spanish is the default; en and es are recognised', () => {
  expect(parseLocale(undefined)).toBe('es')
  expect(parseLocale('')).toBe('es')
  expect(parseLocale('fr')).toBe('es')
  expect(parseLocale(' EN ')).toBe('en')
  expect(parseLocale('es')).toBe('es')
})

test('both catalogs define the same messages', () => {
  expect(Object.keys(messagesFor('en')).sort()).toEqual(Object.keys(messagesFor('es')).sort())
})

test('claimants are shown with name, handle and numeric id', () => {
  const view = { displayName: 'Alice A', username: 'alice', id: '111' }
  expect(messagesFor('en').pairClaimedBy(view)).toBe('Code received from: Alice A (@alice), id 111')
  expect(messagesFor('es').pairClaimedBy({ ...view, username: undefined })).toBe(
    'Código recibido de: Alice A, id 111',
  )
})

test.each([['s'], ['Sí'], ['si'], ['y'], [' YES ']])('%p is a yes', (answer) => {
  expect(isAffirmative(answer)).toBe(true)
})

test.each([[''], ['n'], ['no'], ['sure'], ['yes please']])('%p is not a yes', (answer) => {
  expect(isAffirmative(answer)).toBe(false)
})
