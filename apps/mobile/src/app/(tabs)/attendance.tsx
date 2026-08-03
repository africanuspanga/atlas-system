import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Card } from "@/components/card";
import { EmptyState } from "@/components/empty-state";
import { Header } from "@/components/header";
import { ListRow } from "@/components/list-row";
import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { ListSkeleton } from "@/components/skeleton";
import { Symbol } from "@/components/symbol";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { useAuth } from "@/lib/auth";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { todayInTanzania } from "@/lib/tanzania-date";
import { color, font, radius, space } from "@/lib/theme";

type Status = "present" | "absent" | "late" | "excused";
const STATUSES: Status[] = ["present", "absent", "late", "excused"];

interface SectionOption {
  id: string;
  label: string;
}

interface RosterStudent {
  id: string;
  student_number: string;
  first_name: string;
  middle_name: string | null;
  last_name: string;
}

function isoDate(d: Date) {
  return todayInTanzania(d);
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

export default function Attendance() {
  const t = useT();
  const { tenant } = useAuth();
  const tenantId = tenant?.tenantId;

  const [sections, setSections] = useState<SectionOption[] | null>(null);
  const [sectionId, setSectionId] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [date, setDate] = useState(isoDate(new Date()));
  const [roster, setRoster] = useState<RosterStudent[] | null>(null);
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [existing, setExisting] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ alertsQueued: number } | null>(null);
  const [pending, setPending] = useState(false);

  // Class sections, ordered by grade sequence — same as the web view.
  const loadSections = useCallback(async () => {
    if (!tenantId) return;
    const { data, error } = await supabase
      .from("class_sections")
      .select("id, name, grade_levels(name, sequence)")
      .eq("tenant_id", tenantId)
      .eq("status", "active");
    if (error) {
      setLoadError(t("err.server"));
      return;
    }
    type SectionRow = {
      id: string;
      name: string;
      grade_levels: { name: string; sequence: number } | null;
    };
    const options = ((data ?? []) as unknown as SectionRow[])
      .map((s) => ({
        id: s.id,
        label: `${s.grade_levels?.name ?? "?"} ${s.name}`,
        sequence: s.grade_levels?.sequence ?? 0,
      }))
      .sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label))
      .map(({ id, label }) => ({ id, label }));
    setSections(options);
    setLoadError(null);
  }, [tenantId, t]);

  useEffect(() => {
    // Deferred so state lands in an async continuation, never mid-render
    // (react-hooks/set-state-in-effect).
    const kick = setTimeout(() => void loadSections(), 0);
    return () => clearTimeout(kick);
  }, [loadSections]);

  // Reset the register when the class/date changes (render-time adjustment).
  const rosterKey = `${sectionId ?? "none"}:${date}`;
  const [prevRosterKey, setPrevRosterKey] = useState(rosterKey);
  if (prevRosterKey !== rosterKey) {
    setPrevRosterKey(rosterKey);
    setRoster(null);
    setSaved(null);
    setSaveError(null);
  }

  // Roster + any already-submitted register for section/date.
  const loadRoster = useCallback(async () => {
    if (!tenantId || !sectionId) return;
    const [{ data: enrolments, error: rosterError }, { data: session }] =
      await Promise.all([
        supabase
          .from("class_enrolments")
          .select(
            "students(id, student_number, first_name, middle_name, last_name)",
          )
          .eq("tenant_id", tenantId)
          .eq("class_section_id", sectionId)
          .eq("status", "active"),
        supabase
          .from("attendance_sessions")
          .select("id, revision, attendance_records(student_id, status)")
          .eq("tenant_id", tenantId)
          .eq("class_section_id", sectionId)
          .eq("session_date", date)
          .maybeSingle(),
      ]);
    if (rosterError) {
      setLoadError(t("err.server"));
      return;
    }
    type EnrolmentRow = { students: RosterStudent | null };
    const students = ((enrolments ?? []) as unknown as EnrolmentRow[])
      .map((e) => e.students)
      .filter((s): s is RosterStudent => s !== null)
      .sort((a, b) =>
        `${a.last_name} ${a.first_name}`.localeCompare(
          `${b.last_name} ${b.first_name}`,
        ),
      );

    const prevRecords: Record<string, string> = {};
    if (session) {
      type RecordRow = { student_id: string; status: string };
      for (const r of (session.attendance_records ?? []) as RecordRow[]) {
        prevRecords[r.student_id] = r.status;
      }
    }
    const initial: Record<string, Status> = {};
    for (const s of students) {
      const prev = prevRecords[s.id];
      initial[s.id] = STATUSES.includes(prev as Status)
        ? (prev as Status)
        : "present";
    }
    setRoster(students);
    setStatuses(initial);
    setExisting(Boolean(session));
    setLoadError(null);
  }, [tenantId, sectionId, date, t]);

  useEffect(() => {
    const kick = setTimeout(() => void loadRoster(), 0);
    return () => clearTimeout(kick);
  }, [loadRoster]);

  function setStatus(studentId: string, status: Status) {
    void Haptics.selectionAsync();
    setSaved(null);
    setStatuses((prev) => ({ ...prev, [studentId]: status }));
  }

  async function save() {
    if (!tenantId || !sectionId || !roster) return;
    setPending(true);
    setSaveError(null);
    setSaved(null);
    try {
      const response = await apiFetch("/api/v1/attendance", {
        method: "POST",
        tenantId,
        body: JSON.stringify({
          classSectionId: sectionId,
          date,
          records: roster.map((s) => ({
            studentId: s.id,
            status: statuses[s.id],
          })),
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          code?: string;
        } | null;
        // Correction of a submitted register needs `attendance.correct`.
        if (response.status === 403 && existing) {
          setSaveError(t("err.attendanceCorrectForbidden"));
        } else {
          setSaveError(apiErrorMessage(t, body, response.status));
        }
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        return;
      }
      const body = (await response.json()) as { alertsQueued?: number };
      setSaved({ alertsQueued: body.alertsQueued ?? 0 });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      await loadRoster();
    } catch {
      setSaveError(t("common.apiUnreachable"));
    } finally {
      setPending(false);
    }
  }

  const counts = useMemo(() => {
    if (!roster) return [];
    return STATUSES.map((status) => ({
      status,
      n: roster.filter((s) => statuses[s.id] === status).length,
    })).filter((c) => c.n > 0);
  }, [roster, statuses]);

  const selectedSection = sections?.find((s) => s.id === sectionId) ?? null;
  const today = isoDate(new Date());

  const renderRow = useCallback(
    ({ item }: { item: RosterStudent }) => {
      const name = [item.first_name, item.middle_name, item.last_name]
        .filter(Boolean)
        .join(" ");
      return (
        <View style={styles.rosterRow}>
          <View style={styles.rosterHead}>
            <Text numberOfLines={1} style={styles.rosterName}>
              {name}
            </Text>
            <Text style={styles.rosterNumber}>{item.student_number}</Text>
          </View>
          <View style={styles.chipRow}>
            {STATUSES.map((status) => {
              const active = statuses[item.id] === status;
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  key={status}
                  onPress={() => setStatus(item.id, status)}
                  style={[
                    styles.chip,
                    active &&
                      (status === "present"
                        ? styles.chipPresent
                        : styles.chipActive),
                  ]}
                >
                  <Text
                    style={[styles.chipLabel, active && styles.chipLabelActive]}
                  >
                    {t(`attendance.${status}`)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      );
    },
    [statuses, t],
  );

  return (
    <Screen>
      <Header title={t("attendance.title")} />

      {/* Class + date controls */}
      <View style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          onPress={() => setShowPicker((v) => !v)}
          style={({ pressed }) => [
            styles.classPill,
            pressed && { backgroundColor: color.hairline },
          ]}
        >
          <Text numberOfLines={1} style={styles.classPillLabel}>
            {selectedSection?.label ?? t("attendance.selectClass")}
          </Text>
          <Symbol
            android="chevron_right"
            ios="chevron.up.chevron.down"
            size={13}
            tint={color.body}
          />
        </Pressable>
        <View style={styles.dateRow}>
          <Pressable
            accessibilityLabel={t("attendance.prevDay")}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setDate((d) => shiftDate(d, -1))}
            style={styles.dateArrow}
          >
            <Symbol android="chevron_left" ios="chevron.left" size={16} tint={color.ink} />
          </Pressable>
          <Text style={styles.dateLabel}>{date}</Text>
          <Pressable
            accessibilityLabel={t("attendance.nextDay")}
            accessibilityRole="button"
            hitSlop={6}
            onPress={() => setDate((d) => shiftDate(d, 1))}
            style={styles.dateArrow}
          >
            <Symbol android="chevron_right" ios="chevron.right" size={16} tint={color.ink} />
          </Pressable>
          {date !== today ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => setDate(today)}
              style={styles.todayPill}
            >
              <Text style={styles.todayLabel}>{t("common.today")}</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {loadError ? (
        <EmptyState
          actionLabel={t("common.retry")}
          description={loadError}
          onAction={() => {
            if (sections === null) void loadSections();
            else void loadRoster();
          }}
          title={t("err.generic")}
        />
      ) : sections === null ? (
        <ListSkeleton rows={6} />
      ) : showPicker || !sectionId ? (
        // Class chooser
        <Card style={styles.pickerCard}>
          {sections.length === 0 ? (
            <Text style={styles.helper}>{t("attendance.pickPrompt")}</Text>
          ) : (
            <FlatList
              data={sections}
              keyExtractor={(s) => s.id}
              renderItem={({ item, index }) => (
                <ListRow
                  last={index === sections.length - 1}
                  onPress={() => {
                    setSectionId(item.id);
                    setShowPicker(false);
                  }}
                  right={
                    item.id === sectionId ? (
                      <Symbol android="check" ios="checkmark" size={16} tint={color.primary} />
                    ) : undefined
                  }
                  title={item.label}
                />
              )}
              showsVerticalScrollIndicator={false}
            />
          )}
        </Card>
      ) : roster === null ? (
        <ListSkeleton rows={8} />
      ) : roster.length === 0 ? (
        <EmptyState
          icon={<Symbol android="group" ios="person.2" size={26} tint={color.muted} />}
          title={t("attendance.empty")}
        />
      ) : (
        <>
          <View style={styles.summaryRow}>
            <Text style={styles.helper}>
              {roster.length} {t("attendance.students")}
              {counts.map((c) => ` · ${t(`attendance.${c.status}`)}: ${c.n}`).join("")}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void Haptics.selectionAsync();
                setSaved(null);
                setStatuses(
                  Object.fromEntries(roster.map((s) => [s.id, "present"])),
                );
              }}
            >
              <Text style={styles.markAll}>{t("attendance.markAllPresent")}</Text>
            </Pressable>
          </View>

          {existing ? (
            <Text style={styles.warning}>{t("attendance.correctionWarning")}</Text>
          ) : null}

          <FlatList
            data={roster}
            extraData={statuses}
            keyExtractor={(item) => item.id}
            renderItem={renderRow}
            showsVerticalScrollIndicator={false}
          />

          <View style={styles.footer}>
            {saveError ? <Text style={styles.error}>{saveError}</Text> : null}
            {saved ? (
              <Text style={styles.savedText}>
                {t("attendance.saved")}
                {saved.alertsQueued > 0
                  ? ` ${saved.alertsQueued} ${t("attendance.alertsQueued")}.`
                  : ""}
              </Text>
            ) : null}
            <PillButton
              haptic
              loading={pending}
              onPress={() => void save()}
              title={t("attendance.save")}
            />
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  controls: { gap: space(2), paddingBottom: space(2) },
  classPill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(2),
    minHeight: 44,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceStrong,
    paddingHorizontal: space(4),
  },
  classPillLabel: {
    fontFamily: font.medium,
    fontSize: 15,
    color: color.ink,
    flexShrink: 1,
  },
  dateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(2),
  },
  dateArrow: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceSoft,
    alignItems: "center",
    justifyContent: "center",
  },
  dateLabel: {
    fontFamily: font.mono,
    fontSize: 15,
    color: color.ink,
    minWidth: 110,
    textAlign: "center",
  },
  todayPill: {
    borderRadius: radius.pill,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    backgroundColor: color.surfaceStrong,
  },
  todayLabel: { fontFamily: font.medium, fontSize: 13, color: color.primary },
  pickerCard: { flex: 1, marginBottom: space(4) },
  helper: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.body,
    flexShrink: 1,
  },
  summaryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(2),
    paddingBottom: space(2),
  },
  markAll: {
    fontFamily: font.medium,
    fontSize: 13,
    color: color.primary,
  },
  warning: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.accentYellow,
    paddingBottom: space(2),
  },
  rosterRow: {
    paddingVertical: space(3),
    gap: space(2),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.hairline,
  },
  rosterHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(2),
  },
  rosterName: {
    fontFamily: font.semibold,
    fontSize: 15,
    color: color.ink,
    flexShrink: 1,
  },
  rosterNumber: { fontFamily: font.mono, fontSize: 12, color: color.muted },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: space(2) },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: space(3),
    paddingVertical: space(1.5),
    backgroundColor: color.surfaceSoft,
    minHeight: 32,
    justifyContent: "center",
  },
  chipActive: { backgroundColor: color.ink },
  chipPresent: { backgroundColor: color.primary },
  chipLabel: { fontFamily: font.medium, fontSize: 13, color: color.body },
  chipLabelActive: { color: color.onPrimary },
  footer: { gap: space(2), paddingVertical: space(3) },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.loss,
  },
  savedText: {
    fontFamily: font.medium,
    fontSize: 13,
    lineHeight: 19,
    color: color.gain,
  },
});
