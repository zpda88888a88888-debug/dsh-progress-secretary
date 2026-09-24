import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EMPTY,
  NARRATIVE_SECTION,
  NOTEBOOK_DEFAULT,
  SECTION_ORDER,
  STATE_SECTIONS,
  noteInstruction,
  parseSections,
  readback,
} from '../lib/notebook.js'

test('the notebook path stays inside the workspace .dsh directory', () => {
  assert.equal(NOTEBOOK_DEFAULT, '.dsh/progress.md')
  assert.equal(NOTEBOOK_DEFAULT.startsWith('/'), false)
  assert.equal(NOTEBOOK_DEFAULT.includes('..'), false)
})

test('the section vocabulary is the fixed six-section skeleton', () => {
  assert.deepEqual(SECTION_ORDER, ['进行中', '待办', '生效约束', '已验证事实', '产出物索引', '叙事'])
  assert.deepEqual([...STATE_SECTIONS, NARRATIVE_SECTION], SECTION_ORDER)
  // The first five are the state snapshot; the sixth is narrative prose.
  assert.equal(STATE_SECTIONS.length, 5)
  assert.equal(SECTION_ORDER.includes(NARRATIVE_SECTION), true)
})

test('noteInstruction states the contract the parser expects', () => {
  const text = noteInstruction(NOTEBOOK_DEFAULT)
  assert.match(text, /记录进度/u)
  assert.match(text, /重写/u)
  assert.match(text, /而不是追加/u)
  for (const name of SECTION_ORDER) assert.match(text, new RegExp(`## ${name}`, 'u'))
  assert.match(text, /产出物索引[\s\S]*只放路径/u)
  assert.match(text, /不设「已完成」/u)
  // The empty-section placeholder in the instruction must be the parser's.
  assert.match(text, new RegExp(EMPTY, 'u'))
  // The instruction names the target file it was given.
  assert.match(text, new RegExp(NOTEBOOK_DEFAULT.replace(/[.]/gu, '\\.'), 'u'))
})

test('noteInstruction embeds the skeleton, so the agent has the only producer copy', () => {
  const text = noteInstruction('.dsh/progress.md')
  // Every section heading appears exactly as parseSections will find it, so a
  // rewrite that follows the instruction parses back into all six sections.
  const instructionAsNotebook = text.slice(text.indexOf('# 工作进度'))
  const parsed = parseSections(instructionAsNotebook)
  for (const name of SECTION_ORDER) {
    assert.ok(name in parsed, `instruction skeleton is missing "${name}"`)
  }
})

test('parseSections is tolerant of off-template input', () => {
  // Missing sections, extra sections, CRLF, and content before the first heading.
  const input = 'preamble\r\n\r\n## 进行中\r\n- a\r\n\r\n## 自定义\r\n- x\r\n'
  const parsed = parseSections(input)
  assert.equal(parsed['进行中'], '- a')
  assert.equal(parsed['自定义'], '- x')
  assert.equal(parsed['待办'], undefined)
})

test('parseSections ignores everything before the first heading', () => {
  const parsed = parseSections('# 工作进度\n\n开场白\n\n## 叙事\n正文\n')
  assert.deepEqual(Object.keys(parsed), ['叙事'])
  assert.equal(parsed['叙事'], '正文')
})

test('parseSections returns nothing for empty or non-string input', () => {
  assert.deepEqual(parseSections(''), {})
  assert.deepEqual(parseSections(undefined), {})
  assert.deepEqual(parseSections(null), {})
})

test('parseSections keeps a section body verbatim, including blank lines', () => {
  const parsed = parseSections('## 叙事\n第一段\n\n第二段\n')
  assert.equal(parsed['叙事'], '第一段\n\n第二段')
})

test('readback carries the two sections that answer "where are we"', () => {
  const markdown =
    '# 工作进度\n\n## 进行中\n- 甲\n\n## 待办\n- 乙\n\n## 生效约束\n- 丙\n\n## 叙事\n丁\n'
  const out = readback(markdown)
  // Bold labels, not `##`: the block is a chat row's body, and a heading there
  // would out-shout the row's own title.
  assert.match(out, /\*\*进行中\*\*[\s\S]*- 甲/u)
  assert.match(out, /\*\*待办\*\*[\s\S]*- 乙/u)
  assert.doesNotMatch(out, /^#/mu, 'the readback must not carry document headings')
  // The other sections stay in the injected context; the readback is not the notebook.
  assert.doesNotMatch(out, /丙/u)
  assert.doesNotMatch(out, /丁/u)
})

test('readback fills an empty section with the placeholder', () => {
  const out = readback('## 进行中\n- 甲\n\n## 待办\n')
  assert.match(out, /\*\*进行中\*\*[\s\S]*- 甲/u)
  assert.match(out, new RegExp(`\\*\\*待办\\*\\*\\s*\\n${EMPTY}`, 'u'))
})
