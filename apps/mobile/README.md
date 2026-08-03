# ATLAS mobile

Expo (SDK 57) app for the ATLAS school platform — staff and parent flows on
iOS and Android. Lives in the pnpm/Turborepo monorepo as `@atlas/mobile`.

## Prerequisites

1. **Install dependencies at the repo root** (pnpm workspaces):

   ```bash
   pnpm install
   ```

2. **Environment**: copy `apps/mobile/.env.example` to `apps/mobile/.env`
   and fill in the Supabase URL + anon key (same project the web app uses;
   the anon key is safe to ship). Leave `EXPO_PUBLIC_API_URL` unset in dev.

3. **API running**: the app talks to the NestJS API on port 4000. Start it
   (`pnpm --filter @atlas/api dev`) and make sure it is reachable on your
   LAN — physical devices connect to your machine's LAN IP, not localhost.

## Start the dev server

```bash
pnpm --filter @atlas/mobile start
```

Then press `i` for the iOS simulator or `a` for an Android emulator.

## Test on a physical device (Expo Go)

1. Install **Expo Go** from the App Store (iPhone) or Play Store (Android).
2. Put the phone on the **same Wi-Fi network** as the dev machine.
3. Scan the QR code the dev server prints:
   - iPhone: use the **Camera** app, tap the banner.
   - Android: use the **scanner inside Expo Go**.

In dev the API host is auto-derived from the dev server's LAN host (see
`src/lib/api.ts`), so a phone reaches your local API with zero config — as
long as the API is running and your firewall allows port 4000.

## Push notifications

Client plumbing lives in `src/lib/notifications.ts`
(`registerForPushNotifications` / `unregisterPushToken`); tokens are stored
by the API in `public.device_tokens` (migration 0028). Sending is a future
worker concern.

**Expo Go limitation**: since SDK 53, REMOTE push notifications do not work
in Expo Go on Android — local notifications still work. To test real
pushes, make a development build:

```bash
npx eas-cli build -p android --profile development   # or -p ios
```

Install the resulting build on the device and start the dev server as
usual. `registerForPushNotifications` also needs `extra.eas.projectId` in
`app.json`, which `eas init` sets (see below) — until then it returns
`null` gracefully.

## Production builds & store submission

Production builds fail fast unless `EXPO_PUBLIC_API_URL` is an explicit HTTPS
URL. Store the public Supabase values and API URL in the EAS production
environment; do not rely on the developer's local `.env` during a cloud build.
Native authentication sessions are stored in chunked `expo-secure-store`
records (with a one-time migration from the former AsyncStorage value). The
web build alone continues to use AsyncStorage because browser SecureStore is
unavailable.

```bash
npx eas-cli login          # Expo account
npx eas-cli init           # once — links the project, sets extra.eas.projectId
eas build -p ios --profile production
eas build -p android --profile production
eas submit -p ios
eas submit -p android
```

Profiles are in `eas.json` (`development` = dev client, `preview` =
internal APK, `production` = store build with auto-incremented build
numbers, version source `remote`).

Store checklist:

- The bundle id / package **`com.atlasschool.mobile`** must match the app
  records you create in App Store Connect and the Google Play Console.
- Apple: membership in the Apple Developer Program (team) is required;
  `eas submit -p ios` walks through App Store Connect API key setup.
- Google: a Play Console **service account** JSON key is required for
  `eas submit -p android` (first submission must be uploaded manually in
  the Play Console).
- Both stores require a **privacy policy URL**, screenshots (6.5" iPhone,
  and phone + 7"/10" tablet for Play), an app description, and data-safety
  / privacy-nutrition declarations before review.

## Database compatibility

Push-token storage was introduced in migration `0028`; production now requires
the complete migration chain through `0033`. The linked live Supabase project
was verified at `0033` on 3 August 2026. For another environment, rehearse and
use the Supabase CLI so only missing migrations are applied:

```bash
./scripts/shadow-migrations.sh
set -a && source .env && set +a
pnpm exec supabase db push --dry-run --include-all
pnpm exec supabase db push --include-all
```

## Brand assets

All icons/splash art are generated — never edit the PNGs by hand:

```bash
node apps/mobile/scripts/generate-assets.mjs
```
