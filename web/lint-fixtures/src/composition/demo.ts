import 'server-only'
export function getDemoUseCase() {
  return {
    async submit(requestId: string) {
      return { ok: true as const, requestId }
    },
    async list() {
      return [] as string[]
    },
  }
}
