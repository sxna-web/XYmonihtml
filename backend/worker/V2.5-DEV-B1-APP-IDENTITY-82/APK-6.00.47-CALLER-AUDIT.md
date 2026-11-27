# APP 6.00.47 source-level caller audit — Batch 82

- Batch: `V2.5-DEV-B1-APP-IDENTITY-82`
- Source archive: Library file `StarJump-6.00.47-source.zip`
- Size: 2,377,487 bytes
- SHA-256: `5a45da3d6e6e42a6aabf776336fdfff8424af0e9c7d756a8fea17f882459f7ab`
- ZIP integrity: `testzip() = None`; 745 archive entries; extracted successfully.
- Source tree: 163 Kotlin files, 26 Java files, 503 relevant text/config/doc files; 622 extracted files total.
- App metadata: package `com.starjump.client`; versionName `6.00.47`; metadata VERSION_CODE=70 and build helper multiplies by 5, so configured Android versionCode is 350.
- Scope limitation: this is the inspected 6.00.47 source archive, not proof of the installed APK or later 6.00.48 source. Repository tree contains a `StarJump-6.00.48-source.zip` entry, but that binary was not readable through the repository text interface in this batch; the Library search returned the 6.00.47 archive.

## 1. Result summary

No direct APP source callsites were found for the legacy Worker endpoints:

- `/api/app/resolve`
- `/api/app/groups`
- `/api/app/free`
- `/api/app/links`
- `/api/app/redeem`
- `/api/app/status`
- `/api/app/nodes`
- `/api/user/share-code`
- `/api/super/admins/:id/share-code`

No direct callsites were found for the proposed membership API routes:

- `/v1/device/bootstrap`
- `/v1/license/activate`
- `/v1/license/status`
- `/v1/catalog/resolve`
- `/v1/license/deactivate`

The only occurrences of those v1 route strings and terms such as entitlement/challenge/nonce/share-code in the inspected source tree are in `STARJUMP-BACKEND-AND-MEMBERSHIP-SPEC.md`, a design document. They are not implemented network calls.

This establishes a source-level gap for this archive: APP identity discovery, card activation, device binding, status and entitlement-scoped catalog retrieval are not wired into the inspected app source.

## 2. Actual network request surfaces found

| Source | Observed request | Purpose / boundary |
|---|---|---|
| `app/src/main/java/io/nekohasekai/sagernet/group/RawUpdater.kt` | `Libcore.newHttpClient().newRequest().setURL(endpoint).execute()` | Downloads user-entered subscription URLs and the built-in StarJump reference feed; not a StarJump identity API |
| `app/src/main/java/io/nekohasekai/sagernet/ui/AssetsActivity.kt` | GitHub Releases API and release asset URL | Fetches optional assets/releases; not membership authorization |
| `app/src/main/java/io/nekohasekai/sagernet/bg/SubscriptionUpdater.kt` | Schedules refreshes through `GroupUpdater/RawUpdater` | Background subscription refresh, not identity API |
| `app/src/main/java/io/nekohasekai/sagernet/ui/WebviewFragment.kt` | Loads configurable local YACD URL | Local controller UI; not StarJump account or card flow |

No Retrofit, OkHttp Request.Builder-based StarJump API client, Bearer entitlement token, Authorization header, APP card activation request, or APP identity persistence path was found in the scanned Kotlin/Java source.

The app's generic subscription engine accepts configured subscription URLs. This is not equivalent to the proposed backend-only upstream architecture.

## 3. StarJump-specific behavior that is implemented

### 3.1 Five reserved local groups

- `ReferenceSubscription.kt` defines five built-in slots named `星跃节点 01` through `星跃节点 05`.
- `AutoNodeStartup.kt` calls `ReferenceSubscription.ensureGroups()` on startup and refreshes only configured built-in sources.
- `RawUpdater.kt` obtains the built-in source URL from the APK's compiled slot constants; it does not call the Worker identity/catalog API.
- Only slot 01 has a configured HTTPS upstream in this archive. Slots 02–05 are literal placeholders and are skipped because `sourceUrlFor()` returns null for non-HTTPS placeholders.
- The upstream host is embedded in the APK source. The full feed URL is intentionally omitted from this report.

### 3.2 Membership design is documentation only

`STARJUMP-BACKEND-AND-MEMBERSHIP-SPEC.md` describes future `/v1/*` APIs, short-lived tokens, nonce, device binding, card activation and signed catalog payloads. No corresponding app request client or callsite was found. Treat this file as an unimplemented design note, not a working integration.

## 4. Deep-link and import behavior

The manifest exports `MainActivity` and registers browsable VIEW filters for:
- `sn://subscription`
- `clash://install-config`
- common proxy profile schemes such as `ss`, `vmess`, `trojan`, `hysteria` and related formats.

`MainActivity.onNewIntent()` dispatches subscription/config imports and profile imports. The subscription import path accepts a `url` query parameter and stores it as a normal subscription. No StarJump identity ID, card code, binding challenge or dedicated StarJump account deep link is implemented in this archive.

These are normal import entry points. They must not be reused as authentication proof or treated as the APP's future identity-binding callback without a separate protocol and validation layer.

## 5. Device identity and local storage

- No use of Android ID, serial number, stable device ID, device public-key proof, APP entitlement token, card credential or identity-binding record was found in the app source scan.
- `NGUtil.getUuid()` generates a random UUID utility, but the inspected source has no callsite for it; it is not evidence of a device identity system.
- The app stores configuration and profile state through Room-backed stores; no APP identity token store was found.
- Manifest sets `android:allowBackup="true"`; backup rules include the profile database and configuration database for cloud backup/device transfer.
- Since no identity secret is implemented here, this is not evidence of a currently backed-up APP token. For future device-bound credentials, do not store private keys or reusable device proofs in backup-eligible Room/DataStore databases. Use Android Keystore-backed non-exportable keys, explicitly exclude any sensitive credential material from backup/device transfer, and design restore as a fresh device-binding decision.

## 6. Consequences for APP v2 adapter work

1. Do not register APP v2 endpoints and assume this APK will call them.
2. Keep APP v2 feature flag OFF until an explicit client protocol implementation and integration test exist.
3. Preserve legacy imports and normal user subscription behavior; they are not identity endpoints.
4. Build a separate client API module with HTTPS, short-lived access token handling, nonce/replay defense and signed catalog verification only after the server contract and user decisions are frozen.
5. Device identity should be generated and held by Android Keystore; device slot count and binding lifecycle remain server-authoritative.
6. A source-level search is not a runtime packet capture. Dynamic native code, external plugins, server-delivered content or later source revisions may add behavior; this audit is limited to the inspected source archive.

## 7. Third-party and distribution note

The archive README identifies the project as a personal fork of NekoBoxForAndroid; the source includes a GPL-3.0 LICENSE and states upstream rights/trademarks remain with their owners. This is not a complete license-compliance opinion. Before commercial redistribution, inventory all source/native dependencies, plugins and bundled assets, preserve required notices/source-offer obligations, and separately review trademark/branding permissions and each dependency's license.

## 8. Evidence and limits

- Archive SHA-256 above is the identity of the inspected ZIP.
- Static searches covered Kotlin/Java/XML/config/document files in the extracted archive.
- No APK binary was installed or dynamically instrumented.
- No network traffic capture, backend access, D1 connection or production operation occurred.
- The 6.00.48 archive was not source-inspected in this batch.
