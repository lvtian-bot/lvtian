import React, { useEffect, useState, type RefObject } from 'react';
import { StyleSheet } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { EnrichedMarkdownTextInput, type EnrichedMarkdownTextInputInstance } from 'react-native-enriched-markdown';
import { useTranslation } from 'react-i18next';
import { textInputColors, theme } from '../utils/theme';
import { useSettingsFont } from './settings';

interface FlashNoteRichInputProps {
    editorRef: RefObject<EnrichedMarkdownTextInputInstance | null>;
    initialContent: string;
    onChange: (markdown: string) => void;
    onReady: () => void;
    onUnsupported: () => void;
}

export const FlashNoteRichInput = ({ editorRef, initialContent, onChange, onReady, onUnsupported }: FlashNoteRichInputProps) => {
    const { t } = useTranslation();
    const font = useSettingsFont();
    const [verified, setVerified] = useState(initialContent === '');

    useEffect(() => {
        if (verified) {
            if (initialContent === '') return;
            const frame = requestAnimationFrame(() => editorRef.current?.focus());
            return () => cancelAnimationFrame(frame);
        }
        let active = true;
        // 比较原生编辑器实际导出的 Markdown，避免旧笔记中的语法或空白被静默改写。
        const showSourceEditor = () => {
            if (!active) return;
            active = false;
            onUnsupported();
        };
        const timeout = setTimeout(showSourceEditor, 1500);
        const frame = requestAnimationFrame(() => {
            const input = editorRef.current;
            if (!input) {
                showSourceEditor();
                return;
            }
            input.getMarkdown().then(markdown => {
                if (!active) return;
                if (markdown !== initialContent) {
                    showSourceEditor();
                    return;
                }
                clearTimeout(timeout);
                setVerified(true);
                onReady();
            }, showSourceEditor);
        });
        return () => {
            active = false;
            cancelAnimationFrame(frame);
            clearTimeout(timeout);
        };
    }, [editorRef, initialContent, onReady, onUnsupported, verified]);

    return (
        <KeyboardAwareScrollView
            style={styles.scroll}
            contentContainerStyle={styles.content}
            bottomOffset={theme.spacing.sm}
            keyboardShouldPersistTaps="handled"
        >
            <EnrichedMarkdownTextInput
                ref={editorRef}
                style={[
                    styles.input,
                    { fontSize: font.flashBody, lineHeight: font.flashLineHeight },
                    !verified && styles.unverifiedInput,
                ]}
                defaultValue={initialContent}
                autoFocus={initialContent === ''}
                editable={verified}
                placeholder={t('timeline.placeholder')}
                placeholderTextColor={theme.colors.textSecondary}
                scrollEnabled={false}
                onChangeMarkdown={verified ? onChange : undefined}
                selectionColor={textInputColors.selectionColor}
                cursorColor={textInputColors.cursorColor}
            />
        </KeyboardAwareScrollView>
    );
};

const styles = StyleSheet.create({
    scroll: { flex: 1 },
    content: { flexGrow: 1 },
    input: {
        flexGrow: 1,
        color: theme.colors.text,
        padding: theme.spacing.md,
    },
    unverifiedInput: { opacity: 0 },
});
