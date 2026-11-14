/**
 * Test fixture run as a separate process: waits until the wall clock reaches
 * `<start at>` (so two copies race as closely as possible), then loads or
 * creates the hook secret in `<state dir>` and prints it as hex.
 * Usage: bun createSecret.ts <state dir> <start at, epoch ms>
 */
import { loadOrCreateHookSecret } from '../../../../src/adapters/ipc/hookSecret.ts'
import { CryptoRandomSource } from '../../../../src/adapters/system/CryptoRandomSource.ts'

const [stateDir = '', startAt = '0'] = process.argv.slice(2)
while (Date.now() < Number(startAt)) {
  // Spin: a timer would add milliseconds of jitter between the two racers.
}
const secret = loadOrCreateHookSecret(stateDir, new CryptoRandomSource())
process.stdout.write(`${Buffer.from(secret).toString('hex')}\n`)
