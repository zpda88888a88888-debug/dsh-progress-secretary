/**
 * Integration test against the REAL command registry and REAL Cordis.
 *
 * The fake-context suite (`index.smoke.test.mjs`) pins this plugin's own logic,
 * but a fake cannot enforce the contracts of the services it stands in for. A
 * permissive fake once let an empty `input.hint` through to a live profile,
 * where `normalizeDefinition` rejected it and the whole plugin tree failed to
 * load. This suite exists so that class of mistake is caught before a restart.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { Context } from '@deepseek-ai/cordis'
// The package's default export IS the Cordis plugin function, not an object
// with `apply`/`inject` — reading `.apply` here would silently grab
// `Function.prototype.apply`.
import commandsPlugin from '@deepseek-ai/dsh-commands'

import { apply as worklogApply, inject as worklogInject, name as worklogName } from '../lib/index.js'

const AGENT = { id: 'session-1' }

/** The only `fs` surface the plugin touches: reading the notebook back for `/brief`. */
function fakeFs() {
  return {
    async resolve(path, opts) {
      return { path, cwd: opts?.cwd }
    },
    async stat() {
      return undefined
    },
    async readText() {
      return ''
    },
  }
}

/**
 * Boot a real Cordis context with the real command registry, then apply this
 * plugin exactly as the loader does. Returns the live context.
 */
function boot() {
  const ctx = new Context()
  ctx.provide('fs', fakeFs())
  ctx.plugin(commandsPlugin)
  ctx.plugin({ name: worklogName, apply: worklogApply, inject: worklogInject })
  return ctx
}

/** Let Cordis settle its plugin fibers. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

test('applies into a real Cordis context with the real command registry', async () => {
  const ctx = boot()
  await settle()

  assert.equal(typeof ctx.commands, 'object', 'commands service did not activate')

  const expected = ['note', 'brief']
  for (const commandName of expected) {
    assert.ok(
      ctx.commands.find(AGENT, commandName) !== undefined,
      `/${commandName} was not registered`,
    )
  }

  // Rollback is not this plugin's business (spec 11): no /rewind may be registered
  // here, and no bottom-plugin command may be named in the config either.
  assert.equal(ctx.commands.find(AGENT, 'rewind'), undefined)
  assert.equal(ctx.commands.find(AGENT, 'progress-rewind'), undefined)
  // Forking belongs to the harness, not to this plugin.
  assert.equal(ctx.commands.find(AGENT, 'fork'), undefined)
})

test('every registered definition satisfies the real registry contract', async () => {
  const ctx = boot()
  await settle()

  const namePattern = /^[a-z][a-z0-9_-]*$/u
  for (const commandName of ['note', 'brief']) {
    const definition = ctx.commands.find(AGENT, commandName)
    assert.ok(definition, `/${commandName} missing`)

    assert.match(definition.name, namePattern)
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.trim().length > 0, `${commandName}: empty description`)
    assert.equal(typeof definition.handler, 'function', `${commandName}: handler is not a function`)

    if (definition.input !== undefined) {
      assert.equal(typeof definition.input.hint, 'string', `${commandName}: hint is not a string`)
      assert.ok(
        definition.input.hint.trim().length > 0,
        `${commandName}: hint is empty — the registry rejects this and the plugin tree fails to load`,
      )
    }
  }
})
