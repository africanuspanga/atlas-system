import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { Screen } from "@/components/screen";
import { SearchField } from "@/components/search-field";
import { ListSkeleton } from "@/components/skeleton";
import { Symbol } from "@/components/symbol";
import { useDebounced } from "@/hooks/use-debounced";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { color, font, space } from "@/lib/theme";

const PAGE_SIZE = 50;

// Mirrors apps/web/src/app/students/students-view.tsx STUDENT_LIST_SELECT.
const LIST_SELECT = `id, student_number, first_name, middle_name, last_name, status,
  class_enrolments(class_sections(name, grade_levels(name)))`;

interface StudentRow {
  id: string;
  student_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
  status: string;
  class_enrolments: {
    class_sections: {
      name: string;
      grade_levels: { name: string } | null;
    } | null;
  }[];
}

/** PostgREST `.or()` filters break on commas/parens/percent — strip them. */
function sanitizeSearch(value: string) {
  return value.replace(/[,()%\\]/g, " ").trim();
}

function sectionLabel(student: StudentRow): string | null {
  const section = student.class_enrolments[0]?.class_sections;
  if (!section) return null;
  return `${section.grade_levels?.name ?? ""} ${section.name}`.trim();
}

export default function Students() {
  const t = useT();
  const router = useRouter();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [rows, setRows] = useState<StudentRow[] | null>(null);
  const [count, setCount] = useState(0);
  const [query, setQuery] = useState("");
  const search = useDebounced(query, 300);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    async (page: number) => {
      if (!tenantId) return { data: null as StudentRow[] | null, count: 0 };
      let builder = supabase
        .from("students")
        .select(LIST_SELECT, { count: "exact" })
        .eq("tenant_id", tenantId);
      const q = sanitizeSearch(search);
      if (q) {
        // Server-side filter: name parts + admission number (string — keeps
        // leading zeros).
        builder = builder.or(
          `first_name.ilike.%${q}%,middle_name.ilike.%${q}%,last_name.ilike.%${q}%,student_number.ilike.%${q}%`,
        );
      }
      const { data, count: exact, error: dbError } = await builder
        .order("created_at", { ascending: false })
        .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
      if (dbError) throw dbError;
      return {
        data: (data ?? []) as unknown as StudentRow[],
        count: exact ?? 0,
      };
    },
    [tenantId, search],
  );

  const reload = useCallback(async () => {
    try {
      const { data, count: exact } = await fetchPage(0);
      setRows(data);
      setCount(exact);
      setError(null);
    } catch {
      setError(t("err.server"));
    }
  }, [fetchPage, t]);

  // Show skeletons whenever the search term changes (render-time adjustment,
  // same pattern as the web students view).
  const [prevSearch, setPrevSearch] = useState(search);
  if (prevSearch !== search) {
    setPrevSearch(search);
    setRows(null);
  }

  useEffect(() => {
    // Deferred so state lands in an async continuation, never mid-render
    // (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => void reload(), 0);
    return () => clearTimeout(kick);
  }, [reload]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const loadMore = useCallback(async () => {
    if (!rows || loadingMore || rows.length >= count) return;
    setLoadingMore(true);
    try {
      const page = Math.floor(rows.length / PAGE_SIZE);
      const { data } = await fetchPage(page);
      if (data) {
        setRows((prev) => {
          const seen = new Set((prev ?? []).map((r) => r.id));
          return [...(prev ?? []), ...data.filter((r) => !seen.has(r.id))];
        });
      }
    } catch {
      // Silent: the footer spinner disappears; pull-to-refresh recovers.
    } finally {
      setLoadingMore(false);
    }
  }, [rows, loadingMore, count, fetchPage]);

  const renderItem = useCallback(
    ({ item }: { item: StudentRow }) => {
      const name = [item.first_name, item.middle_name, item.last_name]
        .filter(Boolean)
        .join(" ");
      const klass = sectionLabel(item);
      return (
        <ListRow
          icon={
            <Symbol android="person" ios="person.fill" size={16} tint={color.ink} />
          }
          onPress={() => router.push(`/students/${item.id}`)}
          right={
            <Symbol
              android="chevron_right"
              ios="chevron.right"
              size={14}
              tint={color.mutedSoft}
            />
          }
          subtitle={`${item.student_number}${klass ? ` · ${klass}` : ""}`}
          title={name}
        />
      );
    },
    [router],
  );

  return (
    <Screen>
      <Header title={t("students.title")} />
      <View style={styles.searchRow}>
        <SearchField
          onChangeText={setQuery}
          placeholder={t("students.search")}
          value={query}
        />
        {rows ? (
          <Text style={styles.count}>
            <Text style={styles.countNumber}>{count}</Text> {t("students.total")}
          </Text>
        ) : null}
      </View>

      {error ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={error}
          onAction={() => void reload()}
          title={t("err.generic")}
        />
      ) : !rows ? (
        <ListSkeleton rows={8} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={
            <Symbol android="group" ios="person.2" size={26} tint={color.muted} />
          }
          title={search ? t("students.noMatches") : t("students.empty")}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListFooterComponent={
            loadingMore ? <ListSkeleton rows={2} /> : <View style={styles.footer} />
          }
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
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
  searchRow: { gap: space(2), paddingBottom: space(2) },
  count: {
    fontFamily: font.regular,
    fontSize: 12,
    color: color.muted,
    textAlign: "right",
  },
  countNumber: { fontFamily: font.mono, color: color.body },
  footer: { height: space(8) },
});
