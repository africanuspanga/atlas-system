import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AppShell } from "@/components/app-shell";
import { Dashboard, type DashboardData } from "@/components/dashboard";
import { getDict } from "@/i18n";
import { getServerDict } from "@/i18n/server";
import type { DictKey } from "@/i18n";

export default async function Home() {
	const supabase = await createClient();
	const {
		data: { user },
	} = await supabase.auth.getUser();
	if (!user) {
		redirect("/login");
	}

	// RLS: members only see their own tenants. Oldest membership-visible school
	// is the deterministic default.
	const { data: tenants } = await supabase
		.from("tenants")
		.select("id, name, status")
		.order("created_at", { ascending: true })
		.limit(1);
	if (!tenants || tenants.length === 0) {
		// Linked parents are not tenant members — route them to their portal.
		const { data: guardianLinks } = await supabase
			.from("guardians")
			.select("id")
			.limit(1);
		if (guardianLinks && guardianLinks.length > 0) {
			redirect("/portal");
		}
		redirect("/onboarding");
	}
	const tenantId = tenants[0].id as string;

	const now = new Date();
	const today = now.toISOString().slice(0, 10);
	const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
		.toISOString()
		.slice(0, 10);

	// Supabase caps row reads at 1000; paginate money-summation reads so busy
	// schools' totals stay correct.
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

	const [
		{ count: students },
		{ count: sections },
		{ data: sessions },
		payments,
		invoices,
		recentPaymentRows,
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
			.gte("session_date", monthAgo),
		fetchAllRows<{ amount: number; method: string }>((from, to) =>
			supabase
				.from("payments")
				.select("amount, method")
				.eq("tenant_id", tenantId)
				.range(from, to),
		),
		fetchAllRows<{ id: string; total: number; status: string }>((from, to) =>
			supabase
				.from("invoices")
				.select("id, total, status")
				.eq("tenant_id", tenantId)
				.range(from, to),
		),
		supabase
			.from("payments")
			.select("receipt_number, amount, method, students(first_name, last_name)")
			.eq("tenant_id", tenantId)
			.order("created_at", { ascending: false })
			.limit(5),
	]);

	// attendance: today's headline + 30-day trend
	const byDate = new Map<string, { present: number; total: number }>();
	for (const session of sessions ?? []) {
		const records = (session.attendance_records ?? []) as Array<{ status: string }>;
		const bucket = byDate.get(session.session_date) ?? { present: 0, total: 0 };
		for (const record of records) {
			bucket.total += 1;
			if (record.status === "present" || record.status === "late") bucket.present += 1;
		}
		byDate.set(session.session_date, bucket);
	}
	const trend = [...byDate.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.filter(([, v]) => v.total > 0)
		.map(([date, v]) => ({ date, rate: Math.round((v.present / v.total) * 1000) / 10 }));
	const todayBucket = byDate.get(today);

	const { lang } = await getServerDict();
	const t = getDict(lang);

	// finance: net collections, channels, outstanding (from full paginated reads)
	const collectedNet = payments.reduce((sum, p) => sum + Number(p.amount), 0);
	const byChannel = new Map<string, number>();
	for (const p of payments) {
		const method = t(`finance.method.${p.method}` as DictKey);
		byChannel.set(method, (byChannel.get(method) ?? 0) + Number(p.amount));
	}
	const invoicedTotal = invoices.reduce((sum, inv) => sum + Number(inv.total), 0);
	const unpaidInvoices = invoices.filter((inv) => inv.status !== "paid").length;

	// recent payments: explicit display list, capped at 5
	const recentPayments = (recentPaymentRows.data ?? []).map((p) => ({
		receipt: p.receipt_number as string,
		amount: Number(p.amount),
		method: t(`finance.method.${p.method}` as DictKey),
		student: (() => {
			const s = p.students as unknown as { first_name: string; last_name: string } | null;
			return s ? `${s.first_name} ${s.last_name}` : "—";
		})(),
	}));

	const data: DashboardData = {
		students: students ?? 0,
		sections: sections ?? 0,
		presentToday: todayBucket?.present ?? 0,
		attendanceRateToday: todayBucket?.total
			? Math.round((todayBucket.present / todayBucket.total) * 1000) / 10
			: null,
		collectedNet,
		receiptCount: payments.filter((p) => Number(p.amount) > 0).length,
		outstanding: Math.max(0, invoicedTotal - collectedNet),
		unpaidInvoices,
		attendanceTrend: trend,
		collectionsByChannel: [...byChannel.entries()]
			.map(([channel, amount]) => ({ channel, amount }))
			.filter((c) => c.amount > 0)
			.sort((a, b) => b.amount - a.amount),
		recentPayments,
	};

	return (
		<AppShell schoolName={tenants[0].name}>
			<Dashboard data={data} lang={lang} />
		</AppShell>
	);
}
