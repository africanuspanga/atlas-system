import type { DictKey } from "@atlas/i18n";
import { Redirect, useRouter } from "expo-router";
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
import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { MoneyText } from "@/components/money-text";
import { Screen } from "@/components/screen";
import { ListSkeleton } from "@/components/skeleton";
import { StatusChip } from "@/components/status-chip";
import { Symbol } from "@/components/symbol";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { color, font, space } from "@/lib/theme";

const ATTENDANCE_KEYS = ["present", "absent", "late", "excused"] as const;

interface Child {
  studentId: string;
  school: string;
  name: string;
  number: string;
  className: string | null;
  balance: number;
  attendance: Record<string, number>;
}

/** Parent portal — warm, read-only children cards. */
export default function Portal() {
  const t = useT();
  const router = useRouter();
  const { session, tenant } = useAuth();

  const [children, setChildren] = useState<Child[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notLinked, setNotLinked] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      // Same contract as apps/web/src/app/portal/portal-view.tsx —
      // no tenant header; the API resolves the guardian's own links.
      const response = await apiFetch("/api/v1/portal/children");
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
        } | null;
        if (body?.code === "PORTAL_NOT_LINKED") {
          setNotLinked(true);
          setError(null);
          return;
        }
        setError(apiErrorMessage(t, body, response.status));
        setNotLinked(false);
        return;
      }
      const body = (await response.json()) as { children: Child[] };
      setChildren(body.children);
      setError(null);
      setNotLinked(false);
    } catch {
      setError(t("common.apiUnreachable"));
    }
  }, [t]);

  useEffect(() => {
    if (!session) return;
    // Deferred so state lands in an async continuation, never mid-render
    // (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => void load(), 0);
    return () => clearTimeout(kick);
  }, [session, load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Routing guard — staff members belong in the tabs, signed-out in login.
  if (session === null) return <Redirect href="/login" />;
  if (tenant) return <Redirect href="/dashboard" />;

  return (
    <Screen edges={["top", "bottom"]}>
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
        subtitle={t("portal.title")}
        title={t("portal.children")}
      />

      {notLinked ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={t("portal.notLinked")}
          icon={
            <Symbol android="family_restroom" ios="person.2" size={26} tint={color.muted} />
          }
          onAction={() => void load()}
          title={t("portal.title")}
        />
      ) : error ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={error}
          onAction={() => void load()}
          title={t("err.generic")}
        />
      ) : !children ? (
        <ListSkeleton rows={4} />
      ) : children.length === 0 ? (
        <EmptyState
          icon={
            <Symbol android="family_restroom" ios="person.2" size={26} tint={color.muted} />
          }
          title={t("portal.noChildren")}
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} />
          }
          showsVerticalScrollIndicator={false}
        >
          {children.map((child) => (
            <Card key={child.studentId} style={styles.childCard}>
              <View style={styles.childHead}>
                <View style={styles.avatar}>
                  <Symbol android="face" ios="person.fill" size={20} tint={color.primary} />
                </View>
                <View style={styles.childTitles}>
                  <Text numberOfLines={1} style={styles.childName}>
                    {child.name}
                  </Text>
                  <Text numberOfLines={1} style={styles.childMeta}>
                    <Text style={styles.mono}>{child.number}</Text>
                    {` · ${child.school}`}
                  </Text>
                </View>
                {child.className ? <StatusChip label={child.className} /> : null}
              </View>

              <View style={styles.divider} />

              <View style={styles.balanceRow}>
                <Text style={styles.balanceLabel}>{t("finance.balance")}</Text>
                <MoneyText
                  amount={child.balance}
                  size={18}
                  tone={child.balance > 0 ? "loss" : "gain"}
                />
              </View>

              <Text style={styles.attendanceLabel}>{t("report.attendance")}</Text>
              <View style={styles.attendanceRow}>
                {ATTENDANCE_KEYS.map((key) => (
                  <View key={key} style={styles.attendanceCell}>
                    <Text style={styles.attendanceCount}>
                      {child.attendance[key] ?? 0}
                    </Text>
                    <Text numberOfLines={1} style={styles.attendanceKey}>
                      {t(`attendance.${key}` as DictKey)}
                    </Text>
                  </View>
                ))}
              </View>
            </Card>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  gear: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  scroll: { gap: space(3), paddingBottom: space(8) },
  childCard: { gap: space(3) },
  childHead: { flexDirection: "row", alignItems: "center", gap: space(3) },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceStrong,
    alignItems: "center",
    justifyContent: "center",
  },
  childTitles: { flex: 1, gap: 2 },
  childName: {
    fontFamily: font.semibold,
    fontSize: 17,
    lineHeight: 23,
    color: color.ink,
  },
  childMeta: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 17,
    color: color.body,
  },
  mono: { fontFamily: font.mono },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  balanceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  balanceLabel: {
    fontFamily: font.regular,
    fontSize: 14,
    color: color.body,
  },
  attendanceLabel: {
    fontFamily: font.regular,
    fontSize: 12,
    color: color.muted,
  },
  attendanceRow: { flexDirection: "row", gap: space(2) },
  attendanceCell: {
    flex: 1,
    alignItems: "center",
    gap: 2,
    backgroundColor: color.surfaceSoft,
    borderRadius: 12,
    paddingVertical: space(2.5),
  },
  attendanceCount: {
    fontFamily: font.mono,
    fontSize: 16,
    color: color.ink,
  },
  attendanceKey: {
    fontFamily: font.regular,
    fontSize: 10,
    color: color.muted,
    paddingHorizontal: 2,
  },
});
