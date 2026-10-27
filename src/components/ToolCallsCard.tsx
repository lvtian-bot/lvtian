import React, { useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Icon from '@expo/vector-icons/MaterialIcons';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';

import { ToolCallState } from '../types/assistantProtocol';
import { theme } from '../utils/theme';

interface ToolCallsCardProps {
    toolCalls: ToolCallState[];
    isProcessing?: boolean;
}

/** 把工具原始摘要转成给用户看的一句话；不改变服务端保存的原始输入输出。 */
export function formatToolSummaryLocalized(
    tool: { summary?: string; name?: string; input?: Record<string, unknown> },
    t: TFunction
): string {
    const name = tool.name?.split('.').pop()?.toLowerCase();
    const inputText = (key: string) => {
        const value = tool.input?.[key];
        return typeof value === 'string' ? value.trim() : '';
    };
    if (name && ['bash', 'pwsh', 'sh', 'shell', 'terminal', 'exec', 'execute', 'cmd', 'run_code'].includes(name)) {
        const description = inputText('description');
        if (description) return description;
        const command = inputText('command') || inputText('cmd') || inputText('script');
        if (command) return command.startsWith('$') ? command : `$ ${command}`;
    }
    const fileActions: Record<string, string> = {
        read: 'assistant.toolActionRead',
        read_image: 'assistant.toolActionRead',
        read_file: 'assistant.toolActionRead',
        write: 'assistant.toolActionWrite',
        write_file: 'assistant.toolActionWrite',
        edit: 'assistant.toolActionEdit',
        edit_file: 'assistant.toolActionEdit',
    };
    const filePath = inputText('file_path') || inputText('path') || inputText('filePath') || inputText('target') || inputText('file');
    if (name && fileActions[name] && filePath) {
        return `${t(fileActions[name])} ${filePath}`;
    }
    if (name && ['grep', 'glob'].includes(name) && inputText('pattern')) {
        return `${t('assistant.toolActionSearch')} ${inputText('pattern')}${filePath ? ` · ${filePath}` : ''}`;
    }
    if (name === 'web_fetch' && inputText('url')) {
        return `${t('assistant.toolActionFetch')} ${inputText('url')}`;
    }
    if (name === 'web_search' && Array.isArray(tool.input?.queries)) {
        const queries = tool.input.queries.filter((query): query is string => typeof query === 'string').join(', ');
        if (queries) return `${t('assistant.toolActionSearch')} ${queries}`;
    }
    const summary = tool.summary;
    if (!summary) return tool.name || '';
    if (summary.startsWith('$')) {
        return summary;
    }
    const match = summary.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (match) {
        const [, action, rest] = match;
        const lowerAction = action.toLowerCase();
        let localizedAction: string | null = null;
        if (lowerAction === 'read') {
            localizedAction = t('assistant.toolActionRead', { defaultValue: '读取' });
        } else if (lowerAction === 'write') {
            localizedAction = t('assistant.toolActionWrite', { defaultValue: '写入' });
        } else if (lowerAction === 'edit') {
            localizedAction = t('assistant.toolActionEdit', { defaultValue: '编辑' });
        } else if (lowerAction === 'search' || lowerAction === 'find') {
            localizedAction = t('assistant.toolActionSearch', { defaultValue: '搜索' });
        } else if (lowerAction === 'fetch') {
            localizedAction = t('assistant.toolActionFetch', { defaultValue: '访问' });
        } else if (lowerAction === 'file') {
            localizedAction = t('assistant.toolActionFile', { defaultValue: '文件' });
        }
        if (localizedAction) {
            return rest ? `${localizedAction} ${rest}` : localizedAction;
        }
    }
    return summary;
}

function ToolCallCard({ tool }: { tool: ToolCallState }) {
    const { t } = useTranslation();
    const [expanded, setExpanded] = useState(false);
    const statusLabel = tool.status === 'running'
        ? t('assistant.runningAction')
        : tool.status === 'failed'
            ? t('assistant.toolStatusFailed')
            : t('assistant.completedActions');
    const statusColor = tool.status === 'running' ? theme.colors.primaryDark
        : tool.status === 'failed' ? theme.colors.dangerText : theme.colors.successText;
    return (
        <View style={styles.toolCardContainer} testID={`tool-card-${tool.id}`}>
            <TouchableOpacity
                style={styles.toolCardHeader}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                accessibilityLabel={`${formatToolSummaryLocalized(tool, t)} · ${statusLabel}`}
                onPress={() => setExpanded((value) => !value)}
            >
                <View style={styles.toolCardHeaderLeft}>
                    <Text style={styles.toolCardHeaderTitle} numberOfLines={2} ellipsizeMode="tail">{formatToolSummaryLocalized(tool, t)}</Text>
                    <View style={styles.toolItemStatusRow}>
                        {tool.status === 'running' ? (
                            <ActivityIndicator size="small" color={statusColor} style={styles.toolStatusIcon} />
                        ) : (
                            <Icon name={tool.status === 'failed' ? 'error' : 'check-circle'} size={14} color={statusColor} style={styles.toolStatusIcon} />
                        )}
                        <Text style={[styles.toolStatusText, { color: statusColor }]}>{statusLabel}</Text>
                    </View>
                </View>
                <Icon name={expanded ? 'expand-less' : 'expand-more'} size={20} color="#6B7280" />
            </TouchableOpacity>
            {expanded && (
                <View style={styles.toolCardBody}>
                    <Text style={styles.toolItemName} selectable>{tool.name}</Text>
                    {tool.summary !== undefined && (
                        <View style={styles.toolCommandBox}>
                            <Text style={styles.toolItemName}>{t('assistant.toolDetailSummary')}</Text>
                            <Text style={styles.toolCommandText} selectable>{tool.summary}</Text>
                        </View>
                    )}
                    {tool.input !== undefined && (
                        <View style={styles.toolCommandBox}>
                            <Text style={styles.toolItemName}>{t('assistant.toolDetailInput')}</Text>
                            <Text style={styles.toolCommandText} selectable>{JSON.stringify(tool.input, null, 2)}</Text>
                        </View>
                    )}
                    {tool.output !== undefined && (
                        <View style={styles.toolOutputBox}>
                            <Text style={styles.toolItemName}>{t('assistant.toolDetailOutput')}</Text>
                            <Text style={styles.toolOutputText} selectable>{tool.output}</Text>
                        </View>
                    )}
                </View>
            )}
        </View>
    );
}

/** 工作记录详情里的工具流水；每个工具独立展开，默认折叠。 */
export const ToolCallsCard: React.FC<ToolCallsCardProps> = ({ toolCalls }) => (
    <View style={styles.toolCallsList} testID="tool-call-group">
        {toolCalls.map((tool) => <ToolCallCard key={tool.id} tool={tool} />)}
    </View>
);

const styles = StyleSheet.create({
    toolCallsList: {
        width: '100%',
        alignSelf: 'stretch',
        backgroundColor: '#E5E7EB',
        borderRadius: 10,
        overflow: 'hidden',
    },
    toolCardContainer: {
        width: '100%',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#D1D5DB',
        backgroundColor: '#E5E7EB',
        overflow: 'hidden',
    },
    toolCardHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingHorizontal: 10,
        paddingVertical: 8,
    },
    toolCardHeaderLeft: {
        flexDirection: 'column',
        alignItems: 'stretch',
        flex: 1,
        minWidth: 0,
        gap: 6,
        marginRight: 6,
    },
    toolStatusText: {
        fontSize: 11,
        flexShrink: 1,
    },
    toolStatusIcon: {
        marginRight: 8,
    },
    toolCardHeaderTitle: {
        fontSize: 13,
        fontWeight: '600',
        color: '#374151',
        flexShrink: 1,
        minWidth: 0,
        lineHeight: 19,
    },
    toolCardBody: {
        paddingHorizontal: 8,
        paddingVertical: 8,
        gap: 6,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: '#D1D5DB',
    },
    toolItemStatusRow: {
        flexDirection: 'row',
        alignItems: 'center',
    },
    toolItemName: {
        fontSize: 11,
        color: '#6B7280',
        fontWeight: '600',
        textTransform: 'uppercase',
    },
    toolCommandBox: {
        backgroundColor: '#F3F4F6',
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        borderWidth: 1,
        borderColor: '#E5E7EB',
    },
    toolCommandText: {
        fontSize: 12,
        color: '#1F2937',
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        lineHeight: 18,
    },
    toolOutputBox: {
        backgroundColor: 'rgba(0, 0, 0, 0.04)',
        borderRadius: 4,
        padding: 6,
        marginTop: 4,
    },
    toolOutputText: {
        fontSize: 11,
        color: '#4B5563',
        fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }),
        lineHeight: 16,
    },
});
