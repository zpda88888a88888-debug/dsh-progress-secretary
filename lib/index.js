/**
 * 工作进度小秘书 — the notebook half of a workspace secretary.
 *
 * This plugin owns exactly one thing: the progress notebook
 * (`.dsh/progress.md`) and the two human operations over it — record progress
 * and brief progress.
 *
 * It owns no snapshot mechanism and no rollback. Those are not delegated any
 * more, they are simply out of scope: whoever wants file snapshots installs a
 * checkpoint plugin of their choosing, and that plugin's own `/rewind` is the
 * entry point. Wrapping it here would rebuild an entry, a degradation path and a
 * set of wordings for a capability this plugin does not own — which is what
 * "don't rebuild the wheel" is supposed to prevent.
 *
 * Consequently this plugin depends on NO other plugin: it never executes another
 * plugin's command, and it carries no config key, no Remote namespace and no
 * fallback that would imply one exists.
 *
 * Session forking is likewise not this plugin's job — the harness ships it. See
 * the spec's scope section.
 *
 * @module dsh-progress-secretary
 */

import Schema from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

import {
  NOTEBOOK_DEFAULT,
  SECTION_ORDER,
  noteInstruction,
  parseSections,
  readback,
} from './notebook.js'

const PLUGIN = 'dsh-progress-secretary'

export const name = 'progress-secretary'

/**
 * `commands` is a genuine hard dependency: without the command registry there is
 * no surface at all. `fs` is required to read the notebook back for `/brief` —
 * the AGENT writes it, this plugin only ever reads. `sessions` is read
 * optionally, because it degrades to a named error instead of blocking mount.
 */
export const inject = ['commands', 'fs']

export const Config = Schema.object({
  /** Workspace-relative notebook path. */
  notebook: Schema.string().default(NOTEBOOK_DEFAULT),
  /** Command names; overridable so a deployment can dodge a name collision. */
  noteCommand: Schema.string().default('note'),
  briefCommand: Schema.string().default('brief'),
})

/** Render a successful direct result. */
const ok = (text) => ({ kind: 'success', text })
/** Render a failed direct result. */
const fail = (text) => ({ kind: 'error', text })

/** Resolve the workspace root for one agent from its live session header. */
function cwdOf(ctx, agent) {
  const sessions = ctx.get('sessions')
  if (sessions === undefined) return undefined
  return sessions.get(agent.id)?.header?.cwd
}

/** Read a workspace-relative text file, or `undefined` when it does not exist. */
async function readIfExists(ctx, cwd, rel) {
  let target
  try {
    target = await ctx.fs.resolve(rel, { cwd })
  } catch {
    return undefined
  }
  const info = await ctx.fs.stat(target).catch(() => undefined)
  if (info === undefined) return undefined
  return ctx.fs.readText(target)
}

/** Build the rewrite-instruction message for `/note`. */
function instructionMessage(text) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN, form: 'instructions' },
  })
}

/**
 * The notebook as a context message for `/brief`, declared as a `snapshot`.
 *
 * `ContextFormed` distinguishes the two forms this could take, and they render
 * very differently:
 *
 *   - `notice` carries a one-line `summary` and is "shown without expanding the
 *     row" — right for "what just happened", wrong for a whole notebook.
 *   - `snapshot` carries `sections`, and the renderer shows THOSE as the body
 *     (`content` is not re-printed beside them): one captioned block per
 *     section. The declared sections are "the same bytes the model read, split
 *     at the boundaries the producer assembled them on".
 *
 * A notebook is named state, so `snapshot` is the honest form. Sections that
 * fail the reader's validation (missing, empty, or a non-string field) silently
 * degrade the whole row to an opaque block, so the shape below matters.
 *
 * @param {string} markdown the notebook, verbatim, as the model should read it
 */
function notebookMessage(markdown) {
  const parsed = parseSections(markdown)
  const sections = SECTION_ORDER.filter(
    (name) => typeof parsed[name] === 'string' && parsed[name].trim().length > 0,
  ).map((name) => ({ name, text: parsed[name] }))

  return createUserMessage({
    // The model-facing text stays the whole notebook, framing line included;
    // only the presentation is sectioned.
    content: [
      {
        type: 'text',
        text: `# 工作进度笔记本（工作进度小秘书 注入）\n\n${markdown}`,
      },
    ],
    source: {
      kind: 'plugin',
      plugin: PLUGIN,
      form: 'snapshot',
      // A hand-edited notebook may parse into nothing; one opaque section is
      // still a valid snapshot, whereas an empty list is not.
      sections: sections.length > 0 ? sections : [{ name: '工作进度', text: markdown }],
    },
  })
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = { ...Config({}), ...(rawConfig ?? {}) }

  // ── 记录进度 · /note ───────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.commands.register({
      name: config.noteCommand,
      description: '请 agent 重写工作进度笔记本',
      // Deliberately no `input`: this command takes no argument, and the real
      // registry rejects an empty hint (`input hint must not be empty`), which
      // makes the whole plugin tree fail to load at profile start.
      handler: (invocation) => {
        const cwd = cwdOf(ctx, invocation.agent)
        if (cwd === undefined) {
          return fail('无法确定当前工作区目录（会话尚未落在某个 workspace 上）。')
        }
        invocation.agent.followup(instructionMessage(noteInstruction(config.notebook)))
        // A one-shot receipt, and nothing more. This command takes no snapshot and
        // schedules no follow-up work, so there is no later state for this line to
        // become true or false in — promising one would invent a lifecycle.
        return ok(`已请 agent 重写笔记本（${config.notebook}）；本轮结束时文件即为最新。`)
      },
    }),
  )

  // ── 汇报进度 · /brief ─────────────────────────────────────────────────────
  ctx.effect(() =>
    ctx.commands.register({
      name: config.briefCommand,
      description: '把工作进度笔记本整本注入当前会话作为背景',
      handler: async (invocation) => {
        const cwd = cwdOf(ctx, invocation.agent)
        if (cwd === undefined) return fail('无法确定当前工作区目录。')
        const markdown = await readIfExists(ctx, cwd, config.notebook)
        if (markdown === undefined) {
          return fail(`笔记本不存在：${config.notebook}。先运行 /${config.noteCommand} 生成它。`)
        }

        const sessions = ctx.get('sessions')
        const session = sessions?.get(invocation.agent.id)
        if (session === undefined) return fail('当前会话不在 store 中，无法注入上下文。')

        // Append to the LOG, not the inbox.
        //
        // `agent.followup()` would put this in the inbox, where the loop claims
        // it as a user turn — so a session that just wanted the background read
        // the notebook's Todo list as a work order and started executing it.
        // A direct `surfaceOp: 'append'` enters the model's derived history as
        // context and claims no turn, which is what "background" means.
        //
        // This mirrors how the harness itself injects the runtime-context
        // snapshot: `dsh-agent-loop` builds exactly this message shape (a
        // plugin-authored `createUserMessage` with `form: 'snapshot'` and its
        // sections) and commits it through this same append path.
        session.append('user/message', notebookMessage(markdown), { surfaceOp: 'append' })

        // A briefing that only opens the notebook and says nothing is not a
        // briefing. Read back the two sections that answer "where are we"; the
        // rest stays in the injected context for the agent.
        return ok(
          [
            readback(markdown),
            '',
            `（笔记本全文已作为背景注入，${markdown.length} 字符，不会触发执行。）`,
          ].join('\n'),
        )
      },
    }),
  )
}
