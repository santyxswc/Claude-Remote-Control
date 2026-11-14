import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A fresh directory per test. Close databases before removing it (Windows locks open files). */
export function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'telegram-bridge-test-'))
}

export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
}
