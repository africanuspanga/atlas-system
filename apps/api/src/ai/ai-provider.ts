/**
 * LLM provider for the ATLAS assistant.
 *
 * Provider decision (ATLAS_AI_ASSISTANT_SPEC.md): the deployment's available
 * credential is Moonshot Kimi (MOONSHOT_API_KEY in .env), an OpenAI-
 * compatible chat-completions API — so that is the v1 provider. The tool
 * layer is provider-agnostic (plain JSON-schema function calling), so
 * swapping to another provider later is a one-file change.
 *
 * AI_DRIVER=mock gives a deterministic, network-free provider used by the
 * smoke test — same pattern as SMS_DRIVER=console for the outbox.
 */

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

export interface ProviderToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ProviderReply {
  content: string | null;
  toolCalls: Array<{ id: string; name: string; argumentsJson: string }>;
  usage: { promptTokens: number; completionTokens: number };
}

export interface AiProvider {
  readonly model: string;
  chat(
    messages: ProviderMessage[],
    tools: ProviderToolSchema[],
  ): Promise<ProviderReply>;
}

// ---------------------------------------------------------------------------
// Moonshot Kimi (OpenAI-compatible)
// ---------------------------------------------------------------------------
class MoonshotProvider implements AiProvider {
  readonly model = process.env.MOONSHOT_MODEL ?? 'kimi-k2-0905-preview';
  private readonly baseUrl = (
    process.env.MOONSHOT_BASE_URL ?? 'https://api.moonshot.ai/v1'
  ).replace(/\/$/, '');

  async chat(
    messages: ProviderMessage[],
    tools: ProviderToolSchema[],
  ): Promise<ProviderReply> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.MOONSHOT_API_KEY ?? ''}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          tool_choice: tools.length > 0 ? 'auto' : undefined,
          // No temperature: kimi-k2.6 rejects anything but the default (1).
          max_tokens: 1200,
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`AI provider ${response.status}: ${text.slice(0, 200)}`);
    }
    const body = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const message = body.choices?.[0]?.message;
    return {
      content: message?.content ?? null,
      toolCalls: (message?.tool_calls ?? []).map((c) => ({
        id: c.id,
        name: c.function.name,
        argumentsJson: c.function.arguments || '{}',
      })),
      usage: {
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Deterministic mock for smoke tests: keyword → tool; after a tool result
// arrives it answers with a stable "MOCK_ANSWER" line embedding the data.
// ---------------------------------------------------------------------------
const MOCK_RULES: Array<{
  pattern: RegExp;
  tool: string;
  args: () => Record<string, string>;
}> = [
  {
    pattern: /outstanding|deni|balances?/i,
    tool: 'getOutstandingFees',
    args: () => ({}),
  },
  {
    pattern: /collect|tumekusanya|makusanyo/i,
    tool: 'getFeeCollectionSummary',
    args: () => {
      const today = new Date().toISOString().slice(0, 10);
      return { from: today, to: today };
    },
  },
  {
    pattern: /absent|hawakuhudhuria/i,
    tool: 'getAbsentStudents',
    args: () => ({ date: new Date().toISOString().slice(0, 10) }),
  },
  {
    pattern: /how many students|wanafunzi wangapi/i,
    tool: 'getStudentCount',
    args: () => ({}),
  },
  {
    pattern: /subscription|plan|kifurushi/i,
    tool: 'getSubscriptionUsage',
    args: () => ({}),
  },
];

class MockProvider implements AiProvider {
  readonly model = 'mock';

  chat(messages: ProviderMessage[]): Promise<ProviderReply> {
    const lastToolResult = [...messages]
      .reverse()
      .find((m) => m.role === 'tool');
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const usage = { promptTokens: 10, completionTokens: 10 };

    if (lastToolResult) {
      const proposed = lastToolResult.content.includes(
        '"requiresConfirmation":true',
      );
      return Promise.resolve({
        content: proposed
          ? `MOCK_PROPOSED please review and confirm ${lastToolResult.content}`
          : `MOCK_ANSWER ${lastToolResult.content}`,
        toolCalls: [],
        usage,
      });
    }
    const text = lastUser?.content ?? '';

    // Deterministic action-proposal rules (checked before read rules).
    const payMatch =
      /record a payment of (\d+)[^]*?(INV-\d+)[^]*?\b(cash|mpesa|bank)\b/i.exec(
        text,
      );
    if (payMatch) {
      return Promise.resolve({
        content: null,
        toolCalls: [
          {
            id: 'mock-pay',
            name: 'proposeRecordPayment',
            argumentsJson: JSON.stringify({
              invoiceNumber: payMatch[2],
              amount: Number(payMatch[1]),
              method: payMatch[3].toLowerCase(),
            }),
          },
        ],
        usage,
      });
    }
    const announceMatch = /announce[^]*?"([^"]+)"/i.exec(text);
    if (announceMatch) {
      return Promise.resolve({
        content: null,
        toolCalls: [
          {
            id: 'mock-announce',
            name: 'proposeSendAnnouncement',
            argumentsJson: JSON.stringify({ body: announceMatch[1] }),
          },
        ],
        usage,
      });
    }
    if (/delete student|archive student|reverse payment/i.test(text)) {
      return Promise.resolve({
        content: 'MOCK_REFUSAL that action is not available to the assistant.',
        toolCalls: [],
        usage,
      });
    }
    if (/salar|mishahara|payroll/i.test(text)) {
      return Promise.resolve({
        content:
          'MOCK_REFUSAL payroll data is not available through this assistant.',
        toolCalls: [],
        usage,
      });
    }
    if (/ignore all previous instructions|puuza maelekezo/i.test(text)) {
      return Promise.resolve({
        content:
          'MOCK_REFUSAL I follow ATLAS permission rules and cannot ignore them.',
        toolCalls: [],
        usage,
      });
    }
    const rule = MOCK_RULES.find((r) => r.pattern.test(text));
    if (rule) {
      return Promise.resolve({
        content: null,
        toolCalls: [
          {
            id: `mock-${rule.tool}`,
            name: rule.tool,
            argumentsJson: JSON.stringify(rule.args()),
          },
        ],
        usage,
      });
    }
    return Promise.resolve({
      content:
        'MOCK_ANSWER no tool matched; I can only answer from ATLAS data.',
      toolCalls: [],
      usage,
    });
  }
}

export function resolveAiProvider(): AiProvider {
  if (process.env.AI_DRIVER === 'mock') return new MockProvider();
  return new MoonshotProvider();
}
