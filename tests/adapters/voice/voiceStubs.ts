import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'

export interface StubBehavior {
  readonly ffmpeg?: 'ok' | 'fail' | 'hang' | 'none'
  readonly whisper?: 'ok' | 'fail' | 'hang' | 'none' | 'flood' | 'huge'
  readonly transcript?: string
}

export interface StubCall {
  readonly tool: 'ffmpeg' | 'whisper'
  readonly args: readonly string[]
  readonly cwd: string
  readonly envKeys: readonly string[]
  readonly files: readonly string[]
  readonly pid: number
}

/**
 * Fake `ffmpeg` and `whisper-cli` for tests: the same Bun script, started
 * through the running Bun executable (no shebang needed on Windows), plus a
 * fake model file. Never a real program.
 */
export class VoiceStubs {
  readonly dir = makeTempDir()
  readonly tool = join(this.dir, 'tool.ts')
  readonly model = join(this.dir, 'ggml-test.bin')
  readonly whisper: readonly string[] = [process.execPath, this.tool]
  readonly ffmpeg: readonly string[] = [process.execPath, this.tool]

  constructor(behavior: StubBehavior = {}) {
    copyFileSync(join(import.meta.dir, 'fixtures', 'fakeVoiceTool.ts'), this.tool)
    writeFileSync(this.model, 'not a real model')
    this.behave(behavior)
  }

  behave(behavior: StubBehavior): void {
    writeFileSync(join(this.dir, 'behavior.json'), JSON.stringify(behavior))
  }

  calls(): StubCall[] {
    const path = join(this.dir, 'calls.jsonl')
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as StubCall)
  }

  /** The pid a hanging stub wrote, if any. */
  hungPid(): number | undefined {
    const path = join(this.dir, 'hung.pid')
    return existsSync(path) ? Number(readFileSync(path, 'utf8')) : undefined
  }

  remove(): void {
    removeTempDir(this.dir)
  }
}

/** A minimal Ogg page head followed by filler: enough for the magic check. */
export function fakeOgg(bytes = 2_000): Uint8Array {
  const out = new Uint8Array(bytes)
  out.set([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02])
  for (let i = 6; i < bytes; i++) out[i] = i % 251
  return out
}

/** True while a process with this pid runs. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
