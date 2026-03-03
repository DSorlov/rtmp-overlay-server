import { CompanionVariableDefinition, InstanceBase } from '@companion-module/base'
import { StreamInfo } from './api-client'

/**
 * Variable definitions for up to 12 streams.
 * Variables follow the pattern: stream_N_<property>
 */
export function getVariables(): CompanionVariableDefinition[] {
	const vars: CompanionVariableDefinition[] = []

	for (let i = 1; i <= 12; i++) {
		vars.push(
			{
				variableId: `stream_${i}_status`,
				name: `Stream ${i} Status`,
			},
			{
				variableId: `stream_${i}_template`,
				name: `Stream ${i} Template`,
			},
			{
				variableId: `stream_${i}_stream_name`,
				name: `Stream ${i} Stream Name`,
			},
			{
				variableId: `stream_${i}_rtmp_url`,
				name: `Stream ${i} RTMP URL`,
			},
			{
				variableId: `stream_${i}_chroma_color`,
				name: `Stream ${i} Chroma Key Color`,
			},
			{
				variableId: `stream_${i}_background_mode`,
				name: `Stream ${i} Background Mode`,
			},
			{
				variableId: `stream_${i}_luma_inverted`,
				name: `Stream ${i} Luma Inverted`,
			},
			{
				variableId: `stream_${i}_audio_mode`,
				name: `Stream ${i} Audio Mode`,
			},
			{
				variableId: `stream_${i}_audio_device`,
				name: `Stream ${i} Audio Device`,
			},
			{
				variableId: `stream_${i}_subtitles_enabled`,
				name: `Stream ${i} Subtitles Enabled`,
			},
			{
				variableId: `stream_${i}_subtitle_language`,
				name: `Stream ${i} Subtitle Language`,
			},
			{
				variableId: `stream_${i}_error`,
				name: `Stream ${i} Error`,
			},
			{
				variableId: `stream_${i}_timer_display`,
				name: `Stream ${i} Timer Display`,
			},
			{
				variableId: `stream_${i}_timer_running`,
				name: `Stream ${i} Timer Running`,
			},
			{
				variableId: `stream_${i}_timer_direction`,
				name: `Stream ${i} Timer Direction`,
			},
		)
	}

	// Total stream count
	vars.push({
		variableId: 'stream_count',
		name: 'Total Stream Count',
	})

	// Count of running streams
	vars.push({
		variableId: 'streams_running',
		name: 'Running Stream Count',
	})

	return vars
}

/**
 * Update variable values from the current stream states.
 */
export function updateVariables(self: InstanceBase<any>, streams: StreamInfo[]): void {
	const values: Record<string, string | undefined> = {}

	for (let i = 1; i <= 12; i++) {
		const stream = streams.find((s) => s.id === i)

		if (stream) {
			values[`stream_${i}_status`] = stream.status
			values[`stream_${i}_template`] = stream.currentTemplate
			values[`stream_${i}_stream_name`] = stream.streamName
			values[`stream_${i}_rtmp_url`] = stream.rtmpUrl
			values[`stream_${i}_chroma_color`] = stream.chromaKeyColor ?? ''
			values[`stream_${i}_background_mode`] = stream.backgroundMode ?? 'chroma'
			values[`stream_${i}_luma_inverted`] = String(stream.lumaInverted ?? false)
			values[`stream_${i}_audio_mode`] = stream.audioMode ?? 'none'
			values[`stream_${i}_audio_device`] = stream.audioDevice ?? ''
			values[`stream_${i}_subtitles_enabled`] = String(stream.subtitlesEnabled ?? false)
			values[`stream_${i}_subtitle_language`] = stream.subtitleLanguage ?? 'auto'
			values[`stream_${i}_error`] = stream.error ?? ''
			values[`stream_${i}_timer_display`] = stream.timer?.display ?? ''
			values[`stream_${i}_timer_running`] = String(stream.timer?.running ?? false)
			values[`stream_${i}_timer_direction`] = stream.timer?.direction ?? 'down'
		} else {
			values[`stream_${i}_status`] = 'N/A'
			values[`stream_${i}_template`] = ''
			values[`stream_${i}_stream_name`] = ''
			values[`stream_${i}_rtmp_url`] = ''
			values[`stream_${i}_chroma_color`] = ''
			values[`stream_${i}_background_mode`] = ''
			values[`stream_${i}_luma_inverted`] = ''
			values[`stream_${i}_audio_mode`] = ''
			values[`stream_${i}_audio_device`] = ''
			values[`stream_${i}_subtitles_enabled`] = ''
			values[`stream_${i}_subtitle_language`] = ''
			values[`stream_${i}_error`] = ''
			values[`stream_${i}_timer_display`] = ''
			values[`stream_${i}_timer_running`] = ''
			values[`stream_${i}_timer_direction`] = ''
		}
	}

	values['stream_count'] = String(streams.length)
	values['streams_running'] = String(streams.filter((s) => s.status === 'running').length)

	self.setVariableValues(values)
}
