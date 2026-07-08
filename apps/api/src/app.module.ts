import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import {
  AssessmentsController,
  SubjectsController,
} from './assessments/assessments.controller';
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
import { AiController } from './ai/ai.controller';
import { AiToolsService } from './ai/ai-tools.service';

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
  ],
  controllers: [
    AppController,
    OnboardingController,
    StudentsController,
    InvitationsController,
    StaffController,
    AttendanceController,
    AssessmentsController,
    SubjectsController,
    FinanceController,
    CommunicationController,
    GuardiansController,
    PortalController,
    HealthController,
    ImportsController,
    ReportsController,
    PlatformController,
    AiController,
  ],
  providers: [
    AppService,
    SupabaseService,
    RedisService,
    QueueKickService,
    PlatformGuard,
    AiToolsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
