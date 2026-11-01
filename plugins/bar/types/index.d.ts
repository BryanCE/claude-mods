export type ContextSlice = { name: string; tokens: number; color: string; isBuffer: boolean }

export type ContextSnapshot = {
  slices: ContextSlice[]
  model: string
  totalTokens: number
  maxTokens: number
  percent: number
  autoCompactAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    bar: { snapshot: ContextSnapshot | null; isOpen: boolean }
  }
}
