/**
 * A stand-in for both `ffmpeg` and `whisper-cli`, run as `bun <copy of this
 * file> <args>` so it works on every OS without shebangs. It never decodes
 * anything. What it does comes from `behavior.json` next to the copy (the
 * environment is scrubbed, so it cannot come from there), and it records
 * each call (argv, cwd, environment keys, the files it saw) in `calls.jsonl`.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Behavior {
  /** ok: write the WAV; fail: exit 1; hang: never exit; none: exit 0 without writing. */
  readonly ffmpeg?: 'ok' | 'fail' | 'hang' | 'none'
  /** ok: write the transcript; fail: exit 1; hang; none: exit 0 without a file; flood: stdout; huge: a huge file. */
  readonly whisper?: 'ok' | 'fail' | 'hang' | 'none' | 'flood' | 'huge'
  readonly transcript?: string
}

const here = import.meta.dir
const behavior = JSON.parse(readFileSync(join(here, 'behavior.json'), 'utf8')) as Behavior
const args = process.argv.slice(2)
const isFfmpeg = args.includes('-protocol_whitelist')

appendFileSync(
  join(here, 'calls.jsonl'),
  `${JSON.stringify({
    tool: isFfmpeg ? 'ffmpeg' : 'whisper',
    args,
    cwd: process.cwd(),
    envKeys: Object.keys(process.env),
    files: readdirSync(process.cwd()),
    pid: process.pid,
  })}\n`,
)

function hang(): void {
  writeFileSync(join(here, 'hung.pid'), String(process.pid))
  setInterval(() => {}, 1000)
}

if (isFfmpeg) {
  const mode = behavior.ffmpeg ?? 'ok'
  const input = args[args.indexOf('-i') + 1] ?? ''
  const output = args.at(-1) ?? ''
  if (mode === 'hang') hang()
  else if (mode === 'fail') process.exit(1)
  else if (mode === 'ok') {
    if (!existsSync(input)) process.exit(1)
    writeFileSync(output, Buffer.concat([Buffer.from('RIFF'), readFileSync(input)]))
  }
} else {
  const mode = behavior.whisper ?? 'ok'
  const base = args[args.indexOf('-of') + 1] ?? 'out'
  if (mode === 'hang') hang()
  else if (mode === 'fail') process.exit(3)
  else if (mode === 'flood') {
    for (;;) process.stdout.write('x'.repeat(65_536))
  } else if (mode === 'huge') {
    writeFileSync(`${base}.txt`, 'a'.repeat(200_000))
  } else if (mode === 'ok') {
    const text = behavior.transcript ?? 'hello'
    process.stdout.write(`${text}\n`)
    writeFileSync(`${base}.txt`, `${text}\n`)
  }
}
