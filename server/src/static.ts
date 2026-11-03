import { existsSync, statSync } from 'node:fs'
import { extname, join, resolve, sep } from 'node:path'

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

export function safeStaticPath(root: string, urlPath: string): string | null {
  let pathname: string
  try {
    pathname = decodeURIComponent(urlPath.split('?')[0] ?? '/')
  } catch {
    return null
  }

  if (pathname.includes('\0')) {
    return null
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^[/\\]+/, '')
  const rootPath = resolve(root)
  const fullPath = resolve(rootPath, relative)
  const insideRoot = fullPath === rootPath || fullPath.startsWith(rootPath + sep)
  return insideRoot ? fullPath : null
}

export type ResolvedClientFile =
  | { ok: true; filePath: string }
  | { ok: false; status: 400 | 404 }

function fileIfPresent(filePath: string): string | null {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return null
  }
  return filePath
}

export function resolveClientFile(clientDir: string, urlPath: string): ResolvedClientFile {
  const staticPath = safeStaticPath(clientDir, urlPath)
  if (!staticPath) {
    return { ok: false, status: 400 }
  }

  if (existsSync(staticPath) && statSync(staticPath).isDirectory()) {
    const directoryIndex = fileIfPresent(join(staticPath, 'index.html'))
    if (directoryIndex) {
      return { ok: true, filePath: directoryIndex }
    }
  }

  const directFile = fileIfPresent(staticPath)
  if (directFile) {
    return { ok: true, filePath: directFile }
  }

  const pathname = urlPath.split('?')[0] ?? '/'
  if (extname(pathname) !== '') {
    return { ok: false, status: 404 }
  }

  const indexPath = safeStaticPath(clientDir, '/index.html')
  const indexFile = indexPath ? fileIfPresent(indexPath) : null
  if (!indexFile) {
    return { ok: false, status: 404 }
  }

  return { ok: true, filePath: indexFile }
}
