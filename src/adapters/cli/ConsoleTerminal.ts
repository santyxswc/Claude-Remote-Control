import { createInterface } from 'node:readline/promises'
import { TerminalUnavailableError } from '../../application/errors.ts'
import { isAffirmative } from '../../application/i18n/messages.ts'
import type { Terminal } from '../../application/ports/Terminal.ts'

/** The subset of `process.stdin` this terminal uses, so tests can pass a fake. */
export interface InputStream extends NodeJS.ReadableStream {
  readonly isTTY?: boolean
  setRawMode?(mode: boolean): unknown
}

export interface OutputStream {
  write(chunk: string): unknown
}

export class InputCancelledError extends Error {
  constructor() {
    super('Input cancelled')
    this.name = 'InputCancelledError'
  }
}

const CTRL_C = '\u0003'
const CTRL_D = '\u0004'
const BACKSPACE = new Set(['\u007f', '\b'])
/** Escape sequences, e.g. bracketed-paste markers, that are not part of a typed secret. */
const ESCAPE_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[~A-Za-z]`, 'g')

/** The real terminal. This is the CLI process, so stdout is free to use (unlike the channel). */
export class ConsoleTerminal implements Terminal {
  constructor(
    private readonly input: InputStream = process.stdin,
    private readonly output: OutputStream = process.stdout,
    private readonly errors: OutputStream = process.stderr,
  ) {}

  print(line: string): void {
    this.output.write(`${line}\n`)
  }

  error(line: string): void {
    this.errors.write(`${line}\n`)
  }

  async ask(prompt: string): Promise<string> {
    const rl = createInterface({
      input: this.input,
      output: this.output as NodeJS.WritableStream,
      terminal: this.input.isTTY === true,
    })
    try {
      return await rl.question(prompt)
    } finally {
      rl.close()
    }
  }

  async confirm(prompt: string): Promise<boolean> {
    return isAffirmative(await this.ask(prompt))
  }

  /** Raw mode, so nothing typed or pasted is echoed. Needs a TTY. */
  askSecret(prompt: string): Promise<string> {
    const input = this.input
    if (input.isTTY !== true || input.setRawMode === undefined) {
      return Promise.reject(new TerminalUnavailableError())
    }
    this.output.write(prompt)
    input.setRawMode(true)
    input.setEncoding('utf8')
    input.resume()
    return new Promise((resolve, reject) => {
      let value = ''
      const finish = (error?: Error) => {
        input.removeListener('data', onData)
        input.setRawMode?.(false)
        input.pause()
        this.output.write('\n')
        if (error === undefined) resolve(value.replace(ESCAPE_SEQUENCE, ''))
        else reject(error)
      }
      const onData = (chunk: string | Buffer) => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n' || char === CTRL_D) return finish()
          if (char === CTRL_C) return finish(new InputCancelledError())
          if (BACKSPACE.has(char)) value = value.slice(0, -1)
          else value += char
        }
      }
      input.on('data', onData)
    })
  }

  /** Everything piped to stdin. Refuses a TTY: typing there would echo the secret. */
  async readPipedInput(): Promise<string> {
    if (this.input.isTTY === true) throw new TerminalUnavailableError()
    let text = ''
    for await (const chunk of this.input) {
      text += chunk.toString()
    }
    return text
  }
}
