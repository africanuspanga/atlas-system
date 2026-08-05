import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getActiveTenants } from "@/lib/active-tenant";
import { AppShell } from "@/components/app-shell";
import {
	TimetableView,
	type PeriodRow,
	type SectionOption,
	type SubjectOption,
} from "./timetable-view";

export const metadata = { title: "Timetable" };

const MANAGE_SUPER_ROLES = ["school_owner", "director"];

export default async function TimetablePage({
	searchParams,
}: {
	searchParams: Promise<{ section?: string; teacher?: string }>;
}) {
	const params = await searchParams;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await getActiveTenants(supabase);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: sections }, { data: periods }, { data: subjects }, { data: memberships }] =
		await Promise.all([
			supabase
				.from("class_sections")
				.select("id, name, grade_levels(name, sequence, education_level)")
				.eq("status", "active"),
			supabase
				.from("timetable_periods")
				.select("id, label, starts_at, ends_at, is_break, sort_order")
				.order("sort_order")
				.order("starts_at"),
			supabase
				.from("subjects")
				.select("id, code, name, name_sw, education_level")
				.eq("status", "active")
				.order("code"),
			supabase
				.from("tenant_memberships")
				.select("id, membership_roles(roles(id, key))")
				.eq("tenant_id", tenant.id)
				.eq("user_id", user.id)
				.eq("status", "active"),
		]);

	// Manage rights: owner/director are superusers; otherwise the member needs
	// a role that carries timetable.manage (simple RLS read — the API re-checks
	// on every write anyway).
	const roles = (memberships ?? []).flatMap((m) =>
		(m.membership_roles ?? []).map(
			(r) => r.roles as unknown as { id: string; key: string } | null,
		),
	);
	let canManage = roles.some((r) => r && MANAGE_SUPER_ROLES.includes(r.key));
	if (!canManage && roles.length > 0) {
		const { data: perms } = await supabase
			.from("role_permissions")
			.select("permission_key")
			.in(
				"role_id",
				roles.filter((r) => r !== null).map((r) => r.id),
			)
			.eq("permission_key", "timetable.manage");
		canManage = (perms ?? []).length > 0;
	}

	const sectionOptions: SectionOption[] = (sections ?? [])
		.map((s) => {
			const grade = s.grade_levels as unknown as {
				name: string;
				sequence: number;
				education_level: string;
			} | null;
			return {
				id: s.id,
				label: `${grade?.name ?? "?"} ${s.name}`,
				educationLevel: grade?.education_level ?? "",
				sequence: grade?.sequence ?? 0,
			};
		})
		.sort((a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label))
		.map(({ id, label, educationLevel }) => ({ id, label, educationLevel }));

	const sectionId = sectionOptions.some((s) => s.id === params.section)
		? (params.section as string)
		: null;
	const teacherMode = params.teacher === "me";

	const periodRows: PeriodRow[] = (periods ?? []).map((p) => ({
		id: p.id,
		label: p.label,
		startsAt: String(p.starts_at).slice(0, 5),
		endsAt: String(p.ends_at).slice(0, 5),
		isBreak: p.is_break,
	}));

	const subjectOptions: SubjectOption[] = (subjects ?? []).map((s) => ({
		id: s.id,
		code: s.code,
		name: s.name,
		nameSw: s.name_sw,
		educationLevel: s.education_level,
	}));


	return (
		<AppShell schoolName={tenant.name}>
			<TimetableView
				key={`${sectionId ?? "none"}:${teacherMode ? "me" : "class"}`}
				canManage={canManage}
				periods={periodRows}
				sectionId={sectionId}
				sections={sectionOptions}
				subjects={subjectOptions}
				teacherMode={teacherMode}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
