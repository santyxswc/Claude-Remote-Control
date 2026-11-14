import { describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'node:stream'
import { ConsoleTerminal, InputCancelledError } from '../../../src/adapters/cli/ConsoleTerminal.ts'
import { TerminalUnavailableError } from '../../../src/application/errors.ts'

function streams(tty: boolean) {
  const input = Object.assign(new PassThrough(), {
    isTTY: tty,
    setRawMode: mock((_mode: boolean) => {}),
  })
  const out: string[] = []
  const err: string[] = []
  const terminal = new ConsoleTerminal(
    input,
    { write: (c: string) => out.push(c) },
    { write: (c: string) => err.push(c) },
  )
  return { input, out, err, terminal }
}

test('print goes to stdout and error to stderr', () => {
  const s = streams(false)
  s.terminal.print('hello')
  s.terminal.error('oops')
  expect(s.out).toEqual(['hello\n'])
  expect(s.err).toEqual(['oops\n'])
})

describe('askSecret', () => {
  test('reads in raw mode without echoing, honouring backspace', async () => {
    const s = streams(true)
    const answer = s.terminal.askSecret('Token: ')
    s.input.write('sec')
    s.input.write('\u007fret\r')
    expect(await answer).toBe('seret')
    expect(s.out.join('')).toBe('Token: \n')
    expect(s.input.setRawMode.mock.calls).toEqual([[true], [false]])
  })

  test('drops bracketed-paste markers around a pasted secret', async () => {
    const s = streams(true)
    const answer = s.terminal.askSecret('> ')
    s.input.write('\u001b[200~123:abc\u001b[201~\r')
    expect(await answer).toBe('123:abc')
  })

  test('Ctrl+C cancels and restores the terminal', async () => {
    const s = streams(true)
    const answer = s.terminal.askSecret('> ')
    s.input.write('abc\u0003')
    await expect(answer).rejects.toBeInstanceOf(InputCancelledError)
    expect(s.input.setRawMode.mock.calls.at(-1)).toEqual([false])
  })

  test('refuses without a TTY instead of reading an echoed secret', async () => {
    await expect(streams(false).terminal.askSecret('> ')).rejects.toBeInstanceOf(
      TerminalUnavailableError,
    )
  })
})

describe('readPipedInput', () => {
  test('reads everything from a pipe', async () => {
    const s = streams(false)
    s.input.end('tok\n')
    expect(await s.terminal.readPipedInput()).toBe('tok\n')
  })

  test('refuses a TTY, where typing would echo the secret', async () => {
    await expect(streams(true).terminal.readPipedInput()).rejects.toBeInstanceOf(
      TerminalUnavailableError,
    )
  })
})

test('confirm accepts yes in either language', async () => {
  const s = streams(false)
  const answer = s.terminal.confirm('Ok? ')
  s.input.write('sí\n')
  expect(await answer).toBe(true)
})
