import { Module } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { DevicesController } from './devices.controller';

/**
 * Push-token registry for the mobile app. Self-contained module (the app
 * otherwise registers controllers directly on AppModule): provides its own
 * SupabaseService instance so AuthGuard and the controller resolve within
 * this module's injector.
 */
@Module({
  controllers: [DevicesController],
  providers: [SupabaseService],
})
export class DevicesModule {}
