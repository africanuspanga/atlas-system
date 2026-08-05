import { isAuthApiError } from "@supabase/supabase-js";
import { useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { PillButton } from "@/components/pill-button";
import { Screen } from "@/components/screen";
import { useT } from "@/lib/i18n";
import { supabase } from "@/lib/supabase";
import { color, font, radius, space } from "@/lib/theme";

/**
 * Public demo school ("Chief Sarwatt School") seeded by
 * apps/api/scripts/seed-demo.mjs. Deliberately visible — it is a demo.
 * Keep in sync with apps/web/src/app/login/login-form.tsx.
 */
const DEMO_EMAIL = "demo@chiefsarwatt.sc.tz";
const DEMO_PASSWORD = "DemoAtlas2026!";

export default function Login() {
  const t = useT();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function signIn(signInEmail: string, signInPassword: string) {
    setError(null);
    setPending(true);
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({
        email: signInEmail.trim(),
        password: signInPassword,
      });
      if (authError) {
        // Friendly mapping for the common Supabase auth failures.
        if (isAuthApiError(authError)) {
          if (authError.code === "invalid_credentials") {
            setError(t("err.invalidCredentials"));
            return;
          }
          if (authError.code === "email_not_confirmed") {
            setError(t("err.emailNotConfirmed"));
            return;
          }
          if (authError.status === 429) {
            setError(t("err.rateLimited"));
            return;
          }
        }
        setError(authError.message);
        return;
      }
      // Success: AuthProvider picks up the session; the (auth) layout
      // redirects to "/" which dispatches to tabs / portal / no-school.
    } catch {
      setError(t("common.apiUnreachable"));
    } finally {
      setPending(false);
    }
  }

  function demoSignIn() {
    // Fill the form so the visitor sees the credentials, then sign in.
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    void signIn(DEMO_EMAIL, DEMO_PASSWORD);
  }

  return (
    <Screen edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={styles.flex}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.hero}>
            <Text style={styles.wordmark}>ATLAS</Text>
            <Text style={styles.tagline}>{t("login.tagline")}</Text>
          </View>

          <View style={styles.form}>
            <Text style={styles.heading}>{t("login.signin")}</Text>
            <Text style={styles.subheading}>{t("login.signinDesc")}</Text>

            <View style={styles.field}>
              <Text style={styles.label}>{t("login.email")}</Text>
              <TextInput
                autoCapitalize="none"
                autoComplete="email"
                autoCorrect={false}
                editable={!pending}
                inputMode="email"
                onChangeText={setEmail}
                placeholder="you@school.ac.tz"
                placeholderTextColor={color.mutedSoft}
                style={styles.input}
                value={email}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.label}>{t("login.password")}</Text>
              <TextInput
                autoCapitalize="none"
                autoComplete="password"
                editable={!pending}
                onChangeText={setPassword}
                onSubmitEditing={() => void signIn(email, password)}
                returnKeyType="go"
                secureTextEntry
                style={styles.input}
                value={password}
              />
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <PillButton
              disabled={email.trim().length === 0 || password.length === 0}
              haptic
              loading={pending}
              onPress={() => void signIn(email, password)}
              title={pending ? t("login.pleaseWait") : t("login.signin")}
            />

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{t("login.demoDivider")}</Text>
              <View style={styles.dividerLine} />
            </View>

            <PillButton
              disabled={pending}
              onPress={demoSignIn}
              title={t("login.tryDemo")}
              variant="secondary"
            />
            <Text style={styles.demoHint}>{t("login.demoHint")}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { flexGrow: 1, paddingBottom: space(8) },
  hero: {
    alignItems: "center",
    gap: space(2),
    paddingVertical: space(12),
  },
  wordmark: {
    fontFamily: font.bold,
    fontSize: 36,
    letterSpacing: 3,
    color: color.primary,
  },
  tagline: {
    fontFamily: font.regular,
    fontSize: 15,
    lineHeight: 22,
    color: color.body,
    textAlign: "center",
  },
  form: { gap: space(3) },
  heading: {
    fontFamily: font.medium,
    fontSize: 24,
    lineHeight: 30,
    letterSpacing: -0.4,
    color: color.ink,
  },
  subheading: {
    fontFamily: font.regular,
    fontSize: 14,
    lineHeight: 21,
    color: color.body,
    marginBottom: space(2),
  },
  field: { gap: space(1.5) },
  label: {
    fontFamily: font.medium,
    fontSize: 13,
    color: color.ink,
  },
  input: {
    height: 48,
    borderRadius: radius.input,
    borderWidth: 1,
    borderColor: color.hairline,
    paddingHorizontal: space(3.5),
    fontFamily: font.regular,
    fontSize: 16,
    color: color.ink,
    backgroundColor: color.canvas,
  },
  error: {
    fontFamily: font.regular,
    fontSize: 13,
    lineHeight: 19,
    color: color.loss,
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: space(3),
    marginVertical: space(1),
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: color.hairline,
  },
  dividerText: {
    fontFamily: font.regular,
    fontSize: 12,
    color: color.muted,
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  demoHint: {
    fontFamily: font.regular,
    fontSize: 12,
    lineHeight: 18,
    color: color.muted,
    textAlign: "center",
  },
});
