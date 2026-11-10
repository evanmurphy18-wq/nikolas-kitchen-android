# Nikola's Kitchen — long-term Android app (v4.2)

A single app with a freezer, fridge and pantry inventory, food icons and custom units, 68 recipes, meal planning, local backups, and **opt-in household cloud sharing for shopping lists and the freezer, fridge and pantry**, across two phones.

## Household cloud sharing — one-time Firebase setup

The app works offline immediately. Cloud sharing **will not work until a Firebase project is configured**; the source ships with `www/cloud-config.js` containing `null` deliberately.

1. In the [Firebase Console](https://console.firebase.google.com/), create a project and register a **web app**. Copy its web app config (`apiKey`, `authDomain`, `projectId`, `appId`). These values identify the project; they aren't private server keys.
2. Enable **Authentication → Sign-in method → Email/Password**.
3. Create a **Cloud Firestore** database in production mode. Paste `cloud/firestore.rules` into its Rules tab and publish. Do **not** use public allow-all rules.
4. Change `www/cloud-config.js` from `null` to `window.NK_CLOUD_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };` and commit it.
5. Build another APK (or use the signed update mechanism below). On both phones, open **Settings → Shared household**. The first user creates a household, copies the invitation code, and the second user signs in and joins using the code. Accounts use different emails.

The shopping list is shared after signing in. **Food inventory sharing is separate and opt-in**: after completing your imports, export a backup on your primary phone, then go to **Shared household → Share this phone's freezer, fridge and pantry**. This seeds one canonical household inventory. On the second phone, export a backup before selecting **Use shared freezer, fridge and pantry on this phone**, because that replaces its local food quantities and custom items. After both phones opt in, quantities, item additions/deletions, food names, units, dates and locations sync automatically; quantity adjustments are atomic to avoid overwriting simultaneous changes. **Recipes, favourites, weekly plans and recipe history stay personal**. When food stock is paused on one phone, that phone's inventory becomes local until re-enabled.

**Upgrade from v4.1 to v4.2 requires republishing Firestore Rules:** open your Firebase project → Firestore → Rules, replace the rules with the latest contents of [cloud/firestore.rules](cloud/firestore.rules) and tap Publish. The existing v4.1 rules do not permit inventory writes. Do not enable public allow-all rules.

Keep each account password private. The invite code permits joining; share it privately.

## APK updates — permanent signing identity

Android updates require the **same application ID and signing key** plus a nondecreasing version code. The app ID is fixed to `com.nikola.kitchen.forever`, and CI automatically increments version codes. The built-in **Check for updates** button checks GitHub Releases.

The first v4 APK is signed privately, with its signing keystore stored off GitHub. **Never put the unencrypted keystore or its password in a public repository.** The CI pipeline supports decrypting a copy of the encrypted keystore from `release-key/nikolas-release.jks.enc.b64` when the GitHub repository secret `NK_SIGNING_PASSWORD` has been set. Once configured, tagged version releases automatically publish signed APKs.

To release an update: change the version in `package.json`, commit your changes, then create a `vX.Y.Z` Git tag. The workflow builds and uploads a signed release APK. Within the installed app, tap **Check for updates** to find the download. Android still asks for installation approval, but it replaces the installed app while retaining its data.

**Important:** Earlier v1-v3 apps were built with different Android signing identities and cannot be upgraded in place. Export the old app's backup and import it into v4. After v4, updates signed with its permanent keystore can install over one another. Keep a separate safe backup of the signing key and password.

## Safety & testing

- Firestore enforces membership-only list access with email/password authentication. An unguessable invitation code allows a second account to join.
- Each device keeps a local copy and a durable pending-operations queue to send when reconnected.
- Both shopping data and inventory can be exported in the app's JSON backup. Treat exported backups as private.
- Cloud functionality requires a configured Firebase project and appropriate rules. End-to-end syncing must still be tested on both household phones.
- GitHub CI compiles the app. The CI-provided signing toolkit permits a private, stable first-time signature without exposing the key.

_Update signing: GitHub Actions verification requested after configuring the release password._
