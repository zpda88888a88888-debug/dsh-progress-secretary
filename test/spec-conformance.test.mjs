/**
 * Spec conformance.
 *
 * The spec is the source of truth for this plugin, so the factual claims in it
 * that CAN be checked mechanically are checked here. Two things are deliberately
 * brittle:
 *
 *   1. The spec's config table and inject declarations are PARSED OUT OF the
 *      spec and compared against the code. Neither side can drift silently.
 *   2. The red lines are asserted as source-text patterns. If a future edit
 *      rewrites those lines, this test fails on purpose — the failure is a
 *      prompt to revisit the spec section that names the red line.
 *
 * The spec is split by concern: `spec.md` owns system behaviour, `spec-ui.md`
 * owns interaction and presentation. A requirement is described in exactly one
 * of them, so this suite reads whichever one owns the claim it is checking — and
 * checks that the boundary itself has not been blurred.
 *
 * A failure here means spec and implementation disagree. That is the defect;
 * fix whichever one is wrong, in the same change.
 *
 * Project STATUS does not live in the spec (see `CHANGELOG.md` and the workspace
 * notebook), so this suite asserts only requirements — never "is it done yet".
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { Config, inject } from '../lib/index.js'
import { NOTEBOOK_DEFAULT, SECTION_ORDER, noteInstruction } from '../lib/notebook.js'

const spec = readFileSync(fileURLToPath(new URL('../spec.md', import.meta.url)), 'utf8')
const uiSpec = readFileSync(fileURLToPath(new URL('../spec-ui.md', import.meta.url)), 'utf8')
const hostSource = readFileSync(fileURLToPath(new URL('../lib/index.js', import.meta.url)), 'utf8')
const clientSource = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8')
const patchSource = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')

/**
 * Source with comments removed.
 *
 * Negative red-line assertions must look at CODE, not prose. A comment that
 * names a forbidden construct as a counter-example — or that explains why a
 * required construct exists — is not a violation, and must not be able to
 * satisfy a positive assertion either.
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '') // block comments, including JSDoc
    .replace(/(^|[^:])\/\/[^\n]*/gmu, '$1') // line comments, sparing '://'
}

const host = stripComments(hostSource)
const client = stripComments(clientSource)

/** Slice one `## <heading>` section out of one spec file. */
function sectionIn(document, heading) {
  const start = document.indexOf(`## ${heading}`)
  assert.notEqual(start, -1, `spec is missing the section "${heading}"`)
  const rest = document.slice(start + heading.length)
  const next = rest.indexOf('\n## ')
  return next === -1 ? rest : rest.slice(0, next)
}

/** A section of the system spec. */
const section = (heading) => sectionIn(spec, heading)

/** A section of the interaction/presentation spec. */
const uiSection = (heading) => sectionIn(uiSpec, heading)

/** Backticked tokens on the spec line matching `pattern`. */
function backticked(linePattern, source) {
  const line = linePattern.exec(source)
  assert.notEqual(line, null, `spec is missing the line ${String(linePattern)}`)
  return [...line[0].matchAll(/`([^`]+)`/gu)].map((m) => m[1])
}

/** The system spec's config table, as `{ key, raw }` rows (section 8). */
function specConfigRows() {
  const rows = [...section('八、配置').matchAll(/^\|\s*`([A-Za-z][A-Za-z0-9]*)`\s*\|\s*`([^`]*)`/gmu)].map(
    (m) => ({ key: m[1], raw: m[2] }),
  )
  assert.ok(rows.length > 0, 'could not parse the config table out of the spec')
  return rows
}

test('the spec declares every config key, with the defaults the code resolves', () => {
  const rows = specConfigRows()

  const resolved = Config({})
  assert.deepEqual(
    rows.map((r) => r.key).sort(),
    Object.keys(resolved).sort(),
    'spec config table and Config schema disagree on keys',
  )

  for (const { key, raw } of rows) {
    const expected = raw === 'true' ? true : raw === 'false' ? false : raw
    assert.deepEqual(resolved[key], expected, `default for \`${key}\` differs from the spec`)
  }
})

test('the spec declares the inject list the host half actually uses', () => {
  const declared = backticked(/-\s*host 半边[^\n]*/u, section('九、依赖与约束'))
  assert.deepEqual(inject, declared, 'host inject and the spec disagree')
})

test('the spec declares the inject list the client half actually uses', () => {
  const declared = backticked(/-\s*client 半边[^\n]*/u, section('九、依赖与约束'))
  const codeInject = /const inject = \[([^\]]*)\]/u.exec(client)
  assert.notEqual(codeInject, null, 'could not find the client inject array in the code')
  const codeList = codeInject[1]
    .split(',')
    .map((s) => s.trim().replace(/^'|'$/gu, ''))
    .filter(Boolean)
  assert.deepEqual(codeList, declared, 'client inject and the spec disagree')
})

test('RED LINE: the plugin does not fork sessions', () => {
  // Spec section 11: session forking is the harness's job. Reaching for it here
  // would re-introduce a capability the spec puts out of scope.
  //
  // Match the bare word, not `sessions.fork`: reaching through `ctx.get(...)`,
  // aliasing, or any other spelling is the same violation, and a narrower
  // pattern silently lets it through. Comments are already stripped, so this is
  // about code only.
  assert.doesNotMatch(host, /\bfork\b/u, 'spec section 11 forbids forking here')
  assert.doesNotMatch(client, /\bfork\b/u, 'spec section 7 lists three buttons, none of them fork')
})

test('RED LINE: emitted message sources are producer-owned, not the retired plugin wrapper', () => {
  // Spec 6.1/6.2. Format v4 admits no `{ kind: 'plugin', plugin }` wrapper: such
  // a message is refused at Session admission ("format v4 message requires a
  // producer-owned source kind") and the user sees a failed turn instead of the
  // operation. The rule is asserted on CODE — the JSDoc that explains it is a
  // comment, and comments are stripped above.
  assert.doesNotMatch(host, /kind: 'plugin'/u, 'the retired catch-all kind must not appear in code')
  assert.match(
    host,
    /const SOURCE_KIND = `plugin:\$\{PLUGIN\}`/u,
    'the producer-owned kind must be declared once, from the package name',
  )
  const declared = [...host.matchAll(/kind: SOURCE_KIND/gu)]
  assert.equal(declared.length, 2, 'both emitted messages (instructions and snapshot) must declare it')
})

test('RED LINE: briefing commits to the log, never to the inbox', () => {
  // Spec 6.2. `followup()` puts the notebook in the inbox, the loop claims it as
  // a user turn, and a session that only wanted the background starts executing
  // the notebook's Todo list.
  assert.match(
    host,
    /session\.append\('user\/message', notebookMessage\(markdown\), \{ surfaceOp: 'append' \}\)/u,
    "spec 6.2 requires session.append(..., { surfaceOp: 'append' })",
  )
  assert.doesNotMatch(
    host,
    /agent\.followup\(notebookMessage/u,
    'spec 6.2 forbids delivering the notebook through the inbox',
  )
})

test('RED LINE: briefing reads the progress back, not just an acknowledgement', () => {
  // Spec 6.2: a briefing that only opens the notebook and says nothing is not a
  // briefing.
  assert.match(host, /return ok\(\s*\[\s*readback\(markdown\)/u, 'spec 6.2 requires a readback')
})

test('RED LINE: the composer never echoes a command result', () => {
  // spec-ui sections 2 and 3. The harness already folds command/run → command/done
  // into a persistent chat row, so a second copy in the composer would be a
  // duplicate on a surface that clears itself. Only an ADMISSION failure — which
  // never entered a handler and therefore has no durable event — belongs here.
  assert.match(
    client,
    /if \(receipt\.admitted !== true\) setFailure\(receipt\.text\)/u,
    'spec-ui 3 requires the admission guard before any composer receipt',
  )
  assert.doesNotMatch(
    client,
    /setTimeout/u,
    'spec-ui 3 keeps the admission receipt until the next action — no timer may clear it',
  )
})

test('RED LINE: each command has a card in the chat frame', () => {
  // spec-ui section 2. The result text belongs to the chat frame, on a row that
  // survives a reload; the generic platform row is the fallback, not the plan.
  assert.match(
    client,
    /COMMAND_VIEW_SLOT = 'conversation\.chat\.commandview'/u,
    'spec-ui 2 names the chat command-row extension point',
  )
  const keys = [...client.matchAll(/register\(\{ name: COMMAND_VIEW_SLOT, key \}/gu)]
  assert.equal(keys.length, 1, 'spec-ui 2 registers the cards through one keyed loop')
  const titles = [...client.matchAll(/label: '([\u4e00-\u9fff]+)'/gu)].map((m) => m[1])
  assert.deepEqual(titles, ['记录进度', '汇报进度'], 'spec-ui 2 requires both labels')
  // Rollback is gone (spec 11), so no label, key or card may survive it.
  assert.equal(client.includes('回滚'), false, 'spec-ui 1: no rollback entry may remain')
  assert.equal(client.includes('progress-rewind'), false, 'nor a command name for one')
})

test('RED LINE: the card body is rendered, not dumped as Markdown source', () => {
  // spec-ui section 2. The result text is Markdown cut out of the notebook;
  // printed verbatim it shows the user '#' and '**' — the source of the report
  // instead of the report. It is handed to the shell's own renderer, which is a
  // platform seed module (the same static table `react` comes from).
  assert.match(
    client,
    /require\('@deepseek-ai\/dsh-client-ui-primitives'\)/u,
    'spec-ui 2 requires the platform Markdown renderer',
  )
  assert.match(client, /MarkdownText/u, 'spec-ui 2 names the renderer it uses')
  assert.match(
    client,
    /MarkdownText === null\s*\n\s*\? react\.createElement\('div', \{ key: 'body', style: cardRawBodyStyle \}/u,
    'spec-ui 2 keeps a verbatim body for the world without the renderer',
  )
  // And reading it must not be able to take the client half down with it: the
  // read runs inside the bundle factory, where a throw costs the buttons.
  assert.match(client, /function readMarkdownText\(\) \{\s*\n\s*try \{/u, 'reading must be defended')
})

test('the split spec describes each concern in exactly one file', () => {
  // The boundary is part of the contract: a UI requirement that drifts back into
  // spec.md (or a system requirement into spec-ui.md) makes the pair ambiguous.
  for (const slot of ['conversation.input.left', 'conversation.chat.commandview']) {
    assert.equal(spec.includes(slot), false, `spec.md must not describe the UI seat ${slot}`)
    assert.equal(uiSpec.includes(slot), true, `spec-ui.md must describe the UI seat ${slot}`)
  }
  assert.equal(uiSpec.includes('.dsh/progress.md'), false, 'spec-ui.md must not describe notebook storage')
  assert.equal(section('七、交互与呈现').includes('spec-ui.md'), true, 'spec.md must point at spec-ui.md')
})

test('every UI requirement the tests pin has its own section in spec-ui.md', () => {
  // Same rule as the red lines above: the file that OWNS the requirement is the
  // one a reader is sent to, so the headings themselves are load-bearing.
  for (const heading of ['一、两个入口', '二、命令结果只出现在聊天框', '三、输入框区域承载什么', '四、呈现措辞', '五、客户端依赖与降级']) {
    assert.ok(uiSection(heading).trim().length > 0, `spec-ui.md is missing the section "${heading}"`)
  }
})

// ---------------------------------------------------------------------------
// The notebook contract (spec section 5).
//
// The notebook drifted from a secretary's notebook into a technical archive of
// this plugin: platform experiments, implementation detail, methodology and a
// half-length retrospective, all injected on every brief. The cause was
// structural — section TITLES with no admission criteria leave every section an
// open container, and for the agent writing it "记下来总没错". These tests pin
// the cure, on both producers (the spec, and the instruction the agent reads),
// so that removing the criteria fails here instead of showing up months later as
// a 20 KB notebook.
// ---------------------------------------------------------------------------

/** The notebook's criteria table, as `{ section: [放什么, 不放什么, 上限] }`. */
function criteriaTable(document) {
  const rows = {}
  for (const m of document.matchAll(
    /^\|\s*(进行中|待办|生效约束|已验证事实|产出物索引|叙事)\s*\|([^\n]*)$/gmu,
  )) {
    const cells = m[2]
      .split('|')
      .map((cell) => cell.trim())
      .filter((cell) => cell.length > 0)
    assert.equal(cells.length, 3, `criteria row for "${m[1]}" must be 放什么 / 不放什么 / 上限`)
    rows[m[1]] = cells
  }
  return rows
}

/** Spec section 5, sliced by heading: its body contains `##` inside a code fence. */
const notebookSection = spec.slice(spec.indexOf('## 五、笔记本结构'), spec.indexOf('## 六、操作'))

const expectedCaps = {
  进行中: '3 条',
  待办: '一行一条',
  生效约束: '8 条',
  已验证事实: '10 条',
  产出物索引: '只放指针',
  叙事: '5 行',
}

test('both producers cap every notebook section, and they agree on the caps', () => {
  const fromSpec = criteriaTable(notebookSection)
  const fromInstruction = criteriaTable(noteInstruction(NOTEBOOK_DEFAULT))
  for (const name of SECTION_ORDER) {
    assert.ok(fromSpec[name], `spec section 5 has no criteria row for "${name}"`)
    assert.ok(fromInstruction[name], `noteInstruction has no criteria row for "${name}"`)
    assert.deepEqual(
      fromInstruction[name],
      fromSpec[name],
      `the instruction and the spec disagree about "${name}"`,
    )
    assert.equal(fromSpec[name][2], expectedCaps[name], `the cap on "${name}" changed`)
  }
})

test('RED LINE: the template names its reader and carries an admission test', () => {
  // Spec section 5. Without a reader, the notebook's implicit audience becomes
  // "the next agent to work on this plugin", and every implementation detail
  // qualifies. Without an admission test, every section is an open container.
  for (const [label, document] of [
    ['spec.md', notebookSection],
    ['noteInstruction', noteInstruction(NOTEBOOK_DEFAULT)],
  ]) {
    assert.match(document, /读者/u, `${label} must name the notebook's reader`)
    assert.match(document, /回到这个工作区/u, `${label} must say who the reader is`)
    assert.match(document, /准入判据/u, `${label} must state an admission test`)
    assert.match(document, /重新捡起工作的那一刻/u, `${label} must state the question to ask`)
  }
  // The reader is explicitly NOT the plugin's next developer: that is the whole
  // reason the archive moved out.
  assert.match(notebookSection, /不是.{0,12}接手开发/u, 'spec must rule out the developer reader')
  assert.match(
    noteInstruction(NOTEBOOK_DEFAULT),
    /不是「接手开发/u,
    'the instruction must rule out the developer reader',
  )
})

test('RED LINE: what the notebook pushes out has a named home', () => {
  // Displaced material must not simply be dropped: the reader of section 5 is
  // sent to the file that owns each kind of information.
  for (const home of ['CHANGELOG.md', 'NOTES.md', 'spec']) {
    assert.ok(notebookSection.includes(home), `spec section 5 must point at ${home}`)
  }
  const instruction = noteInstruction(NOTEBOOK_DEFAULT)
  for (const home of ['CHANGELOG', 'NOTES.md']) {
    assert.ok(instruction.includes(home), `the instruction must point at ${home}`)
  }
})

test('the template no longer invites the open containers that caused the drift', () => {
  // The pre-0.5 template literally asked for "已做的决定、边界" and "踩过的坑".
  // Those two phrases ARE the defect: they name a container, not a criterion.
  const instruction = noteInstruction(NOTEBOOK_DEFAULT)
  assert.doesNotMatch(instruction, /已做的决定/u, 'design decisions belong in the spec/CHANGELOG')
  assert.doesNotMatch(instruction, /踩过的坑/u, 'process notes belong in NOTES.md/CHANGELOG')
  // And the cap is a writing constraint, not a validation the parser performs:
  // the notebook is written by the agent, the plugin only ever reads it.
  assert.match(notebookSection, /上限是\*\*写作约束\*\*，不是运行时校验/u)
})

test('RED LINE: NOTES.md is never injected into a session', () => {
  // The archive exists so that the notebook can stay small. If either half ever
  // read it, the displacement would buy nothing: NOTES.md would grow into the
  // same context cost the notebook had.
  assert.equal(host.includes('NOTES.md'), false, 'the host half must not read NOTES.md')
  assert.equal(client.includes('NOTES.md'), false, 'the client half must not read NOTES.md')
  const notes = readFileSync(fileURLToPath(new URL('../NOTES.md', import.meta.url)), 'utf8')
  assert.match(notes, /不进笔记本/u, 'NOTES.md must declare that it is not injected')
})

// ---------------------------------------------------------------------------
// The checkpoint list offers CHOICES (spec-ui section 4, spec 6.3 / section 9).
//
// One turn of work produced forty-odd automatic checkpoints, a dozen of them
// reading identically, and every one was the plugin's own safety net rather than
// a moment the user chose. The list is narrowed to manual records — and because
// the bottom plugin dedupes on CONTENT ALONE, the narrowing is only meaningful
// alongside the deployment requirement that the automatic writers be off: while
// they run, a manual record is always captured first by the automatic net and
// then deduped away, so the narrowed list would be empty for ever.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The rollback deletion (spec 11, spec-ui 1).
//
// Removing a feature is not removing a button: a plugin that "no longer offers
// rollback" while still naming a checkpoint command, reading a checkpoint
// Remote or carrying a config key for one has not removed the dependency — it
// has only hidden it. These assertions are what make the absence structural.
// ---------------------------------------------------------------------------

test('RED LINE: the plugin knows of no checkpoint plugin', () => {
  // Neither half may name one: no command, no Remote namespace, no config key.
  for (const [label, source] of [['host', host], ['client', client]]) {
    assert.equal(source.includes('checkpointPanel'), false, `${label} must not read a checkpoint Remote`)
    for (const forbidden of ['/checkpoint', 'checkpointCommand', 'restoreCommand', 'rewindCommand', 'dsh-checkpoint-rewind']) {
      assert.equal(source.includes(forbidden), false, `${label} must not reference "${forbidden}"`)
    }
  }
  // `rewind` itself must not appear in code at all. (Prose in comments is already
  // stripped, so a mention here would be a real one.)
  assert.equal(/\brewind\b/u.test(host + client), false, 'no code path may reach for a rewind')
  // And the two specs must own that boundary explicitly.
  assert.match(section('九、依赖与约束'), /不依赖任何其他插件/u, 'spec 9 must state the absence')
  assert.match(section('十一、范围边界'), /不实现、不包装、不为其提供入口/u, 'spec 11 must state the scope')
  assert.match(uiSection('一、两个入口'), /没有第三个入口/u, 'spec-ui 1 must forbid a leftover entry')

  // The same boundary constrains the shipped, user-facing document (spec 11).
  // README is the one place a reader is told where rollback lives, which makes it
  // the easiest place to re-import the dependency as a POINTER rather than as
  // code: "use its `/rewind`" costs no import yet still tells the reader this
  // plugin knows that command, and describing another plugin's `copy provider`
  // default tells them it knows that plugin's config too. Prose, so nothing to
  // strip here — the wording itself is the subject.
  const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
  for (const forbidden of ['/checkpoint', '/rewind', 'checkpointPanel', 'dsh-checkpoint-rewind', 'copy provider']) {
    assert.equal(readme.includes(forbidden), false, `README must not name "${forbidden}"`)
  }
  assert.equal(/\brewind\b/u.test(readme), false, 'README must not name a rewind')
  // And the boundary itself must survive: the assertions above are satisfied by
  // deleting the boundary paragraph, which would be the deletion winning, not the
  // wording tightening. So the generic statement is required to stay.
  assert.match(readme, /不是本插件/u, 'README must still say what is not this plugin')
  assert.match(readme, /检查点插件/u, 'README must still point at a checkpoint plugin, generically')
})

test('the config surface shrank with the feature', () => {
  // A key left behind is a dependency left behind: `checkpointOnNote` would still
  // imply this plugin takes checkpoints, and `rewindCommand` would still imply it
  // has a rollback entry.
  const keys = Object.keys(Config({}))
  assert.deepEqual(keys.sort(), ['briefCommand', 'noteCommand', 'notebook'])
})

test('the shipped bundle patch advertises exactly the spec config keys', () => {
  // The test above pins the SCHEMA. This one pins the published DOCUMENT: the
  // commented `config` block of `cordis.patch.yml` ships in the package
  // (`package.json` `files`) and is the config surface a deployer reads and
  // uncomments — so a key left there advertises a capability just as loudly as a
  // schema key does. 0.7.0 dropped the rollback keys from `Config` and left four
  // of them in this block, which is the shape of an unfinished deletion.
  //
  // The red-line test reads the two source halves with comments STRIPPED, so this
  // file is outside its reach: here the comments ARE the content, and the block is
  // parsed raw. The key set is compared against the spec table rather than a
  // literal list, so spec, schema and published document cannot drift apart.
  const block = /^[ \t]*#[ \t]*config:[ \t]*\n((?:[ \t]*#[ \t]*[A-Za-z][A-Za-z0-9]*:.*\n)+)/mu.exec(patchSource)
  assert.notEqual(block, null, 'cordis.patch.yml must keep its commented config block')

  const documented = [...block[1].matchAll(/^[ \t]*#[ \t]*([A-Za-z][A-Za-z0-9]*):/gmu)].map((m) => m[1])
  assert.deepEqual(
    documented.sort(),
    specConfigRows().map((r) => r.key).sort(),
    'the shipped patch documents config keys the spec does not declare',
  )
})
