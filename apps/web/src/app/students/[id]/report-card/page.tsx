import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import { ReportCardView, type TermOption } from "./report-card-view";

export const metadata = { title: "Report card" };

export default async function ReportCardPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const { id } = await params;
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: student }, { data: terms }] = await Promise.all([
		supabase
			.from("students")
			.select("id, first_name, last_name, student_number")
			.eq("id", id)
			.maybeSingle(),
		supabase
			.from("academic_terms")
			.select("id, name, starts_on, ends_on")
			.order("starts_on"),
	]);
	if (!student) notFound();

	// default to the term covering today, else the latest
	const today = new Date().toISOString().slice(0, 10);
	const current =
		(terms ?? []).find((t) => t.starts_on <= today && t.ends_on >= today) ??
		(terms ?? []).at(-1);

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<ReportCardView
				defaultTermId={current?.id ?? null}
				lang={lang}
				schoolName={tenant.name}
				studentId={student.id}
				tenantId={tenant.id}
				terms={(terms ?? []).map((t) => ({ id: t.id, name: t.name })) as TermOption[]}
			/>
		</AppShell>
	);
}
