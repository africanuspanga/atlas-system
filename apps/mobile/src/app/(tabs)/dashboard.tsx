import type { DictKey } from "@atlas/i18n";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Card } from "@/components/card";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { MoneyText } from "@/components/money-text";
import { Screen } from "@/components/screen";
import { Skeleton } from "@/components/skeleton";
import { Symbol } from "@/components/symbol";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { todayInTanzania } from "@/lib/tanzania-date";
import { color, font, radius, space } from "@/lib/theme";

interface DashboardData {
  students: number;
  sections: number;
  presentToday: number;
  attendanceRateToday: number | null;
  collectedMonth: number;
  receiptsMonth: number;
  recentPayments: {
    receipt: string;
    amount: number;
    method: string;
    student: string;
  }[];
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

export default function Dashboard() {
  const t = useT();
  const router = useRouter();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId) return;
    try {
      const today = todayInTanzania();
      const monthStart = `${today.slice(0, 7)}-01`;

      // Same RLS aggregation the web dashboard uses (apps/web/src/app/page.tsx),
      // with payments narrowed to the current month for the mobile headline.
      const [
        { count: students },
        { count: sections },
        { data: sessions },
        payments,
        { data: recentRows },
      ] = await Promise.all([
        supabase
          .from("students")
          .select("*", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "active"),
        supabase
          .from("class_sections")
          .select("*", { count: "exact", head: true })
          .eq("tenant_id", tenantId)
          .eq("status", "active"),
        supabase
          .from("attendance_sessions")
          .select("session_date, attendance_records(status)")
          .eq("tenant_id", tenantId)
          .eq("session_date", today),
        fetchAllRows<{ amount: number }>((from, to) =>
          supabase
            .from("payments")
            .select("amount")
            .eq("tenant_id", tenantId)
            .gte("created_at", monthStart)
            .range(from, to),
        ),
        supabase
          .from("payments")
          .select(
            "receipt_number, amount, method, students(first_name, last_name)",
          )
          .eq("tenant_id", tenantId)
          .order("created_at", { ascending: false })
          .limit(5),
      ]);

      let present = 0;
      let total = 0;
      for (const session of sessions ?? []) {
        const records: { status: string }[] = session.attendance_records ?? [];
        for (const record of records) {
          total += 1;
          if (record.status === "present" || record.status === "late") {
            present += 1;
          }
        }
      }

      const collectedMonth = payments.reduce(
        (sum, p) => sum + Number(p.amount),
        0,
      );

      type RecentRow = {
        receipt_number: string;
        amount: number;
        method: string;
        students: { first_name: string; last_name: string } | null;
      };
      const recent: RecentRow[] = (recentRows ?? []) as unknown as RecentRow[];

      setData({
        students: students ?? 0,
        sections: sections ?? 0,
        presentToday: present,
        attendanceRateToday:
          total > 0 ? Math.round((present / total) * 1000) / 10 : null,
        collectedMonth,
        receiptsMonth: payments.filter((p) => Number(p.amount) > 0).length,
        recentPayments: recent.map((p) => ({
          receipt: p.receipt_number,
          amount: Number(p.amount),
          method: t(`finance.method.${p.method}` as DictKey),
          student: p.students
            ? `${p.students.first_name} ${p.students.last_name}`
            : "—",
        })),
      });
      setError(null);
    } catch {
      setError(t("common.apiUnreachable"));
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

  const quickActions: {
    label: string;
    ios: "checkmark.circle.fill" | "creditcard.fill" | "sparkles" | "person.2.fill";
    android: "fact_check" | "payments" | "auto_awesome" | "group";
    onPress: () => void;
  }[] = [
    {
      label: t("nav.attendance"),
      ios: "checkmark.circle.fill",
      android: "fact_check",
      onPress: () => router.push("/attendance"),
    },
    {
      label: t("nav.finance"),
      ios: "creditcard.fill",
      android: "payments",
      onPress: () => router.push("/finance"),
    },
    {
      label: t("nav.students"),
      ios: "person.2.fill",
      android: "group",
      onPress: () => router.push("/students"),
    },
    {
      label: t("assistant.launcher"),
      ios: "sparkles",
      android: "auto_awesome",
      onPress: () => router.push("/assistant"),
    },
  ];

  return (
    <Screen>
      <Header
        right={
          <Pressable
            accessibilityLabel={t("nav.settings")}
            accessibilityRole="button"
            hitSlop={8}
            onPress={() => router.push("/settings")}
            style={({ pressed }) => [
              styles.gear,
              pressed && { backgroundColor: color.hairline },
            ]}
          >
            <Symbol android="settings" ios="gearshape.fill" size={18} tint={color.ink} />
          </Pressable>
        }
        subtitle={t("nav.overview")}
        title={tenant?.name ?? "ATLAS"}
      />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={
          <RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} />
        }
        showsVerticalScrollIndicator={false}
      >
        {error ? <Text style={styles.error}>{error}</Text> : null}

        {/* Headline numbers */}
        <View style={styles.statRow}>
          <Card style={styles.statCard}>
            <Text style={styles.statLabel}>{t("dash.totalStudents")}</Text>
            {data ? (
              <>
                <Text style={styles.statNumber}>{data.students}</Text>
                <Text style={styles.statSub}>
                  {data.sections} {t("dash.classes")}
                </Text>
              </>
            ) : (
              <Skeleton height={30} width={72} />
            )}
          </Card>
          <Card style={styles.statCard}>
            <Text style={styles.statLabel}>{t("dash.presentToday")}</Text>
            {data ? (
              data.attendanceRateToday === null ? (
                <>
                  <Text style={styles.statNumber}>—</Text>
                  <Text style={styles.statSub}>{t("dash.noRegisters")}</Text>
                </>
              ) : (
                <>
                  <Text style={styles.statNumber}>
                    {data.attendanceRateToday}%
                  </Text>
                  <Text style={styles.statSub}>
                    {data.presentToday} {t("attendance.students")}
                  </Text>
                </>
              )
            ) : (
              <Skeleton height={30} width={72} />
            )}
          </Card>
        </View>
        <Card>
          <Text style={styles.statLabel}>{t("dash.collectedMonth")}</Text>
          {data ? (
            <>
              <MoneyText amount={data.collectedMonth} size={26} tone="gain" />
              <Text style={styles.statSub}>
                {data.receiptsMonth} {t("dash.receipts")}
              </Text>
            </>
          ) : (
            <Skeleton height={34} width={160} />
          )}
        </Card>

        {/* Quick actions */}
        <Text style={styles.sectionTitle}>{t("dash.quickActions")}</Text>
        <View style={styles.actionsRow}>
          {quickActions.map((action) => (
            <Pressable
              accessibilityRole="button"
              key={action.label}
              onPress={action.onPress}
              style={({ pressed }) => [
                styles.action,
                pressed && { backgroundColor: color.hairline },
              ]}
            >
              <View style={styles.actionPlate}>
                <Symbol
                  android={action.android}
                  ios={action.ios}
                  size={20}
                  tint={color.primary}
                />
              </View>
              <Text numberOfLines={1} style={styles.actionLabel}>
                {action.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {/* Recent payments */}
        <Text style={styles.sectionTitle}>{t("dash.recentPayments")}</Text>
        <Card>
          {!data ? (
            <View style={styles.skeletonStack}>
              <Skeleton height={16} />
              <Skeleton height={16} width="80%" />
              <Skeleton height={16} width="65%" />
            </View>
          ) : data.recentPayments.length === 0 ? (
            <Text style={styles.noData}>{t("dash.noData")}</Text>
          ) : (
            data.recentPayments.map((p, i) => (
              <ListRow
                icon={
                  <Symbol
                    android="receipt_long"
                    ios="banknote"
                    size={16}
                    tint={color.ink}
                  />
                }
                key={p.receipt}
                last={i === data.recentPayments.length - 1}
                right={
                  <MoneyText
                    amount={p.amount}
                    size={14}
                    tone={p.amount < 0 ? "loss" : "gain"}
                  />
                }
                subtitle={`${p.receipt} · ${p.method}`}
                title={p.student}
              />
            ))
          )}
        </Card>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: space(4), paddingBottom: space(8) },
  gear: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    color: color.loss,
  },
  statRow: { flexDirection: "row", gap: space(3) },
  statCard: { flex: 1 },
  statLabel: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 18,
    color: color.body,
    marginBottom: space(1.5),
  },
  statNumber: {
    fontFamily: font.mono,
    fontSize: 26,
    lineHeight: 34,
    color: color.ink,
  },
  statSub: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: color.muted,
    marginTop: 2,
  },
  sectionTitle: {
    fontFamily: font.semibold,
    fontSize: 16,
    lineHeight: 22,
    color: color.ink,
    marginTop: space(2),
  },
  actionsRow: { flexDirection: "row", gap: space(2) },
  action: {
    flex: 1,
    alignItems: "center",
    gap: space(1.5),
    paddingVertical: space(3),
    borderRadius: radius.input,
    backgroundColor: color.surfaceSoft,
  },
  actionPlate: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.canvas,
    alignItems: "center",
    justifyContent: "center",
  },
  actionLabel: {
    fontFamily: font.medium,
    fontSize: 11,
    color: color.ink,
    paddingHorizontal: space(1),
  },
  skeletonStack: { gap: space(3) },
  noData: {
    fontFamily: font.regular,
    fontSize: 14,
    color: color.muted,
    textAlign: "center",
    paddingVertical: space(4),
  },
});
