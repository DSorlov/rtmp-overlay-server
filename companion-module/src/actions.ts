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

		// ── Set Background Mode ───────────────────────────────────
		setBackgroundMode: {
			name: 'Set Background Mode',
			description: 'Switch between chroma key, alpha channel, or luma key background mode',
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
					type: 'dropdown',
					id: 'mode',
					label: 'Background Mode',
					default: 'chroma',
					choices: [
						{ id: 'chroma', label: 'Chroma Key' },
						{ id: 'alpha', label: 'Alpha Channel' },
						{ id: 'luma', label: 'Luma Key' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setBackgroundMode(
						Number(action.options.streamId),
						action.options.mode as 'chroma' | 'alpha' | 'luma',
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set background mode failed: ${err.message}`)
				}
			},
		},

		// ── Set Luma Inverted ──────────────────────────────────────
		setLumaInverted: {
			name: 'Set Luma Invert',
			description: 'Toggle between black and white background for luma keying',
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
					type: 'dropdown',
					id: 'inverted',
					label: 'Background',
					default: 'false',
					choices: [
						{ id: 'false', label: 'Black (default)' },
						{ id: 'true', label: 'White (inverted)' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setLumaInverted(
						Number(action.options.streamId),
						action.options.inverted === 'true',
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set luma inverted failed: ${err.message}`)
				}
			},
		},

		// ── Set Audio Mode ────────────────────────────────────────
		setAudioMode: {
			name: 'Set Audio Mode',
			description: 'Switch between none, template page audio, or device audio input',
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
					type: 'dropdown',
					id: 'mode',
					label: 'Audio Mode',
					default: 'none',
					choices: [
						{ id: 'none', label: 'None (silent)' },
						{ id: 'template', label: 'Template Audio' },
						{ id: 'device', label: 'Device Input' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setAudioMode(
						Number(action.options.streamId),
						action.options.mode as 'none' | 'template' | 'device',
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set audio mode failed: ${err.message}`)
				}
			},
		},

		// ── Set Stream Key ────────────────────────────────────────
		setStreamKey: {
			name: 'Set Stream Key',
			description: 'Change the RTMP stream key (path) for a stream',
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
					label: 'Stream Key',
					default: 'overlay1',
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				const key = String(action.options.key || '').trim()
				if (!key) return
				try {
					await client.setStreamKey(Number(action.options.streamId), key)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set stream key failed: ${err.message}`)
				}
			},
		},

		// ── Set Subtitles Enabled ──────────────────────────────────
		setSubtitlesEnabled: {
			name: 'Set Subtitles',
			description: 'Enable or disable live subtitle generation',
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
					type: 'dropdown',
					id: 'enabled',
					label: 'Subtitles',
					default: 'false',
					choices: [
						{ id: 'false', label: 'Off' },
						{ id: 'true', label: 'On' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setSubtitlesEnabled(
						Number(action.options.streamId),
						action.options.enabled === 'true',
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set subtitles failed: ${err.message}`)
				}
			},
		},

		// ── Set Subtitle Language ─────────────────────────────────
		setSubtitleLanguage: {
			name: 'Set Subtitle Language',
			description: 'Set the language for speech recognition (auto-detect or specific)',
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
					type: 'dropdown',
					id: 'language',
					label: 'Language',
					default: 'auto',
					choices: [
						{ id: 'auto', label: 'Auto-detect' },
						{ id: 'af', label: 'Afrikaans' },
						{ id: 'am', label: 'Amharic' },
						{ id: 'ar', label: 'Arabic' },
						{ id: 'as', label: 'Assamese' },
						{ id: 'az', label: 'Azerbaijani' },
						{ id: 'ba', label: 'Bashkir' },
						{ id: 'be', label: 'Belarusian' },
						{ id: 'bg', label: 'Bulgarian' },
						{ id: 'bn', label: 'Bengali' },
						{ id: 'bo', label: 'Tibetan' },
						{ id: 'br', label: 'Breton' },
						{ id: 'bs', label: 'Bosnian' },
						{ id: 'ca', label: 'Catalan' },
						{ id: 'cs', label: 'Czech' },
						{ id: 'cy', label: 'Welsh' },
						{ id: 'da', label: 'Danish' },
						{ id: 'de', label: 'German' },
						{ id: 'el', label: 'Greek' },
						{ id: 'en', label: 'English' },
						{ id: 'es', label: 'Spanish' },
						{ id: 'et', label: 'Estonian' },
						{ id: 'eu', label: 'Basque' },
						{ id: 'fa', label: 'Persian' },
						{ id: 'fi', label: 'Finnish' },
						{ id: 'fo', label: 'Faroese' },
						{ id: 'fr', label: 'French' },
						{ id: 'gl', label: 'Galician' },
						{ id: 'gu', label: 'Gujarati' },
						{ id: 'ha', label: 'Hausa' },
						{ id: 'haw', label: 'Hawaiian' },
						{ id: 'he', label: 'Hebrew' },
						{ id: 'hi', label: 'Hindi' },
						{ id: 'hr', label: 'Croatian' },
						{ id: 'ht', label: 'Haitian Creole' },
						{ id: 'hu', label: 'Hungarian' },
						{ id: 'hy', label: 'Armenian' },
						{ id: 'id', label: 'Indonesian' },
						{ id: 'is', label: 'Icelandic' },
						{ id: 'it', label: 'Italian' },
						{ id: 'ja', label: 'Japanese' },
						{ id: 'jw', label: 'Javanese' },
						{ id: 'ka', label: 'Georgian' },
						{ id: 'kk', label: 'Kazakh' },
						{ id: 'km', label: 'Khmer' },
						{ id: 'kn', label: 'Kannada' },
						{ id: 'ko', label: 'Korean' },
						{ id: 'la', label: 'Latin' },
						{ id: 'lb', label: 'Luxembourgish' },
						{ id: 'ln', label: 'Lingala' },
						{ id: 'lo', label: 'Lao' },
						{ id: 'lt', label: 'Lithuanian' },
						{ id: 'lv', label: 'Latvian' },
						{ id: 'mg', label: 'Malagasy' },
						{ id: 'mi', label: 'Maori' },
						{ id: 'mk', label: 'Macedonian' },
						{ id: 'ml', label: 'Malayalam' },
						{ id: 'mn', label: 'Mongolian' },
						{ id: 'mr', label: 'Marathi' },
						{ id: 'ms', label: 'Malay' },
						{ id: 'mt', label: 'Maltese' },
						{ id: 'my', label: 'Myanmar' },
						{ id: 'ne', label: 'Nepali' },
						{ id: 'nl', label: 'Dutch' },
						{ id: 'nn', label: 'Nynorsk' },
						{ id: 'no', label: 'Norwegian' },
						{ id: 'oc', label: 'Occitan' },
						{ id: 'pa', label: 'Punjabi' },
						{ id: 'pl', label: 'Polish' },
						{ id: 'ps', label: 'Pashto' },
						{ id: 'pt', label: 'Portuguese' },
						{ id: 'ro', label: 'Romanian' },
						{ id: 'ru', label: 'Russian' },
						{ id: 'sa', label: 'Sanskrit' },
						{ id: 'sd', label: 'Sindhi' },
						{ id: 'si', label: 'Sinhala' },
						{ id: 'sk', label: 'Slovak' },
						{ id: 'sl', label: 'Slovenian' },
						{ id: 'sn', label: 'Shona' },
						{ id: 'so', label: 'Somali' },
						{ id: 'sq', label: 'Albanian' },
						{ id: 'sr', label: 'Serbian' },
						{ id: 'su', label: 'Sundanese' },
						{ id: 'sv', label: 'Swedish' },
						{ id: 'sw', label: 'Swahili' },
						{ id: 'ta', label: 'Tamil' },
						{ id: 'te', label: 'Telugu' },
						{ id: 'tg', label: 'Tajik' },
						{ id: 'th', label: 'Thai' },
						{ id: 'tk', label: 'Turkmen' },
						{ id: 'tl', label: 'Tagalog' },
						{ id: 'tr', label: 'Turkish' },
						{ id: 'tt', label: 'Tatar' },
						{ id: 'uk', label: 'Ukrainian' },
						{ id: 'ur', label: 'Urdu' },
						{ id: 'uz', label: 'Uzbek' },
						{ id: 'vi', label: 'Vietnamese' },
						{ id: 'yi', label: 'Yiddish' },
						{ id: 'yo', label: 'Yoruba' },
						{ id: 'zh', label: 'Chinese' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setSubtitleLanguage(
						Number(action.options.streamId),
						String(action.options.language),
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Set subtitle language failed: ${err.message}`)
				}
			},
		},

		// ── Call Template Function ─────────────────────────────────
		callFunction: {
			name: 'Call Template Function',
			description: 'Call a global JavaScript function defined in the template',
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
					id: 'functionName',
					label: 'Function Name',
					default: '',
					tooltip: 'Name of a global window function (e.g. startTimer, showAlert)',
				},
				{
					type: 'textinput',
					id: 'argument',
					label: 'Argument',
					default: '',
					tooltip: 'String or JSON data to pass to the function',
					useVariables: true,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				const fnName = String(action.options.functionName || '').trim()
				if (!fnName) return
				try {
					await client.executeFunction(
						Number(action.options.streamId),
						fnName,
						String(action.options.argument || ''),
					)
				} catch (err: any) {
					self.log('error', `Call function failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Start ──────────────────────────────────────────
		timerStart: {
			name: 'Timer Start',
			description: 'Start the timer on a stream',
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
					await client.startTimer(Number(action.options.streamId))
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer start failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Stop ───────────────────────────────────────────
		timerStop: {
			name: 'Timer Stop',
			description: 'Stop (pause) the timer on a stream',
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
					await client.stopTimer(Number(action.options.streamId))
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer stop failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Toggle ─────────────────────────────────────────
		timerToggle: {
			name: 'Timer Toggle',
			description: 'Start the timer if stopped, stop it if running',
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
					if (stream?.timer?.running) {
						await client.stopTimer(id)
					} else {
						await client.startTimer(id)
					}
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer toggle failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Reset ──────────────────────────────────────────
		timerReset: {
			name: 'Timer Reset',
			description: 'Reset the timer back to its configured duration',
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
					await client.resetTimer(Number(action.options.streamId))
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer reset failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Set Duration ───────────────────────────────────
		timerSetDuration: {
			name: 'Timer Set Duration',
			description: 'Set the timer duration in seconds',
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
					type: 'number',
					id: 'seconds',
					label: 'Duration (seconds)',
					default: 300,
					min: 0,
					max: 86400,
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				try {
					await client.setTimerDuration(
						Number(action.options.streamId),
						Number(action.options.seconds),
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer set duration failed: ${err.message}`)
				}
			},
		},

		// ── Timer: Set Direction ──────────────────────────────────
		timerSetDirection: {
			name: 'Timer Set Direction',
			description: 'Set the timer direction (count up or down)',
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
					type: 'dropdown',
					id: 'direction',
					label: 'Direction',
					default: 'down',
					choices: [
						{ id: 'down', label: 'Count Down' },
						{ id: 'up', label: 'Count Up' },
					],
				},
			],
			callback: async (action: CompanionActionEvent) => {
				const client = self.getClient()
				if (!client) return
				const dir = String(action.options.direction) as 'up' | 'down'
				try {
					await client.setTimerDirection(
						Number(action.options.streamId),
						dir,
					)
					await self.refreshState()
				} catch (err: any) {
					self.log('error', `Timer set direction failed: ${err.message}`)
				}
			},
		},
	}
}
