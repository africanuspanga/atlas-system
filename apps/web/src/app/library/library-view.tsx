"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpenIcon, PlusIcon, Undo2Icon } from "lucide-react";
import { apiFetch } from "@/lib/api";
import { apiErrorMessage } from "@/lib/api-error";
import { dateInTanzaniaAfterDays } from "@/lib/tanzania-date";
import { ListSkeleton } from "@/components/list-skeleton";
import { getDict, type DictKey, type Lang } from "@/i18n";
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
}

export interface SubjectOption {
	id: string;
	name: string;
}

interface BookRow {
	id: string;
	code: string;
	title: string;
	author: string | null;
	subject: string | null;
	copiesTotal: number;
	activeLoans: number;
	available: number;
}

interface OverdueRow {
	loanId: string;
	bookCode: string;
	bookTitle: string;
	studentNumber: string;
	studentName: string;
	className: string | null;
	dueOn: string;
	daysLate: number;
}

interface BookLoan {
	loanId: string;
	studentNumber: string;
	studentName: string;
	loanedOn: string;
	dueOn: string;
}

const selectClass =
	"h-9 rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

const ERROR_KEYS: Partial<Record<string, DictKey>> = {
	LIBRARY_NO_COPIES: "library.err.noCopies",
	LIBRARY_ALREADY_LOANED: "library.err.alreadyLoaned",
};

function defaultDueOn(): string {
	return dateInTanzaniaAfterDays(14);
}

export function LibraryView({
	tenantId,
	students,
	subjects,
	canManage,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	subjects: SubjectOption[];
	canManage: boolean;
	lang: Lang;
}) {
	const t = useMemo(() => getDict(lang), [lang]);
	const [books, setBooks] = useState<BookRow[]>([]);
	const [overdue, setOverdue] = useState<OverdueRow[]>([]);
	const [loaded, setLoaded] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [addOpen, setAddOpen] = useState(false);
	const [loanOpen, setLoanOpen] = useState(false);
	const [openBook, setOpenBook] = useState<BookRow | null>(null);

	const reload = useCallback(async () => {
		setLoaded(false);
		setLoadError(null);
		try {
			const [booksResponse, overdueResponse] = await Promise.all([
				apiFetch("/api/v1/library", { tenantId }),
				apiFetch("/api/v1/library/overdue", { tenantId }),
			]);
			if (!booksResponse.ok || !overdueResponse.ok) {
				setLoadError(
					`${t("library.loadFailed")} (HTTP ${booksResponse.ok ? overdueResponse.status : booksResponse.status})`,
				);
				return;
			}
			setBooks((await booksResponse.json()).data);
			setOverdue((await overdueResponse.json()).data);
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
				<h1 className="text-xl font-semibold">{t("library.title")}</h1>
				{canManage && (
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => setAddOpen(true)} size="sm" variant="outline">
							<PlusIcon /> {t("library.addBook")}
						</Button>
						<Button disabled={books.length === 0} onClick={() => setLoanOpen(true)} size="sm">
							<BookOpenIcon /> {t("library.loan")}
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

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("library.books")}</CardTitle>
				</CardHeader>
				<CardContent>
					{!loaded && !loadError ? (
						<ListSkeleton className="border-0 p-0" rows={5} />
					) : loaded && !loadError && books.length === 0 ? (
						<p className="py-6 text-center text-sm text-muted-foreground">
							{t("library.empty")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("library.code")}</TableHead>
									<TableHead>{t("library.bookTitle")}</TableHead>
									<TableHead>{t("library.subject")}</TableHead>
									<TableHead className="text-right">{t("library.copies")}</TableHead>
									<TableHead className="text-right">{t("library.available")}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{books.map((book) => (
									<TableRow
										className="cursor-pointer"
										key={book.id}
										onClick={() => setOpenBook(book)}
									>
										<TableCell className="font-mono">{book.code}</TableCell>
										<TableCell className="font-medium">
											{book.title}
											{book.author && (
												<span className="ml-2 text-xs text-muted-foreground">{book.author}</span>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground">{book.subject ?? "—"}</TableCell>
										<TableCell className="text-right font-mono">{book.copiesTotal}</TableCell>
										<TableCell className="text-right font-mono">{book.available}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			<Card className="shadow-none">
				<CardHeader>
					<CardTitle className="text-base">{t("library.overdue")}</CardTitle>
				</CardHeader>
				<CardContent>
					{overdue.length === 0 ? (
						<p className="py-4 text-center text-sm text-muted-foreground">
							{t("library.noOverdue")}
						</p>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t("library.book")}</TableHead>
									<TableHead>{t("library.student")}</TableHead>
									<TableHead>{t("library.class")}</TableHead>
									<TableHead>{t("library.dueOn")}</TableHead>
									<TableHead className="text-right">{t("library.daysLate")}</TableHead>
									{canManage && <TableHead />}
								</TableRow>
							</TableHeader>
							<TableBody>
								{overdue.map((loan) => (
									<OverdueLoanRow
										canManage={canManage}
										key={loan.loanId}
										lang={lang}
										loan={loan}
										onChanged={reload}
										tenantId={tenantId}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>

			{canManage && (
				<AddBookDialog
					lang={lang}
					onClose={() => setAddOpen(false)}
					onSaved={async () => {
						setAddOpen(false);
						await reload();
					}}
					open={addOpen}
					subjects={subjects}
					tenantId={tenantId}
				/>
			)}
			{canManage && (
				<LoanDialog
					books={books}
					key={loanOpen ? "open" : "closed"}
					lang={lang}
					onClose={() => setLoanOpen(false)}
					onSaved={async () => {
						setLoanOpen(false);
						await reload();
					}}
					open={loanOpen}
					students={students}
					tenantId={tenantId}
				/>
			)}
			{openBook && (
				<BookLoansDialog
					book={openBook}
					canManage={canManage}
					lang={lang}
					onChanged={reload}
					onClose={() => setOpenBook(null)}
					tenantId={tenantId}
				/>
			)}
		</div>
	);
}

function OverdueLoanRow({
	tenantId,
	loan,
	canManage,
	onChanged,
	lang,
}: {
	tenantId: string;
	loan: OverdueRow;
	canManage: boolean;
	onChanged: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [pending, setPending] = useState(false);

	async function returnLoan() {
		setPending(true);
		try {
			const response = await apiFetch(`/api/v1/library/loans/${loan.loanId}/return`, {
				method: "POST",
				tenantId,
			});
			if (response.ok) await onChanged();
		} finally {
			setPending(false);
		}
	}

	return (
		<TableRow>
			<TableCell>
				<span className="font-mono text-xs">{loan.bookCode}</span>{" "}
				<span className="font-medium">{loan.bookTitle}</span>
			</TableCell>
			<TableCell>
				{loan.studentName}{" "}
				<span className="font-mono text-xs text-muted-foreground">{loan.studentNumber}</span>
			</TableCell>
			<TableCell className="text-muted-foreground">{loan.className ?? "—"}</TableCell>
			<TableCell className="font-mono">{loan.dueOn}</TableCell>
			<TableCell className="text-right font-mono text-down">{loan.daysLate}</TableCell>
			{canManage && (
				<TableCell className="text-right">
					<Button disabled={pending} onClick={() => void returnLoan()} size="sm" variant="outline">
						<Undo2Icon /> {t("library.return")}
					</Button>
				</TableCell>
			)}
		</TableRow>
	);
}

function AddBookDialog({
	tenantId,
	subjects,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	subjects: SubjectOption[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [code, setCode] = useState("");
	const [title, setTitle] = useState("");
	const [author, setAuthor] = useState("");
	const [subjectId, setSubjectId] = useState("");
	const [copies, setCopies] = useState("1");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const copiesNumber = Number.parseInt(copies, 10);

	async function save() {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/library/books", {
				method: "POST",
				tenantId,
				body: JSON.stringify({
					code: code.trim(),
					title: title.trim(),
					author: author.trim() === "" ? undefined : author.trim(),
					subjectId: subjectId === "" ? undefined : subjectId,
					copiesTotal: copiesNumber,
				}),
			});
			if (!response.ok) {
				const body = await response.json().catch(() => null);
				setError(apiErrorMessage(t, body, response.status));
				return;
			}
			setCode("");
			setTitle("");
			setAuthor("");
			setSubjectId("");
			setCopies("1");
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
					<DialogTitle>{t("library.addBook")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("library.code")}
						<Input onChange={(e) => setCode(e.target.value)} value={code} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("library.bookTitle")}
						<Input onChange={(e) => setTitle(e.target.value)} value={title} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("library.author")}
						<Input onChange={(e) => setAuthor(e.target.value)} value={author} />
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("library.subject")}
						<select
							className={selectClass}
							onChange={(e) => setSubjectId(e.target.value)}
							value={subjectId}
						>
							<option value="">{t("library.noSubject")}</option>
							{subjects.map((s) => (
								<option key={s.id} value={s.id}>
									{s.name}
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("library.copiesTotal")}
						<Input
							min={1}
							onChange={(e) => setCopies(e.target.value)}
							type="number"
							value={copies}
						/>
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={
								pending ||
								code.trim() === "" ||
								title.trim().length < 2 ||
								!Number.isInteger(copiesNumber) ||
								copiesNumber < 1
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

function LoanDialog({
	tenantId,
	students,
	books,
	open,
	onClose,
	onSaved,
	lang,
}: {
	tenantId: string;
	students: StudentOption[];
	books: BookRow[];
	open: boolean;
	onClose: () => void;
	onSaved: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [query, setQuery] = useState("");
	const [studentId, setStudentId] = useState("");
	const [bookId, setBookId] = useState("");
	const [dueOn, setDueOn] = useState(defaultDueOn());
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const q = query.toLowerCase().trim();
	const matches =
		q === ""
			? students.slice(0, 8)
			: students
					.filter(
						(s) =>
							s.name.toLowerCase().includes(q) ||
							s.studentNumber.toLowerCase().includes(q),
					)
					.slice(0, 8);
	const selected = students.find((s) => s.id === studentId) ?? null;

	async function save() {
		if (!studentId || !bookId || dueOn === "") return;
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch("/api/v1/library/loans", {
				method: "POST",
				tenantId,
				body: JSON.stringify({ bookId, studentId, dueOn }),
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
					<DialogTitle>{t("library.loan")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<label className="flex flex-col gap-1 text-sm">
						{t("library.student")}
						<Input
							onChange={(e) => {
								setQuery(e.target.value);
								setStudentId("");
							}}
							placeholder={t("library.searchStudent")}
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
								<p className="px-2 text-sm text-muted-foreground">{t("library.noMatches")}</p>
							)}
						</div>
					)}
					<label className="flex flex-col gap-1 text-sm">
						{t("library.book")}
						<select
							className={selectClass}
							onChange={(e) => setBookId(e.target.value)}
							value={bookId}
						>
							<option value="">{t("library.selectBook")}</option>
							{books.map((b) => (
								<option disabled={b.available <= 0} key={b.id} value={b.id}>
									{b.code} — {b.title} ({b.available} {t("library.available").toLowerCase()})
								</option>
							))}
						</select>
					</label>
					<label className="flex flex-col gap-1 text-sm">
						{t("library.dueOn")}
						<Input onChange={(e) => setDueOn(e.target.value)} type="date" value={dueOn} />
					</label>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button
							disabled={pending || !studentId || !bookId || dueOn === ""}
							onClick={() => void save()}
						>
							{pending ? t("common.loading") : t("library.loan")}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}

function BookLoansDialog({
	tenantId,
	book,
	canManage,
	onClose,
	onChanged,
	lang,
}: {
	tenantId: string;
	book: BookRow;
	canManage: boolean;
	onClose: () => void;
	onChanged: () => Promise<void>;
	lang: Lang;
}) {
	const t = getDict(lang);
	const [loans, setLoans] = useState<BookLoan[] | null>(null);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		const response = await apiFetch(`/api/v1/library/books/${book.id}/loans`, { tenantId });
		if (!response.ok) {
			setError(`${t("library.loadFailed")} (HTTP ${response.status})`);
			return;
		}
		setLoans((await response.json()).data);
	}, [book.id, tenantId, t]);

	useEffect(() => {
		// Async data load; state updates land after awaits, not synchronously.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		void load();
	}, [load]);

	async function returnLoan(loanId: string) {
		setPending(true);
		setError(null);
		try {
			const response = await apiFetch(`/api/v1/library/loans/${loanId}/return`, {
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
						{t("library.activeLoans")} — {book.title}
					</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-2">
					{loans === null ? (
						<p className="text-sm text-muted-foreground">{t("common.loading")}</p>
					) : loans.length === 0 ? (
						<p className="text-sm text-muted-foreground">{t("library.noLoans")}</p>
					) : (
						loans.map((loan) => (
							<div
								className="flex items-center justify-between gap-2 border-b border-border pb-2 last:border-b-0"
								key={loan.loanId}
							>
								<div>
									<div className="text-sm font-medium">{loan.studentName}</div>
									<div className="font-mono text-xs text-muted-foreground">
										{loan.studentNumber} · {t("library.dueOn")} {loan.dueOn}
									</div>
								</div>
								{canManage && (
									<Button
										disabled={pending}
										onClick={() => void returnLoan(loan.loanId)}
										size="sm"
										variant="outline"
									>
										<Undo2Icon /> {t("library.return")}
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
