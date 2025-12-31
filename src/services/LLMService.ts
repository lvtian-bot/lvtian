import { AIConfig, ChatMessage } from '../store/useAIStore';

interface ChatCompletionResponse {
    id: string;
    choices: {
        message: {
            role: string;
            content: string;
        };
        finish_reason: string;
    }[];
}

export class LLMService {
    static async chatCompletion(
        messages: ChatMessage[],
        config: AIConfig
    ): Promise<string> {
        const { baseUrl, apiKey, model } = config;

        // 移除末尾的斜杠（如果存在），确保路径拼接正确
        const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
        const url = `${cleanBaseUrl}/chat/completions`;

        // 过滤掉本地生成的一些额外字段，只保留 API 需要的字段
        const apiMessages = messages.map(msg => ({
            role: msg.role,
            content: msg.content
        }));

        try {
            console.log(`[LLMService] Sending request to ${url} with model ${model}`);

            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: apiMessages,
                    temperature: 0.7,
                }),
            });

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[LLMService] API Error:', response.status, errorText);
                throw new Error(`API Error: ${response.status} - ${errorText}`);
            }

            const data: ChatCompletionResponse = await response.json();

            if (data.choices && data.choices.length > 0) {
                return data.choices[0].message.content;
            } else {
                throw new Error('No response content from AI');
            }

        } catch (error) {
            console.error('[LLMService] Request failed:', error);
            throw error;
        }
    }

    static async summarizeTitle(
        content: string,
        config: AIConfig
    ): Promise<string> {
        const { baseUrl, apiKey, model } = config;
        const cleanBaseUrl = baseUrl.replace(/\/+$/, '');
        const url = `${cleanBaseUrl}/chat/completions`;

        const prompt = `Summarize the following text into a short title (max 6 words). output language should match the input language. Do not use punctuation. \n\nText: ${content}`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: model,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.5,
                    max_tokens: 20,
                }),
            });

            if (!response.ok) {
                // If API fails, use first 10 words of user input as title
                return content.split(' ').slice(0, 10).join(' ');
            }

            const data: ChatCompletionResponse = await response.json();
            if (data.choices && data.choices.length > 0) {
                let title = data.choices[0].message.content.trim();
                // Remove wrapping quotes if any
                title = title.replace(/^["']|["']$/g, '');
                // Fallback to user input excerpt if title is empty or "New Chat"
                if (!title || title === 'New Chat') {
                    return content.split(' ').slice(0, 10).join(' ');
                }
                return title;
            }
            return content.split(' ').slice(0, 10).join(' ');
        } catch (error) {
            console.warn('[LLMService] Title summarization failed:', error);
            // If API fails, use first 10 words of user input as title
            return content.split(' ').slice(0, 10).join(' ');
        }
    }
}
