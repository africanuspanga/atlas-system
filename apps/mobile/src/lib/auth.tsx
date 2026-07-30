import type { Session } from "@supabase/supabase-js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  registerForPushNotifications,
  unregisterPushToken,
} from "./notifications";
import { supabase } from "./supabase";

export type TenantInfo = {
  tenantId: string;
  name: string;
  slug: string;
  status: string;
};

type AuthState = {
  /** undefined while restoring the persisted session (show splash). */
  session: Session | null | undefined;
  /** undefined while resolving; null = signed-in but no school membership. */
  tenant: TenantInfo | null | undefined;
  /** True when the signed-in user is a guardian linked to students (parent portal). */
  isGuardian: boolean;
  refreshTenant: () => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

async function resolveTenant(): Promise<{
  tenant: TenantInfo | null;
  isGuardian: boolean;
}> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { tenant: null, isGuardian: false };

  // Same resolution the web app uses: oldest active membership wins.
  const { data: memberships } = await supabase
    .from("tenant_memberships")
    .select("tenant_id, status, created_at, tenants(id, name, slug, status)")
    .eq("user_id", user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1);

  const row = memberships?.[0] as
    | {
        tenant_id: string;
        tenants: { name: string; slug: string; status: string } | null;
      }
    | undefined;

  if (row?.tenants) {
    return {
      tenant: {
        tenantId: row.tenant_id,
        name: row.tenants.name,
        slug: row.tenants.slug,
        status: row.tenants.status,
      },
      isGuardian: false,
    };
  }

  // Not a member — maybe a linked guardian (parent portal, RLS own-row read).
  const { data: guardian } = await supabase
    .from("guardians")
    .select("id")
    .eq("user_id", user.id)
    .limit(1);

  return { tenant: null, isGuardian: (guardian?.length ?? 0) > 0 };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(
    undefined,
  );
  const [tenant, setTenant] = useState<TenantInfo | null | undefined>(
    undefined,
  );
  const [isGuardian, setIsGuardian] = useState(false);

  const refreshTenant = useCallback(async () => {
    const resolved = await resolveTenant();
    setTenant(resolved.tenant);
    setIsGuardian(resolved.isGuardian);
  }, []);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (data.session) void refreshTenant();
      else setTenant(null);
    });
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (next) {
        void refreshTenant();
      } else {
        setTenant(null);
        setIsGuardian(false);
      }
    });
    return () => subscription.unsubscribe();
  }, [refreshTenant]);

  // Register the Expo push token once signed in and tenant is resolved.
  // No-ops gracefully in Expo Go / on permission denial / before `eas init`.
  useEffect(() => {
    if (session && tenant !== undefined) {
      void registerForPushNotifications(tenant?.tenantId);
    }
  }, [session, tenant]);

  const signOut = useCallback(async () => {
    // Detach the device token while the session can still authenticate.
    await unregisterPushToken().catch(() => undefined);
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ session, tenant, isGuardian, refreshTenant, signOut }),
    [session, tenant, isGuardian, refreshTenant, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
