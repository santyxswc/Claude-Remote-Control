/**
 * Every command line the voice adapter can run (F13), and nothing else: the
 * transcriber has no way to build another one. Both programs run with an
 * argument array (no shell), the workspace as the working directory, stdin
 * closed, a scrubbed environment (`voiceEnvironment`) and a deadline. Files
 * are named relative to the workspace with our own fixed names, so no path
 * can start with `-` or name a protocol.
 *
 * ffmpeg (https://ffmpeg.org/ffmpeg.html, ffmpeg-protocols.html):
 * - `-nostdin`: never reads the terminal ("To explicitly disable interaction
 *   you need to specify -nostdin").
 * - `-hide_banner -nostats -loglevel error`: quiet; stderr is discarded anyway.
 * - `-protocol_whitelist file`: only the `file` protocol may be opened, so a
 *   crafted container cannot make ffmpeg open a URL or another protocol.
 * - `-f ogg` before `-i`: the input demuxer is forced; ffmpeg does not probe
 *   for other formats.
 * - `-t <seconds>` before `-i`: "limit the duration of data read from the
 *   input file", whatever the note declares.
 * - `-map 0:a:0 -vn -sn -dn -map_metadata -1`: one audio stream, nothing else.
 * - `-ac 1 -ar 16000 -c:a pcm_s16le -f wav`: 16 kHz mono 16-bit WAV, the
 *   conversion the whisper.cpp README gives.
 * - `-fs <bytes>`: stops writing past the size a full-length note needs.
 * - `-n`: never overwrites a file.
 *
 * whisper-cli (examples/cli/README.md of ggml-org/whisper.cpp):
 * - `-m <model>`: the model, an absolute path checked at startup.
 * - `-f voice.wav`: the converted input.
 * - `-l <lang>`: `auto` or a language code (validated: two or three letters).
 * - `-otxt -of transcript`: the result as text in `transcript.txt`.
 * - `-nt`: no timestamps. `-np`: no progress or system prints.
 */

/** The voice note as downloaded, inside the workspace. */
export const VOICE_AUDIO_FILE = 'voice.ogg'
/** ffmpeg's output and whisper.cpp's input. */
export const VOICE_WAV_FILE = 'voice.wav'
/** `-of` takes the name without the extension; `-otxt` adds `.txt`. */
export const TRANSCRIPT_BASE = 'transcript'
export const TRANSCRIPT_FILE = `${TRANSCRIPT_BASE}.txt`

/** `auto`, or a whisper language code such as `es`, `en` or `haw`. */
const LANGUAGE = /^(?:auto|[a-z]{2,3})$/

export function isWhisperLanguage(value: string): boolean {
  return LANGUAGE.test(value)
}

export interface FfmpegArgvOptions {
  /** At most this many seconds of audio are read. */
  readonly maxSeconds: number
  /** At most this many bytes of WAV are written. */
  readonly maxWavBytes: number
}

/** The arguments after the ffmpeg executable. */
export function ffmpegArgv(options: FfmpegArgvOptions): string[] {
  if (!Number.isSafeInteger(options.maxSeconds) || options.maxSeconds <= 0) {
    throw new Error('invalid duration limit')
  }
  if (!Number.isSafeInteger(options.maxWavBytes) || options.maxWavBytes <= 0) {
    throw new Error('invalid size limit')
  }
  return [
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
    String(options.maxSeconds),
    '-i',
    VOICE_AUDIO_FILE,
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
    String(options.maxWavBytes),
    '-n',
    VOICE_WAV_FILE,
  ]
}

export interface WhisperArgvOptions {
  /** Absolute path of the ggml model file. */
  readonly model: string
  readonly language: string
}

/** The arguments after the whisper-cli executable. Throws for a value that could be read as an option. */
export function whisperArgv(options: WhisperArgvOptions): string[] {
  if (!isWhisperLanguage(options.language)) throw new Error('invalid language')
  if (options.model === '' || options.model.startsWith('-')) throw new Error('invalid model path')
  return [
    '-m',
    options.model,
    '-f',
    VOICE_WAV_FILE,
    '-l',
    options.language,
    '-otxt',
    '-of',
    TRANSCRIPT_BASE,
    '-nt',
    '-np',
  ]
}

/** Variables kept from the channel's environment (matched case-insensitively, for Windows). */
const INHERITED = new Set([
  // To find shared libraries and the DLLs next to the executable.
  'PATH',
  'LD_LIBRARY_PATH',
  // Windows needs these for its own DLLs.
  'SYSTEMROOT',
  'WINDIR',
])

/**
 * The whole environment both programs run with: what they need to load, and
 * the temporary directories pointed at the workspace. The bot token and
 * every other channel variable are dropped.
 */
export function voiceEnvironment(
  parent: Readonly<Record<string, string | undefined>>,
  workspace: string,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && INHERITED.has(key.toUpperCase())) env[key] = value
  }
  return { ...env, TMPDIR: workspace, TEMP: workspace, TMP: workspace }
}
