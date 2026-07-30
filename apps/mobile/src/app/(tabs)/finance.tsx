import type { DictKey } from "@atlas/i18n";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { MoneyText } from "@/components/money-text";
import { Screen } from "@/components/screen";
import { SearchField } from "@/components/search-field";
import { ListSkeleton } from "@/components/skeleton";
import { StatusChip } from "@/components/status-chip";
import { Symbol } from "@/components/symbol";
import { useDebounced } from "@/hooks/use-debounced";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { color, space } from "@/lib/theme";

interface InvoiceListRow {
  id: string;
  number: string;
  student: string;
  studentNumber: string;
  total: number;
  paid: number;
  status: string;
}

/** Paginated read helper — Supabase caps reads at 1000 rows. */
async function fetchAllRows<Row>(
  build: (from: number, to: number) => PromiseLike<{ data: Row[] | null }>,
): Promise<Row[]> {
  const pageSize = 1000;
  const all: Row[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data } = await build(from, from + pageSize - 1);
    const page = data ?? [];
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

export default function Finance() {
  const t = useT();
  const router = useRouter();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [rows, setRows] = useState<InvoiceListRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const search = useDebounced(query, 250);

  // Same reads as apps/web/src/app/finance/page.tsx: invoice list via RLS,
  // paid-to-date from a paginated payments read.
  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const [{ data: invoices, error: invError }, payments] = await Promise.all([
        supabase
          .from("invoices")
          .select(
            "id, invoice_number, total, status, students(first_name, last_name, student_number)",
          )
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(200),
        fetchAllRows<{ invoice_id: string; amount: number }>((from, to) =>
          supabase
            .from("payments")
            .select("invoice_id, amount")
            .eq("tenant_id", tenantId)
            .range(from, to),
        ),
      ]);
      if (invError) throw invError;

      const paidByInvoice = new Map<string, number>();
      for (const p of payments) {
        paidByInvoice.set(
          p.invoice_id,
          (paidByInvoice.get(p.invoice_id) ?? 0) + Number(p.amount),
        );
      }

      type InvoiceRow = {
        id: string;
        invoice_number: string;
        total: number;
        status: string;
        students: {
          first_name: string;
          last_name: string;
          student_number: string;
        } | null;
      };
      setRows(
        ((invoices ?? []) as unknown as InvoiceRow[]).map((inv) => ({
          id: inv.id,
          number: inv.invoice_number,
          student: inv.students
            ? `${inv.students.first_name} ${inv.students.last_name}`
            : "—",
          studentNumber: inv.students?.student_number ?? "",
          total: Number(inv.total),
          paid: paidByInvoice.get(inv.id) ?? 0,
          status: inv.status,
        })),
      );
      setError(null);
    } catch {
      setError(t("err.server"));
    }
  }, [tenantId, t]);

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

  const filtered = useMemo(() => {
    if (!rows) return null;
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.number.toLowerCase().includes(q) ||
        r.student.toLowerCase().includes(q) ||
        r.studentNumber.includes(q),
    );
  }, [rows, search]);

  const renderItem = useCallback(
    ({ item }: { item: InvoiceListRow }) => {
      const balance = item.total - item.paid;
      return (
        <ListRow
          icon={
            <Symbol
              android="receipt_long"
              ios="doc.text"
              size={16}
              tint={color.ink}
            />
          }
          onPress={() => router.push(`/finance/${item.id}`)}
          right={
            <View style={styles.right}>
              <MoneyText
                amount={balance}
                size={14}
                tone={balance > 0 ? "loss" : "gain"}
              />
              <StatusChip
                label={t(`finance.status.${item.status}` as DictKey)}
                tone={item.status === "paid" ? "gain" : "neutral"}
              />
            </View>
          }
          subtitle={`${item.number} · ${item.studentNumber}`}
          title={item.student}
        />
      );
    },
    [router, t],
  );

  return (
    <Screen>
      <Header title={t("finance.title")} />
      <View style={styles.searchRow}>
        <SearchField
          onChangeText={setQuery}
          placeholder={t("finance.search")}
          value={query}
        />
      </View>

      {error ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={error}
          onAction={() => void load()}
          title={t("err.generic")}
        />
      ) : !filtered ? (
        <ListSkeleton rows={8} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={
            <Symbol android="receipt_long" ios="doc.text" size={26} tint={color.muted} />
          }
          title={search ? t("students.noMatches") : t("finance.empty")}
        />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={<View style={styles.footer} />}
          refreshControl={
            <RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} />
          }
          renderItem={renderItem}
          showsVerticalScrollIndicator={false}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  searchRow: { paddingBottom: space(2) },
  right: { alignItems: "flex-end", gap: space(1) },
  footer: { height: space(8) },
});
