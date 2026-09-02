import type { Plugin } from "@opencode-ai/plugin"

import { createSandboxPlugin } from "../sandbox/plugin-runtime"

const SandboxPlugin: Plugin = async (input) => (await createSandboxPlugin(input)) ?? {}

export default SandboxPlugin
