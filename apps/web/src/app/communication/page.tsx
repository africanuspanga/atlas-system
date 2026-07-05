import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { getServerDict } from "@/i18n/server";
import {
	CommunicationView,
	type AnnouncementRow,
	type OutboxStats,
	type SectionOption,
} from "./communication-view";

export const metadata = { title: "Communication" };

export default async function CommunicationPage() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) redirect("/login");

	const { data: tenants } = await supabase.from("tenants").select("id, name").limit(1);
	if (!tenants || tenants.length === 0) redirect("/onboarding");
	const tenant = tenants[0];

	const [{ data: announcements }, { data: outbox }, { data: sections }] = await Promise.all([
		supabase
			.from("announcements")
			.select(
				"id, audience_type, body, recipient_count, created_at, class_sections(name, grade_levels(name))",
			)
			.order("created_at", { ascending: false })
			.limit(100),
		supabase.from("notification_outbox").select("status"),
		supabase
			.from("class_sections")
			.select("id, name, grade_levels(name, sequence)")
			.eq("status", "active"),
	]);

	const stats: OutboxStats = { pending: 0, sent: 0, failed: 0 };
	for (const row of outbox ?? []) {
		if (row.status === "pending") stats.pending += 1;
		else if (row.status === "sent") stats.sent += 1;
		else if (row.status === "failed") stats.failed += 1;
	}

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

	const rows: AnnouncementRow[] = (announcements ?? []).map((a) => {
		const section = a.class_sections as unknown as {
			name: string;
			grade_levels: { name: string } | null;
		} | null;
		return {
			id: a.id,
			audienceType: a.audience_type,
			sectionLabel: section ? `${section.grade_levels?.name ?? ""} ${section.name}` : null,
			body: a.body,
			recipients: a.recipient_count,
			createdAt: a.created_at,
		};
	});

	const { lang } = await getServerDict();

	return (
		<AppShell schoolName={tenant.name}>
			<CommunicationView
				announcements={rows}
				lang={lang}
				outbox={stats}
				sections={sectionOptions}
				tenantId={tenant.id}
			/>
		</AppShell>
	);
}
