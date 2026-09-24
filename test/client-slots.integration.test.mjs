/**
 * Client half against the REAL slot registry.
 *
 * `test/client.test.mjs` renders the two surfaces, but against a *recording*
 * slot stub — it asserts the calls, not their legality. The slot registry has
 * load-time rules of its own, and getting one wrong fails the whole client half
 * (the same class of failure as the empty `input.hint` that once broke the host
 * tree). So this suite boots the platform's real `SlotRegistry` over a real
 * Cordis context, declares the seat chain the real owners declare, and applies
 * this bundle into it.
 *
 * The platform packages are the PLATFORM's, not this plugin's: they are not
 * dependencies, so a bare checkout may not resolve them. Resolution tries the
 * normal path first and the installed DSH profile second (that is where the
 * platform actually lives); when neither works the suite SKIPS rather than
 * pretending it verified anything.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const localRequire = createRequire(import.meta.url)
const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const clientSource = readFileSync(clientPath, 'utf8')

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Resolve the platform's client packages, or `null` when they are not here. */
async function loadPlatform() {
  const roots = [localRequire, createRequire(join(DSH_HOME, 'profiles', 'node_modules', 'dsh.js'))]
  for (const req of roots) {
    const resolved = {}
    try {
      resolved.cordis = await import(pathToFileURL(req.resolve('@deepseek-ai/cordis')).href)
      resolved.uiSlots = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-client-ui-slots')).href)
      resolved.runtimeSource = readFileSync(req.resolve('@deepseek-ai/dsh-client-runtime/client'), 'utf8')
    } catch {
      continue
    }
    // The runtime is a BROWSER bundle: importing it yields no exports, because it
    // publishes itself onto `window.__ModuleLoader__`. It is loaded the way the
    // shell loads it, with the two platform modules it requires.
    const table = {
      '@deepseek-ai/cordis': resolved.cordis,
      '@deepseek-ai/dsh-client-ui-slots': resolved.uiSlots,
    }
    try {
      let runtime = null
      const window = {
        __ModuleLoader__: {
          load({ factory }) {
            runtime = factory((name) => {
              if (name in table) return table[name]
              throw new Error(`unexpected require(${name})`)
            })
          },
        },
      }
      new Function('window', resolved.runtimeSource)(window)
      if (runtime === null || typeof runtime.SlotRegistry !== 'function') continue
      return { cordis: resolved.cordis, runtime }
    } catch {
      /* try the next root */
    }
  }
  return null
}

/**
 * A `require` rooted wherever the platform packages live, or `null`.
 *
 * Used by the tests that only need to READ the platform's own files, rather than
 * load them.
 */
function platformRequire() {
  for (const req of [localRequire, createRequire(join(DSH_HOME, 'profiles', 'node_modules', 'dsh.js'))]) {
    try {
      req.resolve('@deepseek-ai/dsh-client-web')
      req.resolve('@deepseek-ai/dsh-client-ui-primitives')
      return req
    } catch {
      /* try the next root */
    }
  }
  return null
}

/** Load this plugin's bundle through a fake module table, as the shell does. */
function loadClientBundle() {
  let exports = null
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
    useState: (value) => [value, () => {}],
    useRef: (value) => ({ current: value }),
    useEffect: () => {},
  }
  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        exports = factory((name) => {
          if (name === 'react') return react
          throw new Error(`unexpected require(${name})`)
        })
      },
    },
  }
  new Function('window', clientSource)(window)
  assert.notEqual(exports, null, 'the bundle did not register itself')
  return exports
}

/** Let Cordis settle its plugin fibers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

/**
 * Declare the seat chain the real owners declare, down to the seats this plugin
 * occupies.
 *
 * The kinds and scopes are the real ones (`conversation.input.left` is a
 * session-scoped LIST; `conversation.chat.commandview` is a session-scoped KEYED
 * child of the command chat row). A registry rule this suite is checking — keyed
 * needs `key`, list needs `id` — is only enforced once the kind is right.
 *
 * @param ctx client context with the real `slots` service
 */
function declareChain(ctx) {
  ctx.slots.register({ name: 'root', children: { main: { kind: 'keyed', scope: 'root' } } }, () => null)
  ctx.slots.register(
    { name: 'main', key: 'conversation', children: { 'main.conversation': { kind: 'single', scope: 'session-maybe' } } },
    () => null,
  )
  ctx.slots.register(
    {
      name: 'main.conversation',
      children: {
        'conversation.composer.bar': { kind: 'single', scope: 'session-maybe' },
        'conversation.chat.node': { kind: 'keyed', scope: 'session' },
      },
    },
    () => null,
  )
  ctx.slots.register(
    {
      name: 'conversation.composer.bar',
      children: { 'conversation.input.left': { kind: 'list', scope: 'session' } },
    },
    () => null,
  )
}

/**
 * The chat half's command row: the entry whose children table DECLARES the
 * command-card seat. In the real shell it is one of several `conversation.chat.node`
 * entries, which is why a seat's declaration can arrive from a different plugin
 * than the one that registers into it.
 */
function declareCommandRow(ctx) {
  ctx.slots.register(
    {
      name: 'conversation.chat.node',
      key: 'command',
      children: { 'conversation.chat.commandview': { kind: 'keyed', scope: 'session' } },
    },
    () => null,
  )
}

/** Boot a real Cordis context holding the real slot registry. */
function boot(cordis, runtime) {
  const ctx = new cordis.Context()
  ctx.plugin({
    name: 'slots',
    apply: (inner) => {
      new runtime.SlotRegistry(inner)
    },
  })
  return ctx
}

test('the real registry declares the seats this plugin occupies', async (t) => {
  const platform = await loadPlatform()
  if (platform === null) {
    t.skip(`platform client packages not resolvable (looked in node_modules and ${DSH_HOME}/profiles)`)
    return
  }

  const ctx = boot(platform.cordis, platform.runtime)
  await settle()
  assert.equal(typeof ctx.slots?.register, 'function', 'the real slots service did not mount')

  declareChain(ctx)
  declareCommandRow(ctx)

  // The kinds this plugin's registration depends on, pinned against the real
  // declaration path: a keyed seat needs `key`, a list seat needs `id`.
  assert.equal(ctx.slots.spec('conversation.chat.commandview').kind, 'keyed')
  assert.equal(ctx.slots.spec('conversation.input.left').kind, 'list')

  const bundle = loadClientBundle()
  bundle.apply(ctx)

  const composer = ctx.slots.entriesOfSlot('conversation.input.left')
  assert.equal(composer.length, 1, 'the composer seat must hold exactly one entry')
  assert.equal(composer[0].options.id, 'progress-secretary')
  assert.equal(typeof composer[0].component, 'function')

  const cards = ctx.slots.entriesOfSlot('conversation.chat.commandview')
  assert.deepEqual(
    cards.map((entry) => entry.options.key).sort(),
    ['brief', 'note'],
    'one chat card per command name, keyed by that name',
  )
  for (const card of cards) assert.equal(typeof card.component, 'function')
})

test('a seat declared LATER still receives its registration (lazy inject)', async (t) => {
  const platform = await loadPlatform()
  if (platform === null) {
    t.skip('platform client packages not resolvable')
    return
  }

  const ctx = boot(platform.cordis, platform.runtime)
  await settle()

  // Boot order is not ours to choose: the chat half may mount after this plugin.
  // Registering directly would throw on an undeclared seat — which is the reason
  // every registration goes through inject, and the reason a missing seat must
  // not break the buttons.
  declareChain(ctx)
  assert.equal(ctx.slots.spec('conversation.chat.commandview'), undefined, 'precondition: not declared yet')
  assert.throws(
    () => ctx.slots.register({ name: 'conversation.chat.commandview', key: 'brief' }, () => null),
    /is not declared/u,
    'the registry rejects a registration into an undeclared seat',
  )

  const bundle = loadClientBundle()
  assert.doesNotThrow(() => bundle.apply(ctx), 'a missing seat must not break the plugin')
  assert.equal(ctx.slots.entriesOfSlot('conversation.input.left').length, 1, 'the composer seat still registers')
  assert.deepEqual(ctx.slots.entriesOfSlot('conversation.chat.commandview'), [])

  // Now the chat half arrives, exactly as it would during boot: the declaration
  // comes with the owner's own children table.
  declareCommandRow(ctx)

  assert.deepEqual(
    ctx.slots.entriesOfSlot('conversation.chat.commandview').map((entry) => entry.options.key).sort(),
    ['brief', 'note'],
    'a later declaration must still receive the cards',
  )
})

test('the card body renderer is a PLATFORM module, published by the shell', async (t) => {
  // The card reads `MarkdownText` from `@deepseek-ai/dsh-client-ui-primitives`,
  // and that single `require` is only safe because the shell publishes that
  // package in the SAME static table as `react` (its platform module list) —
  // not because it is a plugin row this bundle could declare. Pin the
  // assumption against the installed platform, so a shell that stops publishing
  // it fails here rather than downgrading the card in the browser.
  const req = platformRequire()
  if (req === null) {
    t.skip(`platform packages not resolvable (looked in node_modules and ${DSH_HOME}/profiles)`)
    return
  }

  const shellSource = readFileSync(req.resolve('@deepseek-ai/dsh-client-web'), 'utf8')
  assert.match(
    shellSource,
    /"@deepseek-ai\/dsh-client-ui-primitives": UiPrimitives/u,
    'the shell must seed the primitives package into the platform module table',
  )

  // And the seed's namespace must actually carry the name the card reads.
  const primitivesSource = readFileSync(req.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8')
  const exportList = /export \{([^}]*)\}/u.exec(primitivesSource)
  assert.notEqual(exportList, null, 'the primitives entry must export a named list')
  assert.match(exportList[1], /\bMarkdownText\b/u, 'the seed must export MarkdownText')
})
