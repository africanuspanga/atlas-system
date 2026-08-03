import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';

/**
 * Server-side Supabase access. Uses the service-role key: bypasses RLS, so
 * every caller MUST enforce tenant scoping and permissions itself.
 * This client never leaves the API process.
 */
@Injectable()
export class SupabaseService implements OnModuleInit {
  private client!: SupabaseClient;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const url = this.config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = this.config.getOrThrow<string>(
      'SUPABASE_SERVICE_ROLE_KEY',
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.client = createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  get admin(): SupabaseClient {
    return this.client;
  }

  /** Validate a user access token and return the user, or null. */
  async getUserFromToken(accessToken: string): Promise<User | null> {
    const { data, error } = await this.client.auth.getUser(accessToken);
    if (error) {
      // Invalid/expired credentials are an authentication outcome. Provider
      // outages are operational failures and must reach the 500/Sentry path.
      if (error.status && [400, 401, 403].includes(error.status)) return null;
      throw new Error(`AUTH_PROVIDER_UNAVAILABLE: ${error.message}`);
    }
    return data.user;
  }
}
