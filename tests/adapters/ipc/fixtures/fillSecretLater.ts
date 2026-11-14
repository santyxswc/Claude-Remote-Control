/**
 * Test fixture: plays a concurrent creator that has created `hooks.key` but
 * not written it yet. Waits `<delay ms>`, then writes `<hex>` into the
 * existing file in place (no rename) and prints `filled`.
 * Usage: bun fillSecretLater.ts <file> <hex> <delay ms>
 */
import { writeFileSync } from 'node:fs'

const [file = '', hex = '', delay = '0'] = process.argv.slice(2)
process.stdout.write('ready\n')
await Bun.sleep(Number(delay))
writeFileSync(file, `${hex}\n`, { flag: 'r+' })
process.stdout.write('filled\n')
