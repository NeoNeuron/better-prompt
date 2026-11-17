// Shared stand-ins for the engine beneath the mod. Not a test file itself.
import { mock } from 'claude-code/testing'
import type { On } from 'claude-code'

export const PLUGIN = 'better-prompt'

export const QUESTIONS_REPLY = JSON.stringify({
  questions: [
    { question: 'Who is the email for?', options: ['My team', 'A customer', 'My manager'] },
    { question: 'How long should it be?', options: ['Short', 'Detailed'] },
  ],
})

export const REWRITE_REPLY = JSON.stringify({
  prompt:
    'Write a short email to my team announcing the release of [product name] on [date]. Keep it friendly and under 150 words, end with one clear next step, and it is done when I can paste it straight into my mail client.',
  added: ['A clear goal', 'Audience: my team', 'Length limit', 'What done looks like'],
})

export const ROUGH = 'write an email about the release for everyone'

export type Bottom = {
  submitted: { text: string; origin: string }[]
  filled: string[]
  closed: string[]
  opened: string[]
  logged: string[]
  modelCalls: { model: string; prompt: string }[]
  clock: ReturnType<typeof mock.clock>
}

export type Replies = {
  questions?: string | 'fail'
  rewrite?: string | 'fail'
  isPlaced?: boolean
  store?: Record<string, unknown>
  // The first model call waits this long on the mocked clock.
  firstCallDelayMs?: number
}

function usage() {
  return { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
}

// Hooks that stand for the engine: a `$` call is answered `{ value }`, an
// event by its own result.
export function engine(on: On, replies: Replies = {}): Bottom {
  const bottom: Bottom = {
    submitted: [],
    filled: [],
    closed: [],
    opened: [],
    logged: [],
    modelCalls: [],
    clock: mock.clock(on),
  }
  mock.store(on, replies.store ?? {})
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'better' } }))
  on('ui.open', (_, e) => {
    bottom.opened.push(e.id)
    return { value: replies.isPlaced === false ? { isPlaced: false, reason: 'too narrow' } : { isPlaced: true } }
  })
  on('ui.close', (_, e) => {
    bottom.closed.push(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [] }))
  on('ui.log', (_, e) => {
    bottom.logged.push(e.text)
    return { value: undefined }
  })
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('prompt.fill', (_, e) => {
    bottom.filled.push(e.text)
    return { isFilled: true, text: e.text, cursor: e.text.length }
  })
  on('prompt.submit', (_, e) => {
    bottom.submitted.push({ text: e.text, origin: e.origin.kind })
    return { text: e.text }
  })
  on('model.complete', async (_, e) => {
    bottom.modelCalls.push({ model: e.model, prompt: e.prompt })
    if (bottom.modelCalls.length === 1 && replies.firstCallDelayMs !== undefined) {
      await bottom.clock.sleep(replies.firstCallDelayMs)
    }
    const isQuestions = e.model === 'haiku'
    const reply = isQuestions ? replies.questions ?? QUESTIONS_REPLY : replies.rewrite ?? REWRITE_REPLY
    if (reply === 'fail') {
      return { value: { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: usage() } }
    }
    return { value: { isAnswered: true, text: reply, usage: usage() } }
  })
  return bottom
}

export function paneAt(columns: number) {
  return {
    plugin: PLUGIN,
    component: 'Pane',
    requestId: PLUGIN,
    props: {
      title: 'Prompt Upgrade',
      isFocused: true,
      bodyColumns: columns,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 60 },
      view: {},
    },
  } as const
}

export const TYPED = { origin: { kind: 'composer' }, wait: false } as const

export const AS_TYPED_COMMAND = {
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 160 },
} as const
