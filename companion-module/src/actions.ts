import {
	CompanionActionDefinitions,
	CompanionActionEvent,
} from '@companion-module/base'

// Forward reference — the instance type is imported only for typing
interface ModuleInstance {
	getClient(): import('./api-client').ApiClient | null
	getTemplates(): string[]
	getStreams(): import('./api-client').StreamInfo[]
	refreshState(): Promise<void>
	log(level: string, msg: string): void
}

export function getActions(self: ModuleInstance): CompanionActionDefinitions {
	return {
		// ── Start Stream ──────────────────────────────────────────
		startStream: {
			name: 'Start Stream',
			description: 'Start an overlay stream',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.startStream(Number(action.options.streamId))
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Start stream failed: ${err.message}`)
				}
			},
		},

		// ── Stop Stream ───────────────────────────────────────────
		stopStream: {
			name: 'Stop Stream',
			description: 'Stop an overlay stream',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.stopStream(Number(action.options.streamId))
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Stop stream failed: ${err.message}`)
				}
			},
		},

		// ── Toggle Stream ─────────────────────────────────────────
		toggleStream: {
			name: 'Toggle Stream',
			description: 'Start the stream if stopped, stop it if running',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				const id = Number(action.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				try {
					if (stream?.status === 'running') {
						await client.stopStream(id)
					} else {
						await client.startStream(id)
					}
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Toggle stream failed: ${err.message}`)
				}
			},
		},

		// ── Set Template ──────────────────────────────────────────
		setTemplate: {
			name: 'Set Template',
			description: 'Change the HTML template for a stream',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
				{
					type: 'textinput',
					id: 'template',
					label: 'Template Name',
					default: 'lower-third.html',
					tooltip: 'e.g. lower-third.html, scoreboard.html',
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setTemplate(
						Number(action.options.streamId),
						String(action.options.template),
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set template failed: ${err.message}`)
				}
			},
		},

		// ── Set Placeholder Value ─────────────────────────────────
		setPlaceholder: {
			name: 'Set Placeholder Value',
			description: 'Set a single placeholder value on a stream',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
				{
					type: 'textinput',
					id: 'key',
					label: 'Placeholder Key',
					default: '',
					tooltip: 'The placeholder name (e.g. title, name, score_home)',
				},
				{
					type: 'textinput',
					id: 'value',
					label: 'Value',
					default: '',
					useVariables: true,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				const key = String(action.options.key)
				const value = String(action.options.value)
				if (!key) return
				try {
					await client.updateData(Number(action.options.streamId), { [key]: value })
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set placeholder failed: ${err.message}`)
				}
			},
		},

		// ── Set All Placeholders ──────────────────────────────────
		setAllPlaceholders: {
			name: 'Set All Placeholders (JSON)',
			description: 'Replace all placeholder values with a JSON object',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
				{
					type: 'textinput',
					id: 'json',
					label: 'JSON Data',
					default: '{}',
					tooltip: 'JSON object, e.g. {"title":"Breaking News","subtitle":"Live"}',
					useVariables: true,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					const data = JSON.parse(String(action.options.json))
					await client.setData(Number(action.options.streamId), data)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set all placeholders failed: ${err.message}`)
				}
			},
		},

		// ── Set Chroma Key Color ──────────────────────────────────
		setChromaColor: {
			name: 'Set Chroma Key Color',
			description: 'Set the chroma key background color for a stream',
			options: [
				{
					type: 'number',
					id: 'streamId',
					label: 'Stream ID',
					default: 1,
					min: 1,
					max: 12,
				},
				{
					type: 'textinput',
					id: 'color',
					label: 'Color (hex)',
					default: '#00FF00',
					tooltip: 'Hex color code, e.g. #00FF00 for green',
					useVariables: true,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setChromaColor(
						Number(action.options.streamId),
						String(action.options.color),
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set chroma color failed: ${err.message}`)
				}
			},
		},
	}
}
