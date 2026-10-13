import { test, expect, mock } from 'claude-code/testing'
import { drawnRow, jumpNotice, pickPrompt, rowKey, windowStart } from './index.tsx'

const prompt = (text: string, onScreen: { first: number; last: number; of: number } | null) => ({
  text,
  origin: { kind: 'composer' as const },
  isExpanded: false,
  onScreen,
})

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} }

const drawPrompts = async ($: any, on: any) => {
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  // Stand in for the engine's empty band when the plugin passes it on.
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  mock.store(on)
  on('config.set', ($: any, e: any) => ({ value: e.value }))
  on('ui.toast', () => ({ value: undefined }))
  // Stand in for the engine moving the band's ring.
  on('ui.focus', () => ({}))
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm1', props: prompt('first prompt', null) })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm2', props: prompt('second prompt', { first: 0, last: 3, of: 4 }) })
}

// The band takes the keyboard as alt+j (abovePrompt:focus) gives it: its
// ring lands on the marked row, the autoFocus Button.
const focusBand = ($: any) =>
  $.ui.focus({ component: 'AbovePrompt', requestId: 'above-prompt', plugin: 'prompt-rail', element: 'open', origin: { kind: 'plugin', name: 'prompt-rail' } })

// Each prompt row the band draws, as the text it shows.
const rowsOf = async (band: any) =>
  (await band.findAll({ type: 'Box' })).filter((box: any) => /^row-\d+$/.test(String(box.props.key))).map((box: any) => String(box.text))

test('at rest the band holds the latest prompt on one tinted row', async ($, on) => {
  await drawPrompts($, on)
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await rowsOf(band)).toEqual(['❯ #2 second prompt'])
  const row = (await band.findAll({ type: 'Box' })).find((box: any) => box.props.key === 'row-1')
  expect(row?.props.backgroundColor).toBe('userMessageBackground')
  // Its Button is where the ring lands as the band takes the keyboard; no other control is drawn.
  expect((await band.findAll({ type: 'Button' })).map((b: any) => [b.props.key, b.props.autoFocus])).toEqual([['open', true]])
})

test('wide characters are cut by the cells they take, and a narrow band never wraps a row', async ($, on) => {
  await drawPrompts($, on)
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'm3', props: prompt('日本語のプロンプト', null) })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 12 } })
  expect(await rowsOf(band)).toEqual(['❯ #3 日本語…'])
  const narrowest = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, bodyColumns: 4 } })
  expect(await rowsOf(narrowest)).toEqual(['❯ #…'])
})

test('the band taking the keyboard browses the newest four from the latest; j, k and q move and leave', async ($, on) => {
  await drawPrompts($, on)
  for (const n of [3, 4, 5]) {
    await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: `m${n}`, props: prompt(`prompt ${n}`, null) })
  }
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect((await focusBand($)).deny).toBeUndefined()
  const frame = (await band.findAll({ type: 'Box' })).find((box: any) => box.props.borderStyle === 'round')
  expect(frame).toBeDefined()
  expect(await rowsOf(band)).toEqual(['#2 second prompt', '#3 prompt 3', '#4 prompt 4', '❯ #5 prompt 5'])
  expect((await band.findAll({ type: 'Button' })).filter((b: any) => b.props.hotkey).map((b: any) => [b.props.hotkey, b.props.label])).toEqual([
    ['j', 'next'],
    ['k', 'prev'],
    ['q', 'back'],
  ])
  await band.press({ key: 'prev' })
  expect(await rowsOf(band)).toEqual(['#2 second prompt', '#3 prompt 3', '❯ #4 prompt 4', '#5 prompt 5'])
  for (let i = 0; i < 4; i++) await band.press({ key: 'prev' })
  // The window follows the selection up and stops at the first prompt.
  expect(await rowsOf(band)).toEqual(['❯ #1 first prompt', '#2 second prompt', '#3 prompt 3', '#4 prompt 4'])
  await band.press({ key: 'next' })
  expect(await rowsOf(band)).toEqual(['#1 first prompt', '❯ #2 second prompt', '#3 prompt 3', '#4 prompt 4'])
  await band.press({ key: 'back' })
  // The drawing that ends browsing has nothing focusable, so the keys go back to the prompt.
  expect(await rowsOf(band)).toEqual(['❯ #5 prompt 5'])
  expect(await band.findAll({ type: 'Button' })).toEqual([])
  await band.redraw(BAND)
  expect((await band.findAll({ type: 'Button' })).map((b: any) => b.props.key)).toEqual(['open'])
})

test('/prompt-rail-back, the binding of Escape in the band, also ends browsing', async ($, on) => {
  await drawPrompts($, on)
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await focusBand($)
  await band.press({ key: 'prev' })
  expect(await rowsOf(band)).toEqual(['❯ #1 first prompt', '#2 second prompt'])
  await $.command.run({ command: 'prompt-rail-back', args: '' })
  expect(await rowsOf(band)).toEqual(['❯ #2 second prompt'])
  // Taking the keyboard again starts from the latest prompt.
  await band.redraw(BAND)
  await focusBand($)
  expect(await rowsOf(band)).toEqual(['#1 first prompt', '❯ #2 second prompt'])
})

test('a browsing window moves only to keep the selection in it', () => {
  // Ten prompts, four at a time.
  expect([windowStart(0, 9, 10), windowStart(6, 8, 10), windowStart(6, 5, 10), windowStart(2, 0, 10)]).toEqual([6, 6, 5, 0])
  expect([windowStart(0, 1, 2), windowStart(0, 0, 0)]).toEqual([0, 0])
})

test('a command names a prompt by number, first, last or the words it holds', () => {
  const texts = ['fix the build', 'add tests', 'Fix the docs']
  expect([pickPrompt('2', texts), pickPrompt('#3', texts), pickPrompt('4', texts), pickPrompt('0', texts)]).toEqual([1, 2, -1, -1])
  expect([pickPrompt('first', texts), pickPrompt('last', texts), pickPrompt('last', [])]).toEqual([0, 2, -1])
  // The newest that holds the words, case aside.
  expect([pickPrompt('find fix the', texts), pickPrompt('find nothing', texts)]).toEqual([2, -1])
  expect([pickPrompt('on', texts), pickPrompt('', texts), pickPrompt('find', texts)]).toEqual([undefined, undefined, undefined])
})

// A transcript JSONL from rows given in order; each row's parent is the one
// before it unless it names its own (`parentUuid`, null at a chain's root).
const jsonl = (rows: Record<string, unknown>[]) =>
  rows
    .map((row, i) => JSON.stringify({ parentUuid: i === 0 ? null : rows[i - 1]?.uuid, ...row }))
    .join('\n')

const TRANSCRIPT = jsonl([
  { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first stored prompt' } },
  {
    type: 'assistant',
    uuid: 'a1',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
  },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
  { type: 'user', uuid: 'u2', message: { role: 'user', content: '<div> why does this overflow?' } },
  { type: 'user', uuid: 'c1', message: { role: 'user', content: '<command-name>/prompt-rail</command-name>' } },
  { type: 'user', uuid: 'u3', message: { role: 'user', content: 'continue' } },
  { type: 'user', uuid: 'u4', message: { role: 'user', content: 'continue' } },
])

// alpha -> beta -> gamma, then /rewind to before beta and delta sent instead.
const FORKED = jsonl([
  { type: 'user', uuid: 'p1', message: { role: 'user', content: 'alpha' } },
  { type: 'assistant', uuid: 'q1', message: { role: 'assistant', content: [{ type: 'text', text: 'alpha' }] } },
  { type: 'user', uuid: 'p2', message: { role: 'user', content: 'beta' } },
  { type: 'assistant', uuid: 'q2', message: { role: 'assistant', content: [{ type: 'text', text: 'beta' }] } },
  { type: 'user', uuid: 'p3', message: { role: 'user', content: 'gamma' } },
  { type: 'assistant', uuid: 'q3', message: { role: 'assistant', content: [{ type: 'text', text: 'gamma' }] } },
  { type: 'user', uuid: 'p4', parentUuid: 'q1', message: { role: 'user', content: 'delta' } },
  { type: 'assistant', uuid: 'q4', message: { role: 'assistant', content: [{ type: 'text', text: 'delta' }] } },
  { type: 'system', uuid: 's1' },
])

// A prompt, then /compact: the boundary starts a new chain whose logical parent
// is the last row before it.
const COMPACTED = jsonl([
  { type: 'user', uuid: 'p1', message: { role: 'user', content: 'before compact' } },
  { type: 'assistant', uuid: 'q1', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } },
  { type: 'system', uuid: 'b1', parentUuid: null, logicalParentUuid: 'q1', subtype: 'compact_boundary' },
  { type: 'user', uuid: 'p2', message: { role: 'user', content: 'after compact' } },
])

// What the world beneath the plugin holds and counts: the transcript file's
// text (a test may change it), how often the plugin read it, how often it
// asked for a redraw of everything it hooks and of the rail alone, and the
// settings it wrote.
type Beneath = {
  transcript: string
  mtimeMs: number
  reads: number
  invalidations: number
  railRedraws: number
  settings: Map<string, unknown>
  commands: unknown[]
  toasts: string[]
  // Each line the plugin pinned as its status (undefined for a clear).
  status: (string | undefined)[]
  // Each `tail` the plugin spawned, as its argv, and whether spawning fails
  // (the desktop app and SDK hosts run no processes).
  spawns: string[][]
  spawnFails: boolean
  // Whether /config has a row for the plugin's fields (the desktop app's SDK sessions have none).
  hasConfigRow: boolean
}
const beneath = (transcript = TRANSCRIPT): Beneath => ({
  transcript,
  mtimeMs: 1,
  reads: 0,
  invalidations: 0,
  railRedraws: 0,
  settings: new Map(),
  commands: [],
  toasts: [],
  status: [],
  spawns: [],
  spawnFails: false,
  hasConfigRow: true,
})

const bytes = (text: string) => new TextEncoder().encode(text)
// The engine's cap on one $.fs.read.
const READ_CAP = 4 * 1024 * 1024

// The world beneath the plugin for a session whose transcript is TRANSCRIPT,
// with a store in memory the test can read.
const world = (on: any, initial: Record<string, unknown> = {}, transcript = TRANSCRIPT, disk: Beneath = beneath(transcript)) => {
  const store = new Map<string, unknown>(Object.entries(initial))
  on('store.get', ($: any, e: any) => ({ value: store.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('store.delete', ($: any, e: any) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('fs.read', ($: any, e: any) => {
    disk.reads++
    if (bytes(disk.transcript).length > READ_CAP) return { deny: 'over 4 MiB' }
    return { value: e.path === '/t/s1.jsonl' ? disk.transcript : '' }
  })
  on('fs.stat', ($: any, e: any) => ({
    value: { kind: 'file', size: e.path === '/t/s1.jsonl' ? bytes(disk.transcript).length : 0, mtimeMs: disk.mtimeMs, isLink: false },
  }))
  // `tail -c +N path`: the file's bytes from the Nth on, in pieces of a
  // megabyte or so, as a child's output arrives.
  on('process.spawn', async function* ($: any, e: any) {
    disk.spawns.push([...e.argv])
    if (disk.spawnFails) throw new Error('no processes here')
    const from = Number(String(e.argv[2]).slice(1)) - 1
    const text = new TextDecoder().decode(bytes(disk.transcript).slice(from))
    for (let i = 0; i < text.length; i += 1 << 20) yield { stream: 'stdout', text: text.slice(i, i + (1 << 20)) }
    return { value: { code: 0, signal: null } }
  })
  on('ui.invalidate', () => {
    disk.invalidations++
    return { value: undefined }
  })
  on('state.set', ($: any, e: any, next: any) => {
    disk.railRedraws++
    return next(e)
  })
  on('session.id', () => ({ value: 's1' }))
  on('classic.SessionStart', () => ({}))
  on('classic.Stop', () => ({}))
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }))
  on('command.register', ($: any, e: any) => {
    disk.commands.push(e)
    return { value: { command: e.name } }
  })
  on('config.set', ($: any, e: any) => {
    if (!disk.hasConfigRow) throw new Error('$.config.set: no /config row with key prompt-rail.mode ($.config.list names them)')
    disk.settings.set(e.key, e.value)
    return { value: e.value }
  })
  on('ui.status', ($: any, e: any) => {
    disk.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($: any, e: any) => {
    disk.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.render', { component: 'UserMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.text }))
  on('ui.render', { component: 'ToolUse' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: e.props.tool }))
  on('ui.render', { component: 'AssistantMessage' }, ($: any, e: any) => $.ui.resolve(e).Text({ children: 'reply' }))
  on('ui.render', { component: 'AbovePrompt' }, ($: any, e: any) => $.ui.resolve(e).Box({}))
  on('ui.focus', () => ({}))
  return store
}

// The prompts the band lists while browsing (the newest four), without their
// marks and numbers; browsing ends again after.
const railLabels = async ($: any) => {
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  // The drawing after one that ended browsing brings the marked row's Button back.
  await band.redraw(BAND)
  if (await band.find({ key: 'open' })) await focusBand($)
  const labels = (await rowsOf(band)).map((row: string) => row.replace(/^(❯ )?#\d+ /, ''))
  await $.command.run({ command: 'prompt-rail-back', args: '' })
  await band.unmount()
  return labels
}

// A transcript over the engine's read cap: a prompt, a tool call whose
// result is 4.5 MB, then more prompts. Every row ends with a newline, as the
// engine writes them.
const BULK = 'x'.repeat(4.5 * 1024 * 1024)
const bigRows = (more: Record<string, unknown>[] = []) => [
  { type: 'user', uuid: 'p1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: 'b1', timestamp: '2026-09-24T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/w/big.log' } }] } },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BULK }] } },
  { type: 'assistant', uuid: 'b2', timestamp: '2026-09-24T00:00:20.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'read it' }] } },
  { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 20000 },
  { type: 'user', uuid: 'p2', timestamp: '2026-09-24T00:01:00.000Z', message: { role: 'user', content: '二番目のプロンプト' } },
  ...more,
]
const bigFile = (rows: Record<string, unknown>[]) => `${jsonl(rows)}\n`
const bigWorld = (on: any, rows = bigRows()) => {
  const disk = beneath(bigFile(rows))
  world(on, {}, disk.transcript, disk)
  return { disk, clock: mock.clock(on) }
}
const stop = ($: any) => $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })

test('a transcript over 4 MiB is listed in its order without $.fs.read', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', '二番目のプロンプト'])
  expect(disk.reads).toBe(0)
  expect(disk.spawns).toEqual([['tail', '-c', '+1', '/t/s1.jsonl']])
})

test('a later read of a large transcript asks only for the bytes after the last row', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  const before = bytes(disk.transcript).length
  const lastRow = bytes(`${JSON.stringify({ parentUuid: 'd1', ...bigRows()[5] })}\n`).length
  disk.transcript = bigFile(bigRows([{ type: 'user', uuid: 'p3', message: { role: 'user', content: 'third' } }]))
  disk.mtimeMs = 2
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', '二番目のプロンプト', 'third'])
  // It starts at the last row read, to check the file still holds it there.
  expect(disk.spawns[1]).toEqual(['tail', '-c', `+${before - lastRow + 1}`, '/t/s1.jsonl'])
})

test('a row torn at the end of a large transcript is listed once it is whole', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  const whole = bigFile(bigRows([{ type: 'user', uuid: 'p3', message: { role: 'user', content: 'third' } }]))
  disk.transcript = whole.slice(0, whole.length - 20)
  disk.mtimeMs = 2
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', '二番目のプロンプト'])
  disk.transcript = whole
  disk.mtimeMs = 3
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', '二番目のプロンプト', 'third'])
})

test('a large transcript rewritten under the rail is read again from its start', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  // Same size or larger, but no longer the rows read: a replaced file.
  disk.transcript = bigFile(bigRows().map(row => (row.uuid === 'p2' ? { ...row, uuid: 'q2', message: { role: 'user', content: 'replaced prompt' } } : row)))
  disk.mtimeMs = 2
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', 'replaced prompt'])
})

test('a rewind appended to a large transcript drops the abandoned prompt', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  disk.transcript = bigFile(bigRows([{ type: 'user', uuid: 'p3', parentUuid: 'd1', message: { role: 'user', content: 'instead' } }]))
  disk.mtimeMs = 2
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['first', 'instead'])
})

test('where no process can run, a large transcript leaves the drawn list and says so once', async ($, on) => {
  const { disk, clock } = bigWorld(on)
  disk.spawnFails = true
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await clock.settle()
  await drawRow($, 'p2', '二番目のプロンプト')
  disk.mtimeMs = 2
  await stop($)
  disk.mtimeMs = 3
  await stop($)
  await clock.settle()
  expect(await railLabels($)).toEqual(['二番目のプロンプト'])
  expect(disk.toasts.filter(text => text.includes('too large'))).toHaveLength(1)
})

test('the session start remembers its transcript under its own key', async ($, on) => {
  const store = world(on, { 'transcript:s0': { path: '/t/s0.jsonl', at: 1 } })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect((store.get('transcript:s1') as any)?.path).toBe('/t/s1.jsonl')
  // Another session's entry is left alone: no shared map is rewritten.
  expect(store.get('transcript:s0')).toEqual({ path: '/t/s0.jsonl', at: 1 })
})

test('a reload lists the prompts again from the remembered transcript', async ($, on) => {
  // A reloaded module has no list; session.start fires again and rebuilds it.
  world(on, { 'transcript:s1': { path: '/t/s1.jsonl', at: 1 } })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(await railLabels($)).toEqual(['first stored prompt', '<div> why does this overflow?', 'continue', 'continue'])
})

test('prompts are listed in transcript order, wrappers left out, repeats kept', async ($, on) => {
  world(on)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first stored prompt', '<div> why does this overflow?', 'continue', 'continue'])
})

// A prompt sent while an artifact is open in the viewer: the engine stores the
// viewer's state ahead of the typed text.
const VIEWED = '<artifact-view-context artifact="bb04">\n{"context":{"mode":"edit","slideId":"s38"}}\n</artifact-view-context>\n\nswap the image'

test('the artifact view context ahead of a stored prompt is left out of its text', async ($, on) => {
  world(on, {}, jsonl([{ type: 'user', uuid: 'v1', message: { role: 'user', content: VIEWED } }]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['swap the image'])
})

test('the artifact view context ahead of a drawn prompt is left out of its text', async ($, on) => {
  world(on, {}, jsonl([]))
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'v1', props: prompt(VIEWED, null) })
  expect(await railLabels($)).toEqual(['swap the image'])
})

test('a typed artifact view context tag is kept, since it is not the viewer\'s state', async ($, on) => {
  world(on, {}, jsonl([]))
  const typed = '<artifact-view-context artifact="demo">example</artifact-view-context> explain this'
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'v1', props: prompt(typed, null) })
  const labels = await railLabels($)
  expect(labels.length).toBe(1)
  expect(labels[0]).toMatch(/^<artifact-view-context artifact="de/)
})

test('a repeated prompt gets its own entry; the provisional row is not listed', async ($, on) => {
  world(on)
  const draw = async (requestId: string, text: string) => {
    const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, null) })
    await row.unmount()
  }
  await draw('placeholder', 'continue')
  await draw('x1', 'continue')
  await draw('placeholder', 'continue')
  await draw('x2', 'continue')
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

// A message the engine splits into rows is drawn under ids derived from its
// stored uuid: the first four groups, then the row's index (seen in 2.1.283).
const SPLIT_IDS = {
  first: 'dae2bfb1-3f75-4882-a3e4-6f43dc45b51c',
  firstRow: 'dae2bfb1-3f75-4882-a3e4-000000000000',
  reply: 'e59aaf08-414b-4bb2-9945-895150ed76c7',
  replyRow: 'e59aaf08-414b-4bb2-9945-000000000001',
  second: '35939e29-64ae-48ff-bc1d-432a998b2414',
}
const SPLIT = jsonl([
  { type: 'user', uuid: SPLIT_IDS.first, message: { role: 'user', content: 'first' } },
  { type: 'assistant', uuid: SPLIT_IDS.reply, message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  { type: 'user', uuid: SPLIT_IDS.second, message: { role: 'user', content: 'second' } },
])
const drawSplit = ($: any, component: 'UserMessage' | 'AssistantMessage', requestId: string, onScreen: { first: number; last: number; of: number } | null) =>
  $.ui.mount({
    plugin: 'prompt-rail',
    surface: 'terminal',
    component,
    requestId,
    props: component === 'UserMessage' ? prompt('first', onScreen) : { text: 'reply', isFirstOfReply: true, onScreen },
  })

test('a prompt drawn under an id derived from its stored uuid is listed once, drawn first', async ($, on) => {
  world(on, {}, SPLIT)
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, null)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first', 'second'])
})

test('a prompt drawn under an id derived from its stored uuid is listed once, read first', async ($, on) => {
  world(on, {}, SPLIT)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await drawSplit($, 'UserMessage', SPLIT_IDS.firstRow, null)
  expect(await railLabels($)).toEqual(['first', 'second'])
})

test('a jump to a stored prompt scrolls to the id its row was drawn under', () => {
  const drawn = new Map([[rowKey(SPLIT_IDS.firstRow), SPLIT_IDS.firstRow]])
  expect(drawnRow(drawn, SPLIT_IDS.first)).toBe(SPLIT_IDS.firstRow)
  // A prompt not drawn yet is looked for under its own id.
  expect(drawnRow(drawn, SPLIT_IDS.second)).toBe(SPLIT_IDS.second)
  expect(drawnRow(drawn, 'u1')).toBe('u1')
})

// How the engine draws a prompt that does not go straight into a turn, as
// seen in 2.1.283 (tmux and Herdr alike):
// - queued while a turn runs and sent once it ends: two rows it never
//   stores, around prompt.submit, then the provisional row and the stored one;
// - delivered into the running turn: the same two rows, then the row of the
//   queued_command attachment the transcript stores, with no provisional row;
// - sent from Remote Control, even at rest: session.receive, one row it never
//   stores, the provisional row, prompt.submit, then the stored row.
const drawRow = async ($: any, requestId: string, text: string, onScreen: { first: number; last: number; of: number } | null = null) => {
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId, props: prompt(text, onScreen) })
  await row.unmount()
}
const submit = ($: any, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
const sendQueued = async ($: any, text: string, ids: [string, string, string]) => {
  await drawRow($, ids[0], text)
  await submit($, text)
  await drawRow($, ids[1], text)
  await drawRow($, 'placeholder', text)
  await drawRow($, ids[2], text)
}
// The world plus the engine's own answers to the events these tests raise.
const queueWorld = (on: any, transcript = jsonl([])) => {
  const disk = beneath(transcript)
  world(on, {}, transcript, disk)
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('turn.complete', ($: any, e: any) => ({ text: e.answer }))
  on('prompt.submit', ($: any, e: any) => ({ text: e.text }))
  on('session.receive', ($: any, e: any) => ({ text: e.text }))
  return disk
}
const sendFirst = async ($: any, text: string, id: string) => {
  await submit($, text)
  await drawRow($, 'placeholder', text)
  await $.turn.start({ text, turnId: `t-${id}` })
  await drawRow($, id, text)
}

test('a prompt queued while a turn runs is listed once', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await sendQueued($, 'queued', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('a queued prompt is listed once as soon as it is sent', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'queued')
  await submit($, 'queued')
  await drawRow($, 'q2', 'queued')
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('queue rows drawn just before the notification make one entry', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'queued')
  await drawRow($, 'q2', 'queued')
  await submit($, 'queued')
  expect(await railLabels($)).toEqual(['first', 'queued'])
})

test('a prompt queued behind the same text keeps both entries', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'continue', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a prompt drawn at rest is kept when a queued prompt has the same text', async ($, on) => {
  // As on a resume whose transcript cannot be read: the rows are drawn only.
  queueWorld(on)
  await drawRow($, 'old', 'continue')
  await sendFirst($, 'go on', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'go on', 'continue'])
})

test('a row drawn well before a prompt with its text is sent stays its own entry', async ($, on) => {
  queueWorld(on)
  await drawRow($, 'old', 'continue')
  await new Promise(resolve => setTimeout(resolve, 300))
  await sendFirst($, 'continue', 's1')
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a prompt whose turn starts with no provisional row is not taken for a queued one', async ($, on) => {
  // The session's first prompt: its turn starts, then its stored row is drawn.
  queueWorld(on)
  await $.turn.start({ text: 'first', turnId: 't1' })
  await drawRow($, 's1', 'first')
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't1', reason: 'answer' })
  await sendFirst($, 'first', 's2')
  expect(await railLabels($)).toEqual(['first', 'first'])
})

test('a sent prompt the transcript listed first still ends its provisional row', async ($, on) => {
  // The turn's start read the file before the stored row was drawn.
  queueWorld(on, jsonl([{ type: 'user', uuid: 's1', message: { role: 'user', content: 'continue' } }]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await sendFirst($, 'continue', 's1')
  await sendQueued($, 'continue', ['q1', 'q2', 's2'])
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

// As seen in 2.1.296: each queued prompt draws a row it never stores right
// after its notification, again whenever another is queued, and the queued
// prompts go together into one turn under `placeholder` and `placeholder-1`.
test('prompts queued together are listed once each once the transcript has them', async ($, on) => {
  const disk = queueWorld(on)
  await sendFirst($, 'first', 's1')
  await submit($, 'nine')
  await drawRow($, 'q9a', 'nine')
  await new Promise(resolve => setTimeout(resolve, 300))
  await drawRow($, 'q9b', 'nine')
  await submit($, 'ten')
  await drawRow($, 'q9c', 'nine')
  await drawRow($, 'q10a', 'ten')
  await drawRow($, 'q9d', 'nine')
  await drawRow($, 'q10b', 'ten')
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-s1', reason: 'answer' })
  await drawRow($, 'placeholder', 'nine')
  await drawRow($, 'placeholder-1', 'ten')
  await $.turn.start({ text: 'ten', turnId: 't2' })
  await drawRow($, 's9', 'nine')
  await drawRow($, 's10', 'ten')
  // Listed once each as their stored rows are drawn, before the transcript is read.
  expect(await railLabels($)).toEqual(['first', 'nine', 'ten'])
  disk.transcript = jsonl([
    { type: 'user', uuid: 's1', message: { role: 'user', content: 'first' } },
    { type: 'user', uuid: 's9', message: { role: 'user', content: 'nine' } },
    { type: 'user', uuid: 's10', message: { role: 'user', content: 'ten' } },
  ])
  disk.mtimeMs = 2
  await stop($)
  expect(await railLabels($)).toEqual(['first', 'nine', 'ten'])
})

test('a queued prompt with the text of one just stored stays listed while it waits', async ($, on) => {
  const disk = queueWorld(on)
  await sendFirst($, 'continue', 's1')
  await submit($, 'continue')
  await drawRow($, 'q2', 'continue')
  disk.transcript = jsonl([{ type: 'user', uuid: 's1', message: { role: 'user', content: 'continue' } }])
  disk.mtimeMs = 2
  await stop($)
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

// As seen in 2.1.296: a prompt queued alone starts its turn with no
// provisional row, straight after the turn before completes.
test('a queued prompt with the text of the one before is listed once after it is sent and stored', async ($, on) => {
  const disk = queueWorld(on)
  const stored = (ids: string[]) => jsonl(ids.map(uuid => ({ type: 'user', uuid, message: { role: 'user', content: 'same' } })))
  await sendFirst($, 'same', 's1')
  await submit($, 'same')
  await drawRow($, 'q2', 'same')
  disk.transcript = stored(['s1'])
  disk.mtimeMs = 2
  await stop($)
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-s1', reason: 'answer' })
  await $.turn.start({ text: 'same', turnId: 't2' })
  await drawRow($, 's2', 'same')
  expect(await railLabels($)).toEqual(['same', 'same'])
  disk.transcript = stored(['s1', 's2'])
  disk.mtimeMs = 3
  await stop($)
  expect(await railLabels($)).toEqual(['same', 'same'])
})

test('a prompt sent from Remote Control at rest is listed once', async ($, on) => {
  queueWorld(on)
  await $.session.receive({ text: 'remote one', origin: { kind: 'bridge' } })
  await drawRow($, 'r1', 'remote one')
  await drawRow($, 'placeholder', 'remote one')
  await $.prompt.submit({ text: 'remote one', wait: false, origin: { kind: 'bridge' } })
  await $.turn.start({ text: 'remote one', turnId: 't1' })
  await drawRow($, 's1', 'remote one')
  expect(await railLabels($)).toEqual(['remote one'])
})

test('a prompt delivered into the running turn is listed once', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await drawRow($, 'q1', 'mid')
  await submit($, 'mid')
  await drawRow($, 'q2', 'mid')
  // The row of the attachment the turn read.
  await drawRow($, 'a1', 'mid')
  expect(await railLabels($)).toEqual(['first', 'mid'])
})

// A prompt delivered into the running turn: its queue rows around the
// notification, then, once a tool call ends, the row of its attachment.
const deliver = async ($: any, text: string, ids: [string, string, string]) => {
  await drawRow($, ids[0], text)
  await submit($, text)
  await drawRow($, ids[1], text)
  await new Promise(resolve => setTimeout(resolve, 300))
  await drawRow($, ids[2], text)
}

test('a prompt delivered into a turn with the text that started it keeps both entries', async ($, on) => {
  queueWorld(on)
  await sendFirst($, 'continue', 's1')
  await deliver($, 'continue', ['q1', 'q2', 'a1'])
  await $.turn.complete({ answer: 'done', durationMs: 12500, isAborted: true, turnId: 't-s1', reason: 'aborted' })
  expect(await railLabels($)).toEqual(['continue', 'continue'])
})

test('a delivered prompt keeps its entry when the same text is sent after its turn', async ($, on) => {
  // As where the transcript cannot be read: the delivery is known from draws only.
  queueWorld(on)
  await sendFirst($, 'first', 's1')
  await deliver($, 'continue', ['q1', 'q2', 'a1'])
  await $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: 't-s1', reason: 'answer' })
  await sendFirst($, 'continue', 's2')
  expect(await railLabels($)).toEqual(['first', 'continue', 'continue'])
})

// A prompt delivered into the running turn, stored as a queued_command
// attachment inside the turn the first prompt started.
const DELIVERED = [
  { type: 'user', uuid: 's1', timestamp: '2026-09-24T00:00:00.000Z', message: { role: 'user', content: 'first' } },
  {
    type: 'assistant',
    uuid: 'b1',
    timestamp: '2026-09-24T00:00:05.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'sleep 8' } }] },
  },
  { type: 'user', uuid: 'r1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '' }] } },
  { type: 'attachment', uuid: 'a1', attachment: { type: 'queued_command', prompt: 'mid' } },
  { type: 'assistant', uuid: 'b2', timestamp: '2026-09-24T00:00:14.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
  { type: 'system', uuid: 'd1', subtype: 'turn_duration', durationMs: 14000 },
]

test('a prompt delivered into a turn is listed from the transcript', async ($, on) => {
  queueWorld(on, jsonl(DELIVERED))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first', 'mid'])
})

test('a delivered prompt drawn before the transcript is read is listed once after it', async ($, on) => {
  const disk = queueWorld(on, jsonl(DELIVERED.slice(0, 3)))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await drawRow($, 'q1', 'mid')
  await submit($, 'mid')
  await drawRow($, 'q2', 'mid')
  await drawRow($, 'a1', 'mid')
  disk.transcript = jsonl(DELIVERED)
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(await railLabels($)).toEqual(['first', 'mid'])
})

test('after /rewind only the live branch is listed', async ($, on) => {
  world(on, {}, FORKED)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['alpha', 'delta'])
})

test('a drawn row from an abandoned branch drops out once the transcript is read', async ($, on) => {
  world(on, {}, FORKED)
  const row = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'p2', props: prompt('beta', null) })
  await row.unmount()
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['alpha', 'delta'])
})

test('prompts before a compaction stay listed', async ($, on) => {
  world(on, {}, COMPACTED)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['before compact', 'after compact'])
})

test("while a subagent's transcript is in view the band stays empty", async ($, on) => {
  await drawPrompts($, on)
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'ag1' } } })
  expect(await band.findAll({ type: 'Button' })).toEqual([])
})

// The engine's answer for a row the transcript does not draw (a slash
// command's own row, for one).
const NOT_DRAWN = 'nothing drawn under that requestId'

test('an unchanged transcript is not read again when a turn ends', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(disk.reads).toBe(1)
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(1)
  // A turn that wrote to it is read.
  disk.transcript = `${TRANSCRIPT}\n${JSON.stringify({ type: 'user', uuid: 'u5', parentUuid: 'u4', message: { role: 'user', content: 'fifth' } })}`
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(2)
  // The newest four.
  expect(await railLabels($)).toEqual(['<div> why does this overflow?', 'continue', 'continue', 'fifth'])
})

// A session with no /config row for the plugin's fields (the desktop app's
// SDK sessions) makes $.config.set throw rather than deny.
// A module reloaded mid-session starts again from the setting; a mode the
// setting could not keep is kept for the session under its id instead.
// The kit loads the module with its default options, so the session starts
// again after the command, as a module reloaded with the setting off does.
test('a view that cannot scroll the transcript is said once, in plain words, and dots no prompt', () => {
  // The engine's refusal where no transcript viewport is bound, as in the desktop app.
  const UNSCROLLABLE = 'transcript not scrollable here'
  expect(jumpNotice(UNSCROLLABLE, false)).toMatch(/^jumps cannot land here/)
  expect(jumpNotice(UNSCROLLABLE, true)).toBeUndefined()
  // Any other refusal is passed on as the engine words it, every time.
  expect(jumpNotice(NOT_DRAWN, true)).toBe(NOT_DRAWN)
})

test('slash-command rows and interruption notices are not listed as prompts', async ($, on) => {
  world(on, {}, jsonl([
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'first' } },
    { type: 'user', uuid: 'i1', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
    { type: 'user', uuid: 'c1', message: { role: 'user', content: '/compact' } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: 'second' } },
    { type: 'user', uuid: 'i2', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
  ]))
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  expect(await railLabels($)).toEqual(['first', 'second'])
})

// The status line belongs to the person: the rail pins nothing there, even
// where neither the pane nor the band shows it.

test('a turn that leaves the list as it was redraws nothing', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await railLabels($)
  const before = { invalidations: disk.invalidations, railRedraws: disk.railRedraws }
  // Same list, rewritten on disk (a row the index skips was appended).
  disk.transcript = `${TRANSCRIPT}\n${JSON.stringify({ type: 'system', uuid: 's9', parentUuid: 'u4', subtype: 'turn_duration' })}`
  disk.mtimeMs = 2
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.reads).toBe(2)
  expect(disk.invalidations).toBe(before.invalidations)
  expect(disk.railRedraws).toBe(before.railRedraws)
})

// The kit does not scroll to a transcript row, so where a jump lands is
// checked in a live session; these pin how presses and commands route.
test('browsing draws the rail alone again, never the transcript rows', async ($, on) => {
  // Rows drawn again while the person scrolls just after a jump move the viewport a turn away.
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  const band = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  const before = disk.railRedraws
  await focusBand($)
  await band.press({ key: 'prev' })
  await band.press({ key: 'back' })
  expect(disk.railRedraws).toBe(before + 3)
  expect(disk.invalidations).toBe(0)
})

test('/prompt-rail N names a prompt to jump to, and waits while a subagent transcript is in view', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  const sub = await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: { ...BAND, view: { agentId: 'ag1' } } })
  await $.command.run({ command: 'prompt-rail', args: '1' })
  // No jump is tried there, so no refusal can dot a main-conversation prompt.
  expect(disk.toasts).toEqual(['jumps move through the main conversation; switch back to it first'])
  await sub.unmount()
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  await $.command.run({ command: 'prompt-rail', args: '#3' })
  expect(disk.toasts.filter(text => text.includes('switch back') || text.startsWith('no prompt'))).toHaveLength(1)
  await $.command.run({ command: 'prompt-rail', args: '9' })
  expect(disk.toasts.at(-1)).toBe('no prompt 9')
})

test('/prompt-rail and /prompt-rail-back run mid-turn', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.commands).toEqual([
    expect.objectContaining({ name: 'prompt-rail', immediate: true, argumentHint: '[on|off|<n>|first|last|find <words>]' }),
    // Argument-free, for a keybinding to name.
    expect.objectContaining({ name: 'prompt-rail-back', immediate: true }),
  ])
})

test('/prompt-rail off hides the rail; on, or bare /prompt-rail, shows it again; each writes the setting', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  // On by default, with nothing written.
  expect(disk.settings.size).toBe(0)
  expect(await railLabels($)).toHaveLength(4)
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('off')
  expect(await railLabels($)).toEqual([])
  await $.command.run({ command: 'prompt-rail', args: '' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('on')
  expect(await railLabels($)).toHaveLength(4)
  await $.command.run({ command: 'prompt-rail', args: '' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('off')
  await $.command.run({ command: 'prompt-rail', args: 'on' })
  expect(disk.settings.get('prompt-rail.mode')).toBe('on')
  await $.command.run({ command: 'prompt-rail', args: 'sideways' })
  expect(disk.toasts.at(-1)).toBe('/prompt-rail [on|off|<n>|first|last|find <words>]')
})

// A session with no /config row for the plugin's fields (the desktop app's
// SDK sessions) makes $.config.set throw rather than deny.
test('/prompt-rail off still hides the rail when the setting has no /config row, and keeps it for the session', async ($, on) => {
  const disk = { ...beneath(), hasConfigRow: false }
  const store = world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  expect(await railLabels($)).toEqual([])
  expect(disk.toasts.at(-1)).toMatch(/not saved/)
  expect(store.get('session-mode:s1')).toBe('off')
})

// A module reloaded mid-session starts again from the setting; a mode the
// setting could not keep is kept for the session under its id instead.
test('a mode kept for the session only survives a reload of the module', async ($, on) => {
  world(on, { 'session-mode:s1': 'off' })
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(await railLabels($)).toEqual([])
})

test('the mode no longer lives in the store: an earlier version\'s moves to the setting', async ($, on) => {
  const disk = beneath()
  const store = world(on, { mode: 'off' }, TRANSCRIPT, disk)
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  expect(disk.settings.get('prompt-rail.mode')).toBe('off')
  expect(store.has('mode')).toBe(false)
})

// The status line belongs to the person: the rail pins nothing there.
test('the rail never pins a status line', async ($, on) => {
  const disk = beneath()
  world(on, {}, TRANSCRIPT, disk)
  await $.classic.SessionStart({ source: 'resume', session_id: 's1', transcript_path: '/t/s1.jsonl' })
  await $.session.start({ cwd: '/t', surface: 'terminal', isInteractive: true })
  await $.ui.mount({ plugin: 'prompt-rail', surface: 'terminal', component: 'UserMessage', requestId: 'u3', props: prompt('continue', null) })
  await $.command.run({ command: 'prompt-rail', args: 'off' })
  await $.command.run({ command: 'prompt-rail', args: 'on' })
  await $.classic.Stop({ session_id: 's1', transcript_path: '/t/s1.jsonl', stop_hook_active: false })
  expect(disk.status).toEqual([])
})
