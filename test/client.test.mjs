/**
 * Client-half behaviour.
 *
 * `lib/client.js` is the browser bundle, and the bug this suite exists for was
 * pure presentation: the composer echoed a command's result text that had
 * already been rendered in the chat frame. Source-pattern assertions cannot pin
 * "which surface shows what", so this suite LOADS the bundle and renders it.
 *
 * Two stand-ins are used, and neither is a general emulator:
 *
 *   1. The platform module table (`window.__ModuleLoader__`) is faked so the
 *      bundle can be evaluated in Node, exactly as `dsh-client-modules` would
 *      evaluate it in the browser.
 *   2. React is a minimal stand-in, because the real one is not resolvable from
 *      this workspace. It models exactly what these components rely on: hook
 *      slots addressed by call order, and a state setter that marks a re-render.
 *      It is NOT a reconciler, and it does not run effects — so a component that
 *      depended on an effect to render correctly would be wrong under it. Say so
 *      here rather than let a green test imply more than it checks.
 *
 * The slot registry, by contrast, is faked only as a recorder: the bundle's
 * contract with it (lazy `inject`, then `register`) is asserted, not emulated.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(clientPath, 'utf8')

/** 进行中 + 待办, i.e. what `/brief` reads back. Markdown, multi-line on purpose. */
const READBACK = '**进行中**\n- 甲\n\n**待办**\n- 乙'

// ── the two stand-ins ────────────────────────────────────────────────────────

/**
 * A minimal React stand-in: `createElement` plus the hook subset these
 * components use. Hook state lives in one flat slot array addressed by call
 * order, which is what React does too; the difference is that this one does not
 * reconcile, batch, or run effects.
 */
function makeRuntime() {
  const slots = []
  let cursor = 0
  let dirty = false

  const react = {
    createElement(type, props, ...children) {
      return {
        type,
        props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] },
      }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [
        slots[index],
        (next) => {
          const value = typeof next === 'function' ? next(slots[index]) : next
          if (value !== slots[index]) {
            slots[index] = value
            dirty = true
          }
        },
      ]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect() {
      // Effects are not modelled. No component under test reads state an effect
      // writes, so skipping them cannot make a broken component look correct
      // here; if that changes, this stand-in must change too.
      cursor += 1
    },
  }

  return {
    react,
    /**
     * Render to a settled tree: run the component, let its promise chains
     * settle, and re-render until no state moved.
     */
    async render(Component, props) {
      let tree = null
      for (let pass = 0; pass < 50; pass += 1) {
        cursor = 0
        dirty = false
        tree = Component(props)
        await new Promise((resolve) => setTimeout(resolve, 1))
        if (!dirty) return tree
      }
      throw new Error('component never settled')
    },
  }
}

/**
 * Evaluate the bundle exactly as the module loader does, resolving every module
 * from the supplied table.
 *
 * The table is a parameter because the bundle reads the platform's Markdown
 * renderer from it, and BOTH worlds have to be exercised: the shell's table
 * (`react` + `@deepseek-ai/dsh-client-ui-primitives`) and a table without the
 * renderer, where the card must degrade rather than break.
 */
function loadBundle(table) {
  let bundle = null

  const window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        bundle = { id, exports: factory((name) => {
          if (name in table) return table[name]
          throw new Error(`unexpected require(${name})`)
        }) }
      },
    },
  }
  // The bundle is a script, not a module: it publishes itself onto `window`.
  new Function('window', source)(window)
  assert.notEqual(bundle, null, 'the bundle did not register itself')

  return bundle
}

/**
 * A client context recording the slot traffic, plus a scriptable command channel.
 *
 * The runtime is built FIRST: the bundle captures `require('react')` at load
 * time, so the hooks a test drives must be the very object the components call.
 *
 * @param {object} [options]
 * @param {boolean} [options.markdown] put a Markdown renderer in the table, as the
 * shell's platform seed does; `false` models a shell without it
 */
function makeClient({ markdown = true } = {}) {
  const runtime = makeRuntime()
  // Stands in for `MarkdownText`, which is a `react.memo` object rather than a
  // function — the bundle must accept either. It renders nothing clever: the
  // FORMATTING belongs to the platform's renderer and is not this suite's to
  // check. What is checked here is the handoff.
  const markdownText = (props) => runtime.react.createElement('span', { 'data-markdown': true }, props.text)
  const table = { react: runtime.react }
  if (markdown) table['@deepseek-ai/dsh-client-ui-primitives'] = { MarkdownText: markdownText }
  const bundle = loadBundle(table)
  const injects = []
  const registrations = []
  // The command channel is the ONLY Remote namespace this client half has any
  // business with: it turns a button into the same slash command the composer
  // would have run. Nothing here reads a checkpoint panel, and there is no
  // namespace left that could degrade (spec 9 / spec-ui 5).
  const remote = {
    commands: {
      async execute() {
        throw new Error('this test did not script remote.commands.execute')
      },
    },
  }
  const ctx = {
    remote,
    slots: {
      inject(slotName, callback) {
        injects.push(slotName)
        callback()
      },
      register(options, Component) {
        registrations.push({ options, Component })
        return () => {}
      },
    },
  }
  return { bundle, ctx, remote, runtime, injects, registrations, markdownText }
}

// ── tiny tree helpers ────────────────────────────────────────────────────────

function elementsOf(tree) {
  const out = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'object') {
      out.push(node)
      walk(node.props?.children)
    }
  }
  walk(tree)
  return out
}

function textOf(tree) {
  const parts = []
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    if (typeof node === 'object') walk(node.props?.children)
    else parts.push(String(node))
  }
  walk(tree)
  return parts.join('')
}

/** The single element whose rendered text starts with `label`. */
function elementByText(tree, label) {
  const found = elementsOf(tree).filter((element) => textOf(element).trim() === label)
  assert.equal(found.length, 1, `expected exactly one "${label}" element`)
  return found[0]
}

/**
 * Render an element tree the way React would, for the hook-free components in
 * this suite: invoke function components with their props and walk the result.
 *
 * Without it, a card that hands its text to a child COMPONENT would look empty
 * here — the child is created as an element but never called. That gap is what
 * this helper closes, and it is also why nothing asserted through it can claim
 * the child rendered *well*: only that the card asked it to render this text.
 */
function rendered(tree) {
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return node
    if (Array.isArray(node)) return node.map(walk)
    if (typeof node === 'object') {
      if (typeof node.type === 'function') return walk(node.type(node.props))
      return { type: node.type, props: { ...node.props, children: walk(node.props?.children) } }
    }
    return node
  }
  return walk(tree)
}

/**
 * Load the bundle, apply it, and return the recording context.
 *
 * @param {Function} [remoteSetup] namespaces to hang on `ctx.remote`
 * @param {object} [options] forwarded to {@link makeClient}
 */
function applied(remoteSetup, options) {
  const client = makeClient(options)
  Object.assign(client.remote, remoteSetup?.(client.remote) ?? {})
  client.bundle.exports.apply(client.ctx)
  return client
}

/** The composer seat's component. */
function composerComponent(client) {
  const composer = client.registrations.find((r) => r.options.name === 'conversation.input.left')
  assert.notEqual(composer, undefined, 'the composer seat was never registered')
  return composer.Component
}

/** The composer seat's injected business face. */
function composerFace(client, sessionId = 'session-1') {
  const composer = client.registrations.find((r) => r.options.name === 'conversation.input.left')
  assert.notEqual(composer, undefined, 'the composer seat was never registered')
  return composer.options.inject(sessionId)
}

/** The chat card registered for one command name. */
function cardFor(client, key) {
  const card = client.registrations.find(
    (r) => r.options.name === 'conversation.chat.commandview' && r.options.key === key,
  )
  assert.notEqual(card, undefined, `no chat card registered for "${key}"`)
  return card.Component
}

// ── both surfaces exist, and are registered the lazy way ─────────────────────

test('the client half registers the composer seat and one chat card per command', () => {
  const client = applied()
  const seats = client.registrations.map((r) => r.options.name)
  assert.deepEqual(seats, [
    'conversation.input.left',
    'conversation.chat.commandview',
    'conversation.chat.commandview',
  ])
  assert.deepEqual(
    client.registrations.filter((r) => r.options.name === 'conversation.chat.commandview').map((r) => r.options.key),
    ['note', 'brief'],
    'cards are keyed by the command names the chat frame dispatches',
  )
  // Every registration went through the lazy seat inject, so a missing seat
  // cannot leave this client half waiting: nothing is a hard dependency.
  assert.deepEqual(client.injects, [
    'conversation.input.left',
    'conversation.chat.commandview',
    'conversation.chat.commandview',
  ])
  assert.deepEqual(client.bundle.exports.inject, ['slots', 'remote', 'remote.commands'])
})

// ── the composer shows admission failures, and only those ────────────────────

test('a successful brief renders no receipt in the composer at all', async () => {
  // The regression this suite exists for: the readback showed up in the input
  // area, next to the buttons, instead of only on the chat row that carries it
  // durably.
  //
  // Two things are asserted, and the second is not redundant: a composer that
  // echoes an admitted command through the BRIDGE's empty text would still slip
  // past a text-only check as an empty block — which is the same defect with a
  // quieter face. (Mutation testing found exactly that hole.)
  const calls = []
  const client = applied((remote) => ({
    commands: {
      async execute(_sessionId, line) {
        calls.push(line)
        return { ok: true, value: { commandId: 'cmd-1', result: { kind: 'success', text: READBACK } } }
      },
    },
  }))
  const face = composerFace(client)
  const Bar = composerComponent(client)
  const runtime = client.runtime

  const tree = await runtime.render(Bar, face)
  elementByText(tree, '汇报进度').props.onClick()
  const settled = await runtime.render(Bar, face)

  assert.deepEqual(calls, ['/brief'], 'the button must drive the same slash command')
  const text = textOf(settled)
  assert.match(text, /记录进度/u, 'the buttons must still be there')
  assert.match(text, /汇报进度/u)
  assert.equal(text.includes('回滚'), false, 'rollback is not this plugin`s business and has no button')
  assert.equal(text.includes('进行中'), false, "the composer must not echo the command's result")
  assert.equal(text.includes('甲'), false, 'not even a fragment of it')

  const receipts = elementsOf(settled).filter((element) => element.props?.role === 'alert')
  assert.deepEqual(receipts, [], 'an admitted command must produce no composer receipt, empty or not')
})

test('an admission failure is rendered in the composer and stays there', async () => {
  // An admission failure never entered a handler, so no durable event exists and
  // the chat frame will never render it. It is the composer's to show — and to
  // KEEP showing: there is no copy anywhere else.
  const client = applied(() => ({
    commands: {
      async execute() {
        return { ok: false, error: { message: 'command refuser', code: 'command/unavailable' } }
      },
    },
  }))
  const face = composerFace(client)
  const Bar = composerComponent(client)
  const runtime = client.runtime

  const tree = await runtime.render(Bar, face)
  elementByText(tree, '汇报进度').props.onClick()
  const settled = await runtime.render(Bar, face)

  assert.match(textOf(settled), /command refuser \(command\/unavailable\)/u)
  const alert = elementsOf(settled).find((element) => element.props?.role === 'alert')
  assert.notEqual(alert, undefined, 'a failure must be announced, not just coloured')

  // No timer takes it away: after a real delay it is still there. (A timer long
  // enough to outlast this test is caught by the spec-conformance red line,
  // which forbids `setTimeout` in this file outright.)
  await new Promise((resolve) => setTimeout(resolve, 30))
  const later = await runtime.render(Bar, face)
  assert.match(textOf(later), /command refuser/u)
})

test('a failed handler is NOT a composer receipt: the chat card carries it', async () => {
  // The handler's own error text is a durable `command/done` outcome. Echoing it
  // into the composer would be a second copy that a reload loses.
  const client = applied(() => ({
    commands: {
      async execute() {
        return { ok: true, value: { commandId: 'cmd-2', result: { kind: 'error', text: 'handler failed: notebook missing' } } }
      },
    },
  }))
  const face = composerFace(client)
  const Bar = composerComponent(client)
  const runtime = client.runtime

  const tree = await runtime.render(Bar, face)
  elementByText(tree, '汇报进度').props.onClick()
  const settled = await runtime.render(Bar, face)

  assert.equal(textOf(settled).includes('handler failed'), false, 'the chat card owns this text')
})

test('the composer reports admission, never the handler outcome', async () => {
  // This bridge is the guard that keeps a handler's text out of the composer:
  // forwarding `result.text` here would put the readback back in the input area,
  // and the composer's own admission check would merely render it as an empty
  // block. Both halves are pinned, here and in the render test above.
  const client = applied()
  const face = composerFace(client, 'session-7')
  assert.equal(face.sessionId, 'session-7')

  client.remote.commands.execute = async () =>
    ({ ok: true, value: { commandId: 'c', result: { kind: 'success', text: 'ignored' } } })
  assert.deepEqual(await face.runCommand('/brief'), { admitted: true, text: '' })

  client.remote.commands.execute = async () =>
    ({ ok: true, value: { commandId: 'c', result: { kind: 'error', text: 'handler failed' } } })
  assert.deepEqual(await face.runCommand('/brief'), { admitted: true, text: '' })

  client.remote.commands.execute = async () => ({ ok: true, value: undefined })
  assert.equal((await face.runCommand('/nope')).admitted, false)

  client.remote.commands.execute = async () =>
    ({ ok: false, error: { message: 'refused', code: 'command/unavailable' } })
  assert.deepEqual(await face.runCommand('/brief'), { admitted: false, text: 'refused (command/unavailable)' })
})

// ── the chat card ────────────────────────────────────────────────────────────

test('the chat card hands the result to the platform Markdown renderer', () => {
  // The regression this pins: the digest is Markdown, and a card that printed it
  // verbatim showed the user `#`, `**` and `- ` — the source of the report
  // instead of the report. The body must go through the shell's own renderer,
  // the one assistant prose goes through.
  const client = applied()
  const Card = cardFor(client, 'brief')

  const tree = Card({ node: { name: 'brief', outcome: { kind: 'success', text: READBACK } } })
  assert.match(textOf(tree), /汇报进度/u, 'the card carries the command label')

  const view = rendered(tree)
  const body = elementsOf(view).find((element) => element.props?.['data-markdown'] === true)
  assert.notEqual(body, undefined, 'the body must be the platform renderer, not a plain block')
  assert.equal(body.props.children, READBACK, 'and the renderer is handed the exact durable text')

  // One body, one rendering: the verbatim fallback block is not used as well.
  const fallback = elementsOf(view).find((element) => element.props?.style?.whiteSpace === 'pre-wrap')
  assert.equal(fallback, undefined, 'the verbatim body must not be rendered beside the formatted one')
})

test('without the platform renderer the card still shows the result, verbatim', () => {
  // A formatting downgrade, not a lost report: the shell may not put the
  // renderer in its platform table, and that must not cost the content — or the
  // buttons.
  const client = applied(undefined, { markdown: false })
  const Card = cardFor(client, 'brief')

  const view = rendered(Card({ node: { name: 'brief', outcome: { kind: 'success', text: READBACK } } }))
  assert.match(textOf(view), /进行中/u, 'the content must survive the downgrade')
  assert.equal(
    elementsOf(view).find((element) => element.props?.['data-markdown'] === true),
    undefined,
    'no renderer is present in this world',
  )

  const body = elementsOf(view).find((element) => element.props?.children === READBACK)
  assert.notEqual(body, undefined, 'the text is rendered as-is')
  assert.equal(body.props.style.whiteSpace, 'pre-wrap', 'line breaks must survive too')
})

test('an unusable platform renderer cannot take the client half down', () => {
  // `readMarkdownText` runs while the bundle's factory executes, so a throw there
  // would cost the whole client half — the buttons included. Any unusable answer
  // from the platform table must read as "no renderer" and fall back to the
  // verbatim body.
  for (const value of [null, {}, { MarkdownText: null }, 'nope']) {
    const runtime = makeRuntime()
    const table = { react: runtime.react, '@deepseek-ai/dsh-client-ui-primitives': value }
    let bundle = null
    assert.doesNotThrow(
      () => {
        bundle = loadBundle(table)
      },
      `a platform table answering ${JSON.stringify(value)} must not break loading`,
    )

    const registrations = []
    bundle.exports.apply({
      remote: {
        commands: {
          async execute() {
            throw new Error('unused in this test')
          },
        },
      },
      slots: {
        inject(_slotName, callback) {
          callback()
        },
        register(options, Component) {
          registrations.push({ options, Component })
          return () => {}
        },
      },
    })
    assert.equal(registrations.length, 3, 'all three seats still register')

    const card = registrations.find((r) => r.options.name === 'conversation.chat.commandview').Component
    const tree = card({ node: { outcome: { kind: 'success', text: READBACK } } })
    assert.match(textOf(tree), /进行中/u, 'the content still renders, just unformatted')
  }
})

test('the chat card distinguishes a failed command from a successful one', () => {
  const client = applied()
  const Card = cardFor(client, 'brief')
  const view = (props) => rendered(Card(props))
  const node = (outcome) => ({ node: { name: 'brief', outcome } })

  const failed = textOf(view(node({ kind: 'error', text: '底层命令 /rewind 不存在' })))
  assert.match(failed, /⚠/u, 'a failure must not look like a success')
  assert.match(failed, /底层命令 \/rewind 不存在/u)

  assert.doesNotMatch(textOf(view(node({ kind: 'success', text: '已注入' }))), /⚠/u)
  assert.match(textOf(view(node(null))), /进行中/u, 'an unsettled command must not read as done')
})

test('a card never throws on a shape it did not expect', () => {
  const client = applied()
  const Card = cardFor(client, 'note')
  for (const node of [undefined, {}, { outcome: {} }, { outcome: { kind: 'success' } }]) {
    assert.equal(typeof Card({ node }), 'object')
  }
  assert.equal(typeof Card({}), 'object')
})
