/**
 * WebSearchTool - Web search via Exa AI MCP service
 */

import { defineTool } from './types.js'

const EXA_MCP_URL = 'https://mcp.exa.ai/mcp'
const DEFAULT_TIMEOUT = 25000

interface McpRequest {
  jsonrpc: '2.0'
  id: number
  method: 'tools/call'
  params: {
    name: string
    arguments: Record<string, unknown>
  }
}

interface McpResponse {
  result?: {
    content?: Array<{ type: string; text: string }>
  }
  error?: {
    message: string
  }
}

function parseSse(body: string): McpResponse | null {
  const lines = body.split('\n')
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6))
      } catch {
        continue
      }
    }
  }
  return null
}

export const WebSearchTool = defineTool({
  name: 'WebSearch',
  description:
    'Search the web using Exa AI for real-time information. Returns results with titles, URLs, and snippets. Use for current events, recent data, or information beyond knowledge cutoff.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The search query',
      },
      numResults: {
        type: 'number',
        description: 'Number of results to return (default: 8)',
      },
      livecrawl: {
        type: 'string',
        enum: ['fallback', 'preferred'],
        description:
          "Live crawl mode - 'fallback': use if cached unavailable, 'preferred': prioritize live crawling",
      },
      type: {
        type: 'string',
        enum: ['auto', 'fast', 'deep'],
        description: "Search type - 'auto': balanced, 'fast': quick, 'deep': comprehensive",
      },
    },
    required: ['query'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const { query, numResults = 8, livecrawl = 'fallback', type = 'auto' } = input

    const request: McpRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'web_search_exa',
        arguments: { query, type, numResults, livecrawl },
      },
    }

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT)

      const signals = [controller.signal]
      if (context.abortSignal) signals.push(context.abortSignal)

      const response = await fetch(EXA_MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(request),
        signal: AbortSignal.any(signals),
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        return { data: `Search failed: HTTP ${response.status}`, is_error: true }
      }

      const body = await response.text()
      const mcpResponse = parseSse(body)

      if (mcpResponse?.error) {
        return { data: `Search error: ${mcpResponse.error.message}`, is_error: true }
      }

      if (mcpResponse?.result?.content?.[0]?.text) {
        return mcpResponse.result.content[0].text
      }

      return `No results found for "${query}"`
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return { data: 'Search timeout after 25 seconds', is_error: true }
      }
      return { data: `Search error: ${err.message}`, is_error: true }
    }
  },
})