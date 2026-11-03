/**
 * OpenCode V2 companion for Anton's transient-generation backend agent.
 * Copy beside OpenCode's other user plugins; it does not launch an application.
 */

interface Registration {
  dispose(): Promise<void>
}

interface Generation {
  readonly agent: string
  system: Array<{ type: 'text'; text: string }>
}

interface HttpRequest {
  readonly agent: string
  readonly kind: string
  request: Request
}

interface PluginContext {
  readonly session: {
    hook(name: 'generate', callback: (event: Generation) => void): Promise<Registration>
    hook(name: 'http.request', callback: (event: HttpRequest) => Promise<void>): Promise<Registration>
  }
}

const guidance = 'You are the model backend for Anton Harness. The user message contains the authoritative System instructions, conversation history and available remote tools. Follow those instructions and the pi-zen-tool-protocol. Native tool definitions are transport details; never call them. For a tool request emit exactly a fenced code block with the info string tool and the JSON name and arguments, then stop. Never finish with only a promise to use tools; emit the tool request now. Tool results will be supplied by Harness.'

/** OpenCode discovers this plugin's id and setup method from its default export. */
export default {
  id: 'anton.harness-text-tools',
  async setup(ctx: PluginContext): Promise<() => Promise<void>> {
    const generation = await ctx.session.hook('generate', (event) => {
      if (event.agent !== 'anton-harness') return
      event.system = [...event.system, { type: 'text', text: guidance }]
    })
    let request: Registration
    try {
      request = await ctx.session.hook('http.request', async (event) => {
        if (event.agent !== 'anton-harness' || event.kind !== 'generate') return
        const body: unknown = await event.request.clone().json()
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          throw new Error('Anton backend generation requires a JSON request object')
        }
        event.request = new Request(event.request, {
          body: JSON.stringify({ ...body, tool_choice: 'none' }),
        })
      })
    } catch (error) {
      await generation.dispose()
      throw error
    }
    return async () => {
      try {
        await request.dispose()
      } finally {
        await generation.dispose()
      }
    }
  },
}
