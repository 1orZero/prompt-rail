import type { EngineInterface, Register } from 'claude-code'

// Rows the person typed (terminal composer, desktop/remote bridge, SDK host).
const PROMPT_KINDS = new Set(['composer', 'bridge', 'sdk'])
// The mode is the plugin's `mode` setting (userConfig), a row in /config. An
// earlier version kept it in the store under this key, shared by every session.
const LEGACY_MODE_KEY = 'mode'
// `session-mode:<session id>` -> a mode the setting could not keep (a session
// with no /config row for plugin fields), so a module reloaded mid-session
// starts in it again. Keyed by session, so a later session starts clean.
const SESSION_MODE_KEY_PREFIX = 'session-mode:'
const MODE_SETTING = 'prompt-rail.mode'
// `transcript:<session id>` -> { path, at }, so a hot-reloaded module (whose
// session.start carries no path) can rebuild its list. One key per session, so
// sessions starting together never rewrite each other's; the newest few stay.
const TRANSCRIPT_KEY_PREFIX = 'transcript:'
const KEPT_TRANSCRIPTS = 20
// The ids a prompt row is drawn under before its message is stored, one per
// prompt sent together (`placeholder`, `placeholder-1`); the stored row follows
// under its uuid.
const PROVISIONAL_ID = /^placeholder(-\d+)?$/
// User rows the engine writes around its own output (slash commands, bash
// mode, reminders), which are not prompts.
const WRAPPER = /^<(command-|local-command-|bash-|system-reminder|task-notification|user-prompt-submit-hook)/
// The viewer's state the engine puts ahead of a prompt sent while an artifact
// is open; the typed text follows it. No row field tells it from typed text,
// so only the engine's layout matches: the artifact id, a JSON line starting
// with "context", and the closing tag on a line of its own.
const VIEW_CONTEXT = /^\s*<artifact-view-context artifact="[^"]*">\n\{"context":[\s\S]*?\n<\/artifact-view-context>/
// The notice the engine stores as a user row when the person interrupts a turn.
const INTERRUPTED = /^\[Request interrupted by user/
// A message uuid, as the transcript stores it (see rowKey).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// A row added at most this many ms before a prompt's notification may be that
// prompt's own: the engine draws a queued prompt's first row as it notifies.
const LATELY_MS = 250
// The engine's refusal where no transcript viewport takes a plugin's scroll,
// as in the desktop app; said once, in words of the rail's own.
const UNSCROLLABLE = /not scrollable/
const UNSCROLLABLE_TOAST = 'jumps cannot land here: this view does not let a plugin scroll the transcript'
// A count the rail reads while drawing, so bumping it draws the rail again,
// and it alone. `$.ui.invalidate('ui.render')` also draws every transcript row
// this module hooks.
const MOVED = { plugin: 'prompt-rail', key: 'moved' } as const
// While browsing, the frame lists this many prompts at a time.
const FRAME_ROWS = 4
// The theme key of the transcript's user-message background, which the rail's
// marked row is tinted with.
const MARKED_BG = 'userMessageBackground'
// Ends browsing; the keybinding of Escape where the band holds the keys.
const BACK_COMMAND = 'prompt-rail-back'
// How long the band draws nothing focusable as browsing ends (see isReleasing).
const RELEASE_MS = 500
const USAGE = '[on|off|<n>|first|last|find <words>]'

// on: the latest prompt on a tinted row above the prompt; off: no rail.
type Mode = 'on' | 'off'
const isMode = (value: unknown): value is Mode => value === 'on' || value === 'off'

type Entry = { id: string; text: string }
// The elements a terminal band draws with.
type Elements = Pick<ReturnType<EngineInterface['ui']['resolve']>, 'Box' | 'Button' | 'Text'>

// The key rows are matched by. A message the engine splits into several rows
// is drawn under ids derived from its stored uuid, the first four groups kept
// and the last replaced by the row's index, so a uuid is matched by those
// groups; any other id (the provisional one) as it is.
export const rowKey = (id: string) => (UUID.test(id) ? id.slice(0, 24) : id)

// The id a prompt's row was last drawn under, which a jump scrolls to, from a
// map of row key -> drawn id; its own id while it has not been drawn.
export const drawnRow = (drawn: Map<string, string>, id: string) => drawn.get(rowKey(id)) ?? id

// Terminal cells a character takes: two for East Asian wide and emoji ranges.
const cells = (char: string) => {
  const code = char.codePointAt(0) ?? 0
  const isWide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  return isWide ? 2 : 1
}

// The prompt on one line, cut to `width` terminal cells with an ellipsis.
const oneLine = (text: string, width: number) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  const chars = [...flat]
  if (chars.reduce((sum, char) => sum + cells(char), 0) <= width) return flat
  let out = ''
  let used = 0
  for (const char of chars) {
    if (used + cells(char) > width - 1) break
    out += char
    used += cells(char)
  }
  return `${out}…`
}

// The first prompt of a FRAME_ROWS window over `count` prompts that holds
// `selected`, moving `start` only as far as it takes.
export const windowStart = (start: number, selected: number, count: number) =>
  Math.max(0, Math.min(selected, Math.max(start, selected - FRAME_ROWS + 1), count - FRAME_ROWS))

// What a refused jump says: the engine's refusal as it words it, or, where
// the view cannot scroll the transcript at all, words of the rail's own the
// first time; undefined once those were said.
export const jumpNotice = (deny: string, isUnscrollableSaid: boolean) =>
  UNSCROLLABLE.test(deny) ? (isUnscrollableSaid ? undefined : UNSCROLLABLE_TOAST) : deny

// The prompt `/prompt-rail <asked>` names among `texts`: `n` or `#n` by its
// number, `first`, `last`, or with `find <words>` the newest whose text holds
// them (case aside). -1 when none does; undefined when `asked` names none.
export const pickPrompt = (asked: string, texts: string[]) => {
  const number = /^#?(\d+)$/.exec(asked)
  if (number) {
    const i = Number(number[1]) - 1
    return i < texts.length ? i : -1
  }
  if (asked === 'first') return texts.length > 0 ? 0 : -1
  if (asked === 'last') return texts.length - 1
  const words = /^find\s+(.+)$/.exec(asked)?.[1]?.toLowerCase()
  if (words === undefined) return undefined
  for (let i = texts.length - 1; i >= 0; i--) if (texts[i]?.toLowerCase().includes(words)) return i
  return -1
}

type TranscriptIndex = {
  prompts: Entry[]
  // Every row uuid the file holds, live branch or not.
  known: Set<string>
}

// The uuids on the live branch: the chain of parents from the last row. A
// /rewind leaves the abandoned branch in the file; a /compact boundary starts
// a new chain whose logicalParentUuid links back to the rows before it.
const liveBranch = (rows: any[]) => {
  const byId = new Map<string, any>()
  for (const row of rows) byId.set(row.uuid, row)
  const live = new Set<string>()
  let row = [...rows].reverse().find(candidate => !candidate.isSidechain)
  while (row && !live.has(row.uuid)) {
    live.add(row.uuid)
    const parent = row.parentUuid ?? row.logicalParentUuid
    row = typeof parent === 'string' ? byId.get(parent) : undefined
  }
  return live
}

// What the index reads of a transcript row, and nothing else: a long
// session's rows are kept between reads, and most of their bytes are tool
// results and replies the rail never shows. Undefined for a line that is not
// a row (a torn last line while the engine appends, or no uuid).
const parseRow = (line: string): any => {
  let row: any
  try {
    row = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof row?.uuid !== 'string') return undefined
  const content = row.message?.content
  const blocks = Array.isArray(content)
    ? content.flatMap((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'text', text: block.text }]
        if (block?.type === 'tool_result') return [{ type: 'tool_result' }]
        return []
      })
    : content
  return {
    uuid: row.uuid,
    parentUuid: row.parentUuid,
    logicalParentUuid: row.logicalParentUuid,
    isSidechain: row.isSidechain,
    type: row.type,
    isMeta: row.isMeta,
    isCompactSummary: row.isCompactSummary,
    message: row.message && { role: row.message.role, content: typeof content === 'string' ? content : blocks },
    attachment: row.attachment?.type === 'queued_command' ? { type: row.attachment.type, prompt: row.attachment.prompt } : undefined,
  }
}

// The person's prompts on the live branch of a transcript's rows, in order,
// keyed by message uuid. Tool results, meta rows, sidechains, interruption
// notices and the engine's wrapper rows are not prompts.
const indexRows = (rows: any[]): TranscriptIndex => {
  const live = liveBranch(rows)
  const prompts: Entry[] = []
  for (const row of rows) {
    if (row.isSidechain || !live.has(row.uuid)) continue
    // A prompt typed while a turn ran and delivered into it is stored as a
    // queued_command attachment, never as a user row of its own.
    if (row.type === 'attachment' && row.attachment?.type === 'queued_command') {
      const prompt = row.attachment.prompt
      const text = typeof prompt === 'string' ? prompt.replace(VIEW_CONTEXT, '').trim() : ''
      if (text && !WRAPPER.test(text) && !text.startsWith('/')) prompts.push({ id: row.uuid, text })
      continue
    }
    if (row.type !== 'user' || row.isMeta || row.isCompactSummary || row.message?.role !== 'user') continue
    const content = row.message.content
    if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) continue
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
        .map((block: any) => block.text)
        .join('\n')
    }
    text = text.replace(VIEW_CONTEXT, '').trim()
    // A slash command's own row is not a prompt: the render hook skips it too,
    // so it is never drawn and could not be scrolled to.
    if (!text || INTERRUPTED.test(text) || WRAPPER.test(text) || text.startsWith('/')) continue
    prompts.push({ id: row.uuid, text })
  }
  return { prompts, known: new Set(rows.map(row => row.uuid)) }
}

// The engine's cap on one $.fs.read; a larger transcript is streamed.
const READ_CAP = 4 * 1024 * 1024
const encoder = new TextEncoder()

// The transcript as last read: its size and modification time, the rows of
// its complete lines and the byte where they end, and where the last row
// starts, which a later read of a long session's file checks is still there.
// Whether a read is under way, and the path whose file could not be read,
// said once.
type Seen = {
  path: string
  size: number
  mtimeMs: number
  rows: any[]
  offset: number
  lastStart: number
  lastUuid: string | undefined
  isReading: boolean
  warned: string
}
const unseen = (): Seen => ({
  path: '',
  size: -1,
  mtimeMs: -1,
  rows: [],
  offset: 0,
  lastStart: 0,
  lastUuid: undefined,
  isReading: false,
  warned: '',
})

// Take the complete lines of `text`, which starts at byte `at` of the file,
// into `seen`, and return the rest: a line the engine is still writing, or
// the last of a file with no newline at its end.
const takeLines = (seen: Seen, text: string, at: number) => {
  const lines = text.split('\n')
  const rest = lines.pop() ?? ''
  for (const line of lines) {
    const row = line.trim() ? parseRow(line) : undefined
    if (row) {
      seen.rows.push(row)
      seen.lastStart = at
      seen.lastUuid = row.uuid
    }
    at += encoder.encode(line).length + 1
  }
  seen.offset = at
  return rest
}

// The index of the rows read, and of a last line with no newline yet when it
// parses whole (it is read again once it has one).
const indexSeen = (seen: Seen, rest: string) => {
  const last = rest.trim() ? parseRow(rest) : undefined
  return indexRows(last ? [...seen.rows, last] : seen.rows)
}

// Read the file on from the last row read, with tail, since $.fs.read takes
// no more than READ_CAP. That row comes first and must still be there, else
// the file was replaced: false then, and nothing is taken. Otherwise the rest
// after the last complete line.
async function streamRows($: EngineInterface, path: string, seen: Seen) {
  let expected = seen.lastUuid
  let at = expected === undefined ? seen.offset : seen.lastStart
  let carry = ''
  const child = $.process.spawn({ argv: ['tail', '-c', `+${at + 1}`, path] })
  for await (const piece of child) {
    if (piece.stream !== 'stdout') continue
    let text = carry + piece.text
    if (expected !== undefined) {
      const end = text.indexOf('\n')
      if (end < 0) {
        carry = text
        continue
      }
      const line = text.slice(0, end)
      if (parseRow(line)?.uuid !== expected) return false
      expected = undefined
      at += encoder.encode(line).length + 1
      text = text.slice(end + 1)
    }
    carry = takeLines(seen, text, at)
    at = seen.offset
  }
  const { code } = await child.result
  if (code !== 0) throw new Error(`tail exited with ${code}`)
  return carry
}

// Stream a transcript too large for $.fs.read, from its start when it was
// replaced; its index, or undefined when it could not be read, which is said
// once for the file.
async function readLarge($: EngineInterface, path: string, seen: Seen, size: number, mtimeMs: number) {
  try {
    let rest = await streamRows($, path, seen)
    if (rest === false) {
      Object.assign(seen, { rows: [], offset: 0, lastStart: 0, lastUuid: undefined })
      rest = await streamRows($, path, seen)
      if (rest === false) return undefined
    }
    Object.assign(seen, { path, size, mtimeMs })
    return indexSeen(seen, rest)
  } catch (err) {
    if (seen.warned !== path) {
      seen.warned = path
      const megabytes = Math.round(size / 1024 / 1024)
      $.ui.toast(`the transcript is ${megabytes} MB, too large to read here (${(err as Error).message}); prompts are listed as they are drawn`)
    }
    return undefined
  }
}

// The transcript's index, or undefined when it is as `seen` last read it (a
// long session's file is not parsed again for a turn that wrote nothing),
// before the file exists (a fresh session), or while another read is under
// way. Records what it read in `seen`. A file over READ_CAP is read on from
// where the last read ended; when that is more than READ_CAP, as on resuming a
// long session, it is read without holding the hook, and `whenLate` gets the
// index once it is done.
async function readTranscript($: EngineInterface, path: string, seen: Seen, whenLate: (index: TranscriptIndex) => void) {
  if (seen.isReading) return undefined
  try {
    const { size, mtimeMs } = await $.fs.stat(path)
    if (seen.path === path && seen.size === size && seen.mtimeMs === mtimeMs) return undefined
    if (seen.path !== path || size < seen.offset) Object.assign(seen, { ...unseen(), warned: seen.warned })
    if (size <= READ_CAP) {
      const text = await $.fs.read(path)
      Object.assign(seen, { rows: [], lastStart: 0, lastUuid: undefined })
      const rest = takeLines(seen, text, 0)
      Object.assign(seen, { path, size, mtimeMs })
      return indexSeen(seen, rest)
    }
    seen.isReading = true
    const reading = readLarge($, path, seen, size, mtimeMs).finally(() => {
      seen.isReading = false
    })
    if (size - seen.offset <= READ_CAP) return await reading
    void reading.then(index => index && whenLate(index))
    return undefined
  } catch {
    seen.isReading = false
    return undefined
  }
}

// Remember this session's transcript path under its own key, then drop all
// but the newest few sessions' keys.
async function rememberTranscript($: EngineInterface, sessionId: string, transcriptPath: string) {
  await $.store.set(`${TRANSCRIPT_KEY_PREFIX}${sessionId}`, { path: transcriptPath, at: Date.now() })
  const keys = (await $.store.keys()).filter(key => key.startsWith(TRANSCRIPT_KEY_PREFIX))
  if (keys.length <= KEPT_TRANSCRIPTS) return
  const dated = await Promise.all(
    keys.map(async key => {
      const value = (await $.store.get(key)) as { at?: unknown } | undefined
      return { key, at: typeof value?.at === 'number' ? value.at : 0 }
    }),
  )
  dated.sort((x, y) => y.at - x.at)
  await Promise.all(dated.slice(KEPT_TRANSCRIPTS).map(({ key }) => $.store.delete(key)))
}

// Write the mode setting, as a change in /config would; say so if refused.
// A session with no /config row for plugin fields (the desktop app's SDK
// sessions) throws instead of denying, and the mode then holds for this
// session only.
async function writeMode($: EngineInterface, mode: Mode) {
  try {
    const result = await $.config.set({ key: MODE_SETTING, value: mode })
    if (result.deny) $.ui.toast(`the mode was not saved: ${result.deny}`)
  } catch (err) {
    await $.store.set(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`, mode)
    $.ui.toast(`${mode} for this session; the mode was not saved: ${(err as Error).message}`)
  }
}

// Scroll the transcript to a prompt's row, drawn under `target`, from a
// dispatch that answers the person's own input (a press, a typed command): a
// transcript row moves only then. Where the view cannot scroll at all, says so
// once a session (`notices.isUnscrollableSaid`).
async function jumpTo($: EngineInterface, target: string, notices: { isUnscrollableSaid: boolean }) {
  try {
    const result = await $.ui.scroll({ to: { requestId: target }, block: 'start' })
    if (result.deny) {
      const notice = jumpNotice(result.deny, notices.isUnscrollableSaid)
      if (notice !== undefined) $.ui.toast(notice)
      if (UNSCROLLABLE.test(result.deny)) notices.isUnscrollableSaid = true
    }
  } catch (err) {
    $.ui.toast((err as Error).message)
  }
}

// Draw the rail again, and it alone (see MOVED).
async function redrawRail($: EngineInterface) {
  const { value = 0 } = await $.state.get(MOVED)
  await $.state.set(MOVED, value + 1)
}

// The same from a render hook, which may not write state: once its dispatch
// ends, or `ms` later.
function redrawRailAfter($: EngineInterface, ms: number) {
  $.clock.after(ms, () => void redrawRail($))
}

// The transcript path remembered for this session, if any.
async function rememberedTranscript($: EngineInterface) {
  const value = (await $.store.get(`${TRANSCRIPT_KEY_PREFIX}${await $.session.id()}`)) as { path?: unknown } | undefined
  return typeof value?.path === 'string' ? value.path : undefined
}

export const register: Register = (on, options) => {
  let entries: Entry[] = []
  // Whether a main-loop turn is running.
  let isRunning = false
  // Notices a session gives once (see jumpTo).
  const notices = { isUnscrollableSaid: false }
  const seen: Seen = unseen()
  // Row key -> the id a prompt's row was last drawn under (see drawnRow).
  const drawn = new Map<string, string>()
  // The ids of the prompts the last transcript read listed.
  let filed = new Set<string>()

  const addPrompt = (id: string, text: string) => {
    // A new prompt is drawn under a provisional id before it is stored, then
    // again under its uuid: list the stored row only, so a repeated prompt
    // ("continue" twice) still gets an entry of its own.
    if (PROVISIONAL_ID.test(id) || entries.some(entry => rowKey(entry.id) === rowKey(id))) return false
    entries = [...entries, { id, text }]
    return true
  }

  // A prompt that does not go straight into a turn (queued behind the running
  // one, delivered into it, or sent from Remote Control) is drawn under ids the
  // engine never stores before its stored row comes. Its entry is pending
  // meanwhile: rows drawn with its text are other names of it (row key ->
  // entry id), and its stored row takes its place in the list.
  const pending = new Set<string>()
  const aliases = new Map<string, string>()
  // Texts of prompts sent and not stored yet: from prompt.submit or
  // session.receive until the stored row is drawn or the main loop rests.
  const waiting = new Set<string>()
  // The text of the prompt last drawn under the provisional id, until its
  // stored row is drawn.
  let provisional: string | undefined
  // Entries added since the last notification, placeholder or turn edge, and
  // when: the engine may draw a queued prompt's first row before its
  // notification, which then takes it for that prompt's.
  let lately: { id: string; at: number }[] = []
  // When each waiting text's notification came, and the pending entries
  // delivered into the running turn: a row of theirs drawn well after the
  // notification is the attachment the turn read, and no provisional row
  // follows, so the turn's end leaves them pending no more.
  const notifiedAt = new Map<string, number>()
  const delivered = new Set<string>()
  // Entries a queued prompt's row was listed under (drawn after it was sent,
  // under an id the engine never stores), and those of them a main-loop turn
  // has started since. A turn starts with every queued prompt sent and
  // stored, so the stored row stands for a sent entry: as it is drawn, or as
  // the next transcript read lists it.
  const queued = new Set<string>()
  const sent = new Set<string>()

  const pendingWith = (text: string) => entries.find(entry => pending.has(entry.id) && entry.text === text)

  // A prompt with `text` was sent: its rows are pending until the stored one
  // is drawn. True when the list changed.
  const noteSent = (text: string) => {
    waiting.add(text)
    const now = Date.now()
    notifiedAt.set(text, now)
    const fresh = new Set(lately.filter(item => now - item.at <= LATELY_MS).map(item => item.id))
    lately = []
    const own = entries.filter(entry => fresh.has(entry.id) && entry.text === text && !pending.has(entry.id))
    const held = pendingWith(text) ?? own[0]
    if (!held || own.length === 0) return false
    pending.add(held.id)
    const others = new Set(own.filter(entry => entry !== held).map(entry => entry.id))
    for (const id of others) aliases.set(rowKey(id), held.id)
    entries = entries.filter(entry => !others.has(entry.id))
    return others.size > 0
  }

  // A stored row drawn as its turn runs takes the place of a sent entry with
  // its text, so the list neither grows nor reorders until the transcript is
  // read; true when it did.
  const takeSent = (id: string, text: string) => {
    const standIn = entries.find(entry => sent.has(entry.id) && entry.text === text)
    if (!standIn) return false
    entries = entries.map(entry => (entry === standIn ? { id, text } : entry))
    sent.delete(standIn.id)
    return true
  }

  // List a prompt row as it is drawn; true when the list changed.
  const listDrawn = (id: string, text: string) => {
    if (PROVISIONAL_ID.test(id)) {
      provisional = text
      lately = []
      return false
    }
    const key = rowKey(id)
    if (entries.some(entry => rowKey(entry.id) === key)) {
      // A stored row a transcript read listed first still ends its prompt.
      if (provisional === text) {
        provisional = undefined
        waiting.delete(text)
      }
      return false
    }
    const alias = aliases.get(key)
    if (alias !== undefined) {
      drawn.set(rowKey(alias), id)
      return false
    }
    if (provisional === text) {
      provisional = undefined
      waiting.delete(text)
      const held = pendingWith(text)
      if (!held) return takeSent(id, text) || addPrompt(id, text)
      // The stored row takes the place of the entry that waited for it.
      entries = entries.map(entry => (entry === held ? { id, text } : entry))
      pending.delete(held.id)
      for (const [name, target] of aliases) if (target === held.id) aliases.set(name, id)
      aliases.set(rowKey(held.id), id)
      return true
    }
    if (waiting.has(text)) {
      const held = pendingWith(text)
      if (held) {
        // Another row of the waiting prompt; a jump goes to the one drawn last.
        aliases.set(key, held.id)
        drawn.set(rowKey(held.id), id)
        if (isRunning && Date.now() - (notifiedAt.get(text) ?? Date.now()) > LATELY_MS) delivered.add(held.id)
        return false
      }
      pending.add(id)
      queued.add(id)
      return addPrompt(id, text)
    }
    if (takeSent(id, text)) return true
    const isAdded = addPrompt(id, text)
    if (isAdded) lately = [...lately, { id, at: Date.now() }]
    return isAdded
  }

  // A change of the setting reloads this module with the new value.
  let mode: Mode = options.mode === 'off' ? 'off' : 'on'
  // The prompt being browsed, while the band holds the keyboard; undefined at
  // rest. The frame's window starts at `shownFrom`.
  let browsed: number | undefined
  let shownFrom = 0
  // Set as browsing ends: the band's next drawing has nothing focusable, so
  // its ring has nowhere to stay and the keys go back to the prompt; the one
  // after, RELEASE_MS later, brings the marked row's Button back.
  let isReleasing = false
  const browse = (index: number) => {
    browsed = index
    shownFrom = windowStart(shownFrom, index, entries.length)
  }
  // The subagent whose transcript is in view, as the rail last drew; undefined
  // for the main conversation, whose prompts alone the rail lists.
  let viewAgent: string | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      // Named after the plugin: a plugin's commands share one namespace with
      // every other plugin's and the built-ins, so a generic name would collide.
      name: 'prompt-rail',
      description: 'Show or hide the prompt rail above the prompt; a number, first, last or find <words> jumps to a prompt.',
      argumentHint: USAGE,
      // Runs while a turn streams, so a jump works then too.
      immediate: true,
    })
    // Argument-free, so a keybinding can name it (`command:prompt-rail-back`).
    await $.command.register({ name: BACK_COMMAND, description: 'Stop browsing the prompt rail.', immediate: true })
    // Move a mode an earlier version stored into the setting, once. Writing
    // the setting reloads this module, so everything after it is best effort.
    const stored = await $.store.get(LEGACY_MODE_KEY)
    if (stored !== undefined) await $.store.delete(LEGACY_MODE_KEY)
    if (isMode(stored) && stored !== mode) {
      mode = stored
      await writeMode($, mode)
    }
    // A mode kept for this session only outlives a reload of this module.
    const kept = await $.store.get(`${SESSION_MODE_KEY_PREFIX}${await $.session.id()}`)
    if (isMode(kept)) mode = kept
    // Also fired after a hot reload, when the list starts empty: rebuild it from
    // the transcript this session's classic SessionStart remembered.
    const transcriptPath = await rememberedTranscript($)
    const index = transcriptPath === undefined ? undefined : await readTranscript($, transcriptPath, seen, index => {
      if (merge(index)) void redrawRail($)
    })
    if (index && merge(index)) await redrawRail($)
    return next(e)
  })

  on('command.run', async ($, e, next) => {
    if (e.command === BACK_COMMAND) {
      browsed = undefined
      isReleasing = true
      await redrawRail($)
      return {}
    }
    if (e.command !== 'prompt-rail') return next(e)
    const asked = e.args.trim()
    const index = pickPrompt(asked, entries.map(entry => entry.text))
    if (index !== undefined) {
      // The main conversation's rows are not drawn beside a subagent's, so a
      // jump would be refused and wrongly dot a prompt that can be reached.
      if (viewAgent !== undefined) {
        $.ui.toast('jumps move through the main conversation; switch back to it first')
        return {}
      }
      const entry = entries[index]
      if (entry) await jumpTo($, drawnRow(drawn, entry.id), notices)
      else $.ui.toast(`no prompt ${asked}`)
      return {}
    }
    if (asked && !isMode(asked)) {
      $.ui.toast(`/prompt-rail ${USAGE}`)
      return {}
    }
    mode = isMode(asked) ? asked : mode === 'on' ? 'off' : 'on'
    await redrawRail($)
    // Last: a changed setting reloads this module, which then starts in it.
    await writeMode($, mode)
    return {}
  })

  // Rebuild the list from the transcript file, whose uuids are the ids the
  // transcript rows are drawn under. A resumed session so lists prompts the
  // surface has not drawn yet; a row drawn but not stored yet stays after them,
  // and one the file holds off the live branch (rewound away) drops out. True
  // when the list changed, so the rail needs a redraw.
  const merge = (index: TranscriptIndex) => {
    const listed = (list: Entry[]) => list.map(entry => `${entry.id}\u0000${entry.text}`).join('\u0001')
    const before = listed(entries)
    // An entry whose row, or another name of it, the file holds is listed
    // from the file.
    const known = new Set([...index.known].map(rowKey))
    for (const [name, id] of aliases) if (known.has(name)) known.add(rowKey(id))
    // An entry the last read listed and this one does not is gone from the
    // file (replaced under the rail), not a row drawn before it was stored;
    // neither is one sent before a turn started (see sent).
    entries = [
      ...index.prompts,
      ...entries.filter(entry => !known.has(rowKey(entry.id)) && !filed.has(entry.id) && !sent.has(entry.id)),
    ]
    for (const id of sent) if (!entries.some(entry => entry.id === id)) sent.delete(id)
    filed = new Set(index.prompts.map(entry => entry.id))
    const ids = new Set(entries.map(entry => entry.id))
    for (const id of pending) if (!ids.has(id) || known.has(rowKey(id))) pending.delete(id)
    for (const [name, id] of aliases) if (!ids.has(id)) aliases.delete(name)
    return listed(entries) !== before
  }

  on('classic.SessionStart', async ($, e, next) => {
    if (e.source === 'clear') {
      entries = []
      isRunning = false
      browsed = undefined
      notices.isUnscrollableSaid = false
      drawn.clear()
      filed = new Set()
      pending.clear()
      aliases.clear()
      waiting.clear()
      provisional = undefined
      lately = []
      notifiedAt.clear()
      delivered.clear()
      queued.clear()
      sent.clear()
      Object.assign(seen, unseen())
      await redrawRail($)
    } else {
      const index = await readTranscript($, e.transcript_path, seen, index => {
        if (merge(index)) void redrawRail($)
      })
      if (index && merge(index)) await redrawRail($)
    }
    await rememberTranscript($, e.session_id, e.transcript_path)
    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    const index = await readTranscript($, e.transcript_path, seen, index => {
      if (merge(index)) void redrawRail($)
    })
    if (index && merge(index)) await redrawRail($)
    return next(e)
  })

  // A main-loop turn starts (a subagent's run raises none).
  on('turn.start', async ($, e, next) => {
    isRunning = true
    lately = []
    for (const id of queued) if (!filed.has(id)) sent.add(id)
    queued.clear()
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      isRunning = false
      // A prompt still waiting now is queued behind this turn; its rows to
      // come follow its provisional row.
      waiting.clear()
      notifiedAt.clear()
      for (const id of delivered) pending.delete(id)
      delivered.clear()
      lately = []
    }
    return result
  })

  // A prompt was sent: typed, or delivered from Remote Control. Its rows drawn
  // before the stored one are pending (see listDrawn).
  on('prompt.submit', async ($, e, next) => {
    browsed = undefined
    if (PROMPT_KINDS.has(e.origin.kind) && noteSent(e.text.replace(VIEW_CONTEXT, '').trim())) await redrawRail($)
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    if (PROMPT_KINDS.has(e.origin.kind) && noteSent(e.text.replace(VIEW_CONTEXT, '').trim())) await redrawRail($)
    return next(e)
  })

  // Record every prompt row as it is drawn.
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    // A slash command's row is drawn as a user row too; it is not a prompt.
    const text = e.props.text.replace(VIEW_CONTEXT, '').trim()
    if (PROMPT_KINDS.has(e.props.origin.kind) && text && !text.startsWith('/')) {
      drawn.set(rowKey(e.requestId), e.requestId)
      if (listDrawn(e.requestId, text)) redrawRailAfter($, 0)
    }
    return next(e)
  })

  // The prompt rows the band draws, `width` cells wide: the marked one tinted
  // behind a `❯`, holding the band's focus ring; the rest dimmed, lined up
  // with it.
  const railRows = ({ Box, Button, Text }: Elements, first: number, end: number, marked: number, width: number, isFocusable = true) =>
    entries.slice(first, end).map((entry, offset) => {
      const i = first + offset
      const row = `#${i + 1} ${entry.text}`
      if (i !== marked) {
        return (
          <Box key={`row-${i}`} paddingLeft={2}>
            <Text dimColor>{oneLine(row, Math.max(1, width - 2))}</Text>
          </Box>
        )
      }
      const label = oneLine(`❯ ${row}`, width)
      return (
        <Box key={`row-${i}`} width={width} backgroundColor={MARKED_BG}>
          {isFocusable ? <Button key="open" plain autoFocus dimColor label={label} onPress={() => {}} /> : <Text dimColor>{label}</Text>}
        </Box>
      )
    })

  // At rest, the latest prompt on one tinted row above the prompt. Once the
  // band takes the keyboard (abovePrompt:focus, bound to alt+j), the newest
  // prompts in a rounded frame with the browsed one marked, and the keys that
  // move through them under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    await $.state.get(MOVED)
    viewAgent = e.props.view.agentId
    // Nothing while the rail is off, a survey holds the band or a subagent's transcript is in view.
    if (mode === 'off' || e.props.hasSurvey || viewAgent !== undefined || entries.length === 0) return next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button } = elements
    const width = e.props.bodyColumns
    const latest = entries.length - 1
    if (browsed === undefined || browsed > latest) {
      browsed = undefined
      const isFocusable = !isReleasing
      if (isReleasing) {
        isReleasing = false
        redrawRailAfter($, RELEASE_MS)
      }
      return <Box flexDirection="column">{railRows(elements, latest, latest + 1, latest, width, isFocusable)}</Box>
    }
    return (
      <Box flexDirection="column" width={width}>
        <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
          {railRows(elements, shownFrom, shownFrom + FRAME_ROWS, browsed, Math.max(1, width - 4))}
        </Box>
        {/* A band too narrow for the hints cuts them rather than wrapping them. */}
        <Box flexDirection="row" columnGap={2} paddingLeft={1} width={width} overflow="hidden">
          {[
            ['next', 'j'],
            ['prev', 'k'],
            ['back', 'q'],
          ].map(([label, hotkey]) => (
            <Box key={label} flexShrink={0} width={`${hotkey}: ${label}`.length}>
              <Button key={label} hotkey={hotkey} plain dimColor label={label} onPress={() => {}} />
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  // The band took the keyboard and its ring landed on the marked row: browse
  // from the latest prompt.
  on('ui.focus', { component: 'AbovePrompt', plugin: 'prompt-rail' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny || e.element !== 'open' || browsed !== undefined || entries.length === 0) return result
    browse(entries.length - 1)
    await redrawRail($)
    return result
  })

  // A press answers the person's own keys, so the transcript may scroll from
  // it: j and k move to the next and previous prompt, Enter on the marked row
  // goes back to it, q ends browsing.
  on('ui.press', { plugin: 'prompt-rail' }, async ($, e, next) => {
    // First: a redraw releases the pressed Button's handler, which `next` runs.
    const result = await next(e)
    if (e.element === 'back') {
      browsed = undefined
      isReleasing = true
      await redrawRail($)
      return result
    }
    if (browsed === undefined) browse(entries.length - 1)
    else if (e.element === 'next' && browsed < entries.length - 1) browse(browsed + 1)
    else if (e.element === 'prev' && browsed > 0) browse(browsed - 1)
    await redrawRail($)
    const entry = entries[browsed ?? -1]
    if (entry) await jumpTo($, drawnRow(drawn, entry.id), notices)
    return result
  })
}
