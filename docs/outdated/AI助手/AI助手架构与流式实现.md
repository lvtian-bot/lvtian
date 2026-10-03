# AI 助手架构与流式实现

> 本文档说明 MDNote 内置 AI 助手的架构设计、大模型 Provider 抽象、流式传输协议与 UI 组件集成。

---

## 1. 架构总览与 Provider 抽象

AI 助手由 `LLMService` 统一管理，支持多大模型服务商无缝切换：

```text
┌─────────────────┐       ┌─────────────────┐
│   AgentScreen   │       │    AISidebar    │
└────────┬────────┘       └────────┬────────┘
         │                         │
         └───────────┬─────────────┘
                     ▼
             ┌───────────────┐
             │  useAIStore   │
             └───────┬───────┘
                     ▼
             ┌───────────────┐
             │  LLMService   │
             └───────┬───────┘
                     │ SSE / Chunk 流式协议
       ┌─────────────┼─────────────┐
       ▼             ▼             ▼
   DeepSeek       OpenAI       Custom API
```

---

## 2. 流式响应机制 (Streaming Response)

### 2.1 协议原理
移动端通过 `fetch` 结合底层 `ReadableStream` 或基于 `XMLHttpRequest` onprogress 监听分块传输，解析 SSE 格式行：`data: {"choices": [{"delta": {"content": "..."}}]}`。

### 2.2 核心流式实现模式
```typescript
export async function streamChatCompletion({
  endpoint,
  apiKey,
  model,
  messages,
  onChunk,
  onFinish,
  onError,
}: StreamChatOptions) {
  try {
    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
      }),
    });

    // 处理分块内容并防抖派发给 UI
  } catch (error) {
    onError(error as Error);
  }
}
```

---

## 3. 安全与存储约束

- **API 凭据安全**：用户输入的 API Key 严禁明文保存在普通 AsyncStorage 中，必须通过 `expo-secure-store` 进行硬件级安全加密存储。
