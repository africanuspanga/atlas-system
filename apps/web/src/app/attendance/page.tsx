import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import {
	AttendanceView,
	type ExistingSession,
	type RosterRow,
	type SectionOption,
} from "./attendance-view";

export const metadata = { title: "Attendance" };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export default async function AttendancePage({
	searchParams,
}: {
	searchParams: Promise<{ section?: string; date?: string }>;
}) {
	const params = await searchParams;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const date =
		params.date && DATE_RE.test(params.date)
			? params.date
			: new Date().toISOString().slice(0, 10);

	const { data: sections } = await supabase
		.from("class_sections")
		.select("id, name, grade_levels(name, sequence)")
		.eq("status", "active");

	const sectionOptions: SectionOption[] = (sections ?? [])
		.map((s) => {
			const grade = s.grade_levels as unknown as { name: string; sequence: number } | null;
			return {
				id: s.id,
				label: `${grade?.name ?? "?"} ${s.name}`,
				sequence: grade?.sequence ?? 0,
			};
		})
		.sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label))
		.map(({ id, label }) => ({ id, label }));

	const sectionId = sectionOptions.some((s) => s.id === params.section)
		? (params.section as string)
		: null;

	let roster: RosterRow[] = [];
	let existing: ExistingSession | null = null;
	if (sectionId) {
		const [{ data: enrolments }, { data: session }] = await Promise.all([
			supabase
				.from("class_enrolments")
				.select("students(id, student_number, first_name, middle_name, last_name)")
				.eq("class_section_id", sectionId)
				.eq("status", "active"),
			supabase
				.from("attendance_sessions")
				.select("id, revision, attendance_records(student_id, status)")
				.eq("class_section_id", sectionId)
				.eq("session_date", date)
				.maybeSingle(),
		]);

		roster = (enrolments ?? [])
			.map((e) => e.students as unknown as RosterRow | null)
			.filter((s): s is RosterRow => s !== null)
			.sort((a, b) =>
				`${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
			);

		if (session) {
			const records: Record<string, string> = {};
			for (const r of (session.attendance_records ?? []) as Array<{
				student_id: string;
				status: string;
			}>) {
				records[r.student_id] = r.status;
			}
			existing = { revision: session.revision as number, records };
		}
	}

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<AttendanceView
				key={`${sectionId ?? "none"}:${date}`}
				date={date}
				existing={existing}
				lang={lang}
				roster={roster}
				sectionId={sectionId}
				sections={sectionOptions}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
