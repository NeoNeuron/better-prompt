import { expect, test } from 'claude-code/testing'

import { AS_TYPED_COMMAND, PLUGIN, REWRITE_REPLY, ROUGH, TYPED, engine, paneAt } from './kit'

const START = { cwd: '/', surface: 'terminal', isInteractive: true } as const
const UPGRADED = (JSON.parse(REWRITE_REPLY) as { prompt: string }).prompt

test('the full flow from /better to Run', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)

  const said = await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  expect(said.text).toMatch(/Nothing is sent until you press Run it/)
  await bottom.clock.settle()
  expect(bottom.opened).toEqual([PLUGIN])

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...paneAt(100), surface })
    expect(await ui.find({ type: 'Text', text: /Who is the email for\?/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /0 of 2 answered/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...paneAt(100), surface: 'terminal' })
  await ui.press({ key: 'q0-o0' })
  expect(await ui.find({ type: 'Text', text: /1 of 2 answered/ })).toBeDefined()
  await ui.press({ key: 'q1-skip' })
  await bottom.clock.settle()

  // The rewrite saw the answer and left out the skipped question.
  const rewriteCall = bottom.modelCalls.find(call => call.model === 'sonnet')
  expect(rewriteCall?.prompt).toContain('Who is the email for? My team')
  expect(rewriteCall?.prompt).not.toContain('How long')

  expect(await ui.find({ key: 'run' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Audience: my team/ })).toBeDefined()
  expect(bottom.submitted).toEqual([])

  await ui.press({ key: 'run' })
  expect(bottom.submitted).toEqual([{ text: UPGRADED, origin: 'plugin' }])
  expect(bottom.closed).toContain(PLUGIN)
  await ui.unmount()
})

test('Cancel puts the original prompt back in the prompt box', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()

  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'cancel' })
  expect(bottom.filled).toEqual([ROUGH])
  expect(bottom.closed).toContain(PLUGIN)
  expect(bottom.submitted).toEqual([])
  await ui.unmount()
})

test('the on and off switch decides whether typed prompts are held', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)

  // Off by default: a typed prompt goes straight through.
  await $.prompt.submit({ text: ROUGH, ...TYPED })
  expect(bottom.submitted).toEqual([{ text: ROUGH, origin: 'composer' }])

  const onSaid = await $.command.run({ command: 'better', args: 'on', ...AS_TYPED_COMMAND })
  expect(onSaid.text).toMatch(/Automatic mode is on/)
  await $.prompt.submit({ text: ROUGH, ...TYPED })
  await bottom.clock.settle()
  expect(bottom.submitted).toHaveLength(1)
  expect(bottom.opened).toEqual([PLUGIN])

  // Short replies, slash commands and > prompts still pass.
  await $.prompt.submit({ text: 'keep going', ...TYPED })
  await $.prompt.submit({ text: '> run the full test suite once more', ...TYPED })
  expect(bottom.submitted.map(one => one.text)).toEqual([ROUGH, 'keep going', 'run the full test suite once more'])

  // Run from the pane is never held again.
  const ui = await $.ui.mount({ ...paneAt(100), surface: 'terminal' })
  await ui.press({ key: 'skip-rest' })
  await bottom.clock.settle()
  await ui.press({ key: 'run' })
  expect(bottom.submitted.at(-1)).toEqual({ text: UPGRADED, origin: 'plugin' })
  await ui.unmount()

  const offSaid = await $.command.run({ command: 'better', args: 'off', ...AS_TYPED_COMMAND })
  expect(offSaid.text).toMatch(/Automatic mode is off/)
  await $.prompt.submit({ text: ROUGH, ...TYPED })
  expect(bottom.submitted.at(-1)).toEqual({ text: ROUGH, origin: 'composer' })
})

test('automatic mode is remembered across sessions', async ($, on) => {
  const bottom = engine(on, { store: { auto: true } })
  await $.session.start(START)
  await $.prompt.submit({ text: ROUGH, ...TYPED })
  await bottom.clock.settle()
  expect(bottom.submitted).toEqual([])
  expect(bottom.opened).toEqual([PLUGIN])
})

test('a pane that cannot open gives the words back', async ($, on) => {
  const bottom = engine(on, { isPlaced: false, store: { auto: true } })
  await $.session.start(START)
  await $.prompt.submit({ text: ROUGH, ...TYPED })
  await bottom.clock.settle()
  expect(bottom.filled).toEqual([ROUGH])
  expect(bottom.logged).toHaveLength(1)
  expect(bottom.submitted).toEqual([])
})

test('a failed model call shows a calm error card with three ways out', async ($, on) => {
  const bottom = engine(on, { questions: 'fail' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()

  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Your prompt is safe/ })).toBeDefined()
  expect(await ui.find({ key: 'retry' })).toBeDefined()
  expect(await ui.find({ key: 'cancel' })).toBeDefined()
  await ui.press({ key: 'send-original' })
  expect(bottom.submitted).toEqual([{ text: ROUGH, origin: 'plugin' }])
  await ui.unmount()
})

test('no question needed goes straight to the review', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  expect(await ui.find({ key: 'run' })).toBeDefined()
  await ui.unmount()
})

test('history keeps upgrades and reopens a review', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const review = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await review.press({ key: 'cancel' })
  await review.unmount()

  const said = await $.command.run({ command: 'better', args: 'history', ...AS_TYPED_COMMAND })
  expect(said.text).toMatch(/last 1 upgrade/)
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  const rows = await ui.findAll({ type: 'Button' })
  const row = rows.find(one => one.key?.startsWith('hist-'))
  expect(row).toBeDefined()
  await ui.press({ key: row?.key ?? '' })
  expect(await ui.find({ key: 'run' })).toBeDefined()
  await ui.unmount()
})

test('every row fits a narrow and a wide pane', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()

  for (const columns of [40, 120]) {
    const ui = await $.ui.mount({ ...paneAt(columns), surface: 'terminal' })
    for (const text of await ui.findAll({ type: 'Text' })) {
      expect(text.text.length).toBeLessThanOrEqual(columns)
    }
    await ui.unmount()
  }

  const questions = await $.ui.mount({ ...paneAt(120), surface: 'terminal' })
  await questions.press({ key: 'skip-rest' })
  await bottom.clock.settle()
  await questions.unmount()

  for (const columns of [40, 120]) {
    const ui = await $.ui.mount({ ...paneAt(columns), surface: 'terminal' })
    expect(await ui.find({ key: 'run' })).toBeDefined()
    for (const text of await ui.findAll({ type: 'Text' })) {
      expect(text.text.length).toBeLessThanOrEqual(columns)
    }
    await ui.unmount()
  }
})

test('/better alone opens a box to type a prompt', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)
  const said = await $.command.run({ command: 'better', args: '', ...AS_TYPED_COMMAND })
  expect(said.text).toMatch(/Type the prompt/)
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.input({ key: 'compose', text: ROUGH })
  await bottom.clock.settle()
  expect(await ui.find({ type: 'Text', text: /Who is the email for\?/ })).toBeDefined()
  await ui.unmount()
})

test('Edit changes the upgrade and Enter runs it', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'edit' })
  await ui.input({ key: 'edit', text: 'my edited prompt for the team', kind: 'submit' })
  expect(bottom.submitted).toEqual([{ text: 'my edited prompt for the team', origin: 'plugin' }])
  await ui.unmount()
})

test('a reload mid-step picks the step back up', async ($, on) => {
  // The first questions call hangs, as one lost with the old code would.
  const bottom = engine(on, { firstCallDelayMs: 600000 })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()

  const stuck = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  expect(await stuck.find({ type: 'Text', text: /Reading your prompt/ })).toBeDefined()
  await stuck.unmount()

  // A reload runs session.start again; $.state keeps the flow.
  await $.session.start(START)
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /Who is the email for\?/ })).toBeDefined()

  // The old call's late answer changes nothing.
  await bottom.clock.advance(600000)
  expect(await ui.find({ type: 'Text', text: /0 of 2 answered/ })).toBeDefined()
  await ui.unmount()
})

test('Other (type it) sends the typed answer to the rewrite', async ($, on) => {
  const bottom = engine(on)
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'q0-other' })
  await ui.input({ key: 'other-0', text: 'The board of directors' })
  await ui.press({ key: 'q1-o1' })
  await bottom.clock.settle()
  const rewriteCall = bottom.modelCalls.find(call => call.model === 'sonnet')
  expect(rewriteCall?.prompt).toContain('Who is the email for? The board of directors')
  expect(rewriteCall?.prompt).toContain('How long should it be? Detailed')
  await ui.unmount()
})

test('an option the model calls Skip or Other is still an ordinary answer', async ($, on) => {
  const questions = JSON.stringify({ questions: [{ question: 'Which step?', options: ['Skip', 'Other'] }] })
  const bottom = engine(on, { questions })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'q0-o0' })
  await bottom.clock.settle()
  expect(bottom.modelCalls.find(call => call.model === 'sonnet')?.prompt).toContain('Which step? Skip')
  await ui.unmount()
})

test('Copy copies the upgrade and says so on the button', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  await ui.press({ key: 'copy' })
  expect((await ui.find({ key: 'copy' }))?.text).toMatch(/Copied/)
  expect(bottom.submitted).toEqual([])
  await ui.unmount()
})

test('the review buttons fit across a narrow pane', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(40), surface: 'terminal' })
  let cells = 0
  for (const key of ['run', 'edit', 'copy', 'cancel']) {
    cells += (await ui.find({ key }))?.text.length ?? 99
  }
  expect(cells + 3 * 2).toBeLessThanOrEqual(40)
  await ui.unmount()
})

test('a malformed saved history entry is left out', async ($, on) => {
  const good = { id: 'a1', at: 0, original: 'old rough prompt', upgraded: 'old upgraded prompt', added: [] }
  const bottom = engine(on, { store: { history: [{ id: 'bad' }, good, 'nonsense'] } })
  await $.session.start(START)
  const said = await $.command.run({ command: 'better', args: 'history', ...AS_TYPED_COMMAND })
  expect(said.text).toMatch(/last 1 upgrade/)
  await bottom.clock.settle()
  const ui = await $.ui.mount({ ...paneAt(80), surface: 'terminal' })
  const rows = (await ui.findAll({ type: 'Button' })).filter(one => one.key?.startsWith('hist-'))
  expect(rows).toHaveLength(1)
  await ui.unmount()
})

test('the review and error screens draw on every surface', async ($, on) => {
  const bottom = engine(on, { questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...paneAt(90), surface })
    expect(await ui.find({ key: 'run' })).toBeDefined()
    await ui.unmount()
  }
})

test('the error screen draws on every surface', async ($, on) => {
  const bottom = engine(on, { rewrite: 'fail', questions: '{"questions":[]}' })
  await $.session.start(START)
  await $.command.run({ command: 'better', args: ROUGH, ...AS_TYPED_COMMAND })
  await bottom.clock.settle()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...paneAt(90), surface })
    expect(await ui.find({ key: 'retry' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Your prompt is safe/ })).toBeDefined()
    await ui.unmount()
  }
})
