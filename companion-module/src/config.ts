import { SomeCompanionConfigField, Regex } from '@companion-module/base'

export interface ModuleConfig {
	host: string
	port: number
	pollInterval: number
}

export function getConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'textinput',
			id: 'host',
			label: 'Server IP / Hostname',
			width: 8,
			default: '127.0.0.1',
			regex: Regex.IP,
		},
		{
			type: 'number',
			id: 'port',
			label: 'API Port',
			width: 4,
			default: 3000,
			min: 1,
			max: 65535,
		},
		{
			type: 'number',
			id: 'pollInterval',
			label: 'Poll Interval (ms)',
			width: 4,
			default: 2000,
			min: 500,
			max: 30000,
			tooltip: 'How often to poll the server for status updates',
		},
	]
}
