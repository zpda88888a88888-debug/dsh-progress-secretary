/**
 * Pure notebook helpers for 工作进度小秘书.
 *
 * No Cordis, no I/O, no services: everything here is a plain function over
 * strings, so it can be unit-tested and reasoned about in isolation.
 *
 * The module is deliberately one-directional. The **agent** writes the notebook
 * from the instruction in `noteInstruction`; the plugin only ever READS it back
 * (to build the `brief` snapshot). There is therefore no render/write half here:
 * a renderer would have no caller, and keeping one would invite the plugin to
 * start owning notebook writes it does not own.
 *
 * There is no summary helper either. One lived here to caption checkpoints; with
 * snapshots out of scope (see `spec.md` section 11) nothing would call it, and an
 * unreachable function is a claim that cannot be tested.
 *
 * @module dsh-progress-secretary/notebook
 */

/** Default workspace-relative notebook path. */
export const NOTEBOOK_DEFAULT = '.dsh/progress.md'

/** Sections that make up the machine-readable part of the notebook, in order. */
export const STATE_SECTIONS = ['进行中', '待办', '生效约束', '已验证事实', '产出物索引']

/** The one narrative section: read by humans and injected on brief. */
export const NARRATIVE_SECTION = '叙事'

/** Every section of the fixed skeleton, in order. */
export const SECTION_ORDER = [...STATE_SECTIONS, NARRATIVE_SECTION]

/** Empty-section placeholder. A stable skeleton keeps the six sections addressable. */
export const EMPTY = '（无）'

/**
 * The agent-facing instruction for `/note`. It states the contract exactly as
 * the parser will read it back, so the rewrite and the parse cannot drift apart.
 *
 * The skeleton lives here as literal text rather than being generated, because
 * the instruction is the ONLY place the notebook's shape is defined now — there
 * is no second producer to keep in sync with.
 *
 * The instruction carries an ADMISSION TEST and per-section limits, not just
 * section titles. Titles alone left every section an open container, and "记下来
 * 总没错" filled them with platform experiments, implementation detail and
 * methodology — the notebook became a technical archive of the plugin instead of
 * a secretary's notebook about the work. The failure was structural, so the cure
 * is here: what each section must NOT accept, and where the displaced material
 * goes instead.
 */
export function noteInstruction(notebookRel) {
  return [
    '【工作进度小秘书 · 记录进度】请重写工作进度笔记本，而不是追加。',
    '',
    `目标文件：${notebookRel}`,
    '',
    '**读者**：回到这个工作区、要接着干活的人（以及替他读这份笔记的 agent）。',
    '不是「接手开发这个插件的下一个 agent」—— 平台机制、实现细节、实验过程、方法论、设计理由都不属于这份笔记。读者不同，要的东西重叠度很低。',
    '',
    '**准入判据**（每条信息都过一遍，过不了就不写）：',
    '「这条信息，在我重新捡起工作的那一刻，需要被知道吗？」',
    '已经写在 CHANGELOG / spec / 测试 / NOTES.md 里的，不要写进笔记本 —— 那些地方就是它的归宿。',
    '每节都有上限；写完回头删一遍。超限不是格式错误，是没删干净。',
    '',
    '请先读这段时间的对话与工作，然后用下面这个固定骨架**整体重写**它：',
    '',
    '| 小节 | 放什么 | 不放什么 | 上限 |',
    '|---|---|---|---|',
    '| 进行中 | 现在到哪一步了 | 背景；「本轮做了 A、B、C」的流水账；待办的重复 | 3 条 |',
    '| 待办 | 要做什么 + 卡在哪个决策上 | 方案小作文：候选方案、参照数据放它们自己的文件，这里只留「要定什么」 | 一行一条 |',
    '| 生效约束 | 违反了会出事的边界 | 设计决策、实现细节、方法论、理由 —— 判据是「违反会不会出事」，不是「重不重要」 | 8 条 |',
    '| 已验证事实 | 「别再试」「别再问」的确认结论 | 过程。「我跑了个实验…」属于 `NOTES.md` 或 `CHANGELOG.md` | 10 条 |',
    '| 产出物索引 | 路径、标识 | 内容、说明 | 只放指针 |',
    '| 叙事 | 这一阶段的主线是什么、结论是什么 | 技术复盘：失败路径、根因分析、机制说明留在 `CHANGELOG.md` | 5 行 |',
    '',
    '```markdown',
    '# 工作进度',
    '',
    '## 进行中',
    '- <现在到哪一步了>',
    '',
    '## 待办',
    '- <要做什么 + 卡在哪个决策上>',
    '',
    '## 生效约束',
    '- <违反了会出事的边界>',
    '',
    '## 已验证事实',
    '- <「别再试」「别再问」的确认结论>',
    '',
    '## 产出物索引',
    '- <交付件路径或标识>',
    '',
    '## 叙事',
    '<主线与结论，不超过 5 行>',
    '```',
    '',
    '规则：',
    `- 前五节是状态快照，每节都写全量；某一节为空时写「${EMPTY}」，不要省略小节标题。`,
    '- 同一件事只写在一节里。一个事实在三节重复出现，说明它还没找到唯一归属。',
    '- 「产出物索引」只放路径/标识，不要抄内容。',
    '- 不设「已完成」小节：已完成的东西从待办消失、在产出物索引留一条即可。',
    '- 条目不带日期，不追求时间线，不支撑周报。',
    '- 只写当前活着的东西，不写历史。',
    '',
    '写完这个文件即可，不要做别的改动。完成后我会自动打一个检查点。',
  ].join('\n')
}

/**
 * Split a notebook into `{ sectionName: bodyText }`.
 *
 * Tolerant by design: a notebook hand-edited by a human or rewritten slightly
 * off-template must still yield whatever sections it does contain rather than
 * throwing. Only `## <name>` headings split; content before the first heading
 * is ignored.
 *
 * @param {string} markdown
 * @returns {Record<string, string>}
 */
export function parseSections(markdown) {
  const out = {}
  if (typeof markdown !== 'string' || markdown.length === 0) return out
  let current = null
  let buffer = []
  const flush = () => {
    if (current !== null) out[current] = buffer.join('\n').trim()
    buffer = []
  }
  for (const line of markdown.split(/\r?\n/u)) {
    const heading = /^##\s+(.+?)\s*$/u.exec(line)
    if (heading !== null) {
      flush()
      current = heading[1]
      continue
    }
    if (current !== null) buffer.push(line)
  }
  flush()
  return out
}

/** The first real bullet of a section body, without its list marker. */
function firstBullet(body) {
  if (typeof body !== 'string') return undefined
  for (const line of body.split(/\r?\n/u)) {
    // Strip the marker BEFORE testing against EMPTY: a raw line is "- （无）",
    // which is never equal to "（无）", so comparing first would hand the
    // placeholder back as if it were content.
    const text = line.trim().replace(/^[-*]\s+/u, '').trim()
    if (text.length === 0 || text === EMPTY) continue
    return text
  }
  return undefined
}

/**
 * The 进行中 and 待办 sections as a short block for `/brief`'s readback.
 *
 * A briefing that only opens the notebook and says nothing is not a briefing.
 * These two sections are the answer to "where are we"; the rest stays in the
 * injected context for the agent.
 *
 * The labels are **bold**, not `##` headings: this block is rendered as the body
 * of a command row inside a transcript, and a document heading there would shout
 * louder than the row's own title.
 *
 * @param {string} markdown
 * @returns {string}
 */
export function readback(markdown) {
  const sections = parseSections(markdown)
  const lines = []
  for (const name of ['进行中', '待办']) {
    const body = typeof sections[name] === 'string' ? sections[name].trim() : ''
    lines.push(`**${name}**`, body.length > 0 ? body : EMPTY, '')
  }
  return lines.join('\n').trim()
}
