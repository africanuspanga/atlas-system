import { Redirect, Stack } from "expo-router";

import { useAuth } from "@/lib/auth";
import { color } from "@/lib/theme";

export default function AuthLayout() {
  const { session } = useAuth();

  // Already signed in — let the root dispatcher route to the right surface.
  if (session) return <Redirect href="/" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: color.canvas },
      }}
    />
  );
}
