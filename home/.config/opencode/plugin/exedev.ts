import type { Hooks, Plugin } from "@opencode-ai/plugin"

import { createExedevPlugin } from "../exedev/plugin-runtime"

const ExedevPlugin: Plugin = async (input) => {
  const hooks = await createExedevPlugin(input)
  if (!hooks) return {}
  return adaptHooks(hooks)
}

function adaptHooks(hooks: Awaited<ReturnType<typeof createExedevPlugin>>): Hooks {
  if (!hooks) return {}
  return {
    dispose: hooks.dispose,
    event: ({ event }) => hooks.event({ event }),
    "command.execute.before": ({ command, sessionID }) => hooks["command.execute.before"]({ command, sessionID }),
    "shell.env": ({ cwd, sessionID }, output) => hooks["shell.env"]({ cwd, sessionID }, output),
  }
}

export default ExedevPlugin
