/**
 * The whisper.cpp adapter against stub programs (a Bun script standing in for
 * both ffmpeg and whisper-cli): the fixed argv, the working directory, the
 * scrubbed environment, the deadline that kills, the output caps and the
 * failures. Never a real ffmpeg or whisper-cli, even if one is installed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { systemProbe } from '../../../src/adapters/capture/systemProbe.ts'
import { spawnCapturing } from '../../../src/adapters/session/processRunner.ts'
import {
  createTranscriber,
  UnavailableTranscriber,
} from '../../../src/adapters/voice/createTranscriber.ts'
import {
  ffmpegArgv,
  VOICE_AUDIO_FILE,
  whisperArgv,
} from '../../../src/adapters/voice/voiceInvocations.ts'
import { WhisperCppTranscriber } from '../../../src/adapters/voice/WhisperCppTranscriber.ts'
import { TranscriptionError } from '../../../src/application/errors.ts'
import { MAX_DECODED_SECONDS, MAX_WAV_BYTES } from '../../../src/domain/voice/voiceNote.ts'
import { makeTempDir, removeTempDir } from '../../tempDir.ts'
import { fakeOgg, isAlive, type StubBehavior, VoiceStubs } from './voiceStubs.ts'

const LEAK = 'TELEGRAM_BOT_TOKEN'

let stubs: VoiceStubs
let workspace: string

function transcriber(behavior: StubBehavior, options: { timeoutMs?: number } = {}) {
  stubs.behave(behavior)
  return new WhisperCppTranscriber({
    whisper: stubs.whisper,
    ffmpeg: stubs.ffmpeg,
    model: stubs.model,
    language: 'es',
    env: { ...process.env, [LEAK]: 'must-not-leak' },
    run: spawnCapturing,
    probe: systemProbe,
    ...(options.timeoutMs === undefined
      ? {}
      : { transcriptionTimeoutMs: () => options.timeoutMs ?? 0 }),
  })
}

async function failure(promise: Promise<unknown>): Promise<TranscriptionError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof TranscriptionError) return error
    throw error
  }
  throw new Error('expected a TranscriptionError')
}

beforeEach(() => {
  stubs = new VoiceStubs()
  workspace = makeTempDir()
  writeFileSync(join(workspace, VOICE_AUDIO_FILE), fakeOgg())
})

afterEach(() => {
  stubs.remove()
  removeTempDir(workspace)
})

describe('WhisperCppTranscriber', () => {
  test('converts, transcribes and reads the text file; fixed argv in the workspace', async () => {
    const result = await transcriber({ transcript: 'hola mundo' }).transcribe(
      { dir: workspace },
      12,
      new AbortController().signal,
    )
    expect(result.text).toBe('hola mundo\n')
    const [convert, transcribe] = stubs.calls()
    expect(convert?.tool).toBe('ffmpeg')
    expect(convert?.args).toEqual(
      ffmpegArgv({ maxSeconds: MAX_DECODED_SECONDS, maxWavBytes: MAX_WAV_BYTES }),
    )
    expect(transcribe?.tool).toBe('whisper')
    expect(transcribe?.args).toEqual(whisperArgv({ model: stubs.model, language: 'es' }))
    // Both run in the note's own directory, which holds only our files.
    expect(convert?.cwd).toBe(workspace)
    expect(transcribe?.cwd).toBe(workspace)
    expect(convert?.files).toEqual([VOICE_AUDIO_FILE])
    expect([...(transcribe?.files ?? [])].sort()).toEqual(['voice.ogg', 'voice.wav'])
  })

  test('the programs inherit nothing but what they need: never the bot token', async () => {
    await transcriber({}).transcribe({ dir: workspace }, 1, new AbortController().signal)
    for (const call of stubs.calls()) {
      expect(call.envKeys).not.toContain(LEAK)
      const upper = call.envKeys.map((key) => key.toUpperCase())
      for (const key of upper) {
        // Bun on Windows adds a few system variables of its own; nothing of the channel's.
        expect(key.startsWith('TELEGRAM_')).toBe(false)
      }
      expect(upper).toContain('TMP')
    }
  })

  test('ffmpeg failing, or writing nothing, is a conversion failure; whisper never runs', async () => {
    for (const ffmpeg of ['fail', 'none'] as const) {
      const error = await failure(
        transcriber({ ffmpeg }).transcribe({ dir: workspace }, 1, new AbortController().signal),
      )
      expect(error.reason).toBe('conversion_failed')
    }
    expect(stubs.calls().every((call) => call.tool === 'ffmpeg')).toBe(true)
  })

  test('whisper failing, or exiting 0 without a transcript, is a transcription failure', async () => {
    for (const whisper of ['fail', 'none'] as const) {
      const error = await failure(
        transcriber({ whisper }).transcribe({ dir: workspace }, 1, new AbortController().signal),
      )
      expect(error.reason).toBe('transcription_failed')
    }
  })

  test('a flood on stdout or a huge transcript file is refused', async () => {
    for (const whisper of ['flood', 'huge'] as const) {
      const error = await failure(
        transcriber({ whisper }).transcribe({ dir: workspace }, 1, new AbortController().signal),
      )
      expect(error.reason).toBe('output_too_large')
    }
  }, 20_000)

  test('a whisper that hangs is killed at the deadline and reported as a timeout', async () => {
    const started = Date.now()
    const error = await failure(
      transcriber({ whisper: 'hang' }, { timeoutMs: 1_500 }).transcribe(
        { dir: workspace },
        1,
        new AbortController().signal,
      ),
    )
    expect(error.reason).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = stubs.hungPid()
    expect(pid).toBeDefined()
    for (let i = 0; i < 100 && isAlive(pid ?? 0); i++) await Bun.sleep(20)
    expect(isAlive(pid ?? 0)).toBe(false)
  }, 20_000)

  test('cancelling kills the program', async () => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(), 700)
    const error = await failure(
      transcriber({ whisper: 'hang' }, { timeoutMs: 60_000 }).transcribe(
        { dir: workspace },
        1,
        abort.signal,
      ),
    )
    expect(error.reason).toBe('cancelled')
    const pid = stubs.hungPid()
    for (let i = 0; i < 100 && isAlive(pid ?? 0); i++) await Bun.sleep(20)
    expect(isAlive(pid ?? 0)).toBe(false)
  }, 20_000)

  test('availability re-checks the files every time', () => {
    const t = transcriber({})
    expect(t.availability()).toEqual({ ok: true })
    const gone = new WhisperCppTranscriber({
      whisper: stubs.whisper,
      ffmpeg: stubs.ffmpeg,
      model: join(stubs.dir, 'missing.bin'),
      language: 'auto',
      env: {},
      run: spawnCapturing,
      probe: systemProbe,
    })
    expect(gone.availability()).toEqual({ ok: false, reason: 'model_missing' })
    const noFfmpeg = new WhisperCppTranscriber({
      whisper: stubs.whisper,
      ffmpeg: [join(stubs.dir, 'ffmpeg-missing')],
      model: stubs.model,
      language: 'auto',
      env: {},
      run: spawnCapturing,
      probe: systemProbe,
    })
    expect(noFfmpeg.availability()).toEqual({ ok: false, reason: 'ffmpeg_missing' })
    // A directory is not a program.
    const dirAsTool = join(stubs.dir, 'dir')
    mkdirSync(dirAsTool)
    const noWhisper = new WhisperCppTranscriber({
      whisper: [dirAsTool],
      ffmpeg: stubs.ffmpeg,
      model: stubs.model,
      language: 'auto',
      env: {},
      run: spawnCapturing,
      probe: systemProbe,
    })
    expect(noWhisper.availability()).toEqual({ ok: false, reason: 'whisper_missing' })
  })
})

describe('createTranscriber', () => {
  test('an unavailable setup gives a transcriber that says why and runs nothing', async () => {
    const t = createTranscriber(
      { ok: false, reason: 'not_configured' },
      { env: {}, run: spawnCapturing, probe: systemProbe },
    )
    expect(t).toBeInstanceOf(UnavailableTranscriber)
    expect(t.availability()).toEqual({ ok: false, reason: 'not_configured' })
    await expect(t.transcribe({ dir: workspace }, 1, new AbortController().signal)).rejects.toThrow(
      TranscriptionError,
    )
    expect(stubs.calls()).toEqual([])
  })

  test('a valid setup gives whisper.cpp with the resolved paths', () => {
    const t = createTranscriber(
      {
        ok: true,
        whisper: process.execPath,
        ffmpeg: process.execPath,
        model: stubs.model,
        language: 'auto',
        languageIgnored: false,
      },
      { env: {}, run: spawnCapturing, probe: systemProbe },
    )
    expect(t).toBeInstanceOf(WhisperCppTranscriber)
    expect(t.availability()).toEqual({ ok: true })
  })
})
