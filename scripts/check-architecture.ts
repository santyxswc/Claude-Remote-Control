/** Fails (exit 1) when code under src/ breaks the layer dependency rules. */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { findViolations, type SourceFile } from './architecture.ts'

const root = join(import.meta.dir, '..')
const SOURCE_EXTENSIONS = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/

const files: SourceFile[] = readdirSync(join(root, 'src'), { recursive: true, encoding: 'utf8' })
  .filter((entry) => SOURCE_EXTENSIONS.test(entry))
  .map((entry) => {
    const absolute = join(root, 'src', entry)
    return {
      path: relative(root, absolute).split(sep).join('/'),
      source: readFileSync(absolute, 'utf8'),
    }
  })

const violations = findViolations(files)

if (violations.length > 0) {
  for (const v of violations) {
    console.error(`${v.file}: imports "${v.specifier}" (${v.rule})`)
  }
  console.error(`\narchitecture check failed: ${violations.length} violation(s)`)
  process.exit(1)
}

console.log(`architecture check passed (${files.length} files)`)
