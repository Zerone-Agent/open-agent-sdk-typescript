/**
 * GrepTool - Search file contents using regex
 * Cross-platform: uses ripgrep (rg) or grep on Unix, pure Node.js fallback on Windows
 */

import { spawn } from 'child_process'
import { resolve, relative, join } from 'path'
import { readdir, readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'

// Simple glob to regex conversion
function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/\\]*')
    .replace(/\?/g, '.')
    .replace(/\{\{GLOBSTAR\}\}/g, '.*')
  return new RegExp(`^${escaped}$`)
}

// Check if filename matches glob pattern
function matchesGlob(filename: string, glob: string): boolean {
  // Handle brace expansion like *.{js,jsx}
  if (glob.includes('{') && glob.includes('}')) {
    const match = glob.match(/^(.*)\{([^}]+)\}(.*)$/)
    if (match) {
      const [, prefix, options, suffix] = match
      const variants = options.split(',').map((opt) => opt.trim())
      return variants.some((variant) => matchesGlob(filename, prefix + variant + suffix))
    }
  }
  return globToRegex(glob).test(filename)
}

// Get file extension for type filtering
function getFileType(filepath: string): string {
  const ext = filepath.split('.').pop()?.toLowerCase()
  if (!ext) return ''
  // Map common extensions to types
  const typeMap: Record<string, string> = {
    ts: 'ts',
    tsx: 'ts',
    js: 'js',
    jsx: 'js',
    py: 'py',
    rs: 'rs',
    go: 'go',
    java: 'java',
    cpp: 'cpp',
    cc: 'cpp',
    c: 'c',
    h: 'c',
    hpp: 'cpp',
    md: 'md',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    html: 'html',
    css: 'css',
    scss: 'css',
    sass: 'css',
    sql: 'sql',
    sh: 'sh',
    bash: 'sh',
    zsh: 'sh',
    ps1: 'ps',
    psd1: 'ps',
    psm1: 'ps',
  }
  return typeMap[ext] || ext
}

// Recursively get files matching criteria
async function* getFiles(
  dir: string,
  options: {
    glob?: string
    type?: string
  }
): AsyncGenerator<string> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = join(dir, entry.name)

      if (entry.isDirectory()) {
        // Skip common directories that shouldn't be searched
        if (['node_modules', '.git', '.svn', '.hg', 'dist', 'build', '.next', '.nuxt', 'coverage', '.cache'].includes(entry.name)) {
          continue
        }
        yield* getFiles(fullPath, options)
      } else if (entry.isFile()) {
        // Check glob filter
        if (options.glob && !matchesGlob(entry.name, options.glob)) {
          continue
        }

        // Check type filter
        if (options.type && getFileType(fullPath) !== options.type) {
          continue
        }

        yield fullPath
      }
    }
  } catch {
    // Skip directories we can't read
  }
}

// Pure Node.js grep implementation
async function nodeGrep(
  pattern: string,
  searchPath: string,
  options: {
    ignoreCase?: boolean
    outputMode?: string
    lineNumbers?: boolean
    contextBefore?: number
    contextAfter?: number
    glob?: string
    type?: string
    headLimit?: number
  }
): Promise<string> {
  const flags = options.ignoreCase ? 'i' : ''
  let regex: RegExp

  try {
    regex = new RegExp(pattern, flags)
  } catch (e) {
    return `Invalid regex pattern: ${pattern}`
  }

  const results: string[] = []
  const filesWithMatches = new Set<string>()
  const matchCounts = new Map<string, number>()

  try {
    const pathStat = await stat(searchPath)

    if (pathStat.isFile()) {
      // Search single file
      await searchFile(searchPath, searchPath, regex, options, results, filesWithMatches, matchCounts)
    } else {
      // Search directory
      for await (const file of getFiles(searchPath, { glob: options.glob, type: options.type })) {
        if (results.length >= (options.headLimit || 250)) break
        await searchFile(file, searchPath, regex, options, results, filesWithMatches, matchCounts)
      }
    }
  } catch (e) {
    return `Error accessing path: ${searchPath}`
  }

  if (options.outputMode === 'files_with_matches') {
    if (filesWithMatches.size === 0) {
      return `No matches found for pattern "${pattern}"`
    }
    const files = Array.from(filesWithMatches).sort()
    if (files.length > (options.headLimit || 250)) {
      return files.slice(0, options.headLimit || 250).join('\n') + `\n... (${files.length - (options.headLimit || 250)} more files)`
    }
    return files.join('\n')
  }

  if (options.outputMode === 'count') {
    if (matchCounts.size === 0) {
      return `No matches found for pattern "${pattern}"`
    }
    const counts = Array.from(matchCounts.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([file, count]) => `${file}:${count}`)
    return counts.join('\n')
  }

  // content mode
  if (results.length === 0) {
    return `No matches found for pattern "${pattern}"`
  }

  if (results.length > (options.headLimit || 250)) {
    return results.slice(0, options.headLimit || 250).join('\n') + `\n... (${results.length - (options.headLimit || 250)} more)`
  }

  return results.join('\n')
}

// Search a single file
async function searchFile(
  filePath: string,
  basePath: string,
  regex: RegExp,
  options: {
    outputMode?: string
    lineNumbers?: boolean
    contextBefore?: number
    contextAfter?: number
    headLimit?: number
  },
  results: string[],
  filesWithMatches: Set<string>,
  matchCounts: Map<string, number>
): Promise<void> {
  try {
    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')
    const relativePath = relative(basePath, filePath)
    let fileMatchCount = 0

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        fileMatchCount++

        if (options.outputMode === 'files_with_matches') {
          filesWithMatches.add(relativePath)
          return // No need to continue scanning this file
        }

        if (options.outputMode === 'count') {
          continue // Just count, don't output
        }

        // Content mode with optional context
        const lineNum = i + 1

        // Add context lines before
        if (options.contextBefore) {
          for (let j = Math.max(0, i - options.contextBefore); j < i; j++) {
            const ctxLineNum = j + 1
            const ctxLine = lines[j]
            if (options.lineNumbers !== false) {
              results.push(`${relativePath}:${ctxLineNum}:${ctxLine}`)
            } else {
              results.push(ctxLine)
            }
          }
        }

        // Add the matching line
        const line = lines[i]
        if (options.lineNumbers !== false) {
          results.push(`${relativePath}:${lineNum}:${line}`)
        } else {
          results.push(line)
        }

        // Add context lines after
        if (options.contextAfter) {
          for (let j = i + 1; j < Math.min(lines.length, i + 1 + options.contextAfter); j++) {
            const ctxLineNum = j + 1
            const ctxLine = lines[j]
            if (options.lineNumbers !== false) {
              results.push(`${relativePath}:${ctxLineNum}:${ctxLine}`)
            } else {
              results.push(ctxLine)
            }
          }
        }

        if (results.length >= (options.headLimit || 250)) {
          break
        }
      }
    }

    if (fileMatchCount > 0) {
      matchCounts.set(relativePath, fileMatchCount)
    }
  } catch {
    // Skip files we can't read (binary, permission issues, etc.)
  }
}

export const GrepTool = defineTool({
  name: 'Grep',
  description: 'Search file contents using regex patterns. Uses ripgrep (rg) if available, falls back to grep on Unix, or pure Node.js implementation on Windows. Supports file type filtering and context lines.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for',
      },
      path: {
        type: 'string',
        description: 'File or directory to search in (defaults to cwd)',
      },
      glob: {
        type: 'string',
        description: 'Glob pattern to filter files (e.g., "*.ts", "*.{js,jsx}")',
      },
      type: {
        type: 'string',
        description: 'File type filter (e.g., "ts", "py", "js")',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files_with_matches', 'count'],
        description: 'Output mode (default: files_with_matches)',
      },
      '-i': {
        type: 'boolean',
        description: 'Case insensitive search',
      },
      '-n': {
        type: 'boolean',
        description: 'Show line numbers (default: true)',
      },
      '-A': { type: 'number', description: 'Lines after match' },
      '-B': { type: 'number', description: 'Lines before match' },
      '-C': { type: 'number', description: 'Context lines' },
      context: { type: 'number', description: 'Context lines (alias for -C)' },
      head_limit: { type: 'number', description: 'Limit output entries (default: 250)' },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchPath = input.path ? resolve(context.cwd, input.path) : context.cwd
    const outputMode = input.output_mode || 'files_with_matches'
    const headLimit = input.head_limit ?? 250

    // Build rg command (fall back to grep if rg unavailable, then Node.js)
    const args: string[] = []

    // Try ripgrep first
    let cmd = 'rg'

    if (outputMode === 'files_with_matches') {
      args.push('--files-with-matches')
    } else if (outputMode === 'count') {
      args.push('--count')
    } else {
      // content mode
      if (input['-n'] !== false) args.push('--line-number')
    }

    if (input['-i']) args.push('--ignore-case')
    if (input['-A']) args.push('-A', String(input['-A']))
    if (input['-B']) args.push('-B', String(input['-B']))
    const ctx = input['-C'] ?? input.context
    if (ctx) args.push('-C', String(ctx))
    if (input.glob) args.push('--glob', input.glob)
    if (input.type) args.push('--type', input.type)

    args.push('--', input.pattern, searchPath)

    return new Promise<string>((resolvePromise) => {
      const proc = spawn(cmd, args, {
        cwd: context.cwd,
        timeout: 30000,
      })

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true })
      }

      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.stderr?.on('data', (d: Buffer) => errChunks.push(d))

      proc.on('close', async (code) => {
        let result = Buffer.concat(chunks).toString('utf-8').trim()

        if (!result && code !== 0) {
          // Try fallback to grep
          const grepArgs = ['-r']
          if (input['-i']) grepArgs.push('-i')
          if (outputMode === 'files_with_matches') grepArgs.push('-l')
          if (outputMode === 'count') grepArgs.push('-c')
          if (outputMode === 'content' && input['-n'] !== false) grepArgs.push('-n')
          if (input.glob) grepArgs.push('--include', input.glob)
          grepArgs.push('--', input.pattern, searchPath)

          const grepProc = spawn('grep', grepArgs, {
            cwd: context.cwd,
            timeout: 30000,
          })

          if (context.abortSignal) {
            context.abortSignal.addEventListener('abort', () => grepProc.kill('SIGTERM'), { once: true })
          }

          const grepChunks: Buffer[] = []
          grepProc.stdout?.on('data', (d: Buffer) => grepChunks.push(d))
          grepProc.on('close', async () => {
            const grepResult = Buffer.concat(grepChunks).toString('utf-8').trim()
            if (!grepResult) {
              const nodeResult = await nodeGrep(input.pattern, searchPath, {
                ignoreCase: input['-i'],
                outputMode,
                lineNumbers: input['-n'] !== false,
                contextBefore: input['-B'] ?? (ctx ? Math.floor(ctx / 2) : 0),
                contextAfter: input['-A'] ?? (ctx ? Math.ceil(ctx / 2) : 0),
                glob: input.glob,
                type: input.type,
                headLimit,
              })
              resolvePromise(nodeResult)
            } else {
              const lines = grepResult.split('\n')
              if (headLimit > 0 && lines.length > headLimit) {
                resolvePromise(lines.slice(0, headLimit).join('\n') + `\n... (${lines.length - headLimit} more)`)
              } else {
                resolvePromise(grepResult)
              }
            }
          })
          grepProc.on('error', async () => {
            const nodeResult = await nodeGrep(input.pattern, searchPath, {
              ignoreCase: input['-i'],
              outputMode,
              lineNumbers: input['-n'] !== false,
              contextBefore: input['-B'] ?? (ctx ? Math.floor(ctx / 2) : 0),
              contextAfter: input['-A'] ?? (ctx ? Math.ceil(ctx / 2) : 0),
              glob: input.glob,
              type: input.type,
              headLimit,
            })
            resolvePromise(nodeResult)
          })
          return
        }

        if (!result) {
          resolvePromise(`No matches found for pattern "${input.pattern}"`)
          return
        }

        const lines = result.split('\n')
        if (headLimit > 0 && lines.length > headLimit) {
          result = lines.slice(0, headLimit).join('\n') + `\n... (${lines.length - headLimit} more)`
        }

        resolvePromise(result)
      })

      proc.on('error', async () => {
        const grepArgs = ['-r', '-n', '--', input.pattern, searchPath]
        const grepProc = spawn('grep', grepArgs, {
          cwd: context.cwd,
          timeout: 30000,
        })

        if (context.abortSignal) {
          context.abortSignal.addEventListener('abort', () => grepProc.kill('SIGTERM'), { once: true })
        }

        const grepChunks: Buffer[] = []
        grepProc.stdout?.on('data', (d: Buffer) => grepChunks.push(d))
        grepProc.on('close', async () => {
          const grepResult = Buffer.concat(grepChunks).toString('utf-8').trim()
          if (grepResult) {
            resolvePromise(grepResult)
          } else {
            const nodeResult = await nodeGrep(input.pattern, searchPath, {
              ignoreCase: input['-i'],
              outputMode,
              lineNumbers: input['-n'] !== false,
              contextBefore: input['-B'] ?? (ctx ? Math.floor(ctx / 2) : 0),
              contextAfter: input['-A'] ?? (ctx ? Math.ceil(ctx / 2) : 0),
              glob: input.glob,
              type: input.type,
              headLimit,
            })
            resolvePromise(nodeResult)
          }
        })
        grepProc.on('error', async () => {
          const nodeResult = await nodeGrep(input.pattern, searchPath, {
            ignoreCase: input['-i'],
            outputMode,
            lineNumbers: input['-n'] !== false,
            contextBefore: input['-B'] ?? (ctx ? Math.floor(ctx / 2) : 0),
            contextAfter: input['-A'] ?? (ctx ? Math.ceil(ctx / 2) : 0),
            glob: input.glob,
            type: input.type,
            headLimit,
          })
          resolvePromise(nodeResult)
        })
      })
    })
  },
})
