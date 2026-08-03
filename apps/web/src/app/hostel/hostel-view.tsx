"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BedDoubleIcon, PlusIcon, UserMinusIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type DictKey, type Lang } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

export interface StudentOption {
	id: string;
	studentNumber: string;
	name: string;
	gender: string;
	boardingStatus: string;
}

interface RoomRow {
	id: string;
	name: string;
	capacity: number;
	occupied: number;
}

interface HostelRow {
	id: string;
	name: string;
	gender: string;
	rooms: RoomRow[];
}

interface Occupant {
	allocationId: string;
	studentNumber: string;
	name: string;
	gender: string;
	allocatedAt: string;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

function OccupancyBar({ occupied, capacity }: { occupied: number; capacity: number }) {
	const pct = capacity > 0 ? Math.min(100, Math.round((occupied / capacity) * 100)) : 0;
	return (
		<div className="h-2 w-24 rounded-full bg-secondary">
			<div
				className="h-2 rounded-full bg-primary"
				style={{ width: `${pct}%` }}
			/>
		</div>
	);
}

export function HostelView({
	tenantId,
	students,
	academicYear,
	canManage,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	academicYear: { id: string; name: string } | null;
	canManage: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [hostels, setHostels] = useState<HostelRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [createOpen, setCreateOpen] = useState(false);
	const [roomHostel, setRoomHostel] = useState<HostelRow | null>(null);
	const [allocateOpen, setAllocateOpen] = useState(false);
	const [openRoom, setOpenRoom] = useState<RoomRow | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setLoadError(null);
		try {
			const response = await apiFetch("/api/v1/hostel", { tenantId });
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setLoadError(apiErrorMessage(t, body, response.status));
				return;
			}
			setHostels((await response.json()).data);
		} catch {
			setLoadError(t("common.apiUnreachable"));
		} finally {
			setLoaded(true);
		}
	}, [tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void reload();
	}, [reload]);

	const genderKey = (gender: string) => t(`hostel.gender.${gender}` as DictKey);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("hostel.title")}</h1>
				{canManage && (
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => setCreateOpen(true)} size="sm" variant="outline">
							<PlusIcon /> {t("hostel.addHostel")}
						</Button>
						<Button
							disabled={hostels.every((h) => h.rooms.length === 0)}
							onClick={() => setAllocateOpen(true)}
							size="sm"
						>
							<BedDoubleIcon /> {t("hostel.allocate")}
						</Button>
					</div>
				)}
			</div>

			{loadError && (
				<div className="flex items-center gap-3" role="alert">
					<p className="text-sm text-destructive">{loadError}</p>
					<Button onClick={() => void reload()} size="sm" variant="outline">
						{t("common.retry")}
					</Button>
				</div>
			)}
			{canManage && !academicYear && (
				<p className="text-sm text-muted-foreground">{t("hostel.noYear")}</p>
			)}

			{!loaded && !loadError ? (
				<ListSkeleton rows={6} />
			) : loaded && !loadError && hostels.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("hostel.empty")}
					</CardContent>
				</Card>
			) : (
				<div className="grid gap-4 lg:grid-cols-2">
					{hostels.map((hostel) => (
						<Card className="shadow-none" key={hostel.id}>
							<CardHeader className="flex flex-row items-center justify-between gap-2">
								<div className="flex items-center gap-2">
									<CardTitle className="text-base">{hostel.name}</CardTitle>
									<Badge variant="secondary">{genderKey(hostel.gender)}</Badge>
								</div>
								{canManage && (
									<Button onClick={() => setRoomHostel(hostel)} size="sm" variant="ghost">
										<PlusIcon /> {t("hostel.addRoom")}
									</Button>
								)}
							</CardHeader>
							<CardContent>
								{hostel.rooms.length === 0 ? (
									<p className="text-sm text-muted-foreground">{t("hostel.noRooms")}</p>
								) : (
									<Table>
										<TableHeader>
											<TableRow>
												<TableHead>{t("hostel.room")}</TableHead>
												<TableHead className="text-right">{t("hostel.capacity")}</TableHead>
												<TableHead className="text-right">{t("hostel.occupied")}</TableHead>
												<TableHead />
											</TableRow>
										</TableHeader>
										<TableBody>
											{hostel.rooms.map((room) => (
												<TableRow
													aria-label={`${t("hostel.occupants")} — ${room.name}`}
													className="cursor-pointer focus-visible:bg-muted focus-visible:outline-none"
													key={room.id}
													onClick={() => setOpenRoom(room)}
													onKeyDown={(e) => {
														if (e.key === "Enter" || e.key === " ") {
															e.preventDefault();
															setOpenRoom(room);
														}
													}}
													role="button"
													tabIndex={0}
												>
													<TableCell className="font-medium">{room.name}</TableCell>
													<TableCell className="text-right font-mono">
														{room.capacity}
													</TableCell>
													<TableCell className="text-right font-mono">
														{room.occupied}
													</TableCell>
													<TableCell>
														<OccupancyBar capacity={room.capacity} occupied={room.occupied} />
													</TableCell>
												</TableRow>
											))}
										</TableBody>
									</Table>
								)}
							</CardContent>
						</Card>
					))}
				</div>
			)}

			{canManage && (
				<CreateHostelDialog
					lang={lang}
					onClose={() => setCreateOpen(false)}
					onSaved={async () => {
						setCreateOpen(false);
						await reload();
					}}
					open={createOpen}
					tenantId={tenantId}
				/>
			)}
			{canManage && roomHostel && (
				<CreateRoomDialog
					hostel={roomHostel}
					lang={lang}
					onClose={() => setRoomHostel(null)}
					onSaved={async () => {
						setRoomHostel(null);
						await reload();
					}}
					tenantId={tenantId}
				/>
			)}
			{canManage && academicYear && (
				<AllocateDialog
					academicYearId={academicYear.id}
					hostels={hostels}
					key={allocateOpen ? "open" : "closed"}
					lang={lang}
					onClose={() => setAllocateOpen(false)}
					onSaved={async () => {
						setAllocateOpen(false);
						await reload();
					}}
					open={allocateOpen}
					students={students}
					tenantId={tenantId}
				/>
			)}
			{openRoom && (
				<OccupantsDialog
					canManage={canManage}
					lang={lang}
					onChanged={reload}
					onClose={() => setOpenRoom(null)}
					room={openRoom}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function CreateHostelDialog({
	tenantId,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [name, setName] = useState("");
	const [gender, setGender] = useState("male");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/hostel", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ name: name.trim(), gender }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setName("");
			await onSaved();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("hostel.addHostel")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.name")}
						<Input onChange={(e) => setName(e.target.value)} value={name} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.gender")}
						<select
							className={selectClass}
							onChange={(e) => setGender(e.target.value)}
							value={gender}
						>
							<option value="male">{t("hostel.gender.male")}</option>
							<option value="female">{t("hostel.gender.female")}</option>
							<option value="mixed">{t("hostel.gender.mixed")}</option>
						</select>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button disabled={pending || name.trim().length < 2} onClick={() => void save()}>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function CreateRoomDialog({
	tenantId,
	hostel,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	hostel: HostelRow;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [name, setName] = useState("");
	const [capacity, setCapacity] = useState("4");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const capacityNumber = Number.parseInt(capacity, 10);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/hostel/rooms", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					hostelId: hostel.id,
					name: name.trim(),
					capacity: capacityNumber,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			await onSaved();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("hostel.addRoom")} — {hostel.name}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.roomName")}
						<Input onChange={(e) => setName(e.target.value)} value={name} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.capacity")}
						<Input
							min={1}
							onChange={(e) => setCapacity(e.target.value)}
							type="number"
							value={capacity}
						/>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={
								pending || name.trim() === "" || !Number.isInteger(capacityNumber) || capacityNumber < 1
							}
							onClick={() => void save()}
						>
							{pending ? t("common.loading") : t("common.save")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function AllocateDialog({
	tenantId,
	students,
	hostels,
	academicYearId,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	hostels: HostelRow[];
	academicYearId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [query, setQuery] = useState("");
	const [studentId, setStudentId] = useState("");
	const [roomId, setRoomId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const boarders = students.filter((s) => s.boardingStatus === "boarding");
	const q = query.toLowerCase().trim();
	const matches =
		q === ""
			? boarders.slice(0, 8)
			: boarders
					.filter(
						(s) =>
							s.name.toLowerCase().includes(q) ||
							s.studentNumber.toLowerCase().includes(q),
					)
					.slice(0, 8);
	const selected = students.find((s) => s.id === studentId) ?? null;

	async function save() {
		if (!studentId || !roomId) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/hostel/allocations", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ studentId, roomId, academicYearId }),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			await onSaved();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open={open}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("hostel.allocate")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.student")}
						<Input
							onChange={(e) => {
								setQuery(e.target.value);
								setStudentId("");
							}}
							placeholder={t("hostel.searchStudent")}
							value={selected ? `${selected.name} (${selected.studentNumber})` : query}
						/>
					</label>
					{!selected && (
						<div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
							{matches.map((s) => (
								<button
									className="rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted"
									key={s.id}
									onClick={() => setStudentId(s.id)}
									type="button"
								>
									{s.name}{" "}
									<span className="font-mono text-xs text-muted-foreground">
										{s.studentNumber}
									</span>
								</button>
							))}
							{matches.length === 0 && (
								<p className="px-2 text-sm text-muted-foreground">{t("hostel.noOccupants")}</p>
							)}
						</div>
					)}
					<label className="flex flex-col gap-1 text-sm">
						{t("hostel.room")}
						<select
							className={selectClass}
							onChange={(e) => setRoomId(e.target.value)}
							value={roomId}
						>
							<option value="">{t("hostel.selectRoom")}</option>
							{hostels.map((h) =>
								h.rooms.map((r) => (
									<option key={r.id} value={r.id}>
										{h.name} / {r.name} — {Math.max(0, r.capacity - r.occupied)}{" "}
										{t("hostel.freeBeds")}
									</option>
								)),
							)}
						</select>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button disabled={pending || !studentId || !roomId} onClick={() => void save()}>
							{pending ? t("common.loading") : t("hostel.allocate")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function OccupantsDialog({
	tenantId,
	room,
	canManage,
	onClose,
	onChanged,
	lang,
}: {
	tenantId: string;
	room: RoomRow;
	canManage: boolean;
	onClose: () => void;
	onChanged: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [occupants, setOccupants] = useState<Occupant[] | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await apiFetch(`/api/v1/hostel/rooms/${room.id}/occupants`, { tenantId });
		if (!response.ok) {
			setError(`${t("hostel.loadFailed")} (HTTP ${response.status})`);
			return;
		}
		setOccupants((await response.json()).data);
	}, [room.id, tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	async function release(allocationId: string) {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/hostel/allocations/${allocationId}/release`, {
				method: "POST",
				tenantId,
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			await load();
			await onChanged();
		} catch {
			setError(t("common.apiUnreachable"));
		} finally {
			setPending(false);
		}
	}

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("hostel.occupants")} — {room.name}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					{occupants === null ? (
						<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
					) : occupants.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("hostel.noOccupants")}</p>
					) : (
						occupants.map((o) => (
							<div
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-b-0"
								key={o.allocationId}
							>
								<div>
									<div className="text-sm font-medium">{o.name}</div>
									<div className="font-mono text-xs text-muted-foreground">
										{o.studentNumber}
									</div>
								</div>
								{canManage && (
									<Button
										disabled={pending}
										onClick={() => void release(o.allocationId)}
										size="sm"
										variant="outline"
									>
										<UserMinusIcon /> {t("hostel.release")}
									</Button>
								)}
							</div>
						))
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
