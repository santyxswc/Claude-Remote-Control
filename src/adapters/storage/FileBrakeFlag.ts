import type { BrakeFlag, BrakeStatus } from '../../application/ports/BrakeFlag.ts'
import type { BrakeRecord } from '../../domain/brake/BrakeRecord.ts'
import { readBrakeFile, removeBrakeFile, writeBrakeFile } from './brakeFile.ts'

/** `BrakeFlag` over `<stateDir>/brake.json`; the same file the PreToolUse hook reads. */
export class FileBrakeFlag implements BrakeFlag {
  constructor(private readonly stateDir: string) {}

  engage(record: BrakeRecord): void {
    writeBrakeFile(this.stateDir, record)
  }

  release(): boolean {
    return removeBrakeFile(this.stateDir)
  }

  status(): BrakeStatus {
    const state = readBrakeFile(this.stateDir)
    switch (state.kind) {
      case 'absent':
        return { engaged: false }
      case 'engaged':
        return { engaged: true, record: state.record }
      case 'unreadable':
        return { engaged: true, record: undefined }
    }
  }
}
