import { describe, expect, test } from 'bun:test'
import { extractImports, findViolations } from '../../scripts/architecture.ts'

describe('extractImports', () => {
  test('finds static, type-only, re-export, side-effect, dynamic and require imports', () => {
    const source = [
      "import a from 'pkg-a'",
      "import type { B } from './b.ts'",
      'import {',
      '  c,',
      '  type D,',
      "} from '../c.ts'",
      "import * as e from 'node:fs'",
      "export { f } from './f.ts'",
      "export * from './g.ts'",
      "import 'side-effect'",
      "const h = await import('./h.ts')",
      "const i = require('i')",
    ].join('\n')

    expect(extractImports(source).sort()).toEqual(
      [
        'pkg-a',
        './b.ts',
        '../c.ts',
        'node:fs',
        './f.ts',
        './g.ts',
        'side-effect',
        './h.ts',
        'i',
      ].sort(),
    )
  })

  test('ignores strings that merely contain the word "from"', () => {
    const source = [
      'export const greeting = \'messages arrive from "telegram"\'',
      'const x = `copied from "elsewhere"`',
    ].join('\n')

    expect(extractImports(source)).toEqual([])
  })
})

describe('findViolations', () => {
  const file = (path: string, source: string) => ({ path, source })

  test('domain may import other domain files', () => {
    const files = [file('src/domain/Pairing.ts', "import { RiskLevel } from './RiskLevel.ts'")]
    expect(findViolations(files)).toEqual([])
  })

  test.each([
    ['an npm package', "import { z } from 'zod'"],
    ['a node builtin', "import { join } from 'node:path'"],
    ['a bun builtin', "import { Database } from 'bun:sqlite'"],
    [
      'the application layer',
      "import type { ChatGateway } from '../application/ports/ChatGateway.ts'",
    ],
    ['an adapter', "import { X } from '../adapters/mcp/X.ts'"],
    ['a path that escapes the layer', "import { X } from '../domainish/X.ts'"],
  ])('domain may not import %s', (_label, source) => {
    const violations = findViolations([file('src/domain/Pairing.ts', source)])
    expect(violations).toHaveLength(1)
    expect(violations[0]?.file).toBe('src/domain/Pairing.ts')
  })

  test('application may import domain, application and zod (including subpaths)', () => {
    const source = [
      "import { Pairing } from '../../domain/Pairing.ts'",
      "import type { Logger } from '../ports/Logger.ts'",
      "import { z } from 'zod'",
      "import { z as z4 } from 'zod/v4'",
    ].join('\n')
    expect(findViolations([file('src/application/use-cases/PairDevice.ts', source)])).toEqual([])
  })

  test.each([
    ['an adapter', "import { McpChannelServer } from '../../adapters/mcp/McpChannelServer.ts'"],
    ['the composition root', "import '../../main.ts'"],
    ['another npm package', "import { Bot } from 'grammy'"],
    ['a node builtin', "import { readFileSync } from 'node:fs'"],
    ['a package that only starts with zod', "import x from 'zod-to-json-schema'"],
  ])('application may not import %s', (_label, source) => {
    const violations = findViolations([file('src/application/use-cases/PairDevice.ts', source)])
    expect(violations).toHaveLength(1)
  })

  test('adapters and main are not restricted', () => {
    const files = [
      file(
        'src/adapters/mcp/X.ts',
        "import { Server } from '@modelcontextprotocol/sdk/server/index.js'",
      ),
      file('src/main.ts', "import { X } from './adapters/mcp/X.ts'"),
    ]
    expect(findViolations(files)).toEqual([])
  })

  test('reports the offending specifier and the rule', () => {
    const [violation] = findViolations([file('src/domain/A.ts', "import x from 'node:os'")])
    expect(violation).toEqual({
      file: 'src/domain/A.ts',
      specifier: 'node:os',
      rule: 'src/domain/ may only import from: src/domain/',
    })
  })
})
