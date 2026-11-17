import { expect, test } from 'claude-code/testing'

import { decide, parseQuestions, parseRewrite, tracker, wrap } from '../hooks/logic'

const typed = (text: string) => ({ text, origin: { kind: 'composer' } })

test('a rough typed prompt is intercepted', async () => {
  expect(decide(typed('write an email about the release for everyone'))).toEqual({ kind: 'intercept' })
})

test('what passes straight through', async () => {
  expect(decide(typed('/compact')).kind).toBe('pass')
  expect(decide({ ...typed('/review the diff'), command: { name: 'review', args: 'the diff' } }).kind).toBe('pass')
  expect(decide({ ...typed('look at this screenshot please now'), attachments: [{ type: 'image' }] }).kind).toBe('pass')
  expect(decide(typed('explain what @src/app.ts does to me')).kind).toBe('pass')
  expect(decide({ ...typed('also check the tests while you are there'), turnId: 't1' }).kind).toBe('pass')
  expect(decide(typed('yes')).kind).toBe('pass')
  expect(decide(typed('keep going')).kind).toBe('pass')
  expect(decide(typed('Sounds good!')).kind).toBe('pass')
  expect(decide({ text: 'write an email about the release for everyone', origin: { kind: 'plugin' } }).kind).toBe('pass')
  expect(decide({ ...typed('write an email about the release for everyone'), isMeta: true }).kind).toBe('pass')
})

test('a prompt starting with > is sent without the >', async () => {
  expect(decide(typed('> just run the whole test suite again'))).toEqual({
    kind: 'strip',
    text: 'just run the whole test suite again',
  })
})

test('reading the questions', async () => {
  const reply = '```json\n{"questions":[{"question":"Who is it for?","options":["Me","My team","Me"]},{"question":"Too few","options":["One"]},{"question":"Format?","options":["List","Table","Prose","Code","Chart"]},{"question":"Tone?","options":["Warm","Plain"]},{"question":"Fourth?","options":["A","B"]}]}\n```'
  const questions = parseQuestions(reply)
  expect(questions).toEqual([
    { text: 'Who is it for?', options: ['Me', 'My team'] },
    { text: 'Format?', options: ['List', 'Table', 'Prose', 'Code'] },
    { text: 'Tone?', options: ['Warm', 'Plain'] },
  ])
  expect(parseQuestions('{"questions":[]}')).toEqual([])
  expect(parseQuestions('I cannot help with that')).toBeUndefined()
})

test('reading the rewrite', async () => {
  const reply = 'Here you go: {"prompt":"Write [thing] for my team.","added":["Audience","  ","Format"]}'
  expect(parseRewrite(reply)).toEqual({ prompt: 'Write [thing] for my team.', added: ['Audience', 'Format'] })
  expect(parseRewrite('{"prompt":"   "}')).toBeUndefined()
  expect(parseRewrite('no json here')).toBeUndefined()
})

test('the tracker and wrapped text fit narrow and wide panes', async () => {
  for (const width of [24, 40, 120]) {
    for (let step = 0; step < 4; step += 1) {
      const length = tracker(step, width).reduce((sum, part) => sum + part.text.length, 0)
      expect(length).toBeLessThanOrEqual(width)
    }
    for (const line of wrap('a supercalifragilisticexpialidocious word and some ordinary words after it', width)) {
      expect(line.length).toBeLessThanOrEqual(width)
    }
  }
})
