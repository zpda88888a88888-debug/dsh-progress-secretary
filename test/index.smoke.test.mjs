import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, inject, name } from '../lib/index.js'

const CWD = '/ws'

/**
 * A deliberately small fake of the host surface this plugin touches.
 *
 * It is not a Cordis emulator — it is a contract pin, and its behaviour mirrors
 * constraints the real services enforce:
 *
 *   1. `commands.execute` is a THROWING stub. This plugin owns a notebook, not
 *      other plugins' commands: it must never reach for a checkpoint plugin, and
 *      a fake that quietly answered such a call would hide a dependency the spec
 *      forbids (section 9: it must not know any checkpoint plugin exists).
 *   2. `fs.writeText` records calls. The agent writes the notebook; the plugin
 *      only ever reads, and that must stay true.
 */
function harness({ files = {} } = {}) {
  const disk = { ...files }
  const registered = new Map()
  const followups = []
  const sessionAppends = []
  const disposers = []
  const writeCalls = []

  // The real `invocation.agent` carries `followup` (see dsh-command-goal), so the
  // fake must too — otherwise the harness, not the plugin, is what fails.
  const agent = {
    id: 'session-1',
    followup(message) {
      followups.push(message)
    },
  }

  const ctx = {
    fs: {
      async resolve(path, opts) {
        return { path, cwd: opts?.cwd }
      },
      async stat(target) {
        return target.path in disk ? { path: target.path } : undefined
      },
      async readText(target) {
        return disk[target.path]
      },
      async writeText(target, content) {
        writeCalls.push({ path: target.path, content })
        disk[target.path] = content
        return { path: target.path }
      },
    },
    commands: {
      register(definition) {
        registered.set(definition.name, definition)
        const disposer = () => registered.delete(definition.name)
        disposers.push(disposer)
        return disposer
      },
      find() {
        return undefined
      },
      async execute(_agent, line) {
        throw new Error(`this plugin must not execute another plugin's command: ${line}`)
      },
    },
    get(service) {
      if (service === 'sessions') {
        return {
          get(id) {
            return {
              id,
              header: { cwd: CWD },
              // The plugin commits context by appending a surface event. This
              // fake records the call so a test can tell "appended to the log"
              // apart from "sent to the inbox" — the distinction the brief bug
              // turned on.
              append(type, data, intent) {
                sessionAppends.push({ type, data, intent })
                return { type, seq: sessionAppends.length }
              },
            }
          },
          // No `fork`: session forking is the harness's job and this plugin must
          // not reach for it. Leaving it out makes such a call fail loudly.
        }
      }
      if (service === 'agents') {
        return {
          get() {
            return agent
          },
        }
      }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      disposers.push(disposer)
      return disposer
    },
  }

  apply(ctx)

  const invoke = (commandName, rawInput = '') =>
    registered.get(commandName).handler({ agent, rawInput, attachments: [], signal: undefined })

  return { ctx, registered, invoke, followups, disk, disposers, agent, sessionAppends, writeCalls }
}

// ── the surface ──────────────────────────────────────────────────────────────

test('declares the plugin name and the services it actually uses', () => {
  assert.equal(name, 'progress-secretary')
  // `timer` is gone with the checkpoint machinery: nothing is deferred any more.
  assert.deepEqual(inject, ['commands', 'fs'])
})

test('registers exactly the two operations, under collision-safe names', () => {
  const h = harness()
  assert.deepEqual([...h.registered.keys()].sort(), ['brief', 'note'])
  // Rollback went with the checkpoint dependency (spec 11), so neither the
  // bottom plugin's name nor a wrapper around it may be registered here.
  assert.equal(h.registered.has('rewind'), false)
  assert.equal(h.registered.has('progress-rewind'), false)
  // Forking moved to the harness, so this plugin must not offer it either.
  assert.equal(h.registered.has('fork'), false)
})

// ── 记录进度 · /note ─────────────────────────────────────────────────────────

test('/note injects the rewrite instruction and does nothing else', async () => {
  const h = harness({ files: { '.dsh/progress.md': '## 进行中\n- 旧的一行\n' } })
  const result = await h.invoke('note')

  assert.equal(result.kind, 'success')
  assert.equal(h.followups.length, 1)
  assert.match(h.followups[0].content[0].text, /记录进度/u)
  assert.match(h.followups[0].content[0].text, /而不是追加/u)

  // The receipt states what happened. It must not read as a live status, and it
  // must not send the user looking for a checkpoint that will never exist.
  assert.doesNotMatch(result.text, /正在重写/u)
  assert.doesNotMatch(result.text, /检查点/u)
  assert.doesNotMatch(result.text, /rewind/u)

  // Nothing else happened: no other command was executed (the fake throws on
  // that), no file was written, no context was appended.
  assert.deepEqual(h.writeCalls, [])
  assert.deepEqual(h.sessionAppends, [])
})

test('/note without a workspace directory fails visibly', async () => {
  const h = harness()
  // The fake builds the service object per call, so replacing the LOOKUP is what
  // actually models "this session carries no cwd".
  const realGet = h.ctx.get
  h.ctx.get = (service) => (service === 'sessions' ? { get: () => undefined } : realGet(service))
  const result = await h.invoke('note')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /工作区/u)
})

// ── 汇报进度 · /brief ────────────────────────────────────────────────────────

test('/brief fails with the path when the notebook does not exist', async () => {
  const h = harness()
  const result = await h.invoke('brief')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /\.dsh\/progress\.md/u)
  assert.match(result.text, /\/note/u, 'the failure names the command that creates it')
})

test('/brief commits the notebook to the log, never to the inbox', async () => {
  // `agent.followup()` would put the notebook in the inbox, where the loop claims
  // it as a user turn: a session that only wanted the background started
  // executing the notebook's Todo list. Appending to the log carries it into the
  // derived history and claims no turn.
  const h = harness({ files: { '.dsh/progress.md': '## 进行中\n- 甲\n\n## 待办\n- 乙\n' } })
  await h.invoke('brief')

  assert.equal(h.sessionAppends.length, 1, 'exactly one log commit')
  assert.equal(h.sessionAppends[0].type, 'user/message')
  assert.equal(h.sessionAppends[0].intent.surfaceOp, 'append')
  assert.deepEqual(h.followups, [], 'and nothing was sent to the inbox')
})

test('/brief reads the progress back instead of only acknowledging', async () => {
  const h = harness({
    files: {
      '.dsh/progress.md': '# 工作进度\n\n## 进行中\n- 甲\n\n## 待办\n- 乙\n\n## 叙事\n丙\n',
    },
  })
  const result = await h.invoke('brief')

  assert.equal(result.kind, 'success')
  // A briefing that only opens the notebook and says nothing is not a briefing.
  assert.match(result.text, /甲/u)
  assert.match(result.text, /乙/u)
  // The readback is body text for a chat row, so its labels are bold, not `##`.
  assert.doesNotMatch(result.text, /^#/mu)
  // The remaining sections stay in the injected context, not in the readback.
  assert.doesNotMatch(result.text, /丙/u)
  assert.match(result.text, /已作为背景注入/u)
})

test('/brief declares a snapshot with named sections, not a one-line notice', async () => {
  const h = harness({
    files: {
      '.dsh/progress.md':
        '# 工作进度\n\n## 进行中\n- 甲\n\n## 待办\n- 乙\n\n## 生效约束\n- 丙\n\n## 已验证事实\n- 丁\n\n## 产出物索引\n- 戊\n\n## 叙事\n己\n',
    },
  })
  await h.invoke('brief')

  const message = h.sessionAppends[0].data
  const source = message.source

  // `notice` is "shown without expanding the row"; a whole notebook is not that.
  assert.equal(source.form, 'snapshot')
  assert.equal(source.summary, undefined, 'snapshot must not carry a notice summary')

  // This is the shape `dsh-agent-loop` itself uses for the runtime-context
  // snapshot. The renderer shows `sections` INSTEAD of `content`, and degrades
  // the row to an opaque block when this list is missing, empty, or malformed.
  assert.ok(Array.isArray(source.sections), 'snapshot requires sections')
  assert.deepEqual(
    source.sections.map((s) => s.name),
    ['进行中', '待办', '生效约束', '已验证事实', '产出物索引', '叙事'],
  )
  for (const section of source.sections) {
    assert.equal(typeof section.name, 'string')
    assert.ok(section.name.length > 0)
    assert.equal(typeof section.text, 'string')
  }
  assert.match(source.sections[0].text, /甲/u)
  assert.match(source.sections[5].text, /己/u)

  // The model-facing text still carries the whole notebook, framing included.
  const content = message.content[0].text
  assert.match(content, /甲/u)
  assert.match(content, /己/u)
  assert.match(content, /工作进度笔记本/u)
})

test('a notebook that parses into no sections still yields a valid snapshot', async () => {
  const h = harness({ files: { '.dsh/progress.md': '手写的、没有小节标题的杂记' } })
  await h.invoke('brief')
  const source = h.sessionAppends[0].data.source
  assert.equal(source.form, 'snapshot')
  // An empty sections list degrades the row; one opaque section does not.
  assert.equal(source.sections.length, 1)
  assert.match(source.sections[0].text, /杂记/u)
})

// ── properties of the whole surface ──────────────────────────────────────────

test('the plugin never writes a file, and never runs another plugin`s command', async () => {
  // Reading is the whole story now: the agent writes the notebook. And the host
  // half must not execute any command — `commands.execute` throws in this fake,
  // so reaching for a checkpoint plugin would fail here rather than in the dark.
  const h = harness({ files: { '.dsh/progress.md': '# 工作进度\n\n## 进行中\n- x\n' } })
  await h.invoke('note')
  await h.invoke('brief')

  assert.deepEqual(h.writeCalls, [], 'the plugin must not write anything')
})

test('every registered effect is disposable, so stop/update unwinds cleanly', () => {
  const h = harness()
  assert.equal(h.registered.size, 2)
  for (const disposer of h.disposers) {
    if (typeof disposer === 'function') disposer()
  }
  assert.equal(h.registered.size, 0)
})
