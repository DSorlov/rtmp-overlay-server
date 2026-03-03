import http from 'http'

export interface TimerInfo {
	running: boolean
	direction: 'up' | 'down'
	duration: number
	remaining: number
	display: string
}

export interface StreamInfo {
	id: number
	status: string
	rtmpUrl: string
	streamName: string
	currentTemplate: string
	placeholderData: Record<string, string>
	enabled: boolean
	chromaKeyColor: string
	backgroundMode: 'chroma' | 'alpha' | 'luma'
	lumaInverted: boolean
	audioMode: 'none' | 'template' | 'device'
	audioDevice: string
	subtitlesEnabled: boolean
	subtitleLanguage: string
	timer: TimerInfo
	error?: string
}

export interface TemplateInfo {
	templates: string[]
	placeholders: Record<string, string[]>
}

/**
 * HTTP client for the RTMP Overlay Server REST API
 */
export class ApiClient {
	private host: string
	private port: number

	constructor(host: string, port: number) {
		this.host = host
		this.port = port
	}

	private request(method: string, path: string, body?: any): Promise<any> {
		return new Promise((resolve, reject) => {
			const bodyStr = body ? JSON.stringify(body) : undefined
			const options: http.RequestOptions = {
				hostname: this.host,
				port: this.port,
				path,
				method,
				headers: {
					'Content-Type': 'application/json',
					...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
				},
				timeout: 5000,
			}

			const req = http.request(options, (res) => {
				let data = ''
				res.on('data', (chunk) => (data += chunk))
				res.on('end', () => {
					try {
						const parsed = JSON.parse(data)
						if (res.statusCode && res.statusCode >= 400) {
							reject(new Error(parsed.error || `HTTP ${res.statusCode}`))
						} else {
							resolve(parsed)
						}
					} catch {
						reject(new Error(`Invalid JSON response: ${data.slice(0, 200)}`))
					}
				})
			})

			req.on('error', reject)
			req.on('timeout', () => {
				req.destroy(new Error('Request timed out'))
			})

			if (bodyStr) req.write(bodyStr)
			req.end()
		})
	}

	async getStreams(): Promise<{ streams: StreamInfo[] }> {
		return this.request('GET', '/api/streams')
	}

	async getStream(id: number): Promise<StreamInfo> {
		return this.request('GET', `/api/streams/${id}`)
	}

	async startStream(id: number): Promise<any> {
		return this.request('POST', `/api/streams/${id}/start`)
	}

	async stopStream(id: number): Promise<any> {
		return this.request('POST', `/api/streams/${id}/stop`)
	}

	async setTemplate(id: number, template: string): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/template`, { template })
	}

	async setData(id: number, data: Record<string, string>): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/data`, data)
	}

	async updateData(id: number, data: Record<string, string>): Promise<any> {
		return this.request('PATCH', `/api/streams/${id}/data`, data)
	}

	async getTemplates(): Promise<TemplateInfo> {
		return this.request('GET', '/api/templates')
	}

	async getStats(): Promise<{ stats: Record<string, any> }> {
		return this.request('GET', '/api/stats')
	}

	async setChromaColor(id: number, color: string): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/chroma`, { color })
	}

	async setBackgroundMode(id: number, mode: 'chroma' | 'alpha' | 'luma'): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/background-mode`, { mode })
	}

	async setLumaInverted(id: number, inverted: boolean): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/luma-inverted`, { inverted })
	}

	async setAudioMode(id: number, mode: 'none' | 'template' | 'device'): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/audio-mode`, { mode })
	}

	async setAudioDevice(id: number, device: string): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/audio-device`, { device })
	}

	async setStreamKey(id: number, key: string): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/stream-key`, { key })
	}

	async setSubtitlesEnabled(id: number, enabled: boolean): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/subtitles-enabled`, { enabled })
	}

	async setSubtitleLanguage(id: number, language: string): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/subtitle-language`, { language })
	}

	async executeFunction(id: number, fnName: string, argument?: string): Promise<any> {
		return this.request('POST', `/api/streams/${id}/execute`, { function: fnName, argument })
	}

	async setTimerDuration(id: number, seconds: number): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/timer/duration`, { seconds })
	}

	async setTimerDirection(id: number, direction: 'up' | 'down'): Promise<any> {
		return this.request('PUT', `/api/streams/${id}/timer/direction`, { direction })
	}

	async startTimer(id: number): Promise<any> {
		return this.request('POST', `/api/streams/${id}/timer/start`)
	}

	async stopTimer(id: number): Promise<any> {
		return this.request('POST', `/api/streams/${id}/timer/stop`)
	}

	async resetTimer(id: number): Promise<any> {
		return this.request('POST', `/api/streams/${id}/timer/reset`)
	}
}
