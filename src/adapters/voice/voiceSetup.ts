import { posix, win32 } from 'node:path'
import type { TranscriberUnavailable } from '../../application/ports/Transcriber.ts'
import type { SystemProbe } from '../capture/systemProbe.ts'
import { isWhisperLanguage } from './voiceInvocations.ts'

/** Absolute path of the ggml model. Setting it is what turns voice notes on. */
export const WHISPER_MODEL_ENV = 'TELEGRAM_BRIDGE_WHISPER_MODEL'
/** Absolute path of whisper-cli; otherwise `whisper-cli` is looked up on PATH once. */
export const WHISPER_ENV = 'TELEGRAM_BRIDGE_WHISPER'
/** `auto` (the default) or a language code such as `es` or `en`. */
export const WHISPER_LANGUAGE_ENV = 'TELEGRAM_BRIDGE_WHISPER_LANGUAGE'
/** Absolute path of ffmpeg; otherwise `ffmpeg` is looked up on PATH once. */
export const FFMPEG_ENV = 'TELEGRAM_BRIDGE_FFMPEG'

/**
 * The names whisper.cpp's CLI is installed under: upstream builds, Arch's
 * `whisper-cpp` package and Homebrew's `whisper.cpp` formula all ship
 * `whisper-cli`. The old upstream name `main` is never looked up.
 */
export const WHISPER_NAMES = ['whisper-cli'] as const
export const FFMPEG_NAMES = ['ffmpeg'] as const

export const DEFAULT_WHISPER_LANGUAGE = 'auto'

export type VoiceSetup =
  | {
      readonly ok: true
      readonly whisper: string
      readonly ffmpeg: string
      readonly model: string
      readonly language: string
      /** The language variable was set to something that is not a language code; `auto` is used. */
      readonly languageIgnored: boolean
    }
  | { readonly ok: false; readonly reason: TranscriberUnavailable }

export interface VoiceSetupContext {
  readonly platform: NodeJS.Platform
  readonly env: Readonly<Record<string, string | undefined>>
  readonly probe: SystemProbe
}

/**
 * Where whisper.cpp, its model and ffmpeg are, decided once at startup (F13).
 * Off unless `TELEGRAM_BRIDGE_WHISPER_MODEL` is set. An override must be an
 * absolute path to a file; otherwise the program is looked up on PATH by its
 * known names (never in the project directory). Pure over the probe.
 */
export function resolveVoiceSetup(context: VoiceSetupContext): VoiceSetup {
  const { env, probe } = context
  const path = context.platform === 'win32' ? win32 : posix
  const model = env[WHISPER_MODEL_ENV]?.trim() ?? ''
  if (model === '') return { ok: false, reason: 'not_configured' }
  if (!path.isAbsolute(model) || !probe.isFile(model)) return { ok: false, reason: 'model_missing' }
  const whisper = program(env[WHISPER_ENV], WHISPER_NAMES, path, probe)
  if (whisper === undefined) return { ok: false, reason: 'whisper_missing' }
  const ffmpeg = program(env[FFMPEG_ENV], FFMPEG_NAMES, path, probe)
  if (ffmpeg === undefined) return { ok: false, reason: 'ffmpeg_missing' }
  const raw = env[WHISPER_LANGUAGE_ENV]?.trim().toLowerCase() ?? ''
  const valid = raw !== '' && isWhisperLanguage(raw)
  return {
    ok: true,
    whisper,
    ffmpeg,
    model,
    language: valid ? raw : DEFAULT_WHISPER_LANGUAGE,
    languageIgnored: raw !== '' && !valid,
  }
}

function program(
  override: string | undefined,
  names: readonly string[],
  path: typeof posix,
  probe: SystemProbe,
): string | undefined {
  const value = override?.trim() ?? ''
  if (value !== '') return path.isAbsolute(value) && probe.isFile(value) ? value : undefined
  for (const name of names) {
    const found = probe.which(name)
    if (found !== undefined) return found
  }
  return undefined
}
