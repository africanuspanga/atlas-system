import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { Header } from "@/components/header";
import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { StatusChip } from "@/components/status-chip";
import { Symbol } from "@/components/symbol";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { color, font, radius, space } from "@/lib/theme";

interface ProposedAction {
  actionId: string;
  preview: {
    title: string;
    lines: [string, string][];
    warnings: string[];
  };
  expiresAt: string;
  /** UI lifecycle: undefined = awaiting decision. */
  outcome?: { status: string; result?: Record<string, unknown>; error?: string };
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolsUsed?: string[];
  actions?: ProposedAction[];
}

/** Streaming-feel typing indicator: three staggered pulsing dots. */
function TypingDots() {
  return (
    <View style={styles.dotsRow}>
      {[0, 1, 2].map((i) => (
        <Dot delay={i * 180} key={i} />
      ))}
    </View>
  );
}

function Dot({ delay }: { delay: number }) {
  const opacity = useSharedValue(0.25);
  useEffect(() => {
    opacity.value = withDelay(
      delay,
      withRepeat(withTiming(1, { duration: 450 }), -1, true),
    );
  }, [opacity, delay]);
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View style={[styles.dot, animated]} />;
}

export default function Assistant() {
  const t = useT();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);

  const suggestions = [
    t("assistant.suggestion1"),
    t("assistant.suggestion2"),
    t("assistant.suggestion3"),
    t("assistant.suggestion4"),
  ];

  const scrollToEnd = useCallback(() => {
    requestAnimationFrame(() => scrollRef.current?.scrollToEnd({ animated: true }));
  }, []);

  async function send(text: string) {
    const message = text.trim();
    if (!message || pending || !tenantId) return;
    setMessages((m) => [...m, { role: "user", content: message }]);
    setInput("");
    setPending(true);
    setError(null);
    scrollToEnd();
    try {
      const res = await apiFetch("/api/v1/ai/chat", {
        method: "POST",
        body: JSON.stringify({
          message,
          ...(conversationId ? { conversationId } : {}),
        }),
        tenantId,
      });
      const body = (await res.json().catch(() => null)) as {
        conversationId?: string;
        reply?: string;
        toolsUsed?: string[];
        proposedActions?: ProposedAction[];
        code?: string;
      } | null;
      if (!res.ok || !body?.reply) {
        setError(apiErrorMessage(t, body, res.status));
        return;
      }
      setConversationId(body.conversationId ?? null);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: body.reply ?? "",
          toolsUsed: body.toolsUsed,
          actions: body.proposedActions,
        },
      ]);
      scrollToEnd();
    } catch {
      setError(t("common.apiUnreachable"));
    } finally {
      setPending(false);
    }
  }

  async function decideAction(
    messageIndex: number,
    actionId: string,
    decision: "confirm" | "reject",
  ) {
    if (!tenantId) return;
    const res = await apiFetch(`/api/v1/ai/actions/${actionId}/${decision}`, {
      method: "POST",
      tenantId,
    });
    const body = (await res.json().catch(() => null)) as {
      status?: string;
      result?: Record<string, unknown>;
      error?: string;
      code?: string;
    } | null;
    const outcome = res.ok
      ? decision === "reject"
        ? { status: "rejected" }
        : {
            status: body?.status ?? "failed",
            result: body?.result,
            error: body?.error,
          }
      : { status: "failed", error: apiErrorMessage(t, body, res.status) };
    void Haptics.notificationAsync(
      outcome.status === "executed"
        ? Haptics.NotificationFeedbackType.Success
        : outcome.status === "rejected"
          ? Haptics.NotificationFeedbackType.Warning
          : Haptics.NotificationFeedbackType.Error,
    );
    setMessages((m) =>
      m.map((msg, i) =>
        i === messageIndex
          ? {
              ...msg,
              actions: msg.actions?.map((a) =>
                a.actionId === actionId ? { ...a, outcome } : a,
              ),
            }
          : msg,
      ),
    );
  }

  function executedSummary(result: Record<string, unknown> | undefined) {
    if (!result) return "";
    if (result.receiptNumber) {
      return ` — ${t("assistant.resultReceipt")} ${String(result.receiptNumber)}`;
    }
    if (result.invoiceNumber) {
      return ` — ${t("assistant.resultInvoice")} ${String(result.invoiceNumber)}`;
    }
    const queued = result.recipients ?? result.queued;
    if (queued !== undefined) {
      return ` — ${String(queued)} ${t("assistant.resultQueued")}`;
    }
    return "";
  }

  return (
    <Screen>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? space(20) : 0}
        style={styles.flex}
      >
        <Header subtitle={t("assistant.subtitle")} title={t("assistant.title")} />

        <ScrollView
          contentContainerStyle={styles.thread}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={scrollToEnd}
          ref={scrollRef}
          showsVerticalScrollIndicator={false}
        >
          {messages.length === 0 ? (
            <View style={styles.emptyWrap}>
              <View style={styles.sparklePlate}>
                <Symbol android="auto_awesome" ios="sparkles" size={26} tint={color.primary} />
              </View>
              <Text style={styles.emptyPrompt}>{t("assistant.emptyPrompt")}</Text>
              <View style={styles.suggestions}>
                {suggestions.map((s) => (
                  <Pressable
                    accessibilityRole="button"
                    key={s}
                    onPress={() => void send(s)}
                    style={({ pressed }) => [
                      styles.suggestion,
                      pressed && { backgroundColor: color.hairline },
                    ]}
                  >
                    <Text style={styles.suggestionText}>{s}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {messages.map((m, i) => (
            <View
              key={i}
              style={[
                styles.bubble,
                m.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
              ]}
            >
              <Text
                style={m.role === "user" ? styles.textUser : styles.textAssistant}
              >
                {m.content}
              </Text>

              {m.toolsUsed && m.toolsUsed.length > 0 ? (
                <View style={styles.toolRow}>
                  {m.toolsUsed.map((tool, j) => (
                    <View key={j} style={styles.toolChip}>
                      <Symbol android="settings" ios="wrench.fill" size={10} tint={color.muted} />
                      <Text style={styles.toolLabel}>{tool}</Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {m.actions?.map((action) => (
                <View key={action.actionId} style={styles.actionCard}>
                  <View style={styles.actionHead}>
                    <Symbol
                      android="verified_user"
                      ios="checkmark.shield.fill"
                      size={16}
                      tint={color.primary}
                    />
                    <Text style={styles.actionCaption}>
                      {t("assistant.needsConfirm")}
                    </Text>
                  </View>
                  <Text style={styles.actionTitle}>{action.preview.title}</Text>
                  <View style={styles.actionLines}>
                    {action.preview.lines.map(([label, value], k) => (
                      <View key={k} style={styles.actionLine}>
                        <Text numberOfLines={1} style={styles.actionLabel}>
                          {label}
                        </Text>
                        <Text style={styles.actionValue}>{value}</Text>
                      </View>
                    ))}
                  </View>
                  {action.preview.warnings.map((w, k) => (
                    <Text key={k} style={styles.actionWarning}>
                      ⚠ {w}
                    </Text>
                  ))}
                  {!action.outcome ? (
                    <View style={styles.actionButtons}>
                      <PillButton
                        haptic
                        onPress={() =>
                          void decideAction(i, action.actionId, "confirm")
                        }
                        style={styles.actionButton}
                        title={t("common.confirm")}
                      />
                      <PillButton
                        onPress={() =>
                          void decideAction(i, action.actionId, "reject")
                        }
                        style={styles.actionButton}
                        title={t("assistant.reject")}
                        variant="secondary"
                      />
                    </View>
                  ) : (
                    <View style={styles.outcomeRow}>
                      {action.outcome.status === "executed" ? (
                        <Text style={styles.outcomeDone}>
                          ✓ {t("assistant.done")}
                          {executedSummary(action.outcome.result)}
                        </Text>
                      ) : action.outcome.status === "rejected" ? (
                        <StatusChip label={t("assistant.rejected")} />
                      ) : (
                        <Text style={styles.outcomeFailed}>
                          {t("common.failed")}
                          {action.outcome.error ? `: ${action.outcome.error}` : ""}
                        </Text>
                      )}
                    </View>
                  )}
                </View>
              ))}
            </View>
          ))}

          {pending ? (
            <View style={[styles.bubble, styles.bubbleAssistant, styles.typing]}>
              <TypingDots />
              <Text style={styles.typingText}>{t("assistant.thinking")}</Text>
            </View>
          ) : null}
        </ScrollView>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.inputBar}>
          <TextInput
            editable={!pending}
            maxLength={2000}
            multiline
            onChangeText={setInput}
            placeholder={t("assistant.placeholder")}
            placeholderTextColor={color.mutedSoft}
            style={styles.input}
            value={input}
          />
          <Pressable
            accessibilityLabel={t("comm.send")}
            accessibilityRole="button"
            disabled={pending || input.trim().length === 0}
            onPress={() => void send(input)}
            style={({ pressed }) => [
              styles.sendBtn,
              (pending || input.trim().length === 0) && styles.sendDisabled,
              pressed && { backgroundColor: color.primaryActive },
            ]}
          >
            <Symbol android="arrow_upward" ios="arrow.up" size={18} tint={color.onPrimary} />
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  thread: { gap: space(3), paddingBottom: space(4), flexGrow: 1 },
  emptyWrap: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: space(3),
    paddingVertical: space(8),
  },
  sparklePlate: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  emptyPrompt: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    color: color.body,
    textAlign: "center",
    paddingHorizontal: space(6),
  },
  suggestions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: space(2),
  },
  suggestion: {
    borderRadius: radius.pill,
    backgroundColor: color.surfaceStrong,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2),
  },
  suggestionText: { fontFamily: font.medium, fontSize: 13, color: color.ink },
  bubble: {
    maxWidth: "88%",
    borderRadius: 18,
    paddingHorizontal: space(3.5),
    paddingVertical: space(2.5),
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: color.primary,
    borderBottomRightRadius: 6,
  },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: color.surfaceSoft,
    borderBottomLeftRadius: 6,
  },
  textUser: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: color.onPrimary,
  },
  textAssistant: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: color.ink,
  },
  toolRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: space(1.5),
    marginTop: space(2),
  },
  toolChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceStrong,
    paddingHorizontal: space(2),
    paddingVertical: 3,
  },
  toolLabel: { fontFamily: font.mono, fontSize: 10, color: color.body },
  actionCard: {
    marginTop: space(3),
    backgroundColor: color.canvas,
    borderRadius: radius.card - 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.hairline,
    padding: space(3.5),
    gap: space(2),
  },
  actionHead: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  actionCaption: {
    fontFamily: font.semibold,
    fontSize: 11,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: color.primary,
  },
  actionTitle: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 21,
    color: color.ink,
  },
  actionLines: { gap: space(1) },
  actionLine: { flexDirection: "row", gap: space(2) },
  actionLabel: {
    width: 110,
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: color.muted,
  },
  actionValue: {
    flex: 1,
    fontFamily: font.medium,
    fontSize: 12,
    lineHeight: 18,
    color: color.ink,
  },
  actionWarning: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: color.accentYellow,
  },
  actionButtons: { flexDirection: "row", gap: space(2), marginTop: space(1) },
  actionButton: { flex: 1, minHeight: 40 },
  outcomeRow: { marginTop: space(1) },
  outcomeDone: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    color: color.gain,
  },
  outcomeFailed: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    color: color.loss,
  },
  typing: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
  },
  typingText: { fontFamily: font.regular, fontSize: 13, color: color.muted },
  dotsRow: { flexDirection: "row", gap: 4 },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: color.body,
  },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.loss,
    paddingVertical: space(1),
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: space(2),
    paddingVertical: space(2),
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space(3.5),
    paddingTop: space(3),
    paddingBottom: space(3),
    fontFamily: font.regular,
    fontSize: 15,
    color: color.ink,
    backgroundColor: color.canvas,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { backgroundColor: color.primaryDisabled },
});
