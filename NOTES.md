# 开发笔记（技术档案）

**这份文件不进笔记本、不被注入、不占任何会话的上下文。** 它是给「继续开发这个插件的人」查的：平台机制、实验记录、底层插件的内部行为、开发与验证方法。

笔记本 `.dsh/progress.md` 的读者是**回来捡工作的人**；这份文件的读者是**接着改这个插件的人**。两者的信息不该混在一份文件里 —— 这正是 0.5.0 把笔记本收紧的原因（见 `CHANGELOG.md`）。

分流规则：

| 信息 | 去哪 |
|---|---|
| 系统应当是什么 | `spec.md` / `spec-ui.md` |
| 设计为什么这么定、改过什么 | `CHANGELOG.md` |
| 平台机制、实验过程、实现笔记、方法论 | 本文件 |
| 现在到哪了、下一步做什么 | `.dsh/progress.md` |
| 可机检的结论 | 测试 |

---

## 一、平台机制

以下各条都是读平台源码或用平台自带 Cordis 实测得到的，不是印象。

### 1.1 Remote 命名空间是 Cordis 服务

- 服务名 = `remote.<namespace>`，由持有方客户端的 `ctx.remote.$mount({ package, descriptors })` 挂载。挂载时机**晚于**本插件的 bundle。
- **只声明 `remote` 的上下文读 `ctx.remote.<namespace>` 得到 `undefined`**（不抛错，因此静默）。这不是「可选依赖」，是「不存在的路径」。
- 正当读取路径两条：延迟式声明 `ctx.inject(['remote.<ns>'], cb)`（只 park 回调，apply 立即返回），或 `ctx.get('remote.<ns>')`（对祖先提供的服务，Cordis 的查找不受声明门限制）。
- 把 `remote.<ns>` 写进 `inject = [...]` **列表**会阻塞：等到服务出现，底层插件不在时连按钮都不出现。
- 平台自己的插件声明点号名（`dsh-client-ui-commands` 的 inject 列表里有 `remote.commands`）；底层插件的客户端半边用 `ctx.inject(['remote.checkpointPanel'], …)`。

### 1.2 Remote 方法返回信封

- resolve 出 `{ ok: true, value }` / `{ ok: false, error: { code, message } }`。照直读 `value` 内部的字段会得到 `undefined` → 把**读失败**显示成一个平静的错误答案。底层插件的客户端半边用 `unwrap()` 拆它。

### 1.3 命令结果本来就在聊天框

- 平台把 `command/run` / `command/done` 折成一条命令节点；`chatNode()` 的 `visibility` 默认 `visible`，`commandDefinition` 的 target 是 `chat`。
- `runDetached`（裸命令）只在**错误**时回落到 composer notice；`execute` 对已受理命令一律报 plain success（无文本）。
- 因此「结果该显示在哪」不是选择：平台已经渲染了一份，插件再画一份就是重复副本。

### 1.4 命令行扩展点

- `conversation.chat.commandview`：keyed、session 作用域，key 由 owner 用命令名派发；未占用时回落平台默认卡片。当前 `replaceRisk: none`。
- **Trajectory 视图不渲染命令行**，只有 Chat 视图渲染。
- 平台默认卡片折叠时只显示单行省略号摘要，多行文本要展开才看得全 —— 这是做专属卡片的理由（设计理由，不是约束）。

### 1.5 槽位（真实 SlotCore）

- 未声明的槽位 `register(...)` 抛 `slot "X" is not declared`；keyed 槽位缺 `key`、list 槽位缺 `id` 也抛 —— 都是加载期校验。
- `slots.inject(key, cb)` 在声明出现后回调（已存在时同步执行）。所以「依赖另一个客户端半边声明的槽位」必须惰性注册。

### 1.6 平台 seed 模块表

- 种子表里有 `dsh-client-ui-primitives`（`react` 也在那张表里）。`MarkdownText` 由 shell 发布在这张**静态模块表**上，因此既不必也不能当作插件行声明。
- 假设不成立时会在**加载路径**上失败；`spec-conformance` 与 `client-slots.integration` 都为此钉了钉子。

### 1.7 会话与事件

- `session/event` 在 root 层收得到，且监听器是在一次 append 的**发布过程中**被调用的 —— 在监听器里直接执行命令会因重入被拒（`session append cannot reenter while another append is being published`）。要 `ctx.timeout(fn, 0)`。
- `ContextFormed` 是判别联合：`snapshot` 把 `sections` 当正文；`notice` 显示一行摘要（上限 120 字符）。`sections` 缺失/为空/类型不符会让整行退化成不透明块。
- 收件箱消息会被 agent loop 认领为一个**用户回合**；追加到会话日志只进入派生历史，不认领回合。

### 1.8 命令注册

- `normalizeDefinition` 四条校验：命令名格式（`/^[a-z][a-z0-9_-]*$/`）、description 非空、handler 是函数、hint 非空。无参命令**不声明 `input` 字段** —— 空 hint 会让整棵插件树加载失败。
- 命令名冲突同样会让整棵插件树加载失败。已占用：`rewind`、`checkpoint`、`feedback`、`compact`、`goal`、`plan`。
- 命令只能由 host 侧代码注册；DSH 没有文件驱动的命令注册机制。
- `--dump-config` 只 dump 不 apply。
- `ctx.logger` 在 root ctx 上不存在 → 失败可见必须走 `agent.followup`。
- 动态 Cordis 插件的 host ctx 暴露服务面很窄（`ctx.get('fs')` 是 undefined）。
- `@deepseek-ai/dsh-commands` 与 `cordis-plugin-timer` 的 default 导出都是插件函数本身，取 `.apply` 会拿到 `Function.prototype.apply`。

### 1.9 热更新

三套，各管各的：

| 机制 | 管什么 | 状态 |
|---|---|---|
| `patchReload: live` | patch 文件（`cordis.patch.yml`） | 已开 —— 改 patch 不用重启 |
| `cordis-plugin-hmr` | 插件源码 | 默认 disabled |
| `dsh-client-hmr` | 被重建的 bundle | 只对重建有反应 |

**推论**：改 `lib/*.js`（host 侧）要重启 DSH；改 `lib/client.js`（手写 bundle，没有 watcher）要重启。两者本插件都做不到自我验证，见 §四。

### 1.10 消息来源（format v4）

- V4 起 `source.kind` 必须**生产者自有**，v3 的包装 `{ kind: 'plugin', plugin }` 在**写入会话时**被拒：`format v4 message requires a producer-owned source kind`（校验点在 `dsh-session-format-v3-to-v4` 的 `assertV4RowAdmission` → `assertV4SourceRowAdmission`，对 `user/message` 直接看 `row.data.source`）。空 kind 同样被拒。
- 两条注入路径的**报错落点不同**：`agent.followup()` 只是投收件箱，等 loop 认领成回合、写 `user/message` 时才校验 —— 所以失败以「本轮运行失败」出现在聊天框；`session.append()` 同步校验，直接抛。
- 平台给第三方生产者分配的 kind 是 `plugin:<完整包名>`（`session-format-v3-to-v4` 的消息来源转换表：「任何其他插件名 → `plugin:` + 完整原名」；一方同名生产者在那张表里逐个列出）。迁移旧行得到的就是这个字符串，所以新代码也用它会话内的来源才统一。
- 未知 kind 不是错误：客户端 `contextProducer()` 只特判 `session-reference` / `agent-instructions` / `skill-invocation`，其余一律 `{ role: 'inject', label: kind }` —— 行头标签就是 kind 字符串本身，这也是换用裸包名会付的实际代价。
- `dsh-llm` 的 `MessageSourceMap` 是 merge-extensible 的，注释明说「没有共享的 catch-all `plugin` kind」；一方插件一律 `kind: name`（`time-context`、`tmux-context`、`agent-instructions`）。

---

## 二、底层插件 `dsh-checkpoint-rewind` 的内部行为

### 2.1 检查点有三个来源

1. **自动**（`kind=auto` / `triggerTool=auto`）：`autoCheckpoint.enabled: true` 且 `intervalMinutes: 0`（= **每步**），在每个 `step/start` 尝试捕获；内容与上一条相同则不写记录。`mutationTools` 含 `bash`，所以只读命令也会算一步。
2. **显式记录**（`kind=manual` / `triggerTool=checkpoint` + `note`）：底层 `/checkpoint`，或本插件在「记录进度」轮次结束后调用。
3. 用户手敲底层 `/checkpoint`。

### 2.2 存储

- 检查点是底层插件的独立存储 `~/.dsh/storages/checkpoints.json`（`{ unit, global, tables.checkpoints }`），**不写进会话日志**。核对检查点要读这个文件，不是 `session.v3.jsonl.zstd`。
- 有界：`maxSnapshots: 50` + `pruneOnTurnEnd: true` → 长会话条目数稳定在 50 上下，不会无限增长，也不会自净。
- `timeline` 每行：`{ id, sessionId, time, seq, kind, provider, triggerTool, turn, step, files, bytes, tree, note, sessionBoundary }`，**跨会话**，必须按 `sessionId` 过滤；`files` 是计数不是列表。
- 底层自己的 `/rewind` 无参列表只列 `limit`（默认 10）条 —— 上游对「该收敛多少条」已有先例。

### 2.3 实测数据（0.5.0 之前的会话）

- 一个会话 44 条（第 1 轮 9 条 + 第 2 轮 35 条），**全是 `auto` / `note=null`**，step 序号 1→100、时间戳间隔几秒 —— 即「改一次文件就多一条」，与用户点了什么无关。
- 全库带 `note` 的行只有 3 条，全是**旧会话**里 `manual / checkpoint / "fork-fork*"`（0.1.x fork 时代的遗物）；**没有一条**是 `记录进度 · …`。
- 原因：底层按内容去重（与上一条相同则不写），而自动快照按步先到 —— 笔记本写完后往往已被捕获。这条**已知限制**已写进 `spec.md` 6.1 与插件 README。

### 2.4 会话日志

- `~/.dsh/sessions/<cwd 编码>/<session>/session.v3.jsonl.zstd`，`zstd -dc` 可解；`command/run` / `command/done` 的原文都在里面。**这是权威证据源。**

---

## 三、本插件的实现笔记

- `lib/index.js` 是 host 半边：**两个命令**（注入重写指令、注入笔记本）加两个纯读辅助。没有编排、没有延迟动作、没有第二个插件的调用。
- 那段无调用点的 sandbox 写文件代码**已随 0.7.0 删除**。它自己的注释写着「不再需要时就删」，而删掉回滚与检查点后本插件没有任何写操作，条件成立。
- host 的 inject 是 `['commands','fs']`：`timer` 随检查点的延迟执行一起消失。
- `lib/notebook.js` 是「读 + 指示」纯函数模块。**单向**：agent 写笔记本，插件只读。没有 render/write 半边 —— 一个渲染器不会有调用者，留着只会诱使插件开始拥有它并不拥有的写入权。
- `lib/client.js` 是**已构建产物**（`window.__ModuleLoader__.load({ id, factory })`），手写，无 watcher；React 由平台模块表提供。
- `readback()` 的小节标签用**粗体**不用 `##`：它是聊天行的正文，文档级标题会比卡片自己的标题还响。这也让降级路径（逐字文本）不难看。
- 客户端持有命令名表（默认 `note` / `brief`），是 host 配置的第二份拷贝。两边不一致会让按钮调用不存在的命令 —— 表现为**可见的**准入失败，不是静默无反应。是否消掉这份拷贝未定（笔记本待办）。
- `link:` 安装下，peer 依赖自本包 realpath 向上解析，因此工作区必须保留指向 `$DSH_HOME/profiles/node_modules/@deepseek-ai` 的 `node_modules/@deepseek-ai/*` 软链（当前 5 个 host 侧），删了会 `ERR_MODULE_NOT_FOUND`。tarball 安装不需要。
- 底层 copy provider 默认排除 `.dsh`；本部署已在其 profile patch 里去掉该排除（`~/.dsh/profiles/web/cordis.patch.yml` 的 `excludeGlobs`）。**那是那个插件的配置，与本插件无关**（0.7.0 起本插件既不读也不写它）；换工作区若还想要笔记本进快照，需在那侧重做。

---

## 四、开发与验证方法

- **先问「屏幕上到底多了什么」，再动代码。** 0.4.2 的起点是「没有看到回滚下拉框」；那张面有四种失败方式（什么都没多出来 / 多了个文本框 / 「本会话还没有检查点」/ 「读取检查点…」卡住），长得完全不一样。一句「是文本框」砍掉了四分之三的搜索空间。
- **平台行为一律去读平台源码或做最小实验，不靠印象。**
- **最小实验记录（0.4.2，用平台自带的 Cordis 4.0.2）**：
  1. 只声明 `remote` 的 ctx 读 `ctx.remote.checkpointPanel` → `undefined`，不抛错；
  2. `ctx.get('remote.checkpointPanel')` 能拿到祖先提供的该服务，不受声明门限制；
  3. `ctx.inject(['remote.checkpointPanel'], cb)` 在服务挂载后回调，可晚于 apply。
  这三条结论都是实验得出的，不是推断。
- **测试假件不得比真环境慷慨。** 0.4.2 的两个 bug 都是被「假 `remote` 直接挂着命名空间 + `timeline` 直接返回 `{rows}`」放过去的 —— 两处慷慨各盖住一个 bug。假件要把真实契约（声明、信封、迟到挂载）一起仿出来。
- **变异测试才能证明守卫有牙齿。** 0.4.2 的五个变异（退回直读 / 不拆信封 / 拿掉降级说明 / 抽掉声明路径 / 抽掉 `ctx.get` 路径）分别红 4 / 4 / 2 / 1 / 1 条；0.4.0 那轮六个也各被抓住。
- **只看文本的断言会漏掉空块。** 输入框把「成功」也渲染成一个空回执块时，文本断言全绿 → 必须断言「没有回执元素」，并单独钉住桥接层（`admitted: true, text: ''`）这个真正的守卫。
- **测试替身的边界**：React 18.3.1 在工作区解析不到（只有 5 个 host 侧软链可解到 profile）→ 客户端测试自带 React 替身，且替身**不跑 effect**；一个靠 effect 才正确的组件在它下面测不出来。
- **客户端 bundle 是脚本**（挂 `window.__ModuleLoader__`），`new Function('window', src)` 就能在 Node 里加载并渲染；`dsh-client-runtime` 的客户端包同理，`import` 它只会得到空模块。
- **我无法自己做真实启动验证**：沙箱禁止写 `~/.dsh`（`dsh --profile web --help` 都会 EPERM ← 它就会写 profile 的 `cordis.yml`），且第二个实例会重写 `cordis.yml`，怕扰动正在跑的 host。替代证据是：host 侧真实 Cordis + 真实命令注册表、客户端真实 SlotRegistry，加上用户的实机观察。
- **占位符比较必须在剥离列表标记之后**：`- （无）` 与 `（无）` 永不相等。
- **「测试通过」不等于「功能验证」；「没看到警告」不等于成功。** 0.4.x 的三个 bug 全都是测试全绿时真实存在着的。

---

## 五、回滚列表：从噪声到「只列手动点」（0.6.0 定案；0.7.0 起作废）

### 5.1 为什么手动点从来没落盘

- `captureCheckpoint` **只按内容去重**：`provider.snapshot(..., { previousRef })` 返回 `null` 表示与上一条检查点内容一致，于是直接返回 `{ deduped: true }`、**不写记录**。`kind` 与 `note` **不参与判定**，也**没有 force/override 开关**（`retryWithoutBaseline` 只处理「去重基线不可读」，不是强制写入）。
- 自动网在 **`step/start`（该步工具调用之前）** 捕获。一个 `/note` 回合里，笔记本写完后只要有**任何**后续 step 开始，那份内容就被自动网捕获；回合结束时我们的手动记录内容不变 → 必然 `deduped`。
  实测（改前本机）：全库 186 条，**183 auto / 3 manual**，那 3 条全是 0.1.x fork 时代的遗物 —— 「记录进度」一条也没留下。
- **`prunePlan` 不给带摘要的记录豁免**：只看每会话最新 `maxSnapshots`（默认 50）条。自动流因此不只是吞掉手动点，还会在手动的存在之后把它们挤出存储。

### 5.2 定案：关掉两路自动写入

| 开关 | 关掉的是 |
|---|---|
| `autoCheckpoint.enabled: false` | `step/start` 的按步 / 按间隔网 |
| `mutationTools: []` | 变更前安全网（`bash` / `write` / `edit` / …） |

配置落**两处**（同值，互为冗余）：

- `~/.dsh/profiles/web/cordis.patch.yml` —— 部署层。**profile patch 不会热加载**（实测：改完仍在写记录），需重启才生效。
- `~/.dsh/settings.yaml` 的 `checkpoint-rewind:` 命名空间 —— 这是该插件**文档化的即时生效路径**（「settings 写回经 watch 即时生效」；有效配置 = `cordis.yml` 为基、settings 命名空间覆盖）。写入后实测：一次本来会产生 `mutation` 记录的写文件操作**不再产生**记录。

代价（用户知情选择）：两次「记录进度」之间没有自动回滚点。底层自己的 `/checkpoint`、`/rewind` 不受影响。

### 5.3 呈现层

- 选择器只列 `kind: manual`（旧记录缺 `kind` 时回落 `triggerTool === 'checkpoint'`）；`note` **不作**判据 —— 它是记录的字段，不是「谁要求的」这一事实。
- **必须说出省略了多少条**：三行的列表与丢掉四十一行的列表长得一模一样。空态必须说明怎么产生一个手动点（点「记录进度」），不得只说「没有检查点」——那会让一个正常的空列表读起来像故障。
- 取数上限提到 Remote 自身的上限 200：`timeline` 返回的是**全局最新** N 行、再按会话过滤，所以它是一次抓取的窗口而非每会话保证 —— 表格里堆满自动条目时，手动点会被挤出窗口（这也是关自动网的第二个理由）。
- 被省略的自动点**不是不可达**：底层 `/rewind` 仍列出与恢复全部检查点。只有 50 条额度是先到先得，旧自动点会随时间被清掉。

### 5.4 曾经考虑过的三个修法（未采用，留档）

① 标签加上秒与步数；② 列表封顶并明说截断；③ 把 `intervalMinutes` 从 0 改成按时间间隔。
① 只是让噪声可辨认；② 治标（列表里仍是没人选的时刻）；③ 只降低频率，且仍与手动点争 50 条额度。0.6.0 选的是「只列手动点 + 关掉自动写入」。

---

## 六、0.7.0 删掉回滚之后，哪些知识作废了

回滚整套删除（见 `CHANGELOG.md` 0.7.0），本文件因此有一批内容从「现役工程知识」变成「历史记录」。保留它们是因为**判断当时为什么那么做**仍然有用，但读之前先知道它们已不再是本插件的约束：

**仍然有效（继续当参考）**

- 平台机制那一整章（§一）：Remote 命名空间是服务、信封要拆、命令结果本来就在聊天框、seed 模块表、SlotCore 加载期校验、`session/event` 的重入限制、命令注册的四条校验、三套热更新。这些是平台的性质，与本插件删不删功能无关。
- §二 会话日志与检查点存储的读法（要核对检查点时仍要读 `~/.dsh/storages/checkpoints.json`）。
- §四 开发与验证方法（假件不得比真环境慷慨、变异才有牙齿、替身的边界、无法真实启动）。

**已作废（只为已删能力存在）**

- §二 检查点三来源、去重、裁剪、`timeline` 行形状 —— 现在只与「用户自己装的检查点插件」有关，与本插件无关。
- §五 回滚列表的全部内容（去重吞手动点、关自动网、只列手动点、省略说明、抓取窗口）。

**部署面遗留**

§五 5.2 那两处配置（profile patch 与 `settings.yaml` 的 `checkpoint-rewind:`）是 0.6.0 为本插件的手动记录落盘而写的。0.7.0 之后本插件不再产生任何检查点，这份配置只影响底层插件自己的行为，**尚未决定保留还是恢复默认**。删功能时没有顺手改它 —— 那会是一次未经请求的环境变更。
