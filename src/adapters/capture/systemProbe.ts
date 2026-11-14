import { statSync } from 'node:fs'

/** What the capture factories may ask the machine; injected so they stay pure in tests. */
export interface SystemProbe {
  /** Is there a regular file at this absolute path? */
  isFile(path: string): boolean
  /** The absolute path of a program on `PATH`, if any. */
  which(name: string): string | undefined
}

export const systemProbe: SystemProbe = {
  isFile(path) {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  },
  which(name) {
    return Bun.which(name) ?? undefined
  },
}
