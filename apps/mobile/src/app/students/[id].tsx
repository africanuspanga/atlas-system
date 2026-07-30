import type { DictKey } from "@atlas/i18n";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { MoneyText } from "@/components/money-text";
import { Screen } from "@/components/screen";
import { Skeleton } from "@/components/skeleton";
import { StatusChip } from "@/components/status-chip";
import { Symbol } from "@/components/symbol";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { color, font, space } from "@/lib/theme";

interface StudentDetail {
  id: string;
  student_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  gender: string;
  date_of_birth: string | null;
  boarding_status: string;
  status: string;
  class_enrolments: {
    status: string;
    class_sections: {
      name: string;
      grade_levels: { name: string } | null;
    } | null;
  }[];
  student_guardians: {
    is_primary: boolean;
    relationship: string;
    guardians: { id: string; full_name: string; phone: string | null } | null;
  }[];
}

interface InvoiceSummary {
  id: string;
  number: string;
  total: number;
  paid: number;
  status: string;
}

export default function StudentScreen() {
  const t = useT();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [student, setStudent] = useState<StudentDetail | null>(null);
  const [invoices, setInvoices] = useState<InvoiceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    if (!tenantId || !id) return;
    try {
      const [{ data: studentRow, error: sErr }, { data: invoiceRows }, { data: paymentRows }] =
        await Promise.all([
          supabase
            .from("students")
            .select(
              `id, student_number, first_name, middle_name, last_name, gender,
               date_of_birth, boarding_status, status,
               class_enrolments(status, class_sections(name, grade_levels(name))),
               student_guardians(is_primary, relationship, guardians(id, full_name, phone))`,
            )
            .eq("tenant_id", tenantId)
            .eq("id", id)
            .maybeSingle(),
          supabase
            .from("invoices")
            .select("id, invoice_number, total, status")
            .eq("tenant_id", tenantId)
            .eq("student_id", id)
            .order("created_at", { ascending: false })
            .limit(50),
          supabase
            .from("payments")
            .select("invoice_id, amount")
            .eq("tenant_id", tenantId)
            .eq("student_id", id)
            .limit(1000),
        ]);
      if (sErr) throw sErr;
      if (!studentRow) {
        setError(t("err.notFound"));
        return;
      }
      setStudent(studentRow as unknown as StudentDetail);

      const paidByInvoice = new Map<string, number>();
      type PaymentRow = { invoice_id: string; amount: number };
      for (const p of (paymentRows ?? []) as PaymentRow[]) {
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
      };
      setInvoices(
        ((invoiceRows ?? []) as InvoiceRow[]).map((inv) => ({
          id: inv.id,
          number: inv.invoice_number,
          total: Number(inv.total),
          paid: paidByInvoice.get(inv.id) ?? 0,
          status: inv.status,
        })),
      );
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

  const relationshipLabel = (relationship: string) => {
    const known = ["mother", "father", "guardian", "sponsor"];
    return known.includes(relationship)
      ? t(`students.rel.${relationship}` as DictKey)
      : relationship;
  };

  const name = student
    ? [student.first_name, student.middle_name, student.last_name]
        .filter(Boolean)
        .join(" ")
    : t("students.title");
  const enrolment = student?.class_enrolments.find(
    (e) => e.status === "active",
  )?.class_sections;
  const klass = enrolment
    ? `${enrolment.grade_levels?.name ?? ""} ${enrolment.name}`.trim()
    : null;

  return (
    <Screen edges={["top", "bottom"]}>
      <Header back subtitle={student?.student_number} title={name} />
      {error ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={error}
          onAction={() => void load()}
          title={t("err.generic")}
        />
      ) : (
        <ScrollView
          contentContainerStyle={styles.scroll}
          refreshControl={
            <RefreshControl onRefresh={() => void onRefresh()} refreshing={refreshing} />
          }
          showsVerticalScrollIndicator={false}
        >
          {/* Profile */}
          <Text style={styles.section}>{t("students.detail.profile")}</Text>
          <Card>
            {!student ? (
              <View style={styles.skeletonStack}>
                <Skeleton height={16} />
                <Skeleton height={16} width="70%" />
              </View>
            ) : (
              <>
                <ListRow
                  right={
                    <Text style={styles.mono}>{student.student_number}</Text>
                  }
                  title={t("students.number")}
                />
                <ListRow
                  right={
                    <Text style={styles.value}>
                      {t(
                        student.gender === "male"
                          ? "students.male"
                          : "students.female",
                      )}
                    </Text>
                  }
                  title={t("students.gender")}
                />
                <ListRow
                  right={
                    <Text style={styles.mono}>
                      {student.date_of_birth ?? "—"}
                    </Text>
                  }
                  title={t("students.dob")}
                />
                <ListRow
                  right={
                    <Text style={styles.value}>
                      {t(
                        student.boarding_status === "boarding"
                          ? "students.boarding"
                          : "students.day",
                      )}
                    </Text>
                  }
                  title={t("students.boarding")}
                />
                <ListRow
                  last
                  right={
                    <StatusChip
                      label={student.status}
                      tone={student.status === "active" ? "gain" : "neutral"}
                    />
                  }
                  title={t("students.status")}
                />
              </>
            )}
          </Card>

          {/* Enrolment */}
          <Text style={styles.section}>{t("students.detail.enrolment")}</Text>
          <Card>
            {!student ? (
              <Skeleton height={16} width="55%" />
            ) : (
              <ListRow
                icon={
                  <Symbol android="school" ios="graduationcap.fill" size={16} tint={color.ink} />
                }
                last
                title={klass ?? "—"}
              />
            )}
          </Card>

          {/* Guardians */}
          <Text style={styles.section}>{t("students.detail.guardians")}</Text>
          <Card>
            {!student ? (
              <Skeleton height={16} width="70%" />
            ) : student.student_guardians.length === 0 ? (
              <Text style={styles.emptyText}>—</Text>
            ) : (
              student.student_guardians.map((link, i) =>
                link.guardians ? (
                  <ListRow
                    icon={
                      <Symbol
                        android="family_restroom"
                        ios="person.fill"
                        size={16}
                        tint={color.ink}
                      />
                    }
                    key={link.guardians.id}
                    last={i === student.student_guardians.length - 1}
                    right={
                      link.is_primary ? (
                        <StatusChip
                          label={relationshipLabel(link.relationship)}
                          tone="primary"
                        />
                      ) : undefined
                    }
                    subtitle={link.guardians.phone ?? undefined}
                    title={link.guardians.full_name}
                  />
                ) : null,
              )
            )}
          </Card>

          {/* Invoices */}
          <Text style={styles.section}>{t("students.detail.invoices")}</Text>
          <Card>
            {!invoices ? (
              <View style={styles.skeletonStack}>
                <Skeleton height={16} />
                <Skeleton height={16} width="70%" />
              </View>
            ) : invoices.length === 0 ? (
              <Text style={styles.emptyText}>{t("finance.empty")}</Text>
            ) : (
              invoices.map((inv, i) => (
                <ListRow
                  key={inv.id}
                  last={i === invoices.length - 1}
                  onPress={() => router.push(`/finance/${inv.id}`)}
                  right={
                    <View style={styles.invoiceRight}>
                      <MoneyText
                        amount={inv.total - inv.paid}
                        size={14}
                        tone={inv.total - inv.paid > 0 ? "loss" : "gain"}
                      />
                      <StatusChip
                        label={t(`finance.status.${inv.status}` as DictKey)}
                        tone={inv.status === "paid" ? "gain" : "neutral"}
                      />
                    </View>
                  }
                  subtitle={t("finance.balance")}
                  title={inv.number}
                />
              ))
            )}
          </Card>
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { gap: space(2), paddingBottom: space(8) },
  section: {
    fontFamily: font.semibold,
    fontSize: 15,
    lineHeight: 21,
    color: color.ink,
    marginTop: space(3),
  },
  skeletonStack: { gap: space(3) },
  mono: { fontFamily: font.mono, fontSize: 14, color: color.ink },
  value: { fontFamily: font.regular, fontSize: 14, color: color.ink },
  emptyText: {
    fontFamily: font.regular,
    fontSize: 14,
    color: color.muted,
    textAlign: "center",
    paddingVertical: space(2),
  },
  invoiceRight: { alignItems: "flex-end", gap: space(1) },
});
