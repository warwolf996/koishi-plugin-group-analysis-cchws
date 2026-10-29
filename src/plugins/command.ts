/* eslint-disable max-len */
import { Context, Session, User } from 'koishi'
import { Config } from '../config'
import { shouldListenToMessage } from '../utils'

export const inject = {
    group_analysis: {
        required: true
    }
}

export function apply(ctx: Context, config: Config) {
    const checkGroup = (
        session: Session,
        target?: { guildId?: string | null; channelId?: string | null }
    ) => {
        if (config.enableAllGroupsByDefault) return true
        if (!config.listenerGroups) return false
        return shouldListenToMessage(
            {
                guildId: target?.guildId ?? session.guildId ?? undefined,
                channelId: target?.channelId ?? session.channelId ?? undefined,
                platform: session.platform,
                selfId: session.selfId
            },
            config.listenerGroups
        )
    }

    const settings = ctx
        .command('群分析 [query:text]', '分析本群的近期聊天记录')
        .usage(
            '本功能会分析本群的近期聊天记录，并生成一份报告。\n' +
                '默认情况下，本功能会分析最近 1 天的聊天记录。\n' +
                '也可以直接输入自然语言进行查询和对话。\n' +
                '例如：/群分析 告诉我最近三小时都聊了什么。\n' +
                '命令格式：/群分析 [-g <分析群号>] [-c <频道号>] [-f] [查询内容]。指定 -g/-c 只改变分析来源，状态和结果仍返回发出指令的会话/群。'
        )
        .alias('group-analysis')

        .option('force', '-f 是否强制刷新群分析')
        .option('group', '-g <guildId:string> 指定群号', {
            authority: 3
        })
        .option('channel', '-c <channelId:string> 指定频道号', {
            authority: 3
        })
        .action(async ({ session, options }, query) => {
            if (config.personaBlacklist.includes(session.userId)) {
                return '您无权使用本插件。'
            }
            if (session.isDirect && !options.group && !options.channel) {
                return '私聊中请使用 -g 或 -c 指定目标群或频道。'
            }

            const targetGuildId = options.group ?? session.guildId ?? undefined
            const targetChannelId =
                options.channel ?? session.channelId ?? undefined

            if (!targetGuildId && !targetChannelId) {
                return '请使用 -g 或 -c 指定目标群或频道。'
            }

            if (
                !checkGroup(session, {
                    guildId: targetGuildId,
                    channelId: targetChannelId
                })
            )
                return '目标群未启用分析功能，请使用 群分析.启用 来启用目标群的分析功能。'

            const queryText =
                typeof query === 'string' ? query.trim() : undefined

            try {
                if (config.customPromptEnabled) {
                    const customPrompt = config.customPrompt?.trim()
                    if (!customPrompt) {
                        return '自定义提示词开关已开启，但提示词内容为空，请先在插件配置中填写自定义提示词。'
                    }
                    if (queryText) {
                        ctx.logger.info(
                            `自定义提示词模式已开启，忽略查询参数: ${queryText}`
                        )
                    }
                    await ctx.group_analysis.executeCustomAnalysis(
                        session,
                        {
                            guildId: targetGuildId || undefined,
                            channelId: targetChannelId || undefined
                        },
                        customPrompt,
                        config.customPromptDays ?? 1,
                        config.customPromptHours ?? 0,
                        config.customPromptMinutes ?? 0
                    )
                } else if (queryText) {
                    await ctx.group_analysis.executeGroupQuery(
                        session,
                        {
                            guildId: targetGuildId || undefined,
                            channelId: targetChannelId || undefined
                        },
                        queryText
                    )
                } else {
                    const analysisDays = ctx.config?.cronAnalysisDays ?? 1
                    const analysisHours = ctx.config?.cronAnalysisHours ?? 0
                    const analysisMinutes = ctx.config?.cronAnalysisMinutes ?? 0
                    if (
                        analysisDays +
                            analysisHours / 24 +
                            analysisMinutes / 1440 >
                        7
                    )
                        return '出于性能考虑，最多只能分析 7 天的数据。'

                    await ctx.group_analysis.executeGroupAnalysis(
                        session.selfId,
                        {
                            guildId: targetGuildId || undefined,
                            channelId: targetChannelId || undefined
                        },
                        analysisDays,
                        undefined,
                        options.force ?? false,
                        session,
                        undefined,
                        analysisHours,
                        analysisMinutes
                    )
                }
            } catch (err) {
                ctx.logger.error('执行分析时发生未捕获的错误:', err)
                return '群分析执行失败，请检查日志。'
            }
        })

    settings
        .subcommand('.enable', '启用本群的分析功能', {
            authority: 3
        })
        .alias('.启用')
        .action(async ({ session }) => {
            if (session.isDirect) return '请在群聊中使用此命令。'

            const config = ctx.config as Config

            const originalGroupSetting = config.listenerGroups.find(
                (settings) =>
                    (settings.channelId === session.channelId &&
                        session.channelId != null) ||
                    (settings.guildId !== null &&
                        settings.guildId === session.guildId)
            )

            if (originalGroupSetting) {
                originalGroupSetting.enabled = true
            } else {
                config.listenerGroups.push({
                    guildId: session.guildId,
                    channelId: session.channelId,
                    selfId: session.selfId,
                    enabled: true,
                    platform: session.platform
                })
            }

            ctx.scope.parent.scope.parent.scope.update(config, true)

            const guildId = session.event.guild.id

            const guildName =
                (await session.bot
                    .getGuild(guildId)
                    .then((guild) => guild.name)) || session.event.guild.name

            return `已为当前群 ${guildName} (${guildId}) 启用日常分析功能。`
        })

    settings
        .subcommand('.disable', '禁用本群的分析功能', {
            authority: 3
        })
        .alias('.禁用')
        .action(async ({ session }) => {
            if (session.isDirect) return '请在群聊中使用此命令。'

            const config = ctx.config as Config

            const originalGroupSetting = config.listenerGroups.findIndex(
                (settings) =>
                    (settings.channelId === session.channelId &&
                        session.channelId != null) ||
                    (settings.guildId !== null &&
                        settings.guildId === session.guildId)
            )

            if (originalGroupSetting !== -1) {
                config.listenerGroups.splice(originalGroupSetting, 1)
            }

            ctx.scope.parent.scope.parent.scope.update(config, true)

            const guildId = session.event.guild.id

            const guildName =
                (await session.bot
                    .getGuild(guildId)
                    .then((guild) => guild.name)) || session.event.guild.name

            return `已为当前群 ${guildName} (${guildId}) 禁用日常分析功能。`
        })

    settings
        .subcommand('clear', '清理当前群分析的某些缓存')
        .alias('.清理')
        .action(async ({ session }) => {
            if (session.isDirect) return '请在群聊中使用此命令。'

            const guildId = session.event.guild.id

            const guildName =
                (await session.bot
                    .getGuild(guildId)
                    .then((guild) => guild.name)) || session.event.guild.name

            ctx.database.remove('group_analysis_messages', {
                guildId: session.guildId,
                channelId: session.channelId || session.guildId
            })

            return `已清理当前群 ${guildName} (${guildId}) 的分析缓存。`
        })

    settings
        .subcommand('.status', '查看当前分析设置')
        .alias('.状态')
        .action(async ({ session }) => {
            if (session.isDirect) return '请在群聊中使用此命令。'

            const config = ctx.config as Config

            const originalGroupSetting = config.listenerGroups.find(
                (settings) =>
                    (settings.channelId === session.channelId &&
                        session.channelId != null) ||
                    (settings.guildId !== null &&
                        settings.guildId === session.guildId)
            )

            ctx.scope.parent.scope.parent.scope.update(config, true)

            const guildId = session.event.guild.id

            const guildName =
                (await session.bot
                    .getGuild(guildId)
                    .then((guild) => guild.name)) || session.event.guild.name

            const enabled = originalGroupSetting?.enabled ? '已启用' : '未启用'
            return `当前群 ${guildName} (${guildId}) 分析功能状态: ${enabled}`
        })

    settings
        .subcommand('.custom <prompt:text>', '使用自定义提示词直接分析本群聊天记录')
        .alias('.自定义')
        .usage(
            '使用你自己的提示词分析本群聊天记录，结果为纯文本，全程只调用一次 LLM。\n' +
                '用法：/群分析.自定义 -d <天数> <你的提示词>\n' +
                '例如：/群分析.自定义 提取群聊中所有用户提出的问题\n' +
                '天数默认 1 天，最多 7 天。'
        )
        .option('days', '-d <days:number> 分析的天数范围（默认 1，最多 7）', {
            fallback: 1
        })
        .option('group', '-g <guildId:string> 指定群号', {
            authority: 3
        })
        .option('channel', '-c <channelId:string> 指定频道号', {
            authority: 3
        })
        .action(async ({ session, options }, prompt) => {
            if (config.personaBlacklist.includes(session.userId)) {
                return '您无权使用本插件。'
            }

            const promptText = typeof prompt === 'string' ? prompt.trim() : ''
            if (!promptText) {
                return '请提供自定义提示词。例如：/群分析.自定义 提取群聊中所有用户提出的问题'
            }

            if (session.isDirect && !options.group && !options.channel) {
                return '私聊中请使用 -g 或 -c 指定目标群或频道。'
            }

            const targetGuildId = options.group ?? session.guildId ?? undefined
            const targetChannelId =
                options.channel ?? session.channelId ?? undefined

            if (!targetGuildId && !targetChannelId) {
                return '请使用 -g 或 -c 指定目标群或频道。'
            }

            if (
                !checkGroup(session, {
                    guildId: targetGuildId,
                    channelId: targetChannelId
                })
            )
                return '目标群未启用分析功能，请使用 群分析.启用 来启用目标群的分析功能。'

            const days = Math.floor(options.days)
            if (!Number.isFinite(days) || days < 1) {
                return '请输入有效的天数（-d <天数>），最小为 1 天。'
            }
            if (days > 7) return '出于性能考虑，最多只能分析 7 天的数据。'

            try {
                await ctx.group_analysis.executeCustomAnalysis(
                    session,
                    {
                        guildId: targetGuildId || undefined,
                        channelId: targetChannelId || undefined
                    },
                    promptText,
                    days
                )
            } catch (err) {
                ctx.logger.error('执行自定义分析时发生未捕获的错误:', err)
                return '自定义分析执行失败，请检查日志。'
            }
        })

    ctx.command('用户画像 [user:user]', '查看指定用户的画像')
        .alias('group-analysis.persona')
        .alias('群分析.用户画像')
        .usage(
            '使用方法：/群分析.用户画像 @用户 或 /群分析.用户画像 <用户ID> 或 /群分析.用户画像。不带参数时查看当前用户。查看其他用户需要为 bot 管理员。'
        )
        .option('force', '-f 是否强制更新用户画像')
        .action(async ({ session, options }, user) => {
            if (session.isDirect) return '请在群聊中使用此命令。'

            // 黑名单检查
            if (config.personaBlacklist.includes(session.userId)) {
                return '您无权使用本插件。'
            }

            if (!checkGroup(session))
                return '本群未启用群分析功能，请使用 群分析.启用 来启用本群的群分析功能。'

            let userId = user?.split(':')?.[1] ?? session.userId
            const isSelf = userId === session.userId
            const isWhitelist = config.personaWhitelist.includes(session.userId)

            // 白名单用户可查看他人，不受权限限制
            if (!isSelf && !isWhitelist) {
                // 不能查看白名单用户
                if (config.personaWhitelist.includes(userId)) {
                    return '您的权限不足，无法查看特权用户。'
                }
                // 权限检查
                if (((session as Session<User.Field>).user?.authority ?? 0) < (config.personaViewAuthority ?? 3)) {
                    await session.send(
                        `你没有权限查看其他用户的画像。需要权限 ${config.personaViewAuthority ?? 3} 级。将转为查看自己的画像。`
                    )
                    userId = session.userId
                }
            }

            if (!userId) {
                return '无法获取目标用户信息。'
            }

            if (config.personaUserFilter.includes(userId)) {
                return '该用户已被设置为禁止分析用户画像。'
            }

            try {
                await ctx.group_analysis.executeUserPersonaAnalysis(
                    session,
                    userId,
                    options.force ?? false
                )
            } catch (err) {
                ctx.logger.error(
                    `执行用户画像分析时发生未捕获的错误 (用户: ${userId}):`,
                    err
                )
                return '用户画像分析执行失败，请检查日志。'
            }
        })
}
