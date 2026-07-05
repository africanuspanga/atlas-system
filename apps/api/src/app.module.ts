import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Root .env is shared by all apps; a local .env can override per app.
      envFilePath: ['.env', '../../.env'],
    }),
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
  ],
  providers: [AppService, SupabaseService],
})
export class AppModule {}
