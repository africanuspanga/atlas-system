import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { Http500ScrubFilter } from './common/http-500-scrub.filter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { SupabaseService } from './supabase/supabase.service';
import { OnboardingController } from './onboarding/onboarding.controller';
import { StudentsController } from './students/students.controller';
import {
  InvitationsController,
  StaffController,
} from './invitations/invitations.controller';
import { AttendanceController } from './attendance/attendance.controller';
import { TimetableController } from './timetable/timetable.controller';
import {
  AssessmentsController,
  SubjectsController,
} from './assessments/assessments.controller';
import { AcademicsController } from './assessments/academics.controller';
import { FinanceController } from './finance/finance.controller';
import { CommunicationController } from './communication/communication.controller';
import {
  GuardiansController,
  PortalController,
} from './parents/parents.controller';
import { HealthController } from './health/health.controller';
import { RedisService } from './observability/redis.service';
import { ImportsController } from './imports/imports.controller';
import { ReportsController } from './reports/reports.controller';
import { QueueKickService } from './queue/queue-kick.service';
import { PlatformController } from './platform/platform.controller';
import { PlatformGuard } from './platform/platform.guard';
import { HostelController } from './hostel/hostel.controller';
import { TransportController } from './transport/transport.controller';
import { LibraryController } from './library/library.controller';
import { InventoryController } from './inventory/inventory.controller';
import { ClinicController } from './clinic/clinic.controller';
import { PayrollController } from './payroll/payroll.controller';
import { AiController } from './ai/ai.controller';
import { ProspectsController } from './prospects/prospects.controller';
import { DevicesModule } from './devices/devices.module';
import { AiToolsService } from './ai/ai-tools.service';
import { AiActionsService } from './ai/ai-actions.service';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Root .env is shared by all apps; a local .env can override per app.
      envFilePath: ['.env', '../../.env'],
    }),
    // Global rate limit; tenant creation has a tighter per-route limit
    // (see OnboardingController — closes AUD-016).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    DevicesModule,
  ],
  controllers: [
    AppController,
    OnboardingController,
    StudentsController,
    InvitationsController,
    StaffController,
    AttendanceController,
    TimetableController,
    AssessmentsController,
    SubjectsController,
    AcademicsController,
    FinanceController,
    CommunicationController,
    GuardiansController,
    PortalController,
    HealthController,
    ImportsController,
    ReportsController,
    PlatformController,
    HostelController,
    TransportController,
    LibraryController,
    InventoryController,
    ClinicController,
    PayrollController,
    AiController,
    ProspectsController,
  ],
  providers: [
    AppService,
    SupabaseService,
    RedisService,
    QueueKickService,
    PlatformGuard,
    AiToolsService,
    AiActionsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // 5xx responses are scrubbed to `{ code }` — raw upstream error messages
    // (Postgres/PostgREST) stay in server logs only (audit M2).
    { provide: APP_FILTER, useClass: Http500ScrubFilter },
  ],
})
export class AppModule {}
