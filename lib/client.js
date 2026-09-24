/**
 * 工作进度小秘书 — browser half.
 *
 * This file is the *built* client bundle. `@deepseek-ai/dsh-client-modules`
 * serves `lib/client.js` verbatim to the browser, so the bundle must register
 * itself through the shell's `window.__ModuleLoader__` and resolve React from
 * the platform module table:
 *
 *     dsh.client = { platform: 'web', inject: [...] }   // in package.json
 *
 * It contributes exactly two surfaces, and they never show the same thing:
 *
 *   `conversation.input.left`       the two buttons. It carries an ADMISSION
 *                                   failure and nothing else — a command the host
 *                                   never admitted produced no durable event, so
 *                                   the composer is the only place it can be seen.
 *   `conversation.chat.commandview` one readable card per command, rendering the
 *                                   handler's DURABLE result in the chat frame.
 *
 * Command results belong to the chat frame. The harness already folds
 * `command/run`/`command/done` into a persistent command row, so echoing the
 * same text into the composer would put one fact on two surfaces with two
 * wordings and two lifetimes — and the composer copy is the one that vanishes.
 *
 * The buttons call the *same* slash commands the host half registers via
 * `ctx.remote.commands.execute`, so there is exactly one implementation of each
 * operation. The buttons are a surface, never a second code path.
 *
 * There is no rollback surface here, and no checkpoint list. Workflow snapshots
 * are not this plugin's business (see `spec.md` section 11), so this half reads
 * no checkpoint Remote, declares no namespace for one, and degrades for none:
 * removing the feature means removing its entry, its data source and its
 * fallback, not just its button.
 *
 * Command names are ASCII because the command registry enforces
 * `/^[a-z][a-z0-9_-]*$/`; the Chinese labels live here, and in the host half's
 * descriptions.
 */
window.__ModuleLoader__.load({
  id: 'dsh-progress-secretary',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    /** Services this client half cannot work without. */
    const inject = ['slots', 'remote', 'remote.commands']

    /** The composer seat: compact controls at the left of the tool row. */
    const COMPOSER_SLOT = 'conversation.input.left'

    /**
     * The chat frame's per-command renderer, keyed by the command name the chat
     * half dispatches (`entryKey: command.name`).
     *
     * Reached through a LAZY slot inject, never through `inject`: the slot is
     * declared by the chat half, and requiring it as a hard dependency would
     * leave this whole client half waiting — the two buttons would never
     * appear — on any target that renders no chat rows. Registering nothing
     * degrades to the platform's own generic command row, which carries the
     * same result text.
     */
    const COMMAND_VIEW_SLOT = 'conversation.chat.commandview'

    /**
     * The platform's Markdown renderer, read from the platform module table.
     *
     * `@deepseek-ai/dsh-client-ui-primitives` is a SEED module: the shell puts it
     * in the same static table as `react` (see `dsh-client-web`'s platform module
     * list), which is why a client bundle may require it without declaring it in
     * `dsh.client`.
     *
     * Read defensively all the same. The renderer decides FORMATTING only: a
     * result text cut out of a Markdown notebook, printed verbatim, shows the
     * user `#`, `**` and `- ` — the source instead of the report. Its absence
     * downgrades the body to the verbatim block below and must never be able to
     * take the buttons down with it.
     */
    function readMarkdownText() {
      try {
        const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
        if (primitives === null || primitives === undefined) return null
        const renderer = primitives.MarkdownText
        return renderer === undefined || renderer === null ? null : renderer
      } catch {
        return null
      }
    }

    /** `null` when the platform renderer is unavailable — see {@link readMarkdownText}. */
    const MarkdownText = readMarkdownText()

    /**
     * Command lines this surface drives, keyed by button id. Kept in one table
     * so the buttons, the chat cards and the host command names cannot drift
     * apart without a visible edit here.
     *
     * These are the client half's copy of the host config's command names; the
     * host config is configurable and this table is not, so a rename must be
     * made in both. A mismatch surfaces as an admission failure (visible in the
     * composer), never as a silent no-op.
     */
    const COMMANDS = {
      note: 'note',
      brief: 'brief',
    }

    const BUTTONS = [
      { id: 'note', label: '记录进度', hint: '请 agent 重写工作进度笔记本' },
      { id: 'brief', label: '汇报进度', hint: '把笔记本作为背景注入，并在对话里回读进度' },
    ]

    /** Minimal, theme-neutral button styling: inherits colour, no token guesses. */
    const buttonStyle = (active) => ({
      font: 'inherit',
      fontSize: '12px',
      lineHeight: '20px',
      padding: '1px 8px',
      borderRadius: '999px',
      border: '1px solid currentColor',
      background: active ? 'color-mix(in srgb, currentColor 12%, transparent)' : 'transparent',
      color: 'inherit',
      opacity: active ? 1 : 0.72,
      cursor: 'pointer',
      whiteSpace: 'nowrap',
    })

    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      flexWrap: 'wrap',
    }

    /**
     * The composer's failure receipt. Nothing else is shown here: an admitted
     * command's outcome renders in the chat frame, on the row the harness
     * already created for it.
     */
    const failureStyle = {
      fontSize: '12px',
      lineHeight: '18px',
      maxWidth: '420px',
      whiteSpace: 'pre-wrap',
    }

    /** Chat-card chrome: a labelled block of the command's own result text. */
    const cardStyle = {
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      maxWidth: '720px',
    }

    const cardHeadStyle = {
      fontSize: '12px',
      lineHeight: '18px',
      opacity: 0.7,
    }

    /**
     * Formatted body. The card title above it is small, so the digest's own
     * typography sits at transcript size and the shell's Markdown renderer owns
     * everything inside; no frame — framed prose reads like a terminal, and this
     * is a report.
     */
    const cardBodyStyle = {
      maxWidth: '720px',
      fontSize: '14px',
      lineHeight: '22px',
      overflowWrap: 'anywhere',
    }

    /**
     * Verbatim body, used only when the platform renderer is unavailable. The
     * frame stays here so a downgraded card still reads as command output — and
     * the content is never lost, only unformatted.
     */
    const cardRawBodyStyle = {
      font: 'inherit',
      fontSize: '13px',
      lineHeight: '20px',
      margin: 0,
      padding: '8px 12px',
      borderRadius: '10px',
      border: '1px solid color-mix(in srgb, currentColor 22%, transparent)',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'anywhere',
    }

    /**
     * One command's row in the chat frame.
     *
     * The body is the handler's own result text — the same bytes the durable
     * `command/done` carries — laid out with its line breaks intact and nothing
     * folded away. Nothing is parsed out of it and nothing local is mixed in, so
     * the row keeps saying the same thing after a reload, which is precisely what
     * a composer receipt could not do.
     *
     * The result text is Markdown — it is cut out of the notebook — so the body
     * is handed to the shell's own renderer, the one assistant prose goes through.
     * Printing it verbatim showed the user `#`, `**` and `- `: the source of the
     * report instead of the report.
     *
     * @param {string} label the command's Chinese label, used as the row title
     * @returns {(props: {node?: {outcome?: {kind: string, text?: string} | null}}) => unknown}
     */
    function commandCardView(label) {
      return function ProgressSecretaryCommandCard(props) {
        const node = props?.node ?? {}
        const outcome = node.outcome ?? null
        const failed = outcome !== null && outcome.kind === 'error'
        const text = typeof outcome?.text === 'string' ? outcome.text : ''
        const head = outcome === null ? `${label} · 进行中…` : failed ? `${label} · ⚠ 失败` : label

        const children = [react.createElement('div', { key: 'head', style: cardHeadStyle }, head)]
        if (text.length > 0) {
          children.push(
            MarkdownText === null
              ? react.createElement('div', { key: 'body', style: cardRawBodyStyle }, text)
              : react.createElement(
                  'div',
                  { key: 'body', style: cardBodyStyle },
                  react.createElement(MarkdownText, { text }),
                ),
          )
        }
        return react.createElement('div', { style: cardStyle }, children)
      }
    }

    /**
     * The composer-row control group: two buttons and, when one is refused, the
     * receipt for it.
     *
     * @param {object} props
     * @param {string} props.sessionId injected by the slot registration
     * @param {(line: string) => Promise<{admitted: boolean, text: string}>} props.runCommand
     */
    function ProgressSecretaryBar(props) {
      const { runCommand } = props
      const [busy, setBusy] = react.useState(false)
      const [failure, setFailure] = react.useState(null)
      const aliveRef = react.useRef(true)

      react.useEffect(
        () => () => {
          aliveRef.current = false
        },
        [],
      )

      /**
       * Run one command line.
       *
       * The composer reports ONLY what the chat frame cannot: a command the host
       * never admitted. An admitted command's outcome — success or failure — is
       * already durable in the chat (the harness logs the lifecycle and this
       * plugin's card renders it), so it is deliberately not echoed here.
       */
      const submit = async (line) => {
        setBusy(true)
        setFailure(null)
        try {
          const receipt = await runCommand(line)
          if (!aliveRef.current) return
          if (receipt.admitted !== true) setFailure(receipt.text)
        } catch (error) {
          if (aliveRef.current) {
            setFailure(error instanceof Error ? error.message : String(error))
          }
        } finally {
          if (aliveRef.current) setBusy(false)
        }
      }

      const onClick = (button) => {
        if (busy) return
        void submit(`/${COMMANDS[button.id]}`)
      }

      const children = BUTTONS.map((button) =>
        react.createElement(
          'button',
          {
            key: button.id,
            type: 'button',
            title: button.hint,
            disabled: busy,
            style: buttonStyle(false),
            onClick: () => onClick(button),
          },
          button.label,
        ),
      )

      const wrapper = [react.createElement('div', { key: 'row', style: rowStyle }, children)]
      if (failure !== null) {
        // No timer: an admission failure exists nowhere else, so it stays until
        // the next action instead of clearing itself out of sight.
        wrapper.push(
          react.createElement('div', { key: 'failure', style: failureStyle, role: 'alert' }, failure),
        )
      }
      return react.createElement('div', null, wrapper)
    }

    /**
     * Register both surfaces.
     * @param {object} ctx client root context
     */
    function apply(ctx) {
      ctx.slots.inject(COMPOSER_SLOT, () =>
        ctx.slots.register(
          {
            name: COMPOSER_SLOT,
            id: 'progress-secretary',
            order: 50,
            inject: (sessionId) => ({
              sessionId,
              runCommand: async (line) => {
                const result = await ctx.remote.commands.execute(sessionId, line, [])
                if (!result.ok) {
                  return { admitted: false, text: `${result.error.message} (${result.error.code})` }
                }
                if (result.value === undefined) return { admitted: false, text: `未知命令：${line}` }
                // Admitted. A handler that returned an error is admitted too: its
                // outcome is a durable `command/done`, and the chat card renders
                // it — on a row that survives a reload.
                return { admitted: true, text: '' }
              },
            }),
          },
          ProgressSecretaryBar,
        ),
      )

      for (const button of BUTTONS) {
        const key = COMMANDS[button.id]
        ctx.slots.inject(COMMAND_VIEW_SLOT, () =>
          ctx.slots.register({ name: COMMAND_VIEW_SLOT, key }, commandCardView(button.label)),
        )
      }
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
