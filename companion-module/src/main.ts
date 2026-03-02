import { InstanceBase, runEntrypoint, InstanceStatus, SomeCompanionConfigField } from '@companion-module/base'
import { ModuleConfig, getConfigFields } from './config'
import { ApiClient, StreamInfo, TemplateInfo } from './api-client'
import { getActions } from './actions'
import { getVariables, updateVariables } from './variables'
import { getFeedbacks } from './feedbacks'

class RtmpOverlayInstance extends InstanceBase<ModuleConfig> {
	private client: ApiClient | null = null
	private pollInterval: ReturnType<typeof setInterval> | null = null
	private streams: StreamInfo[] = []
	private templates: string[] = []
	private templatePlaceholders: Record<string, string[]> = {}

	async init(config: ModuleConfig): Promise<void> {
		this.log('info', 'Initializing RTMP Overlay Server module')
		await this.configUpdated(config)
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		// Stop existing polling
		this.stopPolling()

		this.client = new ApiClient(config.host, config.port)

		this.setVariableDefinitions(getVariables())
		this.setActionDefinitions(getActions(this))
		this.setFeedbackDefinitions(getFeedbacks(this))

		// Initial fetch
		await this.refreshState()

		// Poll for state updates
		const interval = Math.max(config.pollInterval ?? 2000, 500)
		this.pollInterval = setInterval(() => {
			this.refreshState().catch((err) => {
				this.log('debug', `Poll error: ${err.message}`)
			})
		}, interval)

		this.updateStatus(InstanceStatus.Ok)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return getConfigFields()
	}

	async destroy(): Promise<void> {
		this.stopPolling()
		this.client = null
		this.log('info', 'RTMP Overlay Server module destroyed')
	}

	private stopPolling(): void {
		if (this.pollInterval) {
			clearInterval(this.pollInterval)
			this.pollInterval = null
		}
	}

	/**
	 * Refresh all state from the API and update variables
	 */
	async refreshState(): Promise<void> {
		if (!this.client) return

		try {
			const [streamsRes, templatesRes] = await Promise.all([
				this.client.getStreams(),
				this.client.getTemplates(),
			])

			this.streams = streamsRes.streams
			this.templates = templatesRes.templates
			this.templatePlaceholders = templatesRes.placeholders

			updateVariables(this, this.streams)
			this.checkFeedbacks()
			this.updateStatus(InstanceStatus.Ok)
		} catch (err: any) {
			this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
		}
	}

	getClient(): ApiClient | null {
		return this.client
	}

	getStreams(): StreamInfo[] {
		return this.streams
	}

	getTemplates(): string[] {
		return this.templates
	}

	getTemplatePlaceholders(): Record<string, string[]> {
		return this.templatePlaceholders
	}
}

runEntrypoint(RtmpOverlayInstance, [])
