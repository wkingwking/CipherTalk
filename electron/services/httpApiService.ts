import * as http from 'http'
import { URL } from 'url'
import { app } from 'electron'
import { ConfigService } from './config'
import { chatService } from './chatService'

interface ApiEnvelopeSuccess<T> {
  success: true
  data: T
  meta: {
    ts: number
    requestId: string
  }
}

interface ApiEnvelopeError {
  success: false
  error: {
    code: string
    message: string
    hint?: string
  }
  meta: {
    ts: number
    requestId: string
  }
}

interface HttpApiSettings {
  enabled: boolean
  host: string
  port: number
  token: string
}

type ContactType = 'friend' | 'group' | 'official' | 'former_friend' | 'other'
type SessionTypeFilter = 'friend' | 'group' | 'official' | 'other'

class HttpApiService {
  private server: http.Server | null = null
  private readonly connections: Set<import('net').Socket> = new Set()
  private settings: HttpApiSettings = {
    enabled: false,
    host: '127.0.0.1',
    port: 5031,
    token: ''
  }
  private startedAt = 0
  private startError = ''

  applySettings(next: Partial<HttpApiSettings>): void {
    this.settings = {
      ...this.settings,
      ...next,
      host: '127.0.0.1'
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (!this.settings.enabled) {
      return { success: true }
    }

    if (this.server) {
      return { success: true }
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res))

      server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.startError = err.message
        if (err.code === 'EADDRINUSE') {
          resolve({ success: false, error: `端口 ${this.settings.port} 已被占用` })
          return
        }
        resolve({ success: false, error: err.message })
      })

      server.listen(this.settings.port, this.settings.host, () => {
        this.server = server
        this.startedAt = Date.now()
        this.startError = ''
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return

    const currentServer = this.server
    this.server = null

    const sockets = Array.from(this.connections)
    this.connections.clear()
    sockets.forEach((socket) => {
      try {
        socket.destroy()
      } catch {
        // ignore
      }
    })

    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve())
    })
  }

  async restart(): Promise<{ success: boolean; error?: string }> {
    await this.stop()
    if (!this.settings.enabled) return { success: true }
    return this.start()
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  getUiStatus() {
    const uptimeMs = this.server && this.startedAt ? Date.now() - this.startedAt : 0
    return {
      running: this.isRunning(),
      host: this.settings.host,
      port: this.settings.port,
      enabled: this.settings.enabled,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
      uptimeMs,
      tokenConfigured: Boolean(this.settings.token),
      tokenPreview: this.getTokenPreview(),
      baseUrl: this.getBaseUrl(),
      endpoints: [
        { method: 'GET', path: '/v1', desc: '接口详情' },
        { method: 'GET', path: '/v1/health', desc: '健康检查' },
        { method: 'GET', path: '/v1/status', desc: '服务状态' },
        { method: 'GET', path: '/v1/sessions', desc: '会话列表' },
        { method: 'GET', path: '/v1/contacts', desc: '联系人列表' }
      ],
      lastError: this.startError
    }
  }

  private getBaseUrl(): string {
    return `http://${this.settings.host}:${this.settings.port}/v1`
  }

  private getTokenPreview(): string {
    if (!this.settings.token) return ''
    if (this.settings.token.length <= 6) return '******'
    return `${this.settings.token.slice(0, 3)}***${this.settings.token.slice(-3)}`
  }

  private isAuthRequired(pathname: string): boolean {
    if (!this.settings.token) return false
    return pathname !== '/v1' && pathname !== '/v1/' && pathname !== '/v1/health'
  }

  private createRequestId(): string {
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
  }

  private sendJson<T>(
    res: http.ServerResponse,
    statusCode: number,
    payload: ApiEnvelopeSuccess<T> | ApiEnvelopeError
  ): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private sendRedirect(res: http.ServerResponse, to: string): void {
    res.writeHead(307, {
      Location: to,
      'Cache-Control': 'no-store'
    })
    res.end()
  }

  private success<T>(requestId: string, data: T): ApiEnvelopeSuccess<T> {
    return {
      success: true,
      data,
      meta: {
        ts: Date.now(),
        requestId
      }
    }
  }

  private failure(requestId: string, code: string, message: string, hint?: string): ApiEnvelopeError {
    return {
      success: false,
      error: { code, message, hint },
      meta: {
        ts: Date.now(),
        requestId
      }
    }
  }

  private handleCors(res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  }

  private extractAuthToken(req: http.IncomingMessage): string {
    const authHeader = req.headers.authorization
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader
    if (authValue) {
      const match = authValue.match(/^Bearer\s+(.+)$/i)
      if (match?.[1]) {
        return match[1].trim()
      }
    }
    return ''
  }

  private parseBoolean(value: string | null, defaultValue: boolean): boolean {
    if (value === null) return defaultValue
    const normalized = value.trim().toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return defaultValue
  }

  private parseIntInRange(value: string | null, defaultValue: number, min: number, max: number): number {
    if (!value) return defaultValue
    const n = Number.parseInt(value, 10)
    if (!Number.isFinite(n)) return defaultValue
    return Math.max(min, Math.min(max, n))
  }

  private parseTypeFilter(value: string | null): Set<ContactType> | null {
    if (!value) return null
    const allowed: ContactType[] = ['friend', 'group', 'official', 'former_friend', 'other']
    const result = new Set<ContactType>()
    value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .forEach((x) => {
        if (allowed.includes(x as ContactType)) {
          result.add(x as ContactType)
        }
      })
    return result.size > 0 ? result : null
  }

  private parseSessionTypeFilter(value: string | null): Set<SessionTypeFilter> | null {
    if (!value) return null
    const allowed: SessionTypeFilter[] = ['friend', 'group', 'official', 'other']
    const result = new Set<SessionTypeFilter>()
    value
      .split(',')
      .map((x) => x.trim().toLowerCase())
      .forEach((x) => {
        if (allowed.includes(x as SessionTypeFilter)) {
          result.add(x as SessionTypeFilter)
        }
      })
    return result.size > 0 ? result : null
  }

  private detectSessionType(username: string): SessionTypeFilter {
    if (username.includes('@chatroom')) return 'group'
    if (username.startsWith('gh_')) return 'official'
    if (username) return 'friend'
    return 'other'
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    this.handleCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const requestId = this.createRequestId()
    const method = req.method || 'GET'

    if (method !== 'GET') {
      this.sendJson(res, 405, this.failure(requestId, 'METHOD_NOT_ALLOWED', 'Only GET is supported'))
      return
    }

    const url = new URL(req.url || '/', `http://${this.settings.host}:${this.settings.port}`)
    const pathname = url.pathname

    // 兼容旧路径：无版本前缀时重定向到 /v1
    if (pathname === '/health') {
      this.sendRedirect(res, '/v1/health')
      return
    }
    if (pathname === '/status') {
      this.sendRedirect(res, '/v1/status')
      return
    }
    if (pathname === '/api/v1' || pathname === '/api/v1/') {
      this.sendRedirect(res, '/v1')
      return
    }
    if (pathname === '/api/v1/health') {
      this.sendRedirect(res, '/v1/health')
      return
    }
    if (pathname === '/api/v1/status') {
      this.sendRedirect(res, '/v1/status')
      return
    }
    if (pathname === '/api/v1/sessions') {
      this.sendRedirect(res, '/v1/sessions')
      return
    }
    if (pathname === '/api/v1/contacts') {
      this.sendRedirect(res, '/v1/contacts')
      return
    }
    if (pathname === '/') {
      this.sendRedirect(res, '/v1')
      return
    }

    if (this.isAuthRequired(pathname)) {
      const provided = this.extractAuthToken(req)
      if (!provided || provided !== this.settings.token) {
        this.sendJson(
          res,
          401,
          this.failure(
            requestId,
            'UNAUTHORIZED',
            'Invalid or missing Authorization Bearer token',
            'Use header: Authorization: Bearer <token>'
          )
        )
        return
      }
    }

    if (pathname === '/v1' || pathname === '/v1/') {
      this.sendJson(res, 200, this.success(requestId, {
        name: 'CipherTalk Embedded HTTP API',
        version: '1.0.0',
        baseUrl: this.getBaseUrl(),
        authHeader: 'Authorization: Bearer <token>',
        endpoints: this.getUiStatus().endpoints,
        status: this.getUiStatus()
      }))
      return
    }

    if (pathname === '/v1/health') {
      this.sendJson(res, 200, this.success(requestId, {
        status: 'ok'
      }))
      return
    }

    if (pathname === '/v1/status') {
      const configService = new ConfigService()
      const hasDbPath = Boolean(configService.get('dbPath'))
      const hasWxid = Boolean(configService.get('myWxid'))
      const hasDecryptKey = Boolean(configService.get('decryptKey'))
      configService.close()
      const verbose = url.searchParams.get('verbose') === '1'

      const isApiEnabled = this.settings.enabled
      const isApiRunning = this.isRunning()
      const isDbConfigReady = hasDbPath && hasWxid && hasDecryptKey

      let state: 'ready' | 'disabled' | 'starting_or_error' | 'needs_config' = 'ready'
      let message = 'HTTP API is ready for external calls.'

      if (!isApiEnabled) {
        state = 'disabled'
        message = 'HTTP API is disabled. Enable it in Settings > Open API.'
      } else if (!isApiRunning) {
        state = 'starting_or_error'
        message = this.startError || 'HTTP API is enabled but not running. Try restart in settings.'
      } else if (!isDbConfigReady) {
        state = 'needs_config'
        message = 'API is running, but database-related features need dbPath/decryptKey/wxid configuration.'
      }

      const basePayload = {
        summary: {
          state,
          usable: isApiEnabled && isApiRunning,
          message
        },
        server: {
          running: isApiRunning,
          enabled: isApiEnabled,
          host: this.settings.host,
          port: this.settings.port,
          uptimeMs: this.server && this.startedAt ? Date.now() - this.startedAt : 0
        },
        auth: {
          required: Boolean(this.settings.token),
          scheme: 'Authorization: Bearer <token>'
        },
        config: {
          dbConfigReady: isDbConfigReady
        }
      }

      if (!verbose) {
        this.sendJson(res, 200, this.success(requestId, basePayload))
        return
      }

      this.sendJson(res, 200, this.success(requestId, {
        ...basePayload,
        usage: {
          baseUrl: this.getBaseUrl(),
          health: '/v1/health',
          status: '/v1/status',
          auth: this.settings.token ? 'Authorization: Bearer <token>' : 'No auth token required'
        },
        app: {
          version: app.getVersion(),
          electronVersion: process.versions.electron,
          nodeVersion: process.versions.node,
          platform: process.platform
        },
        debug: {
          checks: {
            apiEnabled: isApiEnabled,
            apiRunning: isApiRunning,
            dbConfigReady: isDbConfigReady,
            authRequired: Boolean(this.settings.token)
          },
          tokenPreview: this.getTokenPreview(),
          startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : '',
          lastError: this.startError
        }
      }))
      return
    }

    if (pathname === '/v1/sessions') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const typeFilter = this.parseSessionTypeFilter(url.searchParams.get('type'))
      const unreadOnly = this.parseBoolean(url.searchParams.get('unreadOnly'), false)
      const sort = (url.searchParams.get('sort') || 'sortTimestamp_desc').trim()
      const offset = this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000)
      const limit = this.parseIntInRange(url.searchParams.get('limit'), 100, 1, 500)

      const sessionsResult = await chatService.getSessions()
      if (!sessionsResult.success) {
        this.sendJson(
          res,
          503,
          this.failure(
            requestId,
            'DB_NOT_CONNECTED',
            sessionsResult.error || 'Failed to read sessions',
            'Please complete DB decrypt/setup in Settings and ensure data is available.'
          )
        )
        return
      }

      let sessions = (sessionsResult.sessions || []).map((item) => {
        const sessionType = this.detectSessionType(item.username || '')
        return {
          username: item.username,
          displayName: item.displayName || item.username,
          avatarUrl: item.avatarUrl,
          summary: item.summary,
          unreadCount: item.unreadCount || 0,
          sortTimestamp: item.sortTimestamp || 0,
          lastTimestamp: item.lastTimestamp || 0,
          lastMsgType: item.lastMsgType || 0,
          sessionType
        }
      })

      if (typeFilter) {
        sessions = sessions.filter((item) => typeFilter.has(item.sessionType))
      }

      if (unreadOnly) {
        sessions = sessions.filter((item) => Number(item.unreadCount || 0) > 0)
      }

      if (q) {
        sessions = sessions.filter((item) => {
          const username = String(item.username || '').toLowerCase()
          const displayName = String(item.displayName || '').toLowerCase()
          const summary = String(item.summary || '').toLowerCase()
          return username.includes(q) || displayName.includes(q) || summary.includes(q)
        })
      }

      if (sort === 'name_asc') {
        sessions.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
      } else if (sort === 'name_desc') {
        sessions.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
      } else if (sort === 'lastTimestamp_asc') {
        sessions.sort((a, b) => Number(a.lastTimestamp || 0) - Number(b.lastTimestamp || 0))
      } else if (sort === 'lastTimestamp_desc') {
        sessions.sort((a, b) => Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
      } else if (sort === 'unreadCount_desc') {
        sessions.sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0))
      } else {
        sessions.sort((a, b) => Number(b.sortTimestamp || 0) - Number(a.sortTimestamp || 0))
      }

      const total = sessions.length
      const paged = sessions.slice(offset, offset + limit)
      const hasMore = offset + paged.length < total

      this.sendJson(res, 200, this.success(requestId, {
        total,
        offset,
        limit,
        hasMore,
        sort,
        filters: {
          q,
          type: typeFilter ? Array.from(typeFilter) : null,
          unreadOnly
        },
        sessions: paged
      }))
      return
    }

    if (pathname === '/v1/contacts') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase()
      const typeFilter = this.parseTypeFilter(url.searchParams.get('type'))
      const includeAvatar = this.parseBoolean(url.searchParams.get('includeAvatar'), true)
      const sort = (url.searchParams.get('sort') || 'lastContactTime_desc').trim()
      const offset = this.parseIntInRange(url.searchParams.get('offset'), 0, 0, 100000)
      const limit = this.parseIntInRange(url.searchParams.get('limit'), 100, 1, 500)

      const contactsResult = await chatService.getContacts()
      if (!contactsResult.success) {
        this.sendJson(
          res,
          503,
          this.failure(
            requestId,
            'DB_NOT_CONNECTED',
            contactsResult.error || 'Failed to read contacts',
            'Please complete DB decrypt/setup in Settings and ensure data is available.'
          )
        )
        return
      }

      let contacts = (contactsResult.contacts || []) as Array<Record<string, any>>

      if (typeFilter) {
        contacts = contacts.filter((item) => typeFilter.has((item.type || 'other') as ContactType))
      }

      if (q) {
        contacts = contacts.filter((item) => {
          const username = String(item.username || '').toLowerCase()
          const displayName = String(item.displayName || '').toLowerCase()
          const remark = String(item.remark || '').toLowerCase()
          const nickname = String(item.nickname || '').toLowerCase()
          return (
            username.includes(q) ||
            displayName.includes(q) ||
            remark.includes(q) ||
            nickname.includes(q)
          )
        })
      }

      if (sort === 'name_asc') {
        contacts.sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || ''), 'zh-CN'))
      } else if (sort === 'name_desc') {
        contacts.sort((a, b) => String(b.displayName || '').localeCompare(String(a.displayName || ''), 'zh-CN'))
      } else if (sort === 'lastContactTime_asc') {
        contacts.sort((a, b) => Number((a as any).lastContactTime || 0) - Number((b as any).lastContactTime || 0))
      } else {
        contacts.sort((a, b) => Number((b as any).lastContactTime || 0) - Number((a as any).lastContactTime || 0))
      }

      const total = contacts.length
      const paged = contacts.slice(offset, offset + limit)
      const hasMore = offset + paged.length < total

      const finalContacts = paged.map((item) => {
        if (includeAvatar) return item
        const { avatarUrl, ...rest } = item
        return rest
      })

      this.sendJson(res, 200, this.success(requestId, {
        total,
        offset,
        limit,
        hasMore,
        sort,
        filters: {
          q,
          type: typeFilter ? Array.from(typeFilter) : null,
          includeAvatar
        },
        contacts: finalContacts
      }))
      return
    }

    this.sendJson(
      res,
      404,
      this.failure(
        requestId,
        'NOT_FOUND',
        'Route not found',
        'Try GET /v1 for API overview, or use /v1/health and /v1/status'
      )
    )
  }
}

export const httpApiService = new HttpApiService()
