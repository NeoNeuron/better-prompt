export type Question = { text: string; options: string[] }

// null: not answered yet. A skipped question is left out of the rewrite.
export type Answer = { picked: string } | { skipped: true } | null

export type Step =
  | 'compose'
  | 'reading'
  | 'questions'
  | 'rewriting'
  | 'review'
  | 'error'
  | 'history'

export type FlowError = { during: 'questions' | 'rewrite'; reason: string }

export type Flow = {
  // Changes on every model call; a reply for an older id is ignored.
  runId: string
  step: Step
  original: string
  questions: Question[]
  answers: Answer[]
  otherFor: number | null
  upgraded: string
  added: string[]
  isEditing: boolean
  isCopied: boolean
  isFromHistory: boolean
  error: FlowError | null
}

export type HistoryEntry = {
  id: string
  at: number
  original: string
  upgraded: string
  added: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'better-prompt': {
      flow: Shaped<Flow | null>
      history: Shaped<HistoryEntry[]>
      auto: boolean
    }
  }
}
