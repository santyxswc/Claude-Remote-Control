import { describe, expect, test } from 'bun:test'
import type { SystemProbe } from '../../../src/adapters/capture/systemProbe.ts'
import {
  FFMPEG_ENV,
  resolveVoiceSetup,
  WHISPER_ENV,
  WHISPER_LANGUAGE_ENV,
  WHISPER_MODEL_ENV,
} from '../../../src/adapters/voice/voiceSetup.ts'
import { messagesFor } from '../../../src/application/i18n/messages.ts'

const MODEL = '/home/me/models/ggml-base.bin'

function probe(files: readonly string[], onPath: Record<string, string> = {}): SystemProbe {
  return {
    isFile: (path) => files.includes(path),
    which: (name) => onPath[name],
  }
}

const installed = probe([MODEL, '/opt/whisper-cli', '/opt/ffmpeg'], {
  'whisper-cli': '/usr/bin/whisper-cli',
  ffmpeg: '/usr/bin/ffmpeg',
})

function setup(env: Record<string, string>, p: SystemProbe = installed, platform = 'linux') {
  return resolveVoiceSetup({ platform: platform as NodeJS.Platform, env, probe: p })
}

describe('resolveVoiceSetup', () => {
  test('off until a model is configured, even with whisper-cli on PATH', () => {
    expect(setup({})).toEqual({ ok: false, reason: 'not_configured' })
    expect(setup({ [WHISPER_MODEL_ENV]: '  ' })).toEqual({ ok: false, reason: 'not_configured' })
  })

  test('a model that is relative or missing is refused, never resolved against cwd', () => {
    for (const model of ['models/ggml-base.bin', '~/ggml-base.bin', '/nope.bin']) {
      expect(setup({ [WHISPER_MODEL_ENV]: model })).toEqual({
        ok: false,
        reason: 'model_missing',
      })
    }
  })

  test('whisper-cli and ffmpeg found on PATH once; language defaults to auto', () => {
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL })).toEqual({
      ok: true,
      whisper: '/usr/bin/whisper-cli',
      ffmpeg: '/usr/bin/ffmpeg',
      model: MODEL,
      language: 'auto',
      languageIgnored: false,
    })
  })

  test('absolute overrides win; a relative or missing override is refused, not replaced', () => {
    const ok = setup({
      [WHISPER_MODEL_ENV]: MODEL,
      [WHISPER_ENV]: '/opt/whisper-cli',
      [FFMPEG_ENV]: '/opt/ffmpeg',
    })
    expect(ok).toMatchObject({ ok: true, whisper: '/opt/whisper-cli', ffmpeg: '/opt/ffmpeg' })
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL, [WHISPER_ENV]: 'whisper-cli' })).toEqual({
      ok: false,
      reason: 'whisper_missing',
    })
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL, [FFMPEG_ENV]: '/nope/ffmpeg' })).toEqual({
      ok: false,
      reason: 'ffmpeg_missing',
    })
  })

  test('nothing on PATH: says which program is missing', () => {
    const bare = probe([MODEL])
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL }, bare)).toEqual({
      ok: false,
      reason: 'whisper_missing',
    })
    const noFfmpeg = probe([MODEL], { 'whisper-cli': '/usr/bin/whisper-cli' })
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL }, noFfmpeg)).toEqual({
      ok: false,
      reason: 'ffmpeg_missing',
    })
  })

  test('the old upstream name `main` is never looked up', () => {
    const onlyMain = probe([MODEL], { main: '/usr/bin/main', ffmpeg: '/usr/bin/ffmpeg' })
    expect(setup({ [WHISPER_MODEL_ENV]: MODEL }, onlyMain)).toEqual({
      ok: false,
      reason: 'whisper_missing',
    })
  })

  test('Windows paths', () => {
    const model = 'C:\\models\\ggml-base.bin'
    const exe = 'C:\\whisper\\whisper-cli.exe'
    const p = probe([model, exe], { ffmpeg: 'C:\\ffmpeg\\bin\\ffmpeg.exe' })
    expect(setup({ [WHISPER_MODEL_ENV]: model, [WHISPER_ENV]: exe }, p, 'win32')).toMatchObject({
      ok: true,
      whisper: exe,
      ffmpeg: 'C:\\ffmpeg\\bin\\ffmpeg.exe',
    })
  })

  test('language: a code is used lowercased; anything else falls back to auto, flagged', () => {
    const base = { [WHISPER_MODEL_ENV]: MODEL }
    expect(setup({ ...base, [WHISPER_LANGUAGE_ENV]: ' ES ' })).toMatchObject({
      language: 'es',
      languageIgnored: false,
    })
    expect(setup({ ...base, [WHISPER_LANGUAGE_ENV]: 'auto' })).toMatchObject({ language: 'auto' })
    for (const bad of ['spanish', '-l', 'es;x']) {
      expect(setup({ ...base, [WHISPER_LANGUAGE_ENV]: bad })).toMatchObject({
        language: 'auto',
        languageIgnored: true,
      })
    }
  })

  test('the help replies name the real settings', () => {
    for (const locale of ['es', 'en'] as const) {
      const m = messagesFor(locale)
      expect(m.voiceUnavailable('not_configured')).toContain(WHISPER_MODEL_ENV)
      expect(m.voiceUnavailable('model_missing')).toContain(WHISPER_MODEL_ENV)
      expect(m.voiceUnavailable('whisper_missing')).toContain(WHISPER_ENV)
      expect(m.voiceUnavailable('ffmpeg_missing')).toContain(FFMPEG_ENV)
    }
  })
})
