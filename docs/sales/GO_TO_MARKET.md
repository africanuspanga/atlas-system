# ATLAS — Go-to-Market Playbook (Tanzania)

_For the founder and future sales team. How to find, win, and keep schools.
Companion document: `SCHOOL_OWNER_OFFER.md` (the offer you put in front of
owners). Product facts in this document are grounded in the shipped
platform — nothing here promises a feature that doesn't exist._

---

## 1. Positioning

**One-liner (EN):** ATLAS runs your whole school — students, fees, exams,
SMS to parents — in Swahili and English, with an AI assistant that answers
any question about your school in seconds.

**One-liner (SW):** ATLAS inaendesha shule yako yote — wanafunzi, ada,
mitihani, SMS kwa wazazi — kwa Kiswahili na Kiingereza, na msaidizi wa AI
anayejibu swali lolote kuhusu shule yako kwa sekunde.

**Category:** School management system (SMS/ERP). **Wedge:** the only one
that is (a) genuinely bilingual, (b) NECTA-native (PSLE/CSEE/ACSEE grading,
divisions, CA summaries, candidate exports), and (c) AI-native — "Ask
ATLAS" is on every page and can operate the system, not just chat.

**We are NOT selling software. We are selling three outcomes:**
1. **Collect more of the fees you are owed** (invoices, receipts, debtors
   list, automatic SMS reminders, instalment tracking).
2. **Cut the term-end panic to hours** (marks in, report cards and NECTA
   paperwork out).
3. **Parents who feel informed** (absence SMS the same morning, a portal
   with fees and results).

## 2. Ideal customer profile (ICP)

| Attribute | Target |
|---|---|
| Type | Private (non-government) primary & secondary schools |
| Size | 200–2,000 students (sweet spot 300–800 → Msingi/Kati plans) |
| Geography (first wave) | Arusha & Manyara (home turf + demo school), then Dar es Salaam, Mwanza, Dodoma, Moshi, Mbeya |
| Decision maker | Owner / Director (often also the founder) |
| Champions | Head teacher (academics), Bursar (money) — win BOTH in the demo |
| Pain signals | Fees tracked in exercise books or Excel; report cards typed one by one in Word; parents complain "sikujua" (I didn't know); NECTA CA deadline scramble |

**Disqualify (for now):** government schools (procurement cycles),
schools under ~100 students (price sensitivity), schools demanding offline-
only operation.

## 3. The pain map → what we show

| Their pain | What ATLAS does about it | Where in demo |
|---|---|---|
| "Parents owe us millions and we don't know who" | Debtors list (wadaiwa) reconciled to a real ledger; one-tap fee-reminder SMS per unpaid invoice | `/finance/debtors` |
| Fee leakage / receipts in a notebook | Numbered receipts (RCT-…), immutable payments — corrections are audited reversals, nothing is ever quietly edited | `/finance` invoice detail |
| Report card week is a nightmare | Marks grid per subject → publish → ranked report cards with NECTA divisions, printable, in Swahili too | `/assessments`, report card |
| Parents feel ignored | Absent child → guardian gets a Kiswahili SMS that morning; announcements to all guardians or one class | `/attendance`, `/communication` |
| "I can't see what's happening unless I'm at school" | Owner dashboard + **Ask ATLAS**: "Nani hajalipa ada?" answered in seconds, from anywhere | Ask ATLAS button |
| Teacher/staff data everywhere | Students, guardians, staff, timetable (with clash detection), hostel, transport, library, clinic, inventory, payroll (PAYE/NSSF/HESLB) in one place | sidebar tour |

## 4. Pricing & packaging (as shipped)

| Plan | Monthly (TZS) | Annual (TZS, 2 months free) | Students | Staff | SMS/month | AI tokens/month |
|---|---|---|---|---|---|---|
| Trial | 0 (30 days) | — | 300 | 20 | 200 | 500k |
| **Msingi** | 150,000 | 1,500,000 | 800 | 60 | 2,000 | 2M |
| **Kati** | 350,000 | 3,500,000 | 2,000 | 200 (3 campuses) | 10,000 | 5M |
| **Juu** | 800,000 | 8,000,000 | Unlimited | Unlimited | 50,000 | 10M |

**The money math (memorise this):** Msingi costs 150,000 TZS/month. If a
school's fees are ~600,000 TZS/student/year, recovering **the unpaid fees of
just 3 students** pays for ATLAS for the whole year. Every debtors demo
should end on this sentence.

Billing today is manual reconciliation: the school pays by bank/M-Pesa,
platform staff record it in `/platform` (Record payment) and the paid-until
date extends. Lapsed schools go read-only — they never lose their data.

## 5. Channels (in order of expected yield)

1. **Founder-led direct sales** — the first 20 schools are sold by the
   founder, in person. Nothing else works until reference customers exist.
2. **Referrals from live schools** — build it into the offer (see offer
   doc): a founding school that refers a school that goes live gets a free
   month. School owners all know each other.
3. **Owner associations & networks** — TAMONGSCO (non-government school
   managers/owners association) regional meetings; ask to give a 15-minute
   "digital fee collection" talk, not a sales pitch. Faith-based school
   networks (diocese/mosque school boards) decide for many schools at once.
4. **WhatsApp** — owners live on WhatsApp. Short video (90 seconds: absence
   SMS arriving on a parent's phone + the debtors list) outperforms any PDF.
5. **Head-teacher word of mouth** — head teachers move schools and take
   tools with them. Treat every head teacher as a future champion.
6. **Later (post 20 schools):** local radio in school-dense regions,
   education exhibitions, Facebook groups for school owners.

## 6. The sales process (5 steps)

**Step 1 — List.** 50 target schools per region: name, owner, phone,
approx. size, current system (paper/Excel/competitor). Sources: NECTA
centre lists, association directories, personal network.

**Step 2 — Opener (WhatsApp or call).** In Swahili, short:

> Habari, mimi ni [jina] wa ATLAS. Tunasaidia shule binafsi kukusanya ada
> zote na kutoa ripoti za NECTA bila stress. Naomba dakika 20 tu
> nikuonyeshe jinsi shule kama yako inavyoona kila mdaiwa kwa sekunde —
> live, si maelezo. Lini unaweza — leo jioni au kesho?

(No brochure attached. The ask is 20 minutes, live.)

**Step 3 — The 20-minute demo.** Use the demo school (Chief Sarwatt School,
258 students, real-looking data — one-tap demo login on the login page).
Order matters:

1. **Open with Ask ATLAS** (2 min): ask in Swahili "wanafunzi wangapi
   hawajalipa ada?" — let them watch it answer. This is the moment they
   lean in.
2. **Debtors + reminders** (5 min): the wadaiwa list, then send a fee
   reminder — show the SMS text in Kiswahili. Say the money math sentence.
3. **Attendance → parent SMS** (3 min): mark a child absent, show the SMS
   the guardian receives the same morning.
4. **Marks → report card** (5 min): the marks grid, publish, then a ranked
   report card with NECTA division. If secondary school: show the CA
   summary/candidate export.
5. **Their role matrix** (2 min): show that the bursar sees money, the
   teacher sees marks, and neither sees the other — owners care about
   internal controls more than they say.
6. **Close** (3 min): put the Founding Schools offer (one page, printed) on
   the table. Ask: "Tukianze na muhula huu?" (Shall we start this term?)

**Step 4 — Pilot / onboarding (the offer's promise: live in 48 hours).**
Collect their student list in any Excel/paper form → our imports wizard
takes it (guardian phones included, so parents are linked from day one).
Configure fees, invite 3–5 staff, train the bursar and one teacher (30 min
each). The trial supports this; extend it to a full term for founding
schools (trial-extend exists in `/platform`).

**Step 5 — Convert & expand.** Two weeks before trial end, the platform
dashboard shows "trials expiring ≤14 days" — call, don't email. Convert to
annual where possible (2 months free). Then ask for two referrals.

## 7. Objection handling

| Objection | Answer |
|---|---|
| "We already use Excel / exercise books" | "Keep them — ATLAS imports your Excel in minutes. The difference: Excel doesn't SMS a parent when their child is absent, and it can't tell you who owes what across 3 years without a weekend of work." |
| "Teachers won't manage" | "It's in Kiswahili, and if anyone gets stuck they literally ask the assistant in Kiswahili. We train your staff ourselves; a teacher marks attendance in under a minute." |
| "Internet/power is unreliable" | "It works on a phone over normal bundles — attendance and receipts are light pages. Parents don't need internet at all; they get SMS." |
| "What about our data if we leave?" | "Your data is yours. Every register, mark and payment exports to Excel/PDF/CSV free, any time, including if you cancel. It's in the offer in writing." |
| "Is our data safe from other schools?" | "Every school is isolated at the database level; this is audited. Your staff see only what their role allows — even we log every time platform staff touch your account, and you can request that log." |
| "It's expensive" | Money math (§4). Then: "What did the last mistake in the fee book cost you?" |
| "Another system burned us" | "That's why the pilot is free for a term and we do the setup, not you. If it doesn't earn its place, you walk away with your data and pay nothing." |

## 8. First-90-days launch plan

- **Weeks 1–2:** list of 50 schools (Arusha/Manyara), print offer one-pagers,
  rehearse the 20-min demo until it's < 20 min.
- **Weeks 3–6:** 30 demos booked → target 10 founding pilots live (the
  48-hour onboarding promise is the constraint — don't sell faster than
  you can onboard).
- **Weeks 7–12:** convert pilots (target ≥6 paying), collect 3 written
  testimonials + 1 video, ask every convert for 2 referrals, present at one
  association meeting.
- **Exit criteria for phase 2 (new region):** 10 paying schools, churn 0,
  onboarding time ≤ 2 days without the founder present.

## 9. Metrics that matter

Pipeline: demos booked/week (target 5+), demo→pilot rate (target 40%),
pilot→paid rate (target 60%). Health (already in `/platform`): silent
schools list = churn-risk call list; unit costs (SMS/AI vs plan price) =
margin watch. North star: **schools that ran attendance AND recorded a
payment this week** — a school doing both has embedded ATLAS in its daily
operations and will renew.

## 10. Honesty rules for everyone who sells ATLAS

Never promise: offline mode, a payment gateway ("pay school fees inside
ATLAS" — it's on the roadmap, `docs/product/PAYMENTS_INTEGRATION_PLAN.md`),
a mobile app, or government/NECTA integration. Never guarantee revenue
outcomes — say "schools use the debtors list and reminders to recover fees"
and show it. What we CAN promise, in writing: bilingual UI, NECTA grading,
same-morning absence SMS, ledger-grade money records, free data export,
and setup done for them in 48 hours.
