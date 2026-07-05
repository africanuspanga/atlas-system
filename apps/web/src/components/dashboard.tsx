"use client";

import { useId } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
	GraduationCapIcon,
	CalendarCheckIcon,
	WalletIcon,
	AlertCircleIcon,
} from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	type ChartConfig,
	ChartContainer,
	ChartTooltip,
	ChartTooltipContent,
} from "@/components/ui/chart";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { formatChartAxisTick, formatChartTooltipDate } from "@/components/formater";

/**
 * SAMPLE DATA — this overview renders illustrative numbers until the
 * dashboard endpoints exist in apps/api. Every widget here maps to a real
 * query in the blueprint (students, attendance, fee collection, payments).
 */

const stats = [
	{
		title: "Total students",
		value: "1,284",
		hint: "Across 2 campuses",
		icon: GraduationCapIcon,
	},
	{
		title: "Present today",
		value: "1,201",
		hint: "93.5% attendance",
		icon: CalendarCheckIcon,
	},
	{
		title: "Collected this term",
		value: "TZS 412M",
		hint: "Term 2, 2026",
		icon: WalletIcon,
	},
	{
		title: "Outstanding fees",
		value: "TZS 96M",
		hint: "214 students with balance",
		icon: AlertCircleIcon,
	},
];

const attendanceTrend = [
	{ date: "2026-06-08", rate: 91.2 },
	{ date: "2026-06-09", rate: 92.4 },
	{ date: "2026-06-10", rate: 93.1 },
	{ date: "2026-06-11", rate: 92.8 },
	{ date: "2026-06-12", rate: 90.5 },
	{ date: "2026-06-15", rate: 93.6 },
	{ date: "2026-06-16", rate: 94.0 },
	{ date: "2026-06-17", rate: 93.2 },
	{ date: "2026-06-18", rate: 92.1 },
	{ date: "2026-06-19", rate: 91.8 },
	{ date: "2026-06-22", rate: 94.4 },
	{ date: "2026-06-23", rate: 94.9 },
	{ date: "2026-06-24", rate: 93.7 },
	{ date: "2026-06-25", rate: 92.9 },
	{ date: "2026-06-26", rate: 91.4 },
	{ date: "2026-06-29", rate: 93.8 },
	{ date: "2026-06-30", rate: 94.2 },
	{ date: "2026-07-01", rate: 93.9 },
	{ date: "2026-07-02", rate: 93.1 },
	{ date: "2026-07-03", rate: 93.5 },
];

const collectionsByChannel = [
	{ channel: "M-Pesa", amount: 186 },
	{ channel: "Tigo Pesa", amount: 92 },
	{ channel: "Airtel Money", amount: 54 },
	{ channel: "Bank", amount: 68 },
	{ channel: "Cash", amount: 12 },
];

const recentPayments = [
	{ reference: "RCP-2026-04182", student: "Neema Joseph", cls: "Form 2A", channel: "M-Pesa", amount: "450,000" },
	{ reference: "RCP-2026-04181", student: "Baraka Mushi", cls: "Std 5B", channel: "Bank", amount: "620,000" },
	{ reference: "RCP-2026-04180", student: "Zawadi Komba", cls: "Form 4C", channel: "Tigo Pesa", amount: "300,000" },
	{ reference: "RCP-2026-04179", student: "Daudi Mwakyusa", cls: "Std 7A", channel: "M-Pesa", amount: "150,000" },
	{ reference: "RCP-2026-04178", student: "Rehema Salum", cls: "Form 1B", channel: "Airtel Money", amount: "450,000" },
];

const attendanceChartConfig = {
	rate: {
		label: "Attendance %",
		color: "var(--chart-1)",
	},
} satisfies ChartConfig;

const collectionsChartConfig = {
	amount: {
		label: "TZS (millions)",
		color: "var(--chart-2)",
	},
} satisfies ChartConfig;

function StatsGrid() {
	return (
		<>
			{stats.map((stat) => (
				<Card className="shadow-none dark:ring-0" key={stat.title}>
					<CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
						<CardTitle className="font-medium text-muted-foreground text-sm">
							{stat.title}
						</CardTitle>
						<stat.icon className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<div className="font-semibold text-2xl tabular-nums">{stat.value}</div>
						<p className="text-muted-foreground text-xs">{stat.hint}</p>
					</CardContent>
				</Card>
			))}
		</>
	);
}

function AttendanceTrendChart() {
	const gradientId = `attendance-grad-${useId().replace(/:/g, "")}`;

	return (
		<Card className="shadow-none md:col-span-2 dark:ring-0">
			<CardHeader>
				<CardTitle>Attendance trend</CardTitle>
				<CardDescription>Daily attendance rate, last 30 days (sample data)</CardDescription>
			</CardHeader>
			<CardContent>
				<ChartContainer className="aspect-22/8 w-full" config={attendanceChartConfig}>
					<AreaChart accessibilityLayer data={attendanceTrend} margin={{ left: 4, right: 8, top: 8 }}>
						<defs>
							<linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
								<stop offset="0%" stopColor="var(--color-rate)" stopOpacity={0.4} />
								<stop offset="100%" stopColor="var(--color-rate)" stopOpacity={0} />
							</linearGradient>
						</defs>
						<CartesianGrid className="stroke-border" vertical={false} />
						<XAxis
							axisLine={false}
							dataKey="date"
							interval="preserveStartEnd"
							minTickGap={28}
							tickFormatter={(value) => formatChartAxisTick(String(value), 30)}
							tickLine={false}
							tickMargin={8}
						/>
						<YAxis
							axisLine={false}
							domain={[85, 100]}
							tick={{ className: "tabular-nums" }}
							tickLine={false}
							tickMargin={8}
							width={36}
						/>
						<ChartTooltip
							content={
								<ChartTooltipContent
									indicator="line"
									labelFormatter={(_, payload) => {
										const row = payload?.[0]?.payload as { date?: string } | undefined;
										return row?.date ? formatChartTooltipDate(row.date, "long") : "";
									}}
								/>
							}
							cursor={false}
						/>
						<Area
							dataKey="rate"
							dot={false}
							fill={`url(#${gradientId})`}
							stroke="var(--color-rate)"
							strokeWidth={2}
							type="natural"
						/>
					</AreaChart>
				</ChartContainer>
			</CardContent>
		</Card>
	);
}

function CollectionsByChannelChart() {
	return (
		<Card className="shadow-none md:col-span-2 dark:ring-0">
			<CardHeader>
				<CardTitle>Collections by channel</CardTitle>
				<CardDescription>This term, TZS millions (sample data)</CardDescription>
			</CardHeader>
			<CardContent>
				<ChartContainer className="aspect-22/8 w-full" config={collectionsChartConfig}>
					<BarChart accessibilityLayer data={collectionsByChannel} margin={{ left: 4, right: 8, top: 8 }}>
						<CartesianGrid className="stroke-border" vertical={false} />
						<XAxis axisLine={false} dataKey="channel" tickLine={false} tickMargin={8} />
						<YAxis
							axisLine={false}
							tick={{ className: "tabular-nums" }}
							tickLine={false}
							tickMargin={8}
							width={36}
						/>
						<ChartTooltip content={<ChartTooltipContent indicator="line" />} cursor={false} />
						<Bar dataKey="amount" fill="var(--color-amount)" radius={[4, 4, 0, 0]} />
					</BarChart>
				</ChartContainer>
			</CardContent>
		</Card>
	);
}

function RecentPayments() {
	return (
		<Card className="shadow-none md:col-span-2 lg:col-span-4 dark:ring-0">
			<CardHeader>
				<CardTitle>Recent payments</CardTitle>
				<CardDescription>Latest receipts issued (sample data)</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Receipt</TableHead>
							<TableHead>Student</TableHead>
							<TableHead>Class</TableHead>
							<TableHead>Channel</TableHead>
							<TableHead className="text-right">Amount (TZS)</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{recentPayments.map((payment) => (
							<TableRow key={payment.reference}>
								<TableCell className="font-mono text-xs">{payment.reference}</TableCell>
								<TableCell>{payment.student}</TableCell>
								<TableCell>{payment.cls}</TableCell>
								<TableCell>
									<Badge variant="outline">{payment.channel}</Badge>
								</TableCell>
								<TableCell className="text-right tabular-nums">{payment.amount}</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			</CardContent>
		</Card>
	);
}

export function Dashboard() {
	return (
		<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
			<StatsGrid />
			<AttendanceTrendChart />
			<CollectionsByChannelChart />
			<RecentPayments />
		</div>
	);
}
