import type { DictKey } from "@atlas/i18n";
import * as Haptics from "expo-haptics";
import * as Crypto from "expo-crypto";
import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { MoneyText } from "@/components/money-text";
import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { Skeleton } from "@/components/skeleton";
import { StatusChip } from "@/components/status-chip";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { color, font, radius, space } from "@/lib/theme";

const METHODS = [
  "cash",
  "mpesa",
  "tigopesa",
  "airtel_money",
  "halopesa",
  "bank",
  "cheque",
  "other",
] as const;

interface PaymentRow {
  id: string;
  receipt: string;
  amount: number;
  method: string;
  reference: string | null;
  paidOn: string;
  isReversal: boolean;
  isReversed: boolean;
}

interface InvoiceDetail {
  id: string;
  number: string;
  status: string;
  total: number;
  paid: number;
  student: string;
  studentNumber: string;
  lines: { id: string; description: string; amount: number }[];
  instalments: { id: string; seq: number; amount: number; dueOn: string }[];
  payments: PaymentRow[];
}

export default function InvoiceScreen() {
  const t = useT();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !id) return;
    try {
      const { data, error: dbError } = await supabase
        .from("invoices")
        .select(
          `id, invoice_number, status, total,
           students(first_name, last_name, student_number),
           invoice_lines(id, description, amount),
           invoice_instalments(id, seq, amount, due_on),
           payments(id, receipt_number, amount, method, reference, paid_on,
                    reverses_payment_id, created_at)`,
        )
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle();
      if (dbError) throw dbError;
      if (!data) {
        setError(t("err.notFound"));
        return;
      }

      type Row = {
        id: string;
        invoice_number: string;
        status: string;
        total: number;
        students: {
          first_name: string;
          last_name: string;
          student_number: string;
        } | null;
        invoice_lines: { id: string; description: string; amount: number }[];
        invoice_instalments: {
          id: string;
          seq: number;
          amount: number;
          due_on: string;
        }[];
        payments: {
          id: string;
          receipt_number: string;
          amount: number;
          method: string;
          reference: string | null;
          paid_on: string;
          reverses_payment_id: string | null;
          created_at: string;
        }[];
      };
      const row = data as unknown as Row;

      const reversedIds = new Set(
        row.payments
          .map((p) => p.reverses_payment_id)
          .filter((x): x is string => x !== null),
      );
      const payments: PaymentRow[] = row.payments
        .slice()
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .map((p) => ({
          id: p.id,
          receipt: p.receipt_number,
          amount: Number(p.amount),
          method: p.method,
          reference: p.reference,
          paidOn: p.paid_on,
          isReversal: p.reverses_payment_id !== null,
          isReversed: reversedIds.has(p.id),
        }));

      setInvoice({
        id: row.id,
        number: row.invoice_number,
        status: row.status,
        total: Number(row.total),
        paid: payments.reduce((sum, p) => sum + p.amount, 0),
        student: row.students
          ? `${row.students.first_name} ${row.students.last_name}`
          : "—",
        studentNumber: row.students?.student_number ?? "",
        lines: row.invoice_lines.map((l) => ({
          id: l.id,
          description: l.description,
          amount: Number(l.amount),
        })),
        instalments: row.invoice_instalments
          .slice()
          .sort((a, b) => a.seq - b.seq)
          .map((i) => ({
            id: i.id,
            seq: i.seq,
            amount: Number(i.amount),
            dueOn: i.due_on,
          })),
        payments,
      });
      setError(null);
    } catch {
      setError(t("err.server"));
    }
  }, [tenantId, id, t]);

  useEffect(() => {
    // Deferred so state lands in an async continuation, never mid-render
    // (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => void load(), 0);
    return () => clearTimeout(kick);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const balance = invoice ? invoice.total - invoice.paid : 0;

  return (
    <Screen edges={["top", "bottom"]}>
      <Header
        back
        subtitle={invoice ? `${invoice.student} · ${invoice.studentNumber}` : undefined}
        title={invoice?.number ?? t("finance.title")}
      />
      {error ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={error}
          onAction={() => void load()}
          title={t("err.generic")}
        />
      ) : (
        <>
          <ScrollView
            contentContainerStyle={styles.scroll}
            refreshControl={
              <RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} />
            }
            showsVerticalScrollIndicator={false}
          >
            {/* Totals */}
            <Card>
              {!invoice ? (
                <View style={styles.skeletonStack}>
                  <Skeleton height={18} />
                  <Skeleton height={18} width="70%" />
                </View>
              ) : (
                <View style={styles.totalsRow}>
                  <View style={styles.totalCol}>
                    <Text style={styles.totalLabel}>{t("finance.total")}</Text>
                    <MoneyText amount={invoice.total} size={15} />
                  </View>
                  <View style={styles.totalCol}>
                    <Text style={styles.totalLabel}>{t("finance.paid")}</Text>
                    <MoneyText amount={invoice.paid} size={15} tone="gain" />
                  </View>
                  <View style={styles.totalCol}>
                    <Text style={styles.totalLabel}>{t("finance.balance")}</Text>
                    <MoneyText
                      amount={balance}
                      size={15}
                      tone={balance > 0 ? "loss" : "gain"}
                    />
                  </View>
                </View>
              )}
              {invoice ? (
                <View style={styles.statusRow}>
                  <StatusChip
                    label={t(`finance.status.${invoice.status}` as DictKey)}
                    tone={invoice.status === "paid" ? "gain" : "neutral"}
                  />
                </View>
              ) : null}
            </Card>

            {/* Lines */}
            <Text style={styles.section}>{t("finance.lines")}</Text>
            <Card>
              {!invoice ? (
                <Skeleton height={16} width="70%" />
              ) : (
                invoice.lines.map((line, i) => (
                  <ListRow
                    key={line.id}
                    last={i === invoice.lines.length - 1}
                    right={<MoneyText amount={line.amount} size={14} />}
                    title={line.description}
                  />
                ))
              )}
            </Card>

            {/* Instalments (read-only) */}
            {invoice && invoice.instalments.length > 0 ? (
              <>
                <Text style={styles.section}>{t("finance.instalments")}</Text>
                <Card>
                  {invoice.instalments.map((inst, i) => (
                    <ListRow
                      key={inst.id}
                      last={i === invoice.instalments.length - 1}
                      right={<MoneyText amount={inst.amount} size={14} />}
                      subtitle={`${t("finance.dueOn")}: ${inst.dueOn}`}
                      title={`${t("finance.instalment")} ${inst.seq}`}
                    />
                  ))}
                </Card>
              </>
            ) : null}

            {/* Payments */}
            <Text style={styles.section}>{t("finance.payments")}</Text>
            <Card>
              {!invoice ? (
                <Skeleton height={16} width="70%" />
              ) : invoice.payments.length === 0 ? (
                <Text style={styles.emptyText}>—</Text>
              ) : (
                invoice.payments.map((p, i) => (
                  <ListRow
                    key={p.id}
                    last={i === invoice.payments.length - 1}
                    right={
                      <View style={styles.paymentRight}>
                        <MoneyText
                          amount={p.amount}
                          size={14}
                          tone={p.amount < 0 ? "loss" : "gain"}
                        />
                        {p.isReversed ? (
                          <StatusChip label={t("finance.reversed")} tone="loss" />
                        ) : null}
                      </View>
                    }
                    subtitle={`${p.paidOn} · ${t(`finance.method.${p.method}` as DictKey)}${p.reference ? ` · ${p.reference}` : ""}${p.isReversal ? ` · ${t("finance.reversalOf")}` : ""}`}
                    title={p.receipt}
                  />
                ))
              )}
            </Card>
          </ScrollView>

          {/* Record payment CTA — the server enforces who may post payments. */}
          {invoice && balance > 0 ? (
            <View style={styles.cta}>
              <PillButton
                haptic
                onPress={() => setSheetOpen(true)}
                title={t("finance.recordPayment")}
              />
            </View>
          ) : null}

          {invoice ? (
            <RecordPaymentSheet
              balance={balance}
              invoiceId={invoice.id}
              onClose={() => setSheetOpen(false)}
              onSaved={() => {
                setSheetOpen(false);
                void load();
              }}
              open={sheetOpen}
              tenantId={tenantId}
            />
          ) : null}
        </>
      )}
    </Screen>
  );
}

function RecordPaymentSheet({
  open,
  onClose,
  onSaved,
  invoiceId,
  balance,
  tenantId,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  invoiceId: string;
  balance: number;
  tenantId: string | undefined;
}) {
  const t = useT();
  const [amount, setAmount] = useState(String(balance));
  const [method, setMethod] = useState<(typeof METHODS)[number]>("mpesa");
  const [reference, setReference] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() =>
    Crypto.randomUUID(),
  );

  // Re-prime the amount each time the sheet opens for the current balance.
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) {
      setAmount(String(balance));
      setError(null);
      setIdempotencyKey(Crypto.randomUUID());
    }
  }

  async function submit() {
    if (!tenantId) return;
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError(t("err.invalid"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch(
        `/api/v1/finance/invoices/${invoiceId}/payments`,
        {
          method: "POST",
          tenantId,
          body: JSON.stringify({
            idempotencyKey,
            amount: value,
            method,
            reference: reference.trim() || undefined,
          }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
        } | null;
        setError(apiErrorMessage(t, body, response.status));
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setReference("");
      onSaved();
    } catch {
      setError(t("common.apiUnreachable"));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      transparent
      visible={open}
    >
      <Pressable onPress={onClose} style={styles.backdrop} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        pointerEvents="box-none"
        style={styles.sheetWrap}
      >
        <View style={styles.sheet}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>{t("finance.recordPayment")}</Text>

          <Text style={styles.fieldLabel}>{t("finance.amount")}</Text>
          <TextInput
            editable={!pending}
            inputMode="numeric"
            onChangeText={setAmount}
            style={[styles.input, styles.inputMono]}
            value={amount}
          />

          <Text style={styles.fieldLabel}>{t("finance.method")}</Text>
          <View style={styles.methodWrap}>
            {METHODS.map((m) => (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ selected: method === m }}
                key={m}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setMethod(m);
                }}
                style={[styles.methodChip, method === m && styles.methodActive]}
              >
                <Text
                  style={[
                    styles.methodLabel,
                    method === m && styles.methodLabelActive,
                  ]}
                >
                  {t(`finance.method.${m}` as DictKey)}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.fieldLabel}>{t("finance.reference")}</Text>
          <TextInput
            autoCapitalize="characters"
            autoCorrect={false}
            editable={!pending}
            onChangeText={setReference}
            style={[styles.input, styles.inputMono]}
            value={reference}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.sheetActions}>
            <PillButton
              onPress={onClose}
              style={styles.sheetAction}
              title={t("common.cancel")}
              variant="secondary"
            />
            <PillButton
              haptic
              loading={pending}
              onPress={() => void submit()}
              style={styles.sheetAction}
              title={t("common.save")}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: space(2), paddingBottom: space(20) },
  skeletonStack: { gap: space(3) },
  section: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 21,
    color: color.ink,
    marginTop: space(3),
  },
  totalsRow: { flexDirection: "row", gap: space(3) },
  totalCol: { flex: 1, gap: 2 },
  totalLabel: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: color.body,
  },
  statusRow: { marginTop: space(3) },
  emptyText: {
    fontFamily: font.regular,
    fontSize: 14,
    color: color.muted,
    textAlign: "center",
    paddingVertical: space(2),
  },
  paymentRight: { alignItems: "flex-end", gap: space(1) },
  cta: { paddingVertical: space(3) },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(10, 11, 13, 0.45)",
  },
  sheetWrap: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    backgroundColor: color.canvas,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    padding: space(5),
    paddingBottom: space(9),
    gap: space(2),
  },
  grabber: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: color.hairline,
    marginBottom: space(2),
  },
  sheetTitle: {
    fontFamily: font.semibold,
    fontSize: 18,
    lineHeight: 24,
    color: color.ink,
    marginBottom: space(1),
  },
  fieldLabel: {
    fontFamily: font.medium,
    fontSize: 13,
    color: color.ink,
    marginTop: space(1),
  },
  input: {
    height: 48,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space(3.5),
    fontFamily: font.regular,
    fontSize: 16,
    color: color.ink,
    backgroundColor: color.canvas,
  },
  inputMono: { fontFamily: font.mono },
  methodWrap: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
  methodChip: {
    borderRadius: radius.pill,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    backgroundColor: color.surfaceStrong,
    minHeight: 32,
    justifyContent: "center",
  },
  methodActive: { backgroundColor: color.ink },
  methodLabel: { fontFamily: font.medium, fontSize: 13, color: color.ink },
  methodLabelActive: { color: color.onPrimary },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.loss,
  },
  sheetActions: { flexDirection: "row", gap: space(2), marginTop: space(2) },
  sheetAction: { flex: 1 },
});
