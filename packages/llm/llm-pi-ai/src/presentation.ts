/** Format provider routes and model ids for model selectors. */

const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  anthropic: 'Anthropic Claude',
  deepseek: 'DeepSeek',
  google: 'Google',
  'kimi-coding': 'Kimi Coding',
  moonshotai: 'Moonshot AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  'opencode-free': 'OpenCode Free',
  'openrouter-free': 'OpenRouter Free',
  'qwen-token-plan': 'Qwen Token Plan',
  'qwen-token-plan-individual': 'Qwen Token Plan Individual',
  zai: 'Z.ai',
}

const MODEL_WORDS: Readonly<Record<string, string>> = {
  a3b: 'A3B',
  ai: 'AI',
  b: 'B',
  deepseek: 'DeepSeek',
  flash: 'Flash',
  gemma: 'Gemma',
  glm: 'GLM',
  gpt: 'GPT',
  highspeed: 'Highspeed',
  instruct: 'Instruct',
  it: 'IT',
  kimi: 'Kimi',
  llama: 'Llama',
  minimax: 'MiniMax',
  minimaxai: 'MiniMax',
  mistral: 'Mistral',
  nemotron: 'Nemotron',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  oss: 'OSS',
  qwen: 'Qwen',
  vl: 'VL',
  zai: 'Z.ai',
}

/** Return a branded provider name when a route has no custom label.
 * @param provider - stable route id.
 * @param configuredName - custom name or the route id fallback.
 * @returns the custom label or a readable provider name.
 */
export function displayProviderName(provider: string, configuredName: string): string {
  if (configuredName !== provider) return configuredName
  return PROVIDER_NAMES[provider] ?? titleWords(provider)
}

/** Format a model label without changing the id sent to the provider.
 * @param name - provider-supplied or configured model name.
 * @param id - opaque model id sent on requests.
 * @returns a capitalized label with id separators replaced by spaces.
 */
export function displayModelName(name: string, id: string): string {
  const raw = name === id ? id.slice(id.lastIndexOf('/') + 1) : name
  return titleWords(raw)
}

/** Replace id separators and apply known provider/model capitalization. */
function titleWords(value: string): string {
  return value.replace(/[-_/]+/g, ' ').trim().split(/\s+/).filter(Boolean).map((word) => {
    const key = word.toLowerCase()
    const known = MODEL_WORDS[key]
    if (known !== undefined) return known
    if (/^\d+(?:\.\d+)?[a-z]+$/i.test(word)) return word.toUpperCase()
    return `${word.charAt(0).toUpperCase()}${word.slice(1)}`
  }).join(' ')
}
