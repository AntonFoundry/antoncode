/** Local provider artwork shared by model selection and provider settings. */
const logos: Readonly<Record<string, string>> = {
  anthropic: 'anthropic.svg',
  'claude-code': 'anthropic.svg',
  openai: 'openai.svg',
  codex: 'openai.svg',
  'openai-codex': 'openai.svg',
  antigravity: 'antigravity.png',
  'google-antigravity': 'antigravity.png',
  'opencode-server': 'opencode.png',
  opencode: 'opencode.png',
  'opencode-free': 'opencode.png',
  'deepseek-official': 'deepseek.png',
  deepseek: 'deepseek.png',
  'openrouter-free': 'openrouter.png',
  openrouter: 'openrouter.png',
  'kimi-coding': 'kimi.png',
  nvidia: 'nvidia.png',
  'qwen-token-plan': 'qwen.png',
  'qwen-token-plan-individual': 'qwen.png',
  zai: 'zai.svg',
}

/**
 * Render a provider's locally bundled logo or an initial for a custom route.
 * @param props.provider - stable provider route id.
 * @param props.name - display name used for the fallback initial.
 * @param props.size - square edge length in pixels.
 * @returns a decorative logo beside the provider's text label.
 */
export function ProviderLogo({ provider, name, size = 20 }: {
  provider: string
  name: string
  size?: number
}) {
  const file = logos[provider]
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-grid', placeItems: 'center', flex: `0 0 ${size}px`,
        width: size, height: size, overflow: 'hidden', borderRadius: Math.max(4, size / 5),
        color: 'var(--dsw-alias-label-primary)', fontSize: size * 0.58,
        lineHeight: 1,
      }}
    >
      {file === undefined
        ? name.trim().slice(0, 1).toLocaleUpperCase()
        : <img src={`/assets/providers/${file}`} width={size} height={size} alt="" style={{ display: 'block', objectFit: 'contain' }} />}
    </span>
  )
}
