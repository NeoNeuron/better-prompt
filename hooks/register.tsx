import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelCompleteResult, Register, RenderChildren, UiPressArgument } from 'claude-code'

import type { Answer, Flow, HistoryEntry, Step } from '../types'
import {
  AMBER,
  BG,
  GOLD,
  GREEN,
  HISTORY_LIMIT,
  INK,
  LINE,
  MUTED,
  QUESTIONS_MODEL,
  QUESTIONS_SYSTEM,
  REWRITE_MODEL,
  REWRITE_SYSTEM,
  STEP_LABELS,
  TEXT,
  decide,
  describeFailure,
  fit,
  headingParts,
  newId,
  packChips,
  padEnd,
  parseQuestions,
  parseRewrite,
  questionsPrompt,
  rewritePrompt,
  shortDate,
  statTiles,
  stepIndex,
  titleRule,
  tracker,
  wordCount,
  wrap,
} from './logic'

type Engine = EngineInterface

const PANE = 'better-prompt'
const PANE_TITLE = 'Prompt Upgrade'
const OPEN = {
  id: PANE,
  title: PANE_TITLE,
  focus: true,
  closeOnEscape: true,
  backgroundColor: BG,
} as const

// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const flowAtom = atom({ plugin: 'better-prompt', key: 'flow' } as const, null, { shape: 'flow-1' })
const historyAtom = atom({ plugin: 'better-prompt', key: 'history' } as const, [], { shape: 'history-1' })
const autoAtom = atom({ plugin: 'better-prompt', key: 'auto' } as const, false)

const STORE_HISTORY = 'history'
const STORE_AUTO = 'auto'

// ---------------------------------------------------------------- state changes (never while drawing)

function blankFlow(step: Step, original: string): Flow {
  return {
    runId: newId(),
    step,
    original,
    questions: [],
    answers: [],
    otherFor: null,
    upgraded: '',
    added: [],
    isEditing: false,
    isCopied: false,
    isFromHistory: false,
    error: null,
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Applies `change` only while the flow is still on `runId` and one of `steps`.
async function moveIf(
  $: Engine,
  runId: string,
  steps: readonly Step[],
  change: (flow: Flow) => Flow,
): Promise<boolean> {
  let isApplied = false
  await update($, flowAtom, flow => {
    isApplied = false
    if (flow === null || flow.runId !== runId || !steps.includes(flow.step)) {
      return flow
    }
    isApplied = true
    return change(flow)
  })
  return isApplied
}

async function fail(
  $: Engine,
  runId: string,
  during: 'questions' | 'rewrite',
  reason: string,
): Promise<void> {
  await moveIf($, runId, ['reading', 'rewriting'], flow => ({
    ...flow,
    step: 'error',
    error: { during, reason },
  }))
}

function failureOf(reply: ModelCompleteResult): string {
  if (reply.isAnswered) {
    return ''
  }
  const status = reply.reason === 'api-error' ? reply.status : undefined
  return describeFailure(reply.reason, status)
}

async function fetchQuestions($: Engine, runId: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null || flow.runId !== runId || flow.step !== 'reading') {
    return
  }
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({
      model: QUESTIONS_MODEL,
      system: QUESTIONS_SYSTEM,
      prompt: questionsPrompt(flow.original),
      maxTokens: 800,
      effort: 'low',
      timeoutMs: 45000,
    })
  } catch (error) {
    await fail($, runId, 'questions', `The model call was refused: ${errorText(error)}`)
    return
  }
  if (!reply.isAnswered) {
    await fail($, runId, 'questions', failureOf(reply))
    return
  }
  // A reply that cannot be read is treated as "no question would help".
  const questions = parseQuestions(reply.text) ?? []
  if (questions.length === 0) {
    const isMoved = await moveIf($, runId, ['reading'], current => ({
      ...current,
      step: 'rewriting',
      questions: [],
      answers: [],
    }))
    if (isMoved) {
      await runRewrite($, runId)
    }
    return
  }
  await moveIf($, runId, ['reading'], current => ({
    ...current,
    step: 'questions',
    questions,
    answers: questions.map((): Answer => null),
    otherFor: null,
  }))
}

async function runRewrite($: Engine, runId: string): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null || flow.runId !== runId || flow.step !== 'rewriting') {
    return
  }
  let reply: ModelCompleteResult
  try {
    reply = await $.model.complete({
      model: REWRITE_MODEL,
      system: REWRITE_SYSTEM,
      prompt: rewritePrompt(flow.original, flow.questions, flow.answers),
      maxTokens: 3000,
      timeoutMs: 120000,
    })
  } catch (error) {
    await fail($, runId, 'rewrite', `The model call was refused: ${errorText(error)}`)
    return
  }
  if (!reply.isAnswered) {
    await fail($, runId, 'rewrite', failureOf(reply))
    return
  }
  const rewrite = parseRewrite(reply.text)
  if (rewrite === undefined) {
    await fail($, runId, 'rewrite', describeFailure('unreadable'))
    return
  }
  const isMoved = await moveIf($, runId, ['rewriting'], current => ({
    ...current,
    step: 'review',
    upgraded: rewrite.prompt,
    added: rewrite.added,
    isEditing: false,
    isCopied: false,
  }))
  if (isMoved) {
    await remember($, flow.original, rewrite.prompt, rewrite.added)
  }
}

async function remember($: Engine, original: string, upgraded: string, added: string[]): Promise<void> {
  const entry: HistoryEntry = { id: newId(), at: Date.now(), original, upgraded, added }
  let kept: HistoryEntry[] = []
  await update($, historyAtom, list => {
    kept = [entry, ...list].slice(0, HISTORY_LIMIT)
    return kept
  })
  await $.store.set(STORE_HISTORY, kept)
}

async function startFlow($: Engine, original: string): Promise<void> {
  const flow = blankFlow('reading', original)
  await update($, flowAtom, () => flow)
  void fetchQuestions($, flow.runId).catch(error => fail($, flow.runId, 'questions', errorText(error)))
}

async function giveBack($: Engine, original: string): Promise<void> {
  await update($, flowAtom, () => null)
  try {
    await $.ui.close({ id: PANE })
  } catch {
    // Nothing to close.
  }
  if (original.length > 0) {
    await $.prompt.fill({ text: original })
    $.ui.log('Prompt Upgrade could not open its pane here (the window may be too narrow), so your words are back in the prompt box.')
    return
  }
  $.ui.log('Prompt Upgrade could not open its pane here. Widen the window and try again.')
}

// Opens the pane; when it cannot be drawn, puts the person's words back.
async function openOrGiveBack($: Engine, original: string): Promise<void> {
  try {
    const opened = await $.ui.open(OPEN)
    if (!opened.isPlaced) {
      await giveBack($, original)
    }
  } catch {
    await giveBack($, original)
  }
}

async function answer($: Engine, index: number, given: Answer): Promise<void> {
  const nextRun = newId()
  let isDone = false
  await update($, flowAtom, (flow): Flow | null => {
    isDone = false
    if (flow === null || flow.step !== 'questions') {
      return flow
    }
    const answers = flow.answers.map((one, at) => (at === index ? given : one))
    isDone = answers.every(one => one !== null)
    return {
      ...flow,
      answers,
      otherFor: null,
      step: isDone ? 'rewriting' : 'questions',
      runId: isDone ? nextRun : flow.runId,
    }
  })
  if (isDone) {
    await runRewrite($, nextRun)
  }
}

async function skipRest($: Engine): Promise<void> {
  const nextRun = newId()
  let isMoved = false
  await update($, flowAtom, (flow): Flow | null => {
    isMoved = false
    if (flow === null || flow.step !== 'questions') {
      return flow
    }
    isMoved = true
    return {
      ...flow,
      answers: flow.answers.map((one): Answer => one ?? { skipped: true }),
      otherFor: null,
      step: 'rewriting',
      runId: nextRun,
    }
  })
  if (isMoved) {
    await runRewrite($, nextRun)
  }
}

async function retry($: Engine): Promise<void> {
  const nextRun = newId()
  let during: 'questions' | 'rewrite' | undefined
  await update($, flowAtom, (flow): Flow | null => {
    during = undefined
    if (flow === null || flow.step !== 'error' || flow.error === null) {
      return flow
    }
    during = flow.error.during
    return {
      ...flow,
      step: during === 'questions' ? 'reading' : 'rewriting',
      error: null,
      runId: nextRun,
    }
  })
  if (during === 'questions') {
    await fetchQuestions($, nextRun)
  }
  if (during === 'rewrite') {
    await runRewrite($, nextRun)
  }
}

// Sends `text` as the person's own prompt. It arrives at `prompt.submit` with
// a `plugin` origin, which the intercept always lets through.
async function send($: Engine, text: string): Promise<void> {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return
  }
  await update($, flowAtom, () => null)
  await $.ui.close({ id: PANE })
  try {
    const sent = await $.prompt.submit({ text: trimmed, asUser: true })
    if (sent.drop !== undefined) {
      await $.prompt.fill({ text: trimmed })
    }
  } catch {
    await $.prompt.fill({ text: trimmed })
    $.ui.log('Prompt Upgrade could not send that, so it is in the prompt box for you to send.')
  }
}

async function cancel($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  await update($, flowAtom, () => null)
  await $.ui.close({ id: PANE })
  if (flow !== null && flow.original.length > 0 && !flow.isFromHistory) {
    await $.prompt.fill({ text: flow.original })
  }
}

async function setAuto($: Engine, isOn: boolean): Promise<void> {
  await update($, autoAtom, () => isOn)
  await $.store.set(STORE_AUTO, isOn)
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.at === 'number' &&
    typeof entry.original === 'string' &&
    typeof entry.upgraded === 'string' &&
    Array.isArray(entry.added)
  )
}

async function loadSaved($: Engine): Promise<void> {
  const savedHistory = await $.store.get(STORE_HISTORY)
  const history = Array.isArray(savedHistory) ? savedHistory.filter(isHistoryEntry).slice(0, HISTORY_LIMIT) : []
  await update($, historyAtom, () => history)
  const savedAuto = await $.store.get(STORE_AUTO)
  await update($, autoAtom, () => savedAuto === true)
}

// After a reload, picks up a step whose model call was lost with the old code.
async function resume($: Engine): Promise<void> {
  const flow = await read($, flowAtom)
  if (flow === null) {
    return
  }
  if (flow.step === 'reading' || flow.step === 'rewriting') {
    const nextRun = newId()
    const isMoved = await moveIf($, flow.runId, [flow.step], current => ({ ...current, runId: nextRun }))
    if (isMoved && flow.step === 'reading') {
      void fetchQuestions($, nextRun).catch(error => fail($, nextRun, 'questions', errorText(error)))
    }
    if (isMoved && flow.step === 'rewriting') {
      void runRewrite($, nextRun).catch(error => fail($, nextRun, 'rewrite', errorText(error)))
    }
  }
  const panes = await $.ui.panes()
  if (!panes.some(pane => pane.id === PANE)) {
    void $.ui.open(OPEN).catch(() => undefined)
  }
}

function say(text: string): { text: string; isTextDisplayOnly: true } {
  return { text, isTextDisplayOnly: true }
}

async function better($: Engine, args: string) {
  const typed = args.trim()
  const word = typed.toLowerCase()
  if (word === 'on') {
    await setAuto($, true)
    return say('Automatic mode is on. Prompts you type open in Prompt Upgrade first; start one with > to send it as is.')
  }
  if (word === 'off') {
    await setAuto($, false)
    return say('Automatic mode is off. Prompts you type are sent as usual.')
  }
  if (word === 'history') {
    const history = await read($, historyAtom)
    if (history.length === 0) {
      return say('No upgrades yet. Try /better followed by a rough prompt.')
    }
    await update($, flowAtom, () => blankFlow('history', ''))
    void openOrGiveBack($, '')
    return say(`Your last ${history.length} upgrade${history.length === 1 ? '' : 's'} are in the Prompt Upgrade pane.`)
  }
  if (typed.length === 0) {
    await update($, flowAtom, () => blankFlow('compose', ''))
    void openOrGiveBack($, '')
    return say('Type the prompt you want to upgrade in the Prompt Upgrade pane.')
  }
  await startFlow($, typed)
  void openOrGiveBack($, typed)
  return say('Upgrading your prompt in the Prompt Upgrade pane. Nothing is sent until you press Run it.')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'better',
        description: 'Upgrade a rough prompt before it is sent',
        argumentHint: '[prompt | on | off | history]',
        immediate: true,
      })
      await loadSaved($)
      await resume($)
    } catch (error) {
      $.ui.log(`Prompt Upgrade could not start: ${errorText(error)}`, { to: 'debug' })
    }
    return next(e)
  })

  on('command.run', { command: 'better' }, async ($, e) => {
    try {
      return await better($, e.args)
    } catch (error) {
      return say(`Prompt Upgrade could not do that (${errorText(error)}). Nothing was sent.`)
    }
  }).catch(() => say('Prompt Upgrade could not do that. Nothing was sent.'))

  on('prompt.submit', async ($, e, next) => {
    const isAuto = await read($, autoAtom)
    if (!isAuto) {
      return next(e)
    }
    const decision = decide(e)
    if (decision.kind === 'pass') {
      return next(e)
    }
    if (decision.kind === 'strip') {
      return decision.text.length > 0 ? next({ ...e, text: decision.text }) : next(e)
    }
    const original = e.text.trim()
    // The words are saved before the prompt is held back, and the pane gives
    // them back to the prompt box when it cannot open.
    await startFlow($, original)
    void openOrGiveBack($, original)
    // Answering without `next` enters nothing: the prompt waits in the pane.
    return { text: e.text }
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') {
      const flow = await read($, flowAtom)
      await update($, flowAtom, () => null)
      if (flow !== null && flow.original.length > 0 && !flow.isFromHistory) {
        await $.prompt.fill({ text: flow.original })
      }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Input } = $.ui.resolve(e)
    // Reads only: nothing here writes.
    const flow = await read($, flowAtom)
    const history = await read($, historyAtom)
    const width = Math.max(16, Math.floor(e.props.bodyColumns))

    const act = (work: () => Promise<unknown>) => {
      void work().catch(error => {
        $.ui.log(`Prompt Upgrade: that did not work (${errorText(error)}). Your prompt is safe.`)
      })
    }

    const heading = (label: string) => {
      const parts = headingParts(label, width)
      return (
        <Text>
          <Text color={MUTED} bold>
            {parts.label}
          </Text>
          <Text color={LINE}>{parts.rule}</Text>
        </Text>
      )
    }

    const blank = () => <Text> </Text>

    // Lines with [placeholders] picked out in amber.
    const prose = (line: string, color: string) => {
      const pieces = line.split(/(\[[^\]]+\])/).filter(piece => piece.length > 0)
      if (pieces.length === 0) {
        return <Text> </Text>
      }
      return (
        <Text>
          {pieces.map(piece => (
            <Text color={piece.startsWith('[') && piece.endsWith(']') ? AMBER : color}>{piece}</Text>
          ))}
        </Text>
      )
    }

    const chip = (
      key: string,
      label: string,
      kind: 'gold' | 'slate' | 'quiet',
      onPress: (press: UiPressArgument) => void,
    ) => {
      if (kind === 'quiet') {
        return (
          <Button key={key} plain onPress={onPress}>
            <Text color={MUTED}>{label}</Text>
          </Button>
        )
      }
      return (
        <Button key={key} plain onPress={onPress}>
          <Text backgroundColor={kind === 'gold' ? GOLD : LINE} color={kind === 'gold' ? INK : TEXT} bold={kind === 'gold'}>
            {` ${label} `}
          </Text>
        </Button>
      )
    }

    type Action = { key: string; label: string; kind: 'gold' | 'slate' | 'quiet'; onPress: (press: UiPressArgument) => void }

    // One row of buttons, or one per row when they would not fit across.
    const actions = (list: readonly Action[]) => {
      const cells = list.reduce((sum, one) => sum + one.label.length + (one.kind === 'quiet' ? 0 : 2), 0)
      const across = cells + (list.length - 1) * 2 <= width
      return (
        <Box flexDirection={across ? 'row' : 'column'} columnGap={2}>
          {list.map(one => chip(one.key, fit(one.label, Math.max(1, width - 2)), one.kind, one.onPress))}
        </Box>
      )
    }

    const card = (key: string, title: string, body: string, isAccent: boolean, cardWidth: number) => {
      const inner = Math.max(1, cardWidth - 4)
      return (
        <Box key={key} flexDirection="column" borderStyle="round" borderColor={isAccent ? GOLD : LINE} paddingX={1} width={cardWidth}>
          <Text color={isAccent ? GOLD : MUTED} bold>
            {fit(title.toUpperCase(), inner)}
          </Text>
          {wrap(body, inner).map(line => prose(line, TEXT))}
        </Box>
      )
    }

    const header = () => {
      const title = 'PROMPT UPGRADE'
      const rule = titleRule(title.length, width)
      return [
        <Text color={TEXT} bold>
          {fit(title, width)}
        </Text>,
        <Text>
          <Text color={GOLD}>{rule.gold}</Text>
          <Text color={LINE}>{rule.dim}</Text>
        </Text>,
      ]
    }

    const trackerRow = (current: number) => (
      <Text>
        {tracker(current, width).map(part => (
          <Text
            color={part.tone === 'done' ? GREEN : part.tone === 'current' ? GOLD : part.tone === 'sep' ? LINE : MUTED}
            bold={part.tone === 'current'}
          >
            {part.text}
          </Text>
        ))}
      </Text>
    )

    const cancelAction: Action = { key: 'cancel', label: 'Cancel', kind: 'quiet', onPress: () => act(() => cancel($)) }

    const frame = (body: RenderChildren[], current?: number) => (
      <Box flexDirection="column" width={width}>
        {header()}
        {current === undefined ? null : trackerRow(current)}
        {blank()}
        {body}
      </Box>
    )

    if (e.props.placement === 'widget') {
      const label = flow === null ? 'Ready' : STEP_LABELS[stepIndex(flow.step, flow.error?.during)] ?? 'Ready'
      return (
        <Box flexDirection="column" width={width}>
          <Text color={TEXT} bold>
            {fit('PROMPT UPGRADE', width)}
          </Text>
          <Text color={GOLD}>{fit(label, width)}</Text>
        </Box>
      )
    }

    if (flow === null) {
      return frame([
        <Text color={MUTED}>{fit('Nothing to upgrade right now.', width)}</Text>,
        <Text color={MUTED}>{fit('Type /better and a prompt to start.', width)}</Text>,
        blank(),
        actions([{ key: 'close', label: 'Close', kind: 'quiet', onPress: () => act(() => $.ui.close({ id: PANE })) }]),
      ])
    }

    if (flow.step === 'history') {
      const rows = history.map(entry => {
        const when = shortDate(entry.at)
        const room = Math.max(1, width - when.length - 2)
        const first = entry.original.replace(/\s+/g, ' ').trim()
        return (
          <Button
            key={`hist-${entry.id}`}
            plain
            onPress={() =>
              act(() =>
                update($, flowAtom, () => ({
                  ...blankFlow('review', entry.original),
                  upgraded: entry.upgraded,
                  added: entry.added,
                  isFromHistory: true,
                })),
              )
            }
          >
            <Text color={MUTED}>{`${when}  `}</Text>
            <Text color={TEXT}>{fit(first, room)}</Text>
          </Button>
        )
      })
      return frame([
        heading(`Last ${history.length} upgrades`),
        ...(rows.length > 0 ? rows : [<Text color={MUTED}>{fit('No upgrades yet.', width)}</Text>]),
        blank(),
        actions([{ key: 'close', label: 'Close', kind: 'quiet', onPress: () => act(() => cancel($)) }]),
      ])
    }

    const current = stepIndex(flow.step, flow.error?.during)

    if (flow.step === 'compose') {
      return frame(
        [
          heading('Your prompt'),
          ...wrap('Type the prompt you want to upgrade, then press Enter.', width).map(line => (
            <Text color={MUTED}>{line}</Text>
          )),
          <Input
            key="compose"
            placeholder="Your rough prompt"
            autoFocus
            onSubmit={value => {
              const typed = value.trim()
              if (typed.length > 0) {
                act(() => startFlow($, typed))
              }
            }}
          />,
          blank(),
          actions([cancelAction]),
        ],
        current,
      )
    }

    if (flow.step === 'reading') {
      return frame(
        [
          heading('Your prompt'),
          card('original', 'Your prompt', flow.original, false, width),
          ...wrap('Reading your prompt and choosing the questions that would help most.', width).map(line => (
            <Text color={MUTED}>{line}</Text>
          )),
          blank(),
          actions([cancelAction]),
        ],
        current,
      )
    }

    if (flow.step === 'questions') {
      const indent = 4
      const room = Math.max(8, width - indent)
      const blocks = flow.questions.flatMap((question, index) => {
        const given = flow.answers[index] ?? null
        const picked = given !== null && 'picked' in given ? given.picked : undefined
        const isSkipped = given !== null && 'skipped' in given
        const isCustom = picked !== undefined && !question.options.includes(picked)
        const badge =
          given === null ? (
            <Text backgroundColor={GOLD} color={INK} bold>{` ${index + 1} `}</Text>
          ) : isSkipped ? (
            <Text backgroundColor={LINE} color={MUTED} bold>{' – '}</Text>
          ) : (
            <Text backgroundColor={GREEN} color={INK} bold>{' ✓ '}</Text>
          )
        const lines = wrap(question.text, room)
        const otherLabel = isCustom && picked !== undefined ? `Other: ${picked}` : 'Other (type it)'
        const labels = [...question.options, otherLabel, 'Skip']
        const packed = packChips(labels, room, 1)
        const chipRows = packed.map((row, rowIndex) => (
          <Box key={`q${index}-row${rowIndex}`} flexDirection="row" columnGap={1} marginLeft={indent}>
            {row.map(({ index: at, label }) => {
              // Chips are told apart by position, never by their words.
              if (at === question.options.length + 1) {
                return chip(`q${index}-skip`, label, 'quiet', () => act(() => answer($, index, { skipped: true })))
              }
              if (at === question.options.length) {
                const isOn = isCustom || flow.otherFor === index
                return chip(`q${index}-other`, label, isOn ? 'gold' : 'slate', () =>
                  act(() => update($, flowAtom, now => (now === null ? now : { ...now, otherFor: index }))),
                )
              }
              const option = question.options[at] ?? ''
              return chip(`q${index}-o${at}`, label, picked === option ? 'gold' : 'slate', () =>
                act(() => answer($, index, { picked: option })),
              )
            })}
          </Box>
        ))
        const otherField =
          flow.otherFor === index ? (
            <Box marginLeft={indent} width={room}>
              <Input
                key={`other-${index}`}
                placeholder="Type your answer, then press Enter"
                autoFocus
                onSubmit={value => {
                  const typed = value.trim()
                  if (typed.length > 0) {
                    act(() => answer($, index, { picked: typed }))
                  }
                }}
              />
            </Box>
          ) : null
        return [
          <Text>
            {badge}
            <Text> </Text>
            <Text color={TEXT} bold>
              {lines[0] ?? ''}
            </Text>
          </Text>,
          ...lines.slice(1).map(line => (
            <Text color={TEXT} bold>
              {`${' '.repeat(indent)}${line}`}
            </Text>
          )),
          ...chipRows,
          ...(otherField === null ? [] : [otherField]),
          ...(isSkipped ? [<Text color={MUTED}>{`${' '.repeat(indent)}Skipped`}</Text>] : []),
          blank(),
        ]
      })
      const answered = flow.answers.filter(one => one !== null && 'picked' in one).length
      return frame(
        [
          heading('Questions'),
          <Text color={MUTED}>{fit(`“${flow.original.replace(/\s+/g, ' ').trim()}”`, width)}</Text>,
          blank(),
          ...blocks,
          <Text color={MUTED}>{fit(`${answered} of ${flow.questions.length} answered`, width)}</Text>,
          actions([
            { key: 'skip-rest', label: 'Skip the rest, upgrade now', kind: 'gold', onPress: () => act(() => skipRest($)) },
            cancelAction,
          ]),
        ],
        current,
      )
    }

    if (flow.step === 'rewriting') {
      return frame(
        [
          heading('Rewrite'),
          ...wrap('Writing the upgraded prompt. Nothing is sent until you press Run it.', width).map(line => (
            <Text color={MUTED}>{line}</Text>
          )),
          blank(),
          card('original', 'Your prompt', flow.original, false, width),
          blank(),
          actions([cancelAction]),
        ],
        current,
      )
    }

    if (flow.step === 'error') {
      const inner = Math.max(1, width - 4)
      return frame(
        [
          <Box key="error" flexDirection="column" borderStyle="round" borderColor={AMBER} paddingX={1} width={width}>
            <Text color={AMBER} bold>
              {fit('The upgrade paused', inner)}
            </Text>
            {wrap('Your prompt is safe. Nothing was sent.', inner).map(line => (
              <Text color={TEXT}>{line}</Text>
            ))}
            {wrap(flow.error?.reason ?? 'Something went wrong.', inner).map(line => (
              <Text color={MUTED}>{line}</Text>
            ))}
          </Box>,
          blank(),
          actions([
            { key: 'retry', label: 'Try again', kind: 'gold', onPress: () => act(() => retry($)) },
            { key: 'send-original', label: 'Send my original', kind: 'slate', onPress: () => act(() => send($, flow.original)) },
            cancelAction,
          ]),
        ],
        current,
      )
    }

    // Review.
    const before = wordCount(flow.original)
    const after = wordCount(flow.upgraded)
    const stats = [
      { label: 'words before', value: before },
      { label: 'words after', value: after },
      { label: 'details added', value: flow.added.length },
    ]
    const tiles = statTiles(stats, width)
    // Three tall tiles when they fit across, else one plain line.
    const numbers =
      tiles === undefined ? (
        <Text color={TEXT}>{fit(`${before} words before  ${after} words after  ${flow.added.length} added`, width)}</Text>
      ) : (
        <Box flexDirection="row" columnGap={1}>
          {tiles.map((tile, at) => (
            <Box key={`tile-${at}`} flexDirection="column" borderStyle="round" borderColor={LINE} paddingX={1} width={tile.outer}>
              {tile.rows.map(row => (
                <Text color={at === 1 ? GOLD : at === 2 ? GREEN : TEXT}>{padEnd(row, tile.inner)}</Text>
              ))}
              <Text color={MUTED}>{padEnd(tile.label, tile.inner)}</Text>
            </Box>
          ))}
        </Box>
      )
    const hasPlaceholders = /\[[^\]]+\]/.test(flow.upgraded)
    const side = width >= 64
    const leftWidth = side ? Math.floor((width - 1) / 2) : width
    const rightWidth = side ? width - leftWidth - 1 : width
    const editRows = Math.min(10, Math.max(3, wrap(flow.upgraded, width).length))

    return frame(
      [
        numbers,
        ...(hasPlaceholders
          ? wrap('Fill in the [placeholders] before you run it, or leave them for Claude to ask about.', width).map(line =>
              prose(line, AMBER),
            )
          : []),
        blank(),
        actions([
          { key: 'run', label: 'Run it', kind: 'gold', onPress: () => act(() => send($, flow.upgraded)) },
          {
            key: 'edit',
            label: flow.isEditing ? 'Done editing' : 'Edit',
            kind: 'slate',
            onPress: () => act(() => update($, flowAtom, now => (now === null ? now : { ...now, isEditing: !now.isEditing }))),
          },
          {
            key: 'copy',
            label: flow.isCopied ? 'Copied' : 'Copy',
            kind: 'slate',
            onPress: press =>
              act(async () => {
                const copied = await $.ui.copy({ text: flow.upgraded, surface: press.surface })
                if (copied.isCopied) {
                  await update($, flowAtom, now => (now === null ? now : { ...now, isCopied: true }))
                } else {
                  $.ui.log('Prompt Upgrade could not copy here. Use Edit to select the text instead.')
                }
              }),
          },
          cancelAction,
        ]),
        ...(flow.isEditing
          ? [
              blank(),
              <Text color={MUTED}>{fit('Edit the upgrade, then press Enter to run it.', width)}</Text>,
              <Input
                key="edit"
                value={flow.upgraded}
                rows={editRows}
                autoFocus
                onInput={value =>
                  act(() => update($, flowAtom, now => (now === null ? now : { ...now, upgraded: value, isCopied: false })))
                }
                onSubmit={value => act(() => send($, value))}
              />,
            ]
          : []),
        blank(),
        heading('What I added'),
        ...(flow.added.length === 0
          ? [<Text color={MUTED}>{fit('Nothing beyond tidying the wording.', width)}</Text>]
          : flow.added.flatMap(item =>
              wrap(item, Math.max(1, width - 2)).map((line, at) => (
                <Text>
                  <Text color={GREEN}>{at === 0 ? '+ ' : '  '}</Text>
                  <Text color={TEXT}>{line}</Text>
                </Text>
              )),
            )),
        blank(),
        <Box flexDirection={side ? 'row' : 'column'} columnGap={1}>
          {card('before', 'Your prompt', flow.original, false, leftWidth)}
          {card('after', 'Upgraded', flow.upgraded, true, rightWidth)}
        </Box>,
      ],
      current,
    )
  })
}
