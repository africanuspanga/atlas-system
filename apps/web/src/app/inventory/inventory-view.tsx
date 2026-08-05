"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowDownUpIcon, PlusIcon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type DictKey } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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

interface ItemRow {
	id: string;
	name: string;
	unit: string;
	reorderLevel: number;
	stock: number;
	lowStock: boolean;
}

interface MovementRow {
	id: string;
	kind: string;
	quantity: number;
	note: string | null;
	movedOn: string;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const ERROR_KEYS: Partial<Record<string, DictKey>> = {
	INVENTORY_INSUFFICIENT: "inventory.err.insufficient",
};

export function InventoryView({
	tenantId,
	canManage,
}: {
	tenantId: string;
	canManage: boolean;
}) {
	const t = getDict();
	const [items, setItems] = useState<ItemRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [moveOpen, setMoveOpen] = useState(false);
	const [openItem, setOpenItem] = useState<ItemRow | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setLoadError(null);
		try {
			const response = await apiFetch("/api/v1/inventory", { tenantId });
			if (!response.ok) {
				setLoadError(`${t("inventory.loadFailed")} (HTTP ${response.status})`);
				return;
			}
			setItems((await response.json()).data);
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

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<h1 className="text-xl font-semibold">{t("inventory.title")}</h1>
				{canManage && (
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => setAddOpen(true)} size="sm" variant="outline">
							<PlusIcon /> {t("inventory.addItem")}
						</Button>
						<Button disabled={items.length === 0} onClick={() => setMoveOpen(true)} size="sm">
							<ArrowDownUpIcon /> {t("inventory.recordMovement")}
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
			<p className="text-xs text-muted-foreground">{t("inventory.financeNote")}</p>

			{!loaded && !loadError ? (
				<ListSkeleton rows={6} />
			) : loaded && !loadError && items.length === 0 ? (
				<Card className="shadow-none">
					<CardContent className="py-10 text-center text-sm text-muted-foreground">
						{t("inventory.empty")}
					</CardContent>
				</Card>
			) : (
				<Card className="shadow-none">
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("inventory.item")}</TableHead>
									<TableHead>{t("inventory.unit")}</TableHead>
									<TableHead className="text-right">{t("inventory.stock")}</TableHead>
									<TableHead className="text-right">{t("inventory.reorderLevel")}</TableHead>
									<TableHead />
								</TableRow>
							</TableHeader>
							<TableBody>
								{items.map((item) => (
									<TableRow
										className="cursor-pointer"
										key={item.id}
										onClick={() => setOpenItem(item)}
									>
										<TableCell className="font-medium">{item.name}</TableCell>
										<TableCell className="text-muted-foreground">{item.unit}</TableCell>
										<TableCell className="text-right font-mono">{item.stock}</TableCell>
										<TableCell className="text-right font-mono">{item.reorderLevel}</TableCell>
										<TableCell>
											{item.lowStock && (
												<Badge variant="outline">{t("inventory.lowStock")}</Badge>
											)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			)}

			{canManage && (
				<AddItemDialog
					onClose={() => setAddOpen(false)}
					onSaved={async () => {
						setAddOpen(false);
						await reload();
					}}
					open={addOpen}
					tenantId={tenantId}
				/>
			)}
			{canManage && (
				<MovementDialog
					items={items}
					key={moveOpen ? "open" : "closed"}
					onClose={() => setMoveOpen(false)}
					onSaved={async () => {
						setMoveOpen(false);
						await reload();
					}}
					open={moveOpen}
					tenantId={tenantId}
				/>
			)}
			{openItem && (
				<HistoryDialog
					item={openItem}
					onClose={() => setOpenItem(null)}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function AddItemDialog({
	tenantId,
	open,
	onClose,
	onSaved,
}: {
	tenantId: string;
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = getDict();
	const [name, setName] = useState("");
	const [unit, setUnit] = useState("pcs");
	const [reorderLevel, setReorderLevel] = useState("0");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const reorderNumber = Number.parseInt(reorderLevel, 10);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/inventory/items", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					name: name.trim(),
					unit: unit.trim(),
					reorderLevel: reorderNumber,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setName("");
			setUnit("pcs");
			setReorderLevel("0");
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
					<DialogTitle>{t("inventory.addItem")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.name")}
						<Input onChange={(e) => setName(e.target.value)} value={name} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.unit")}
						<Input
							onChange={(e) => setUnit(e.target.value)}
							placeholder={t("inventory.unitHint")}
							value={unit}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.reorderLevel")}
						<Input
							min={0}
							onChange={(e) => setReorderLevel(e.target.value)}
							type="number"
							value={reorderLevel}
						/>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={
								pending ||
								name.trim().length < 2 ||
								unit.trim() === "" ||
								!Number.isInteger(reorderNumber) ||
								reorderNumber < 0
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

function MovementDialog({
	tenantId,
	items,
	open,
	onClose,
	onSaved,
}: {
	tenantId: string;
	items: ItemRow[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
}) {
	const t = getDict();
	const [itemId, setItemId] = useState("");
	const [kind, setKind] = useState("in");
	const [quantity, setQuantity] = useState("1");
	const [note, setNote] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const quantityNumber = Number.parseInt(quantity, 10);

	async function save() {
		if (!itemId) return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/inventory/movements", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					itemId,
					kind,
					quantity: quantityNumber,
					note: note.trim() === "" ? undefined : note.trim(),
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				const key = body?.code ? ERROR_KEYS[body.code as string] : undefined;
				setError(key ? t(key) : apiErrorMessage(t, body, response.status));
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
					<DialogTitle>{t("inventory.recordMovement")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.item")}
						<select
							className={selectClass}
							onChange={(e) => setItemId(e.target.value)}
							value={itemId}
						>
							<option value="">{t("inventory.item")}…</option>
							{items.map((i) => (
								<option key={i.id} value={i.id}>
									{i.name} — {i.stock} {i.unit}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.kind")}
						<select
							className={selectClass}
							onChange={(e) => setKind(e.target.value)}
							value={kind}
						>
							<option value="in">{t("inventory.kind.in")}</option>
							<option value="out">{t("inventory.kind.out")}</option>
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.quantity")}
						<Input
							min={1}
							onChange={(e) => setQuantity(e.target.value)}
							type="number"
							value={quantity}
						/>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("inventory.note")}
						<Input onChange={(e) => setNote(e.target.value)} value={note} />
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={
								pending || !itemId || !Number.isInteger(quantityNumber) || quantityNumber < 1
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

function HistoryDialog({
	tenantId,
	item,
	onClose,
}: {
	tenantId: string;
	item: ItemRow;
	onClose: () => void;
}) {
	const t = getDict();
	const [movements, setMovements] = useState<MovementRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await apiFetch(`/api/v1/inventory/items/${item.id}/movements`, {
			tenantId,
		});
		if (!response.ok) {
			setError(`${t("inventory.loadFailed")} (HTTP ${response.status})`);
			return;
		}
		setMovements((await response.json()).data);
	}, [item.id, tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	return (
		<Dialog onOpenChange={(v) => !v && onClose()} open>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("inventory.history")} — {item.name}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					{movements === null ? (
						<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
					) : movements.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("inventory.noMovements")}</p>
					) : (
						movements.map((m) => (
							<div
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-b-0"
								key={m.id}
							>
								<div>
									<div className="text-sm font-medium">
										{m.kind === "in" ? t("inventory.kind.in") : t("inventory.kind.out")}{" "}
										<span className="font-mono">
											{m.kind === "in" ? "+" : "−"}
											{m.quantity}
										</span>{" "}
										{item.unit}
									</div>
									{m.note && <div className="text-xs text-muted-foreground">{m.note}</div>}
								</div>
								<div className="font-mono text-xs text-muted-foreground">{m.movedOn}</div>
							</div>
						))
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
				</div>
			</DialogContent>
		</Dialog>
	);
}
