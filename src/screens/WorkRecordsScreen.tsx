import React, { useEffect, useMemo, useState } from 'react';
import {
    ActivityIndicator,
    Modal,
    Pressable,
    ScrollView,
    SectionList,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ChatMarkdownBubble } from '../components/ChatMarkdownBubble';
import { ToolCallsCard } from '../components/ToolCallsCard';
import { useAssistantStore } from '../store/useAssistantStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { buildChatTurns, groupTurnsByDay, type ChatTurn } from '../utils/chatTurns';
import { formatChatDate, formatChatTime } from '../utils/chatDate';
import { getFontSizeMetrics } from '../utils/fontSize';
import { colors, radius, spacing } from '../utils/theme';

const turnTime = (turn: ChatTurn, language: string) => formatChatTime(
    turn.status === 'running' ? turn.startedAt : turn.completedAt,
    language,
);

const statusLabel = (turn: ChatTurn, t: (key: string, options?: Record<string, unknown>) => string) => turn.status === 'running'
    ? t('workRecords.running', { defaultValue: '进行中' })
    : turn.status === 'error'
        ? t('workRecords.failed', { defaultValue: '未完成' })
        : '';

/** 详情正文独立成组件，便于直接验证工具流水与结论的展示。 */
export const WorkRecordDetail: React.FC<{ turn: ChatTurn; onClose: () => void }> = ({ turn, onClose }) => {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const { fontSize } = useSettingsStore();
    const metrics = useMemo(() => getFontSizeMetrics(fontSize), [fontSize]);
    const timestamp = turn.status === 'running' ? turn.startedAt : turn.completedAt;
    const time = turnTime(turn, i18n.language);
    const day = formatChatDate(timestamp, Date.now(), i18n.language, t);
    const status = statusLabel(turn, t);

    return (
        <View style={[styles.detailContainer, { paddingTop: insets.top }]} testID="work-record-detail">
            <View style={styles.detailHeader}>
                <Pressable
                    onPress={onClose}
                    style={styles.detailClose}
                    accessibilityRole="button"
                    accessibilityLabel={t('common.close', '关闭')}
                >
                    <Icon name="close" size={22} color={colors.text} />
                </Pressable>
                <Text style={styles.detailTime}>
                    {day} {time}{status ? ` · ${status}` : ''}
                </Text>
            </View>
            <ScrollView
                contentContainerStyle={[
                    styles.detailScroll,
                    { paddingBottom: insets.bottom + spacing.xxl },
                ]}
            >
                <Text style={styles.detailTitle} selectable>
                    {turn.title || t('workRecords.untitled', '未命名任务')}
                </Text>
                {turn.question && turn.question !== turn.title ? (
                    <Text style={styles.detailRequest} selectable>{turn.question}</Text>
                ) : null}
                {turn.summary ? (
                    <Text style={styles.detailSummary} selectable>{turn.summary}</Text>
                ) : null}

                <Text style={styles.detailSection}>
                    {t('workRecords.steps', '工作过程')}
                </Text>
                {turn.tools.length === 0 ? (
                    <Text style={styles.detailEmpty}>
                        {t('workRecords.noTools', '这一轮没有工具调用')}
                    </Text>
                ) : (
                    <ToolCallsCard toolCalls={turn.tools} />
                )}

                <Text style={styles.detailSection}>
                    {t('workRecords.conclusion', '结论')}
                </Text>
                {turn.answer ? (
                    <ChatMarkdownBubble
                        text={turn.answer}
                        metrics={metrics}
                        plain
                        testID="work-record-conclusion"
                    />
                ) : (
                    <Text style={styles.detailEmpty}>
                        {turn.status === 'running'
                            ? t('workRecords.inProgressHint', '正在进行，完成后显示结论')
                            : t('workRecords.noAnswer', '这一轮没有文字结论')}
                    </Text>
                )}
            </ScrollView>
        </View>
    );
};

/**
 * 工作记录：把工具调用从聊天里剥离出来，按“一次工作”聚合。
 * 列表只给标题、结果摘要与完成时间；点开看这一轮的工具流水和结论。
 */
export const WorkRecordsScreen: React.FC = () => {
    const { t, i18n } = useTranslation();
    const insets = useSafeAreaInsets();
    const messages = useAssistantStore((state) => state.messages);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [dateNow, setDateNow] = useState(Date.now);

    useEffect(() => {
        const timer = setInterval(() => setDateNow(Date.now()), 60_000);
        return () => clearInterval(timer);
    }, []);

    const sections = useMemo(() => groupTurnsByDay(buildChatTurns(messages)), [messages]);
    const selected = useMemo(
        () => sections.flatMap((section) => section.data).find((turn) => turn.id === selectedId) ?? null,
        [sections, selectedId],
    );

    const summaryText = (turn: ChatTurn) => turn.summary
        || (turn.tools.length > 0
            ? t('workRecords.toolCount', { count: turn.tools.length, defaultValue: '{{count}} 次工具调用' })
            : '');

    const renderRow = ({ item }: { item: ChatTurn }) => (
        <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => setSelectedId(item.id)}
            accessibilityRole="button"
            testID={`work-record-${item.id}`}
        >
            <View style={styles.iconWrap}>
                <Icon name="widgets" size={18} color={colors.primaryDark} />
            </View>
            <View style={styles.rowBody}>
                <Text style={styles.rowTitle} numberOfLines={2}>
                    {item.title || t('workRecords.untitled', '未命名任务')}
                </Text>
                {summaryText(item) ? (
                    <Text style={styles.rowSummary} numberOfLines={2}>{summaryText(item)}</Text>
                ) : null}
                <Text style={styles.rowTime}>
                    {turnTime(item, i18n.language)}{statusLabel(item, t) ? ` · ${statusLabel(item, t)}` : ''}
                </Text>
            </View>
            {item.status === 'running' ? (
                <ActivityIndicator size="small" color={colors.primary} />
            ) : (
                <Icon name="chevron-right" size={20} color={colors.border} />
            )}
        </Pressable>
    );

    return (
        <View style={styles.container}>
            <SectionList
                sections={sections}
                keyExtractor={(item) => item.id}
                renderItem={renderRow}
                renderSectionHeader={({ section }) => (
                    <Text style={styles.sectionTitle}>
                        {formatChatDate(section.date, dateNow, i18n.language, t)}
                    </Text>
                )}
                ListEmptyComponent={(
                    <View style={styles.empty}>
                        <Text style={styles.emptyText}>
                            {t('workRecords.empty', '还没有工作记录')}
                        </Text>
                    </View>
                )}
                contentContainerStyle={[styles.listContent, { paddingBottom: insets.bottom + spacing.xl }]}
                stickySectionHeadersEnabled={false}
            />

            <Modal
                visible={selected !== null}
                animationType="slide"
                onRequestClose={() => setSelectedId(null)}
            >
                {selected ? (
                    <WorkRecordDetail turn={selected} onClose={() => setSelectedId(null)} />
                ) : null}
            </Modal>
        </View>
    );
};

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    listContent: { paddingBottom: spacing.xl },
    sectionTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.textSecondary,
        paddingHorizontal: spacing.md,
        paddingTop: spacing.md,
        paddingBottom: spacing.sm,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        backgroundColor: colors.surface,
        marginHorizontal: spacing.md,
        marginBottom: spacing.sm,
        borderRadius: radius.md,
        padding: spacing.md,
    },
    rowPressed: { opacity: 0.75 },
    iconWrap: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.primaryLight,
        alignItems: 'center',
        justifyContent: 'center',
        marginRight: spacing.sm,
    },
    rowBody: { flex: 1 },
    rowTitle: { fontSize: 16, fontWeight: '600', color: colors.text },
    rowSummary: { fontSize: 13, color: colors.textSecondary, marginTop: 4, lineHeight: 18 },
    rowTime: { fontSize: 12, color: colors.mutedText, marginTop: 6 },
    empty: { paddingTop: spacing.xxl, alignItems: 'center' },
    emptyText: { color: colors.textSecondary, fontSize: 14 },
    detailContainer: { flex: 1, backgroundColor: colors.background },
    detailHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: spacing.md,
        paddingTop: spacing.sm,
        paddingBottom: spacing.sm,
    },
    detailClose: {
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: colors.surface,
        alignItems: 'center',
        justifyContent: 'center',
    },
    detailTime: { fontSize: 12, color: colors.mutedText },
    detailScroll: { padding: spacing.md, paddingTop: spacing.sm },
    detailTitle: { fontSize: 22, fontWeight: '700', color: colors.text, lineHeight: 30 },
    detailRequest: { fontSize: 15, color: colors.text, marginTop: spacing.sm, lineHeight: 23 },
    detailSummary: { fontSize: 15, color: colors.textSecondary, marginTop: spacing.sm, lineHeight: 22 },
    detailSection: {
        fontSize: 13,
        fontWeight: '600',
        color: colors.textSecondary,
        marginTop: spacing.lg,
        marginBottom: spacing.sm,
    },
    detailEmpty: { fontSize: 14, color: colors.mutedText },
});
