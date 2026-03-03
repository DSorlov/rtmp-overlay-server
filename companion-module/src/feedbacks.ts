import {
	CompanionFeedbackDefinitions,
	combineRgb,
} from '@companion-module/base'

interface ModuleInstance {
	getStreams(): import('./api-client').StreamInfo[]
}

export function getFeedbacks(self: ModuleInstance): CompanionFeedbackDefinitions {
	return {
		// ── Stream Running ────────────────────────────────────────
		streamRunning: {
			type: 'boolean',
			name: 'Stream Running',
			description: 'True when the stream is running',
			defaultStyle: {
				bgcolor: combineRgb(0, 128, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return stream?.status === 'running'
			},
		},

		// ── Stream Stopped ────────────────────────────────────────
		streamStopped: {
			type: 'boolean',
			name: 'Stream Stopped',
			description: 'True when the stream is stopped',
			defaultStyle: {
				bgcolor: combineRgb(128, 0, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return !stream || stream.status === 'stopped'
			},
		},

		// ── Stream Error ──────────────────────────────────────────
		streamError: {
			type: 'boolean',
			name: 'Stream Error',
			description: 'True when the stream is in error state',
			defaultStyle: {
				bgcolor: combineRgb(255, 0, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return stream?.status === 'error'
			},
		},

		// ── Stream Starting ───────────────────────────────────────
		streamStarting: {
			type: 'boolean',
			name: 'Stream Starting',
			description: 'True when the stream is starting up',
			defaultStyle: {
				bgcolor: combineRgb(128, 128, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return stream?.status === 'starting'
			},
		},

		// ── Chroma Color Match ────────────────────────────────────
		chromaColorMatch: {
			type: 'boolean',
			name: 'Chroma Color Match',
			description: 'True when the stream chroma key matches the specified color',
			defaultStyle: {
				bgcolor: combineRgb(0, 100, 0),
				color: combineRgb(255, 255, 255),
			},
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
					tooltip: 'Hex color to match against, e.g. #00FF00',
				},
			],
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				const expected = String(feedback.options.color).toUpperCase()
				const actual = (stream.chromaKeyColor || '').toUpperCase()
				return actual === expected
			},
		},

		// ── Background Mode Match ─────────────────────────────────
		backgroundModeMatch: {
			type: 'boolean',
			name: 'Background Mode Match',
			description: 'True when the stream background mode matches the specified mode',
			defaultStyle: {
				bgcolor: combineRgb(0, 80, 80),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				return (stream.backgroundMode ?? 'chroma') === String(feedback.options.mode)
			},
		},

		// ── Template Match ────────────────────────────────────────
		templateMatch: {
			type: 'boolean',
			name: 'Template Match',
			description: 'True when the stream is using the specified template',
			defaultStyle: {
				bgcolor: combineRgb(0, 0, 128),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				return stream.currentTemplate === String(feedback.options.template)
			},
		},

		// ── Audio Mode Match ──────────────────────────────────────
		audioModeMatch: {
			type: 'boolean',
			name: 'Audio Mode Match',
			description: 'True when the stream audio mode matches the specified mode',
			defaultStyle: {
				bgcolor: combineRgb(80, 0, 80),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				return (stream.audioMode ?? 'none') === String(feedback.options.mode)
			},
		},

		// ── Subtitles Enabled ─────────────────────────────────────
		subtitlesEnabled: {
			type: 'boolean',
			name: 'Subtitles Enabled',
			description: 'True when subtitles are enabled on the stream',
			defaultStyle: {
				bgcolor: combineRgb(0, 100, 80),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return stream?.subtitlesEnabled === true
			},
		},

		// ── Subtitle Language Match ───────────────────────────────
		subtitleLanguageMatch: {
			type: 'boolean',
			name: 'Subtitle Language Match',
			description: 'True when the subtitle language matches the specified language',
			defaultStyle: {
				bgcolor: combineRgb(0, 80, 100),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				return (stream.subtitleLanguage ?? 'auto') === String(feedback.options.language)
			},
		},

		// ── Timer Running ─────────────────────────────────────────
		timerRunning: {
			type: 'boolean',
			name: 'Timer Running',
			description: 'True when the timer is actively running on the stream',
			defaultStyle: {
				bgcolor: combineRgb(0, 120, 60),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				return stream?.timer?.running === true
			},
		},

		// ── Timer Direction Match ─────────────────────────────────
		timerDirectionMatch: {
			type: 'boolean',
			name: 'Timer Direction Match',
			description: 'True when the timer direction matches the specified direction',
			defaultStyle: {
				bgcolor: combineRgb(80, 80, 0),
				color: combineRgb(255, 255, 255),
			},
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
			callback: (feedback) => {
				const id = Number(feedback.options.streamId)
				const stream = self.getStreams().find((s) => s.id === id)
				if (!stream) return false
				return (stream.timer?.direction ?? 'down') === String(feedback.options.direction)
			},
		},
	}
}
