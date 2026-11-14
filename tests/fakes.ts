import type { ChatGateway } from '../src/application/ports/ChatGateway.ts'
import type { LogFields, Logger } from '../src/application/ports/Logger.ts'

export class FakeChatGateway implements ChatGateway {
  readonly sent: { chatId: string; text: string }[] = []
  failWith: Error | undefined

  async sendText(chatId: string, text: string): Promise<void> {
    if (this.failWith !== undefined) throw this.failWith
    this.sent.push({ chatId, text })
  }
}

export class MemoryLogger implements Logger {
  readonly entries: { level: string; message: string; fields?: LogFields }[] = []

  info(message: string, fields?: LogFields): void {
    this.#push('info', message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.#push('warn', message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.#push('error', message, fields)
  }

  #push(level: string, message: string, fields: LogFields | undefined): void {
    this.entries.push(fields === undefined ? { level, message } : { level, message, fields })
  }
}
