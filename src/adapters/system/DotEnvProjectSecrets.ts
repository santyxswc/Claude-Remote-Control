import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Logger } from '../../application/ports/Logger.ts'
import type { ProjectSecretsSource } from '../../application/ports/ProjectSecretsSource.ts'

/** `.env` and `.env.<anything>`, except the conventional committed templates. */
const ENV_FILE = /^\.env(?:\..+)?$/
const TEMPLATE = /\.(?:example|sample|template|dist)$/i
/** Larger files are not environment files; skip rather than read megabytes. */
const MAX_FILE_BYTES = 256 * 1024

/** `KEY=value` or `export KEY=value`. */
const ASSIGNMENT = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s?(.*)$/

/**
 * Reads the values of the project's environment files once, at startup, so
 * outbound text can be scrubbed of them verbatim. Values are returned raw;
 * the domain decides which are worth redacting. Nothing is logged but file
 * names and counts.
 */
export class DotEnvProjectSecrets implements ProjectSecretsSource {
  readonly #dirs: readonly string[]

  constructor(
    dirs: readonly string[],
    private readonly logger: Logger,
  ) {
    this.#dirs = [...new Set(dirs.map((dir) => resolve(dir)))]
  }

  load(): readonly string[] {
    const values: string[] = []
    for (const dir of this.#dirs) {
      for (const file of envFiles(dir)) {
        try {
          values.push(...parseEnvValues(readFileSync(file, 'utf8')))
        } catch (error) {
          this.logger.warn('could not read an env file for redaction', { file, error })
        }
      }
    }
    this.logger.info('loaded project env values for redaction', {
      dirs: this.#dirs.length,
      values: values.length,
    })
    return values
  }
}

function envFiles(dir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names
    .filter((name) => ENV_FILE.test(name) && !TEMPLATE.test(name))
    .map((name) => join(dir, name))
    .filter((path) => {
      try {
        const stat = statSync(path)
        return stat.isFile() && stat.size <= MAX_FILE_BYTES
      } catch {
        return false
      }
    })
}

/**
 * The values of a dotenv file: unquoted (an inline ` #comment` removed),
 * single-quoted, or double-quoted, possibly spanning lines. For a
 * double-quoted value with `\n` escapes both the raw and the expanded form
 * are returned, since either may show up in output.
 */
export function parseEnvValues(content: string): string[] {
  const lines = content.split(/\r\n|\n|\r/)
  const values: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = ASSIGNMENT.exec(lines[i] ?? '')
    if (match === null) continue
    let raw = (match[1] ?? '').trim()
    const quote = raw[0]
    if (quote === '"' || quote === "'") {
      // Multi-line quoted value: keep reading until the closing quote.
      while (!closesQuote(raw, quote) && i + 1 < lines.length) {
        i += 1
        raw += `\n${lines[i] ?? ''}`
      }
      const end = raw.indexOf(quote, 1)
      const inner = end === -1 ? raw.slice(1) : raw.slice(1, end)
      values.push(inner)
      if (quote === '"' && inner.includes('\\n')) values.push(inner.replaceAll('\\n', '\n'))
      continue
    }
    values.push(raw.replace(/\s+#.*$/, ''))
  }
  return values.filter((value) => value !== '')
}

function closesQuote(raw: string, quote: string): boolean {
  return raw.indexOf(quote, 1) !== -1
}
