/**
 * The argv allowlist (F13): every command line the voice adapter can produce
 * is enumerated here and checked against exactly the expected hardened form.
 * A new flag, a dropped hardening flag or an input that could be read as an
 * option fails.
 */
import { describe, expect, test } from 'bun:test'
import {
  ffmpegArgv,
  isWhisperLanguage,
  TRANSCRIPT_BASE,
  TRANSCRIPT_FILE,
  VOICE_AUDIO_FILE,
  VOICE_WAV_FILE,
  voiceEnvironment,
  whisperArgv,
} from '../../../src/adapters/voice/voiceInvocations.ts'
import { MAX_DECODED_SECONDS, MAX_WAV_BYTES } from '../../../src/domain/voice/voiceNote.ts'

const FFMPEG = [
  '-nostdin',
  '-hide_banner',
  '-nostats',
  '-loglevel',
  'error',
  '-protocol_whitelist',
  'file',
  '-f',
  'ogg',
  '-t',
  String(MAX_DECODED_SECONDS),
  '-i',
  'voice.ogg',
  '-map',
  '0:a:0',
  '-vn',
  '-sn',
  '-dn',
  '-map_metadata',
  '-1',
  '-ac',
  '1',
  '-ar',
  '16000',
  '-c:a',
  'pcm_s16le',
  '-f',
  'wav',
  '-fs',
  String(MAX_WAV_BYTES),
  '-n',
  'voice.wav',
]

const MODELS = ['/home/me/models/ggml-base.bin', 'C:\\models\\ggml small.bin']
const LANGUAGES = ['auto', 'es', 'en', 'haw']

describe('voice argv allowlist', () => {
  test('ffmpeg: exactly the hardened conversion, input forced to Ogg, only the file protocol', () => {
    expect(ffmpegArgv({ maxSeconds: MAX_DECODED_SECONDS, maxWavBytes: MAX_WAV_BYTES })).toEqual(
      FFMPEG,
    )
    // The input options come before -i, so they apply to the input.
    const argv = ffmpegArgv({ maxSeconds: 10, maxWavBytes: 1000 })
    const input = argv.indexOf('-i')
    for (const option of ['-nostdin', '-protocol_whitelist', '-t']) {
      expect(argv.indexOf(option)).toBeLessThan(input)
    }
    expect(argv.indexOf('-f')).toBeLessThan(input)
    expect(argv[argv.indexOf('-protocol_whitelist') + 1]).toBe('file')
  })

  test('ffmpeg refuses limits that are not positive whole numbers', () => {
    for (const maxSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ffmpegArgv({ maxSeconds, maxWavBytes: 1 })).toThrow()
      expect(() => ffmpegArgv({ maxSeconds: 1, maxWavBytes: maxSeconds })).toThrow()
    }
  })

  test('whisper-cli: exactly model, input, language, text output, no timestamps or prints', () => {
    for (const model of MODELS) {
      for (const language of LANGUAGES) {
        expect(whisperArgv({ model, language })).toEqual([
          '-m',
          model,
          '-f',
          'voice.wav',
          '-l',
          language,
          '-otxt',
          '-of',
          'transcript',
          '-nt',
          '-np',
        ])
      }
    }
  })

  test('no argv names a network, translation, output-elsewhere or extra-output option', () => {
    const forbidden =
      /^(?:-tr|--translate|-oj|-ojf|-osrt|-ovtt|-ocsv|-olrc|-owts|--grammar.*|-dtw|--prompt|-y|https?:.*|tcp:.*|udp:.*|rtmp:.*|pipe:.*|concat:.*|data:.*|-filter.*|-vf|-af|-lavfi|-filter_complex)$/
    const all = [
      ...ffmpegArgv({ maxSeconds: MAX_DECODED_SECONDS, maxWavBytes: MAX_WAV_BYTES }),
      ...MODELS.flatMap((model) =>
        LANGUAGES.flatMap((language) => whisperArgv({ model, language })),
      ),
    ]
    for (const arg of all) expect(forbidden.test(arg)).toBe(false)
  })

  test('only our fixed file names, relative to the workspace', () => {
    expect([VOICE_AUDIO_FILE, VOICE_WAV_FILE, TRANSCRIPT_FILE]).toEqual([
      'voice.ogg',
      'voice.wav',
      'transcript.txt',
    ])
    expect(TRANSCRIPT_FILE).toBe(`${TRANSCRIPT_BASE}.txt`)
    for (const name of [VOICE_AUDIO_FILE, VOICE_WAV_FILE, TRANSCRIPT_BASE]) {
      expect(name).toMatch(/^[a-z]+(?:\.[a-z]+)?$/)
    }
  })

  test('a language or model that could be read as an option is refused, never passed', () => {
    for (const language of ['', '-l', 'es;rm', 'ES', 'spanish', 'e', 'auto ', '--help']) {
      expect(isWhisperLanguage(language)).toBe(false)
      expect(() => whisperArgv({ model: MODELS[0] ?? '', language })).toThrow()
    }
    for (const model of ['', '-m', '--model=/x']) {
      expect(() => whisperArgv({ model, language: 'auto' })).toThrow()
    }
  })
})

describe('voiceEnvironment', () => {
  test('keeps only what the programs need to load, points the temp dirs at the workspace', () => {
    const env = voiceEnvironment(
      {
        PATH: '/usr/bin',
        Path: 'C:\\Windows',
        SystemRoot: 'C:\\Windows',
        windir: 'C:\\Windows',
        LD_LIBRARY_PATH: '/opt/whisper/lib',
        HOME: '/home/me',
        TELEGRAM_BOT_TOKEN: 'secret',
        TELEGRAM_BRIDGE_HOME: '/state',
        LD_PRELOAD: '/evil.so',
        TMPDIR: '/tmp',
        UNSET: undefined,
      },
      '/state/voice/abc',
    )
    expect(env).toEqual({
      PATH: '/usr/bin',
      Path: 'C:\\Windows',
      SystemRoot: 'C:\\Windows',
      windir: 'C:\\Windows',
      LD_LIBRARY_PATH: '/opt/whisper/lib',
      TMPDIR: '/state/voice/abc',
      TEMP: '/state/voice/abc',
      TMP: '/state/voice/abc',
    })
  })
})
