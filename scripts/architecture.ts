/**
 * Dependency rules of the clean architecture, as pure functions over source
 * text so they can be unit-tested. `check-architecture.ts` applies them to
 * the files under `src/`.
 *
 * - `src/domain` may only import from `src/domain`: no packages, no builtins.
 * - `src/application` may only import from `src/domain`, `src/application`
 *   and the `zod` package.
 */
import { posix } from 'node:path'

export interface SourceFile {
  /** Repository-relative path with forward slashes, e.g. `src/domain/x.ts`. */
  readonly path: string
  readonly source: string
}

export interface Violation {
  readonly file: string
  readonly specifier: string
  readonly rule: string
}

const IMPORT_PATTERNS: readonly RegExp[] = [
  // import x from 'a' / import type { X } from 'a' / export * from 'a' / export { x } from 'a'
  /^\s*(?:import|export)\s+(?:type\s+)?[\w*{}\s,$]+?\s+from\s*['"]([^'"]+)['"]/gm,
  // import 'a' (side effect only)
  /^\s*import\s*['"]([^'"]+)['"]/gm,
  // import('a')
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // require('a')
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
]

/** Module specifiers referenced by a TypeScript/JavaScript source text. */
export function extractImports(source: string): string[] {
  const found: string[] = []
  for (const pattern of IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier !== undefined) found.push(specifier)
    }
  }
  return found
}

interface Layer {
  readonly dir: string
  readonly mayImportDirs: readonly string[]
  readonly mayImportPackages: readonly string[]
}

const LAYERS: readonly Layer[] = [
  { dir: 'src/domain/', mayImportDirs: ['src/domain/'], mayImportPackages: [] },
  {
    dir: 'src/application/',
    mayImportDirs: ['src/domain/', 'src/application/'],
    mayImportPackages: ['zod'],
  },
]

/** All rule violations found in the given files. Files outside guarded layers are ignored. */
export function findViolations(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = []
  for (const file of files) {
    const layer = LAYERS.find((candidate) => file.path.startsWith(candidate.dir))
    if (layer === undefined) continue
    for (const specifier of extractImports(file.source)) {
      if (!isAllowed(file.path, specifier, layer)) {
        violations.push({ file: file.path, specifier, rule: describe(layer) })
      }
    }
  }
  return violations
}

function isAllowed(filePath: string, specifier: string, layer: Layer): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const target = posix.normalize(posix.join(posix.dirname(filePath), specifier))
    return layer.mayImportDirs.some((dir) => target.startsWith(dir))
  }
  return layer.mayImportPackages.includes(packageName(specifier))
}

/** `zod` -> `zod`, `zod/v4` -> `zod`, `@scope/pkg/sub` -> `@scope/pkg`, `node:fs` -> `node:fs`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier)
}

function describe(layer: Layer): string {
  const allowed = [...layer.mayImportDirs, ...layer.mayImportPackages.map((p) => `package "${p}"`)]
  return `${layer.dir} may only import from: ${allowed.join(', ')}`
}
