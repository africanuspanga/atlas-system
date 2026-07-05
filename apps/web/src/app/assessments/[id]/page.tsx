import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import {
	MarksView,
	type AssessmentInfo,
	type ScoreRow,
	type StudentRow,
	type SubjectOption,
} from "./marks-view";

export const metadata = { title: "Enter marks" };

export default async function MarksPage({
	params,
	searchParams,
}: {
	params: Promise<{ id: string }>;
	searchParams: Promise<{ subject?: string }>;
}) {
	const { id } = await params;
	const { subject } = await searchParams;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const { data: assessment } = await supabase
		.from("assessments")
		.select(
			`id, name, type, status, class_section_id,
			 class_sections(name, grade_levels(name, education_level)),
			 academic_terms(name)`,
		)
		.eq("id", id)
		.maybeSingle();
	if (!assessment) notFound();

	const grade = assessment.class_sections as unknown as {
		name: string;
		grade_levels: { name: string; education_level: string } | null;
	} | null;
	const level = grade?.grade_levels?.education_level ?? "o_level";

	const [{ data: subjects }, { data: enrolments }] = await Promise.all([
		supabase
			.from("subjects")
			.select("id, code, name, name_sw")
			.eq("education_level", level)
			.eq("status", "active")
			.order("code"),
		supabase
			.from("class_enrolments")
			.select("students(id, student_number, first_name, middle_name, last_name)")
			.eq("class_section_id", assessment.class_section_id)
			.eq("status", "active"),
	]);

	const subjectOptions = (subjects ?? []) as unknown as SubjectOption[];
	const subjectId = subjectOptions.some((s) => s.id === subject) ? (subject as string) : null;

	let scores: ScoreRow[] = [];
	if (subjectId) {
		const { data } = await supabase
			.from("assessment_scores")
			.select("student_id, marks, grade")
			.eq("assessment_id", id)
			.eq("subject_id", subjectId);
		scores = (data ?? []) as ScoreRow[];
	}

	const roster = (enrolments ?? [])
		.map((e) => e.students as unknown as StudentRow | null)
		.filter((s): s is StudentRow => s !== null)
		.sort((a, b) =>
			`${a.last_name} ${a.first_name}`.localeCompare(`${b.last_name} ${b.first_name}`),
		);

	const { lang } = await getServerDict();

	const info: AssessmentInfo = {
		id: assessment.id,
		name: assessment.name,
		status: assessment.status,
		sectionLabel: grade ? `${grade.grade_levels?.name ?? ""} ${grade.name}` : "",
		termName:
			(assessment.academic_terms as unknown as { name: string } | null)?.name ?? "",
	};

	return (
		<AppShell schoolName={tenant.name}>
			<MarksView
				key={`${id}:${subjectId ?? "none"}`}
				assessment={info}
				lang={lang}
				roster={roster}
				scores={scores}
				subjectId={subjectId}
				subjects={subjectOptions}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
