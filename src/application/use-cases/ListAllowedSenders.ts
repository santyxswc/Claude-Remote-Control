import type { AllowedSender } from '../../domain/AllowedSender.ts'
import type { AllowedSenderStore } from '../ports/AllowedSenderStore.ts'

export class ListAllowedSenders {
  constructor(private readonly allowed: AllowedSenderStore) {}

  execute(): readonly AllowedSender[] {
    return this.allowed.list()
  }
}
