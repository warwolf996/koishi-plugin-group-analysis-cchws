import { Context, h, Service, Session } from 'koishi'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import {
    AnalysisPromptContext,
    GoldenQuote,
    GroupAnalysisResult,
    PersonaCache,
    PersonaRecord,
    QueryAction,
    QueryIntent,
    StoredMessage,
    SummaryTopic,
    UserPersonaProfile,
    UserTitle
} from '../types'
import { Config } from '..'
import {
    buildGroupAnalysisCacheKey,
    buildPersonaRecordId,
    calculateBasicStats,
    formatMessagesForPersona,
    formatPersonaForPrompt,
    generateActiveHoursChart,
    generateTextReport,
    getAvatarUrl,
    getStartTimeByDays,
    isCacheExpiredByDays,
    isCacheExpiredByMinutes,
    mergePersona,
    shouldListenToMessage
} from '../utils'
import type { GuildMember } from '@satorijs/protocol'
import type { OneBotBot } from 'koishi-plugin-adapter-onebot'

type AnalysisTarget = {
    guildId?: string
    channelId?: string
}

type GroupAnalysisCacheEntry = {
    result: GroupAnalysisResult
    analyzedAt: Date
}

export class AnalysisService extends Service {
    static readonly inject = [
        'group_analysis_llm',
        'group_analysis_message',
        'group_analysis_renderer'
    ]

    private personaCache = new Map<string, PersonaCache>()
    private personaProcessing = new Set<string>()
    private groupAnalysisCache = new Map<string, GroupAnalysisCacheEntry>()

    constructor(
        ctx: Context,
        public config: Config
    ) {
        super(ctx, 'group_analysis', true)
        this.setupPersonaDatabase()
        this.setupPersonaMessageListener()
    }

    private setupPersonaDatabase() {
        this.ctx.database.extend(
            'group_analysis_user_personas',
            {
                id: {
                    type: 'char',
                    length: 100
                },
                platform: {
                    type: 'char',
                    length: 30
                },
                selfId: { type: 'char', length: 100 },
                userId: { type: 'char', length: 100 },
                username: { type: 'char', length: 254 },
                persona: { type: 'text', nullable: true },
                lastAnalysisAt: { type: 'timestamp', nullable: true },
                updatedAt: { type: 'timestamp', nullable: true }
            },
            {
                primary: 'id'
            }
        )
    }

    private setupPersonaMessageListener() {
        if (this.config.personaAnalysisMessageInterval === 0) {
            this.ctx.logger.info('已关闭自动用户画像分析。')
            return
        }

        this.ctx.group_analysis_message.onUserMessage(
            async (session) => {
                if (
                    !shouldListenToMessage(
                        session,
                        this.config.listenerGroups,
                        this.config.enableAllGroupsByDefault
                    )
                )
                    return

                await this.handleIncomingMessageForPersona(session)
            }
        )
    }

    private async handleIncomingMessageForPersona(session: Session) {
        if (this.config.personaAnalysisMessageInterval === 0) return
        if (!session.userId) return

        // Skip users in personaUserFilter
        if (this.config.personaUserFilter.includes(session.userId)) {
            return
        }

        // 黑名单用户不做画像分析
        if (this.config.personaBlacklist?.includes(session.userId)) {
            return
        }

        const recordId = buildPersonaRecordId(
            session.platform,
            session.selfId,
            session.userId
        )

        const cache = await this.ensurePersonaCache(recordId, {
            platform: session.platform,
            selfId: session.selfId,
            userId: session.userId,
            username: session.username || session.userId
        })

        cache.pendingMessages += 1
        cache.record.username = session.username || cache.record.username

        if (
            cache.pendingMessages >=
                this.config.personaAnalysisMessageInterval &&
            !this.personaProcessing.has(recordId)
        ) {
            this.personaProcessing.add(recordId)

            const sourceGroup = {
                guildId: session.guildId || undefined,
                channelId: session.channelId || undefined,
                platform: session.platform,
                selfId: session.selfId
            }

            // eslint-disable-next-line no-void
            void this.runPersonaAnalysis(cache, sourceGroup)
                .catch((error) =>
                    this.ctx.logger.error(
                        `执行用户画像分析失败 (${recordId}):`,
                        error
                    )
                )
                .finally(() => {
                    this.personaProcessing.delete(recordId)
                    cache.pendingMessages = 0
                })
        }
    }

    private async ensurePersonaCache(
        id: string,
        defaults: Pick<
            PersonaRecord,
            'platform' | 'selfId' | 'userId' | 'username'
        >
    ): Promise<PersonaCache> {
        const cached = this.personaCache.get(id)
        if (cached) return cached

        const existing = await this.ctx.database
            .select('group_analysis_user_personas')
            .where({ id })
            .execute()
            .then((records) => records[0])

        if (existing) {
            if (
                existing.lastAnalysisAt &&
                !(existing.lastAnalysisAt instanceof Date)
            ) {
                existing.lastAnalysisAt = new Date(existing.lastAnalysisAt)
            }
            if (existing.updatedAt && !(existing.updatedAt instanceof Date)) {
                existing.updatedAt = new Date(existing.updatedAt)
            }
        }

        let parsedPersona: UserPersonaProfile | null
        if (existing?.persona) {
            try {
                parsedPersona = yamlLoad(existing.persona) as UserPersonaProfile
            } catch (error) {
                this.ctx.logger.warn(
                    `解析用户画像 YAML 失败 (${id})，将忽略历史画像。`,
                    error
                )
                parsedPersona = null
            }
        }

        const cache: PersonaCache = {
            record:
                existing ||
                ({
                    id,
                    ...defaults
                } as PersonaRecord),
            pendingMessages: 0,
            parsedPersona
        }

        /* if (!existing) {
            await this.ctx.database.create(
                'group_analysis_user_personas',
                cache.record
            )
        } */

        this.personaCache.set(id, cache)
        return cache
    }

    private async runPersonaAnalysis(
        cache: PersonaCache,
        sourceGroup?: {
            guildId?: string
            channelId?: string
            platform: string
            selfId: string
        }
    ) {
        const { record } = cache
        const lookbackStart = getStartTimeByDays(
            this.config.personaLookbackDays
        )

        const historyMessages = await this.collectUserMessagesForPersona(
            record,
            lookbackStart,
            sourceGroup
        )

        if (historyMessages.length < this.config.personaMinMessages) {
            this.ctx.logger.info(
                `用户 ${record.userId} 在设定时间窗内仅收集到 ${historyMessages.length} 条消息，低于触发阈值 ${this.config.personaMinMessages}，跳过画像分析。`
            )
            return
        }

        const promptMessages = formatMessagesForPersona(historyMessages)

        this.ctx.logger.info(
            `开始分析用户 ${record.userId} 的画像 (${record.username})，收集到 ${historyMessages.length} 条消息。`
        )

        const previousText = formatPersonaForPrompt(cache.parsedPersona)

        const persona =
            await this.ctx.group_analysis_llm.analyzeUserPersona(
                record.userId,
                record.username,
                record.roles,
                promptMessages,
                previousText
            )

        if (!persona) {
            this.ctx.logger.warn(`LLM 未返回用户画像结果 (${record.userId})。`)
            return
        }

        const personaWithEvidence = this.attachEvidenceMessageIds(
            persona,
            historyMessages
        )

        const merged = mergePersona(cache.parsedPersona, personaWithEvidence)
        cache.parsedPersona = merged

        await this.persistPersona(record, merged)
    }

    private async collectUserMessagesForPersona(
        record: PersonaRecord,
        startTime: Date,
        sourceGroup?: {
            guildId?: string
            channelId?: string
            platform: string
            selfId: string
        }
    ): Promise<StoredMessage[]> {
        const results: StoredMessage[] = []
        const useOnlyCurrentGroup =
            this.config.personaOnlyCurrentGroup ||
            this.config.enableAllGroupsByDefault
        const relevantGroups = useOnlyCurrentGroup
            ? [
                  {
                      enabled: true,
                      platform: sourceGroup?.platform,
                      selfId: sourceGroup?.selfId,
                      channelId: sourceGroup?.channelId,
                      guildId: sourceGroup?.guildId
                  }
              ].filter(
                  (group) =>
                      !!group.platform &&
                      !!group.selfId &&
                      (!!group.channelId || !!group.guildId)
              )
            : this.config.listenerGroups.filter(
                  (group) =>
                      group.enabled &&
                      group.platform === record.platform &&
                      group.selfId === record.selfId
              )

        if (!relevantGroups.length) {
            const reason = useOnlyCurrentGroup
                ? '未提供可用的当前群组信息'
                : '未在配置中找到监听群组'
            this.ctx.logger.warn(
                `用户 ${record.userId} 画像分析缺少群组上下文（${reason}），跳过画像分析。`
            )
            return []
        }

        const totalLimit = this.config.personaMaxMessages

        for (const group of relevantGroups) {
            const bot = this._getBot(group.selfId)

            let userGroupInfo: GuildMember | null = null

            try {
                if (bot.platform === 'onebot') {
                    userGroupInfo = await (
                        bot as OneBotBot<Context>
                    ).internal.getGroupMemberInfo(
                        group.guildId,
                        record.userId,
                        true
                    )
                } else {
                    userGroupInfo = await bot.getGuildMember(
                        group.channelId || group.guildId,
                        record.userId
                    )
                }

                if (userGroupInfo == null) {
                    continue
                }
            } catch (error) {
                this.ctx.logger.warn(
                    `获取用户 ${record.userId} 的群组信息失败 (${group.channelId || group.guildId})，可能是未加入该群聊。将跳过此群组的信息获取。`,
                    error
                )
                continue
            }

            record.roles = (userGroupInfo.roles || []).map((r) => (typeof r === 'string' ? r : r.name || r.id || ''))

            const history =
                await this.ctx.group_analysis_message.getHistoricalMessages(
                    {
                        guildId: group.guildId,
                        channelId: group.channelId,
                        userId: [record.userId],
                        selfId: group.selfId,
                        startTime,
                        endTime: new Date(),
                        limit: totalLimit,
                        purpose: 'user-persona'
                    }
                )

            results.push(
                ...history.map((message) => ({
                    ...message,
                    guildId: message.guildId ?? group.guildId,
                    channelId: message.channelId ?? group.channelId
                }))
            )

            if (results.length >= totalLimit) {
                break
            }
        }

        results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())

        return results
    }

    private attachEvidenceMessageIds(
        persona: UserPersonaProfile,
        messages: StoredMessage[]
    ): UserPersonaProfile {
        if (!persona.evidence) {
            return persona
        }

        const evidenceEntries = persona.evidence
        const messageIndex: Record<string, StoredMessage> = {}
        const contentIndex: Record<string, StoredMessage> = {}

        const getText = (msg: StoredMessage): string =>
            h
                .select(
                    msg.elements || [h.text(msg.content)],
                    'text'
                )
                .toString()
                .trim()

        for (const message of messages) {
            if (message.messageId && !messageIndex[message.messageId]) {
                messageIndex[message.messageId] = message
            }
            if (message.id && !messageIndex[message.id]) {
                messageIndex[message.id] = message
            }
            const text = getText(message)
            if (text && !contentIndex[text]) {
                contentIndex[text] = message
            }
        }

        const updated: string[] = []

        for (const entry of evidenceEntries) {
            const rawEntry = String(entry).trim()
            // 1) 优先按 ID 匹配
            let resolvedMessage: StoredMessage | undefined =
                messageIndex[rawEntry]

            // 2) 再按内容原文匹配（模型有时返回的是消息文本而非 ID）
            if (!resolvedMessage && contentIndex[rawEntry]) {
                resolvedMessage = contentIndex[rawEntry]
            }

            if (resolvedMessage) {
                updated.push(getText(resolvedMessage))
            } else {
                // 3) 都匹配不上，直接把原文作为引用（如果看起来像一句话）
                if (rawEntry.length > 0) {
                    updated.push(rawEntry)
                } else {
                    this.ctx.logger.warn(
                        `无法找到画像证据 ${entry} 对应的消息，请检查消息服务是否正常。`
                    )
                }
            }
        }

        this.ctx.logger.info(`已解析 ${updated.length} 条画像证据。`)

        return {
            ...persona,
            evidence: updated.length ? updated : []
        }
    }

    private async persistPersona(
        record: PersonaRecord,
        persona: UserPersonaProfile
    ) {
        const now = new Date()
        record.persona = yamlDump(persona, {
            indent: 2,
            lineWidth: -1,
            noRefs: true
        })
        record.lastAnalysisAt = now
        record.updatedAt = now

        await this.ctx.database.upsert('group_analysis_user_personas', [record])
    }

    private async _getGroupHistoryFromMessageService(
        selfId: string,
        target: AnalysisTarget,
        days: number,
        hours = 0,
        minutes = 0
    ): Promise<StoredMessage[]> {
        const targetId = target.guildId || target.channelId
        if (!targetId) {
            this.ctx.logger.warn('执行群分析时缺少有效的群组或频道标识。')
            return []
        }

        const endTime = new Date()
        const durationMinutes = days * 24 * 60 + hours * 60 + minutes
        const hasSubDayWindow = hours > 0 || minutes > 0
        const startTime = hasSubDayWindow
            ? new Date(endTime.getTime() - durationMinutes * 60 * 1000)
            : getStartTimeByDays(days)
        const durationText = [
            days > 0 ? `${days} 天` : '',
            hours > 0 ? `${hours} 小时` : '',
            minutes > 0 ? `${minutes} 分钟` : ''
        ]
            .filter(Boolean)
            .join(' ') || `${days} 天`

        this.ctx.logger.info(
            `开始从消息服务获取群组 ${targetId} 近 ${durationText}的消息记录...`
        )

        const messages =
            await this.ctx.group_analysis_message.getHistoricalMessages(
                {
                    guildId: target.guildId,
                    channelId: target.channelId,
                    startTime,
                    selfId,
                    endTime,
                    limit: this.config.maxMessages,
                    purpose: 'group-analysis'
                }
            )

        this.ctx.logger.info(`从消息服务获取到 ${messages.length} 条消息。`)
        return messages
    }

    private async _getGroupHistoryFromMessageServiceByTimeRange(
        selfId: string,
        target: AnalysisTarget,
        startTime: Date,
        endTime: Date
    ): Promise<StoredMessage[]> {
        const targetId = target.guildId || target.channelId
        if (!targetId) {
            this.ctx.logger.warn('执行群分析时缺少有效的群组或频道标识。')
            return []
        }

        this.ctx.logger.info(
            `开始从消息服务获取群组 ${targetId} ${startTime.toLocaleString()} - ${endTime.toLocaleString()} 的消息记录...`
        )

        const messages =
            await this.ctx.group_analysis_message.getHistoricalMessages(
                {
                    guildId: target.guildId,
                    channelId: target.channelId,
                    startTime,
                    selfId,
                    endTime,
                    limit: this.config.maxMessages,
                    purpose: 'group-analysis'
                }
            )

        this.ctx.logger.info(`从消息服务获取到 ${messages.length} 条消息。`)
        return messages
    }

    private async resolveGroupName(
        selfId: string,
        target: AnalysisTarget
    ): Promise<string> {
        const bot = this._getBot(selfId)
        const fallbackName = target.guildId || target.channelId || 'unknown'
        let groupName = fallbackName
        if (bot) {
            try {
                if (target.guildId) {
                    groupName =
                        (await bot.getGuild(target.guildId)).name || groupName
                } else if (target.channelId && bot.getChannel) {
                    const channel = await bot.getChannel(
                        target.channelId,
                        target.guildId
                    )
                    groupName = channel?.name || groupName
                }
            } catch (err) {
                this.ctx.logger.warn(
                    `获取群组 ${fallbackName} 名称失败: ${err}`
                )
            }
        }
        return groupName
    }

    private normalizeQueryAction(action?: string): QueryAction {
        const normalized = action?.trim()
        if (normalized === '分析加对话' || normalized === '只对话') {
            return normalized
        }
        return '只分析'
    }

    private resolveQueryTimeRange(
        intent: QueryIntent | null,
        fallbackDays: number,
        fallbackHours = 0,
        fallbackMinutes = 0
    ): { start: Date; end: Date; description?: string } {
        const now = new Date()
        let start: Date | undefined
        let end: Date | undefined

        if (intent?.targetTime?.startTime) {
            const parsed = new Date(intent.targetTime.startTime)
            if (!isNaN(parsed.getTime())) start = parsed
        }

        if (intent?.targetTime?.endTime) {
            const parsed = new Date(intent.targetTime.endTime)
            if (!isNaN(parsed.getTime())) end = parsed
        }

        if (!end) end = now
        if (!start) {
            if (fallbackHours > 0 || fallbackMinutes > 0) {
                start = new Date(
                    now.getTime() -
                        (fallbackDays * 24 * 60 +
                            fallbackHours * 60 +
                            fallbackMinutes) *
                            60 *
                            1000
                )
            } else {
                start = getStartTimeByDays(fallbackDays)
            }
        }

        if (start > end) {
            const temp = start
            start = end
            end = temp
        }

        return {
            start,
            end,
            description: intent?.targetTime?.description
        }
    }

    public async executeGroupAnalysis(
        selfId: string,
        target: AnalysisTarget,
        days: number,
        outputFormat?: 'image' | 'pdf' | 'text',
        force?: boolean,
        replySession?: Session,
        deliveryTarget?: AnalysisTarget,
        hours = 0,
        minutes = 0
    ) {
        const bot = this._getBot(selfId)
        const sendTarget =
            deliveryTarget?.channelId || deliveryTarget?.guildId
                ? deliveryTarget
                : target
        const targetChannel = sendTarget.channelId ?? sendTarget.guildId
        const targetGuildContext =
            sendTarget.channelId && sendTarget.guildId
                ? sendTarget.guildId
                : undefined

        if (!targetChannel) {
            this.ctx.logger.warn('执行群分析需要提供 channelId 或 guildId。')
            return
        }

        const sendStatus = async (content: string | h) =>
            replySession
                ? replySession.send(content)
                : bot?.sendMessage(targetChannel, content, targetGuildContext)

        const durationMinutes = days * 24 * 60 + hours * 60 + minutes
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
            await sendStatus('分析时间范围必须大于 0 分钟。')
            return
        }

        let message: h

        try {
            const cacheKey = buildGroupAnalysisCacheKey(
                selfId,
                target,
                days + hours / 24 + minutes / 1440
            )
            const cached = this.groupAnalysisCache.get(cacheKey)
            const cacheExpired = isCacheExpiredByMinutes(
                cached?.analyzedAt,
                this.config.groupAnalysisCacheMinutes
            )
            const shouldRefresh = force || cacheExpired || !cached

            let analysisResult: GroupAnalysisResult

            if (!shouldRefresh && cached) {
                analysisResult = cached.result
            } else {
                const windowText = [
                    days > 0 ? `${days} 天` : '',
                    hours > 0 ? `${hours} 小时` : '',
                    minutes > 0 ? `${minutes} 分钟` : ''
                ]
                    .filter(Boolean)
                    .join(' ') || `${days} 天`
                await sendStatus(`开始分析群聊近 ${windowText}的活动，请稍候...`)

                const messages = await this._getGroupHistoryFromMessageService(
                    selfId,
                    target,
                    days,
                    hours,
                    minutes
                )

                if (messages.length < this.config.minMessages) {
                    await sendStatus(
                        `消息数量（${messages.length}/${this.config.minMessages}）不足于进行进行有效分析。`
                    )
                    return
                }

                this.ctx.logger.info(
                    `群分析已获取 ${messages.length} 条消息，开始智能分析。`
                )

                analysisResult = await this.analyzeGroupMessages(
                    messages,
                    selfId,
                    target
                )

                this.groupAnalysisCache.set(cacheKey, {
                    result: analysisResult,
                    analyzedAt: new Date()
                })
            }

            const format = outputFormat || this.config.outputFormat || 'image'

            switch (format) {
                case 'image':
                    {
                        const image =
                            await this.ctx.group_analysis_renderer.renderGroupAnalysis(
                                analysisResult,
                                this.config
                            )
                        message =
                            typeof image === 'string'
                                ? h.text(image)
                                : h.image(image, 'image/png')
                    }
                    break
                case 'pdf': {
                    const pdfBuffer =
                        await this.ctx.group_analysis_renderer.renderGroupAnalysisToPdf(
                            analysisResult
                        )
                    message = pdfBuffer
                        ? h.file(pdfBuffer, 'application/pdf')
                        : h.text('PDF 渲染失败，请检查日志。')
                    break
                }
                default: {
                    message = h.text(generateTextReport(analysisResult))
                }
            }
        } catch (error) {
            this.ctx.logger.error(
                `为群组 ${target.guildId || target.channelId} 执行分析任务时发生错误:`,
                error
            )
            const errorMessage =
                error instanceof Error ? error.message : '未知错误。'

            message = h.text(
                `分析失败: ${errorMessage}。请检查网络连接和 LLM 配置，或联系管理员。`
            )
        }

        if (replySession) {
            await replySession.send(message)
        } else {
            await bot?.sendMessage(targetChannel, message, targetGuildContext)
        }
    }

    public async executeGroupQuery(
        session: Session,
        target: AnalysisTarget,
        query: string,
        outputFormat?: 'image' | 'pdf' | 'text'
    ) {
        const targetChannel = target.channelId ?? target.guildId

        if (!targetChannel) {
            this.ctx.logger.warn('执行群分析需要提供 channelId 或 guildId。')
            return
        }

        const sendStatus = async (content: string | h) => session.send(content)

        const currentTime = new Date()
        const timeZone =
            Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
        const groupName = await this.resolveGroupName(session.selfId, target)

        this.ctx.logger.info(`收到群分析请求，开始解析用户请求: ${query}`)

        const intent =
            await this.ctx.group_analysis_llm.parseGroupQuery({
                query,
                currentTime: currentTime.toLocaleString('zh-CN', {
                    hour12: false
                }),
                timeZone,
                platform: session.platform,
                groupName,
                guildId: target.guildId,
                channelId: target.channelId,
                currentUserId: session.userId,
                currentUserName: session.username || session.userId
            })

        if (!intent) {
            await sendStatus('未能解析你的请求，请换个说法再试。')
            return
        }

        const action = this.normalizeQueryAction(intent.action)
        const timeRange = this.resolveQueryTimeRange(
            intent,
            this.config.cronAnalysisDays ?? 1,
            this.config.cronAnalysisHours ?? 0,
            this.config.cronAnalysisMinutes ?? 0
        )

        this.ctx.logger.info(
            `准备获取消息记录: ${timeRange.start.toLocaleString()} - ${timeRange.end.toLocaleString()}`
        )

        const messages =
            await this._getGroupHistoryFromMessageServiceByTimeRange(
                session.selfId,
                target,
                timeRange.start,
                timeRange.end
            )

        if (messages.length < this.config.minMessages) {
            await sendStatus(
                `消息数量（${messages.length}/${this.config.minMessages}）不足于进行有效分析。`
            )
            return
        }

        this.ctx.logger.info(
            `群分析已获取 ${messages.length} 条消息，开始智能分析。`
        )

        const keywords = Array.isArray(intent.keywords)
            ? intent.keywords.filter(Boolean)
            : intent.keywords
              ? [String(intent.keywords)]
              : []
        const topics = Array.isArray(intent.topics)
            ? intent.topics.filter(Boolean)
            : intent.topics
              ? [String(intent.topics)]
              : []
        const nicknames = Array.isArray(intent.nicknames)
            ? intent.nicknames.filter(Boolean)
            : intent.nicknames
              ? [String(intent.nicknames)]
              : []

        const analysisContext: AnalysisPromptContext = {
            keywords,
            topics,
            nicknames,
            query,
            timeRange
        }

        const analysisResult = await this.analyzeGroupMessages(
            messages,
            session.selfId,
            target,
            analysisContext
        )

        const textReport = generateTextReport(analysisResult)
        const format = outputFormat || this.config.outputFormat || 'image'

        if (action !== '只对话') {
            let reportMessage: h
            switch (format) {
                case 'image':
                    {
                        const image =
                            await this.ctx.group_analysis_renderer.renderGroupAnalysis(
                                analysisResult,
                                this.config
                            )
                        reportMessage =
                            typeof image === 'string'
                                ? h.text(image)
                                : h.image(image, 'image/png')
                    }
                    break
                case 'pdf': {
                    const pdfBuffer =
                        await this.ctx.group_analysis_renderer.renderGroupAnalysisToPdf(
                            analysisResult
                        )
                    reportMessage = pdfBuffer
                        ? h.file(pdfBuffer, 'application/pdf')
                        : h.text('PDF 渲染失败，请检查日志。')
                    break
                }
                default: {
                    reportMessage = h.text(textReport)
                }
            }

            await sendStatus(reportMessage)
        }

        if (action !== '只分析') {
            const reply =
                await this.ctx.group_analysis_llm.replyGroupQuery({
                    query,
                    analysisResult: textReport,
                    currentTime: currentTime.toLocaleString('zh-CN', {
                        hour12: false
                    }),
                    groupName,
                    guildId: target.guildId,
                    channelId: target.channelId,
                    currentUserId: session.userId,
                    currentUserName: session.username || session.userId
                })

            if (reply?.length) {
                await sendStatus(reply)
            } else {
                await sendStatus('对话生成失败，请稍后再试。')
            }
        }
    }

    public async executeCustomAnalysis(
        session: Session,
        target: AnalysisTarget,
        prompt: string,
        days: number,
        hours = 0,
        minutes = 0
    ) {
        const targetChannel = target.channelId ?? target.guildId

        if (!targetChannel) {
            this.ctx.logger.warn('执行自定义分析需要提供 channelId 或 guildId。')
            return
        }

        const sendStatus = async (content: string | h) => session.send(content)

        const durationMinutes = Math.floor(
            days * 24 * 60 + hours * 60 + minutes
        )
        if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
            await sendStatus('自定义提示词分析时间范围必须大于 0 分钟。')
            return
        }
        const durationText = [
            days > 0 ? `${days} 天` : '',
            hours > 0 ? `${hours} 小时` : '',
            minutes > 0 ? `${minutes} 分钟` : ''
        ]
            .filter(Boolean)
            .join(' ') || `${durationMinutes} 分钟`

        this.ctx.logger.info(
            `收到自定义提示词分析请求 (群: ${targetChannel}，范围: 近 ${durationText})。`
        )

        try {
            await sendStatus(
                `开始使用自定义提示词分析近 ${durationText}的聊天记录，请稍候...`
            )

            const endTime = new Date()
            const startTime = new Date(
                endTime.getTime() - durationMinutes * 60 * 1000
            )
            const messages = await this._getGroupHistoryFromMessageServiceByTimeRange(
                session.selfId,
                target,
                startTime,
                endTime
            )

            if (messages.length < this.config.minMessages) {
                await sendStatus(
                    `消息数量（${messages.length}/${this.config.minMessages}）不足于进行有效分析。`
                )
                return
            }

            const { allMessagesText } = calculateBasicStats(messages)
            const messagesText = allMessagesText.join('\n')

            this.ctx.logger.info(
                `自定义分析已获取 ${messages.length} 条消息，开始调用 LLM。`
            )

            const result =
                await this.ctx.group_analysis_llm.runCustomAnalysis(
                    prompt,
                    messagesText
                )

            this.ctx.logger.info('自定义分析完成，开始发送结果。')
            for (const chunk of this._splitTextForSend(result)) {
                await sendStatus(h.text(chunk))
            }
        } catch (error) {
            this.ctx.logger.error(
                `为群组 ${target.guildId || target.channelId} 执行自定义分析时发生错误:`,
                error
            )
            const errorMessage =
                error instanceof Error ? error.message : '未知错误。'

            await sendStatus(
                h.text(
                    `自定义分析失败: ${errorMessage}。请检查网络连接和 LLM 配置，或联系管理员。`
                )
            )
        }
    }

    public async executeAutoAnalysisForEnabledGroups() {
        const enabledGroups = this.config.listenerGroups.filter(
            (group) => group.enabled
        )
        const maxConcurrentAnalyses = 3

        for (
            let index = 0;
            index < enabledGroups.length;
            index += maxConcurrentAnalyses
        ) {
            const currentBatch = enabledGroups.slice(
                index,
                index + maxConcurrentAnalyses
            )

            await Promise.allSettled(
                currentBatch.map(async (group) => {
                    try {
                        await this.executeGroupAnalysis(
                            group.selfId,
                            { guildId: group.guildId, channelId: group.channelId },
                            this.config.cronAnalysisDays,
                            undefined,
                            false,
                            undefined,
                            group.reportChannelId
                                ? { channelId: group.reportChannelId }
                                : undefined,
                            this.config.cronAnalysisHours ?? 0,
                            this.config.cronAnalysisMinutes ?? 0
                        )
                    } catch (err) {
                        this.ctx.logger.error(
                            `群 ${group.guildId || group.channelId} 自动分析失败:`,
                            err
                        )
                    }
                })
            )
        }
    }

    public async getUserPersona(
        platform: string,
        selfId: string,
        userId: string
    ): Promise<{ profile: UserPersonaProfile; username: string } | null> {
        const recordId = buildPersonaRecordId(platform, selfId, userId)

        // First, check the cache
        const cached = this.personaCache.get(recordId)
        if (cached?.parsedPersona) {
            return {
                profile: cached.parsedPersona,
                username: cached.record.username
            }
        }

        // If not in cache, query the database
        const record = await this.ctx.database
            .select('group_analysis_user_personas')
            .where({ id: recordId })
            .execute()
            .then((records) => records[0])

        if (!record?.persona) {
            return null
        }

        try {
            const profile = yamlLoad(record.persona) as UserPersonaProfile
            return { profile, username: record.username }
        } catch (error) {
            this.ctx.logger.warn(
                `解析用户画像 YAML 失败 (${recordId})，无法提供画像。`,
                error
            )
            return null
        }
    }

    public async executeUserPersonaAnalysis(
        session: Session,
        userId: string,
        force?: boolean
    ) {
        const bot = session.bot

        await session.send('正在查询用户画像数据，请稍候...')

        let message: h

        try {
            const recordId = buildPersonaRecordId(
                session.platform,
                session.selfId,
                userId
            )

            let avatar: string | undefined
            let user: GuildMember

            try {
                user = await bot.getGuildMember(
                    session.channelId || session.guildId,
                    userId
                )
            } catch (error) {
                this.ctx.logger.warn(`获取用户 ${userId} 信息失败: ${error}`)
            }

            const cache = await this.ensurePersonaCache(recordId, {
                platform: session.platform,
                selfId: session.selfId,
                userId,
                username: user?.nick || user?.name || userId
            })

            let displayName = cache.record.username

            const cacheExpired = isCacheExpiredByDays(
                cache.record.lastAnalysisAt,
                this.config.personaCacheLifetimeDays
            )
            const shouldRefresh = force || cacheExpired || !cache.parsedPersona

            if (shouldRefresh) {
                if (!force && cache.parsedPersona && cacheExpired) {
                    const ttlDays = this.config.personaCacheLifetimeDays
                    if (ttlDays > 0) {
                        await session.send(
                            `上次用户画像更新已超过 ${ttlDays} 天，正在重新生成画像。`
                        )
                    }
                }

                const sourceGroup = {
                    guildId: session.guildId || undefined,
                    channelId: session.channelId || undefined,
                    platform: session.platform,
                    selfId: session.selfId
                }

                await this.runPersonaAnalysis(cache, sourceGroup)

                if (!cache.parsedPersona) {
                    message = h.text(
                        '暂未收集到足够的聊天记录来生成该用户的画像，请稍后再试。'
                    )
                    await session.send(message)
                    return
                }

                cache.pendingMessages = 0
            }

            const profile = cache.parsedPersona!

            if (user) {
                avatar = user.avatar
                const resolvedName =
                    (user as { nick?: string; name?: string }).nick ||
                    (user as { name?: string }).name
                if (resolvedName) {
                    displayName = resolvedName
                    cache.record.username = resolvedName
                }
            }

            if (session.platform === 'onebot') {
                avatar = getAvatarUrl(userId)
            }

            profile.analysisDate = cache.record.lastAnalysisAt.toLocaleString()

            const image =
                await this.ctx.group_analysis_renderer.renderUserPersona(
                    profile,
                    displayName,
                    avatar,
                    this.config
                )

            message =
                typeof image === 'string'
                    ? h.text(image)
                    : h.image(image, 'image/png')
        } catch (error) {
            this.ctx.logger.error(
                `为用户 ${userId} 执行画像分析时发生错误:`,
                error
            )
            const errorMessage =
                error instanceof Error ? error.message : '未知错误。'

            message = h.text(
                `分析失败: ${errorMessage}。请检查服务状态或联系管理员。`
            )
        }

        await session.send(message)
    }

    public async analyzeGroupMessages(
        messages: StoredMessage[],
        selfId: string,
        target: AnalysisTarget,
        context?: AnalysisPromptContext
    ): Promise<GroupAnalysisResult> {
        this.ctx.logger.info(`开始分析 ${messages.length} 条消息...`)

        const { userStats, totalChars, totalEmojiCount, allMessagesText } =
            calculateBasicStats(messages)

        const messagesText = allMessagesText.join('\n')

        // LLM analyses in parallel
        const users = Object.values(userStats)

        const [topics, userTitles, goldenQuotes] = await Promise.all([
            this.ctx.group_analysis_llm.summarizeTopics(
                messagesText,
                context
            ),
            this.config.userTitleAnalysis
                ? this.ctx.group_analysis_llm.analyzeUserTitles(
                      users,
                      context
                  )
                : Promise.resolve([]),
            this.ctx.group_analysis_llm.analyzeGoldenQuotes(
                messagesText,
                this.config.maxGoldenQuotes,
                context
            )
        ]).catch((error) => {
            this.ctx.logger.error('LLM analysis failed:', error)
            //  On LLM failure, return empty results to avoid crashing the entire analysis.
            return [
                [] as SummaryTopic[],
                [] as UserTitle[],
                [] as GoldenQuote[]
            ] as const
        })

        // Final statistics
        const sortedUsers = users.sort(
            (a, b) => b.messageCount - a.messageCount
        )
        const overallActiveHours = users.reduce(
            (acc, user) => {
                for (const hour in user.activeHours) {
                    acc[hour] = (acc[hour] || 0) + user.activeHours[hour]
                }
                return acc
            },
            {} as Record<number, number>
        )
        const mostActiveHourEntry = Object.entries(overallActiveHours).sort(
            (a, b) => b[1] - a[1]
        )[0]
        const mostActiveHour = mostActiveHourEntry
            ? mostActiveHourEntry[0]
            : 'N/A'

        // Generate chart using the renderer service
        const activeHoursChartHtml =
            generateActiveHoursChart(overallActiveHours)

        const groupName = await this.resolveGroupName(selfId, target)

        const result: GroupAnalysisResult = {
            totalMessages: messages.length,
            totalChars,
            totalParticipants: users.length,
            emojiCount: totalEmojiCount,
            mostActiveUser: sortedUsers[0] || null,
            mostActivePeriod:
                mostActiveHour !== 'N/A'
                    ? `${mostActiveHour.padStart(2, '0')}:00 - ${String(parseInt(mostActiveHour) + 1).padStart(2, '0')}:00`
                    : 'N/A',
            userStats: sortedUsers.slice(0, this.config.maxUsersInReport),
            topics,
            userTitles,
            goldenQuotes,
            activeHoursChart: activeHoursChartHtml,
            activeHoursData: overallActiveHours,
            analysisDate: new Date().toLocaleDateString('zh-CN'),
            groupName
        }

        this.ctx.logger.info('消息分析完成。')
        return result
    }

    private _splitTextForSend(text: string, chunkSize = 2000): string[] {
        const trimmed = text.trim()
        if (!trimmed) return []
        if (trimmed.length <= chunkSize) return [trimmed]

        const chunks: string[] = []
        let current = ''

        for (const line of trimmed.split('\n')) {
            // 单行本身超长时，先按 chunkSize 切成多段（切分而非丢弃）
            if (line.length > chunkSize) {
                if (current) {
                    chunks.push(current)
                    current = ''
                }
                for (let i = 0; i < line.length; i += chunkSize) {
                    chunks.push(line.slice(i, i + chunkSize))
                }
                continue
            }

            // 优先按行边界累积切分，不劈开单行
            if (current && current.length + line.length + 1 > chunkSize) {
                chunks.push(current)
                current = line
            } else {
                current = current ? `${current}\n${line}` : line
            }
        }

        if (current) chunks.push(current)

        return chunks
    }

    private _getBot(selfId: string) {
        return this.ctx.bots.find((bot) => bot.selfId === selfId)
    }
}

declare module 'koishi' {
    interface Context {
        group_analysis: AnalysisService
    }

    interface Tables {
        group_analysis_user_personas: PersonaRecord
    }
}
