import type { AgentProvider, Sandbox, SandboxRunResult } from "@ai-hero/sandcastle"

export const syncBarrierAgent: AgentProvider = {
  name: "OpenCode sync barrier",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({ command: "true" }),
  parseStreamLine: () => [],
}

export function runSyncBarrier(sandbox: Sandbox): Promise<SandboxRunResult> {
  return sandbox.run({
    agent: syncBarrierAgent,
    prompt: "",
    maxIterations: 1,
  })
}
