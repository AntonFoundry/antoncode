/**
 * Native Z.AI tools: the exact behavior of the four ZAI MCP servers
 * (`zai-vision`, `zai-web-search`, `zai-web-reader`, `zai-read-github`) as
 * in-process `defineTool` registrations. No child process is spawned and no
 * port is bound: remote-trio calls reuse the MCP Streamable HTTP endpoints
 * through short-lived per-call sessions, and vision calls the same
 * `chat/completions` endpoint `@z_ai/mcp-server` calls, with its vendored
 * system prompts.
 *
 * Secrets follow the harness credential seam: config carries only
 * `apiKeyEnv` (default `Z_AI_API_KEY`), resolved per tool call through
 * `ctx.credentials` with ambient-environment fallback — a rotated key takes
 * effect on the next call with no restart.
 *
 * @module @deepseek-ai/dsh-tool-zai
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  apiKeyRefOf,
  encodeImageSource,
  encodeVideoSource,
  ENDPOINTS,
  mcpCall,
  mcpText,
  resolveApiKey,
  visionChat,
  VISION_MODEL,
  type VisionPart,
} from './client.ts'
import {
  DATA_VIZ_ANALYSIS_PROMPT,
  DIAGRAM_UNDERSTANDING_PROMPT,
  ERROR_DIAGNOSIS_PROMPT,
  GENERAL_IMAGE_ANALYSIS_PROMPT,
  TEXT_EXTRACTION_PROMPT,
  UI_DIFF_CHECK_PROMPT,
  UI_TO_ARTIFACT_PROMPTS,
} from './prompts.ts'

/** Cordis plugin name used by loader diagnostics and the settings namespace. */
export const name = 'tool-zai'

/** Services required by this plugin. */
export const inject = ['tools']

/** Model-facing tool names registered by this plugin. */
export const TOOL_NAMES = [
  'web_search_prime',
  'webReader',
  'search_doc',
  'read_file',
  'get_repo_structure',
  'ui_to_artifact',
  'extract_text_from_screenshot',
  'diagnose_error_screenshot',
  'understand_technical_diagram',
  'analyze_data_visualization',
  'ui_diff_check',
  'analyze_image',
  'analyze_video',
] as const

/** One model-facing tool name from this plugin. */
export type ToolName = (typeof TOOL_NAMES)[number]

/** Plugin configuration: references and toggles only, never secret values. The zod `Config` supplies defaults for the optional fields. */
export interface ToolZaiConfig {
  /** Credential reference naming the Z.AI key (default `Z_AI_API_KEY`). */
  apiKeyEnv: string
  /** Vision chat model (default `glm-5.3-flash`, as in `@z_ai/mcp-server`). */
  visionModel?: string | undefined
  /** Per-call HTTP timeout in milliseconds (default 300000). */
  timeoutMs?: number | undefined
  /** Allowlist of tool names to register; default is all thirteen. */
  enabledTools?: string[] | undefined
}

export const Config = z.object({
  apiKeyEnv: z.string().default('Z_AI_API_KEY'),
  visionModel: z.string().default(VISION_MODEL),
  timeoutMs: z.number().min(1).default(300000),
  enabledTools: z.array(String).default([...TOOL_NAMES]),
}) as unknown as z<ToolZaiConfig>

/** Throw on blank model input the DSL cannot express (mirrors the MCP originals). */
function nonEmpty(value: string, field: string, tool: string): string {
  if (value.trim().length === 0) throw new Error(`${tool}: "${field}" must be a non-empty string`)
  return value
}

/** Resolve the zod-defaulted fields for direct callers; the loader path gets the same values through `Config`. */
function resolveConfig(config: ToolZaiConfig): {
  apiKeyEnv: string
  visionModel: string
  timeoutMs: number
  enabledTools: string[]
} {
  return {
    apiKeyEnv: config.apiKeyEnv,
    visionModel: config.visionModel ?? VISION_MODEL,
    timeoutMs: config.timeoutMs ?? 300000,
    enabledTools: config.enabledTools ?? [...TOOL_NAMES],
  }
}

export function apply(ctx: Context, partial: ToolZaiConfig): void {
  const config = resolveConfig(partial)
  const ref = apiKeyRefOf(config.apiKeyEnv)
  const unknown = config.enabledTools.filter(tool => !(TOOL_NAMES as readonly string[]).includes(tool))
  if (unknown.length > 0) {
    throw new Error(`tool-zai: unknown tools in enabledTools: ${unknown.join(', ')} (known: ${TOOL_NAMES.join(', ')})`)
  }
  const enabled = new Set(config.enabledTools)
  const keyOf = (): Promise<string> => resolveApiKey(ctx, 'tool-zai', ref)

  if (enabled.has('web_search_prime')) {
    ctx.tools.register(defineTool({
      name: 'web_search_prime',
      description: 'Search web information, returns results including web page title, web page URL, web page summary, website name, website icon, etc.',
      parameters: {
        search_query: { type: 'string', required: true, description: 'Content to be searched, it is recommended that the search query not exceed 70 characters' },
        search_domain_filter: { type: 'string', description: 'Used to limit the scope of search results, only return content from specified whitelist domains, such as: www.example.com.' },
        search_recency_filter: { type: 'string', description: 'Search for web pages within a specified time range. Default is noLimit Available values:- oneDay, within one day- oneWeek, within one week- oneMonth, within one month- oneYear, within one year- noLimit, no limit (default)' },
        content_size: { type: 'string', description: 'Control the number of words in the web page summary; default value is medium - medium: balanced mode, suitable for most queries. 400-600 words.- high: maximize context to provide more comprehensive answers, but higher cost, 2500 words.' },
        location: { type: 'string', description: 'Guess which region the user is from based on user input. Default is cn Available values: - cn, Chinese region- us, non-Chinese region' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const callArgs: Record<string, unknown> = { search_query: nonEmpty(args.search_query, 'search_query', 'web_search_prime') }
        for (const field of ['search_domain_filter', 'search_recency_filter', 'content_size', 'location'] as const) {
          if (args[field] !== undefined) callArgs[field] = args[field]
        }
        const result = await mcpCall(ENDPOINTS.webSearchPrime, await keyOf(), 'web_search_prime', callArgs, exec.signal)
        return mcpText(result.content)
      },
    }))
  }

  if (enabled.has('webReader')) {
    ctx.tools.register(defineTool({
      name: 'webReader',
      description: 'Fetch and Convert URL to Large Model Friendly Input.',
      parameters: {
        url: { type: 'string', required: true, description: 'The URL of the website to fetch and read' },
        timeout: { type: 'integer', description: 'Request timeout(unit is second), default is 20' },
        no_cache: { type: 'boolean', description: 'Disable cache(true/false), default is false' },
        return_format: { type: 'string', description: 'Reader response content type (markdown or text), default is markdown' },
        retain_images: { type: 'boolean', description: 'Retain images (true/false), default is true' },
        no_gfm: { type: 'boolean', description: 'Disable GitHub Flavored Markdown (true/false), default is false' },
        keep_img_data_url: { type: 'boolean', description: 'Keep image data URL (true/false), default is false' },
        with_images_summary: { type: 'boolean', description: 'Include images summary (true/false), default is false' },
        with_links_summary: { type: 'boolean', description: 'Include links summary (true/false), default is false' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const callArgs: Record<string, unknown> = { url: nonEmpty(args.url, 'url', 'webReader') }
        for (const field of ['timeout', 'no_cache', 'return_format', 'retain_images', 'no_gfm', 'keep_img_data_url', 'with_images_summary', 'with_links_summary'] as const) {
          if (args[field] !== undefined) callArgs[field] = args[field]
        }
        const result = await mcpCall(ENDPOINTS.webReader, await keyOf(), 'webReader', callArgs, exec.signal)
        return mcpText(result.content)
      },
    }))
  }

  if (enabled.has('search_doc')) {
    ctx.tools.register(defineTool({
      name: 'search_doc',
      description: 'Search documentation, issues, and commits of a GitHub repository.',
      parameters: {
        repo_name: { type: 'string', required: true, description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        query: { type: 'string', required: true, description: 'The search keywords or question about the repository.' },
        language: { type: 'string', description: "'zh' or 'en' (choose according to context language)." },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const callArgs: Record<string, unknown> = {
          repo_name: nonEmpty(args.repo_name, 'repo_name', 'search_doc'),
          query: nonEmpty(args.query, 'query', 'search_doc'),
        }
        if (args.language !== undefined) callArgs['language'] = args.language
        const result = await mcpCall(ENDPOINTS.zread, await keyOf(), 'search_doc', callArgs, exec.signal)
        return mcpText(result.content)
      },
    }))
  }

  if (enabled.has('read_file')) {
    ctx.tools.register(defineTool({
      name: 'read_file',
      description: 'Read the full code content of a specific file in a GitHub repository.',
      parameters: {
        repo_name: { type: 'string', required: true, description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        file_path: { type: 'string', required: true, description: 'The relative path to the file (e.g. "src/index.ts").' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const result = await mcpCall(ENDPOINTS.zread, await keyOf(), 'read_file', {
          repo_name: nonEmpty(args.repo_name, 'repo_name', 'read_file'),
          file_path: nonEmpty(args.file_path, 'file_path', 'read_file'),
        }, exec.signal)
        return mcpText(result.content)
      },
    }))
  }

  if (enabled.has('get_repo_structure')) {
    ctx.tools.register(defineTool({
      name: 'get_repo_structure',
      description: 'Get the directory structure and file list of a GitHub repository.',
      parameters: {
        repo_name: { type: 'string', required: true, description: 'GitHub repository: owner/repo (e.g. "vitejs/vite")' },
        dir_path: { type: 'string', description: 'The directory path to inspect (default: root "/")' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const callArgs: Record<string, unknown> = { repo_name: nonEmpty(args.repo_name, 'repo_name', 'get_repo_structure') }
        if (args.dir_path !== undefined) callArgs['dir_path'] = args.dir_path
        const result = await mcpCall(ENDPOINTS.zread, await keyOf(), 'get_repo_structure', callArgs, exec.signal)
        return mcpText(result.content)
      },
    }))
  }

  const vision = async (
    tool: string,
    systemPrompt: string,
    userPrompt: string,
    media: VisionPart[],
    signal: AbortSignal,
  ): Promise<string> => {
    nonEmpty(userPrompt, 'prompt', tool)
    return visionChat(await keyOf(), config.visionModel, systemPrompt, userPrompt, media, config.timeoutMs, signal)
  }

  if (enabled.has('ui_to_artifact')) {
    ctx.tools.register(defineTool({
      name: 'ui_to_artifact',
      description: 'Convert UI screenshots into various artifacts: code, prompts, design specifications, or descriptions. Use this tool ONLY when the user wants to: generate frontend code from UI design (output_type=\'code\'), create AI prompts for UI generation (output_type=\'prompt\'), extract design specifications (output_type=\'spec\'), get natural language description of the UI (output_type=\'description\'). Do NOT use for: screenshots containing text/code to extract, error messages, diagrams, or data visualizations.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        output_type: { type: 'string', required: true, enum: ['code', 'prompt', 'spec', 'description'], description: 'Type of output to generate. Options: \'code\' (generate frontend code), \'prompt\' (generate AI prompt for recreating this UI), \'spec\' (generate design specification document), \'description\' (natural language description of the UI).' },
        prompt: { type: 'string', required: true, description: 'Detailed instructions describing what to generate from this UI image. Should clearly state the desired output and any specific requirements.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const artifacts = UI_TO_ARTIFACT_PROMPTS as unknown as Record<string, string>
        const system = artifacts[args.output_type] ?? JSON.stringify(UI_TO_ARTIFACT_PROMPTS)
        return vision('ui_to_artifact', system,
          `Output type: ${args.output_type}\n\n${args.prompt}`,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'ui_to_artifact')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('extract_text_from_screenshot')) {
    ctx.tools.register(defineTool({
      name: 'extract_text_from_screenshot',
      description: 'Extract and recognize text from screenshots using advanced OCR capabilities. Use this tool ONLY when the user has a screenshot containing text and wants to extract it. This tool specializes in OCR for code, terminal output, documentation, and general text extraction. Do NOT use for: UI design conversion, error diagnosis, or diagram understanding.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'What text to extract and any formatting requirements.' },
        programming_language: { type: 'string', description: 'Programming language of code in the screenshot, when applicable.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const userPrompt = args.programming_language !== undefined
          ? `${args.prompt}\n\nProgramming language: ${args.programming_language}`
          : args.prompt
        return vision('extract_text_from_screenshot', TEXT_EXTRACTION_PROMPT, userPrompt,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'extract_text_from_screenshot')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('diagnose_error_screenshot')) {
    ctx.tools.register(defineTool({
      name: 'diagnose_error_screenshot',
      description: 'Diagnose and analyze error messages, stack traces, and exception screenshots. Use this tool ONLY when the user has an error screenshot and needs help understanding or fixing it. This tool specializes in error analysis and provides actionable solutions. Do NOT use for: code extraction, UI analysis, or diagram understanding.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'What the user was doing and what help is needed.' },
        context: { type: 'string', description: 'Additional context: environment, versions, recent changes.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const userPrompt = args.context !== undefined ? `${args.prompt}\n\nContext: ${args.context}` : args.prompt
        return vision('diagnose_error_screenshot', ERROR_DIAGNOSIS_PROMPT, userPrompt,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'diagnose_error_screenshot')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('understand_technical_diagram')) {
    ctx.tools.register(defineTool({
      name: 'understand_technical_diagram',
      description: 'Analyze and explain technical diagrams including architecture diagrams, flowcharts, UML, ER diagrams, and system design diagrams. Use this tool ONLY when the user has a technical diagram and wants to understand its structure or components. This tool specializes in interpreting visual technical documentation. Do NOT use for: UI screenshots, error messages, or data visualizations/charts.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'What to explain about the diagram.' },
        diagram_type: { type: 'string', description: 'Diagram kind (architecture, flowchart, UML, ER, system design).' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const userPrompt = args.diagram_type !== undefined ? `${args.prompt}\n\nDiagram type: ${args.diagram_type}` : args.prompt
        return vision('understand_technical_diagram', DIAGRAM_UNDERSTANDING_PROMPT, userPrompt,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'understand_technical_diagram')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('analyze_data_visualization')) {
    ctx.tools.register(defineTool({
      name: 'analyze_data_visualization',
      description: 'Analyze data visualizations, charts, graphs, and dashboards to extract insights and trends. Use this tool ONLY when the user has a data visualization image and wants to understand the data patterns or metrics. This tool specializes in interpreting visual data representations. Do NOT use for: UI mockups, error messages, or technical architecture diagrams.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'What insights or metrics to surface.' },
        analysis_focus: { type: 'string', description: 'Focus area: trends, anomalies, comparisons, summary.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const userPrompt = args.analysis_focus !== undefined ? `${args.prompt}\n\nAnalysis focus: ${args.analysis_focus}` : args.prompt
        return vision('analyze_data_visualization', DATA_VIZ_ANALYSIS_PROMPT, userPrompt,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'analyze_data_visualization')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('ui_diff_check')) {
    ctx.tools.register(defineTool({
      name: 'ui_diff_check',
      description: 'Compare two UI screenshots to identify visual differences and implementation discrepancies. Use this tool ONLY when the user wants to compare an expected/reference UI with an actual implementation. This tool is specialized for UI quality assurance and design-to-implementation verification. Do NOT use for: general image comparison, error diagnosis, or analyzing single UIs.',
      parameters: {
        expected_image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        actual_image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'Instructions for the comparison. Specify what aspects to focus on or what level of detail is needed.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return vision('ui_diff_check', UI_DIFF_CHECK_PROMPT, args.prompt,
          [
            { type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.expected_image_source, 'expected_image_source', 'ui_diff_check')) } },
            { type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.actual_image_source, 'actual_image_source', 'ui_diff_check')) } },
          ],
          exec.signal)
      },
    }))
  }

  if (enabled.has('analyze_image')) {
    ctx.tools.register(defineTool({
      name: 'analyze_image',
      description: 'General-purpose image analysis for scenarios not covered by specialized tools. Use this tool as a FALLBACK when none of the other specialized tools (ui_to_artifact, extract_text_from_screenshot, diagnose_error_screenshot, understand_technical_diagram, analyze_data_visualization, ui_diff_check) fit the user\'s need. This tool provides flexible image understanding for any visual content.',
      parameters: {
        image_source: { type: 'string', required: true, description: 'Local file path or remote URL to the image' },
        prompt: { type: 'string', required: true, description: 'Detailed description of what you want to analyze, extract, or understand from the image. Be specific about your requirements.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return vision('analyze_image', GENERAL_IMAGE_ANALYSIS_PROMPT, args.prompt,
          [{ type: 'image_url', image_url: { url: encodeImageSource(nonEmpty(args.image_source, 'image_source', 'analyze_image')) } }],
          exec.signal)
      },
    }))
  }

  if (enabled.has('analyze_video')) {
    ctx.tools.register(defineTool({
      name: 'analyze_video',
      description: 'Analyze video content using advanced AI vision models. Use this tool when the user wants to: understand what happens in a video, extract key moments or actions from video, analyze video content, scenes, or sequences, get descriptions of video footage, identify objects, people, or activities in video. Supports both local files and remote URL. Maximum file size: 8MB. Supports MP4, MOV, M4V formats.',
      parameters: {
        video_source: { type: 'string', required: true, description: 'Local file path or remote URL to the video (supports MP4, MOV, M4V)' },
        prompt: { type: 'string', required: true, description: 'Detailed text prompt describing what to analyze, extract, or understand from the video' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        return vision('analyze_video', GENERAL_IMAGE_ANALYSIS_PROMPT, args.prompt,
          [{ type: 'video_url', video_url: { url: encodeVideoSource(nonEmpty(args.video_source, 'video_source', 'analyze_video')) } }],
          exec.signal)
      },
    }))
  }
}
