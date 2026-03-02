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
	}
}
