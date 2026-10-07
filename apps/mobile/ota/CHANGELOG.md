# Changelog

## [1.57.4](https://github.com/Heey-Global/verity/compare/mobile-v1.57.3...mobile-v1.57.4) (2026-10-07)


### Features

* **mobile:** export update diagnostics from settings ([#1282](https://github.com/Heey-Global/verity/issues/1282)) ([b5046ab](https://github.com/Heey-Global/verity/commit/b5046ab5149546445ecd2294df688c65630f6637))

## [1.57.3](https://github.com/Heey-Global/verity/compare/mobile-v1.57.2...mobile-v1.57.3) (2026-10-07)


### Features

* **mobile:** add session favorites, swipe actions and context menu ([#1275](https://github.com/Heey-Global/verity/issues/1275)) ([4b5c745](https://github.com/Heey-Global/verity/commit/4b5c745650a691bcb8cd0d7f9792d055778ced93))
* **tasks:** quieter task surfaces, agent steps apart, bubble physics ([#1276](https://github.com/Heey-Global/verity/issues/1276)) ([f656a4b](https://github.com/Heey-Global/verity/commit/f656a4bf505c977d3fc30e5dcca6ffadd938018c))

## [1.57.2](https://github.com/Heey-Global/verity/compare/mobile-v1.57.1...mobile-v1.57.2) (2026-10-07)


### Bug Fixes

* **session:** improve knowledge retrieval and concise progress guidance ([#1269](https://github.com/Heey-Global/verity/issues/1269)) ([2e1d901](https://github.com/Heey-Global/verity/commit/2e1d9010663405cdb463c080868ec9074361fd18))

## [1.57.1](https://github.com/Heey-Global/verity/compare/mobile-v1.57.0...mobile-v1.57.1) (2026-10-07)


### Features

* **live:** replace app polling with shared socket updates ([#1262](https://github.com/Heey-Global/verity/issues/1262)) ([bff9df1](https://github.com/Heey-Global/verity/commit/bff9df116a8175ba29edc07b3c2ba0014213c99f))

## [1.56.1](https://github.com/Heey-Global/verity/compare/mobile-v1.56.0...mobile-v1.56.1) (2026-10-06)


### Bug Fixes

* **mobile:** display readable names for all Verity tools ([#1236](https://github.com/Heey-Global/verity/issues/1236)) ([3c59133](https://github.com/Heey-Global/verity/commit/3c591338826d0ba376fab95f5e52ef7c98e6118b))

## [1.54.3](https://github.com/Heey-Global/verity/compare/mobile-v1.54.2...mobile-v1.54.3) (2026-10-06)


### Features

* **tasks:** add durable task persistence and agent access ([#1226](https://github.com/Heey-Global/verity/issues/1226)) ([9f446ec](https://github.com/Heey-Global/verity/commit/9f446ec22f298a086db72803fca1403386075055))


### Bug Fixes

* **mobile:** match static folder breadcrumbs to explorer ([#1220](https://github.com/Heey-Global/verity/issues/1220)) ([31ced91](https://github.com/Heey-Global/verity/commit/31ced918a59f28a13fb54a3e4390943b4d2f79eb))

## [1.54.2](https://github.com/Heey-Global/verity/compare/mobile-v1.54.1...mobile-v1.54.2) (2026-10-06)


### Features

* **broker:** mediate GitHub sandbox traffic through HTTP secret broker ([#1204](https://github.com/Heey-Global/verity/issues/1204)) ([2ff5ca9](https://github.com/Heey-Global/verity/commit/2ff5ca92923fba2f989be248fcd907545c1ed990))
* **mobile:** compact issue and branch refs in header and overview ([#1215](https://github.com/Heey-Global/verity/issues/1215)) ([e50cf97](https://github.com/Heey-Global/verity/commit/e50cf975272444bf7aeb6e958a756baafb8885cc))
* **web:** ship browser client in Core Docker image ([#1216](https://github.com/Heey-Global/verity/issues/1216)) ([63bb411](https://github.com/Heey-Global/verity/commit/63bb411ecedce8c687a7025f43f9c1af57db2d4e))


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.7.0 ([#1194](https://github.com/Heey-Global/verity/issues/1194)) ([7669e6e](https://github.com/Heey-Global/verity/commit/7669e6e896454294b3d136875df25ac06370da76))

## [1.54.1](https://github.com/Heey-Global/verity/compare/mobile-v1.54.0...mobile-v1.54.1) (2026-10-06)


### Bug Fixes

* **mobile:** allow dismissing running server hints ([#1209](https://github.com/Heey-Global/verity/issues/1209)) ([35d3e90](https://github.com/Heey-Global/verity/commit/35d3e907b8d2c8f5ef08c1911c713ba6f79971a9))
* **planning:** avoid redundant tool approval for plan presentation ([#1205](https://github.com/Heey-Global/verity/issues/1205)) ([dd64496](https://github.com/Heey-Global/verity/commit/dd644967a88e63d431339724e27c84d2fd63ea54))

## [1.53.1](https://github.com/Heey-Global/verity/compare/mobile-v1.53.0...mobile-v1.53.1) (2026-10-05)


### Features

* **dev-servers:** manage session servers from Preview and chat ([#1175](https://github.com/Heey-Global/verity/issues/1175)) ([c8aa031](https://github.com/Heey-Global/verity/commit/c8aa03142ec51b3b454119c334a18ecc7bb186ec))
* **session:** add persistent planning with synchronized plan approvals ([#1163](https://github.com/Heey-Global/verity/issues/1163)) ([c774e2b](https://github.com/Heey-Global/verity/commit/c774e2b218b5fd54d65e7b436cf7ffa882a14d11))


### Bug Fixes

* **mobile:** even out preview cards and name running servers by state ([#1167](https://github.com/Heey-Global/verity/issues/1167)) ([310848f](https://github.com/Heey-Global/verity/commit/310848f2e209f57c95c683f5cce93bd79208a9f3))
* **mobile:** keep chat-enabled Google services scoped to the session ([#1171](https://github.com/Heey-Global/verity/issues/1171)) ([7df6fcb](https://github.com/Heey-Global/verity/commit/7df6fcb7676ce21cafcf988e84963e15556a532e))
* **mobile:** pin session row icons to the row's right edge ([#1166](https://github.com/Heey-Global/verity/issues/1166)) ([17c5a0d](https://github.com/Heey-Global/verity/commit/17c5a0d308b97f156c5fc21363c862de96527dd8))

## [1.52.7](https://github.com/Heey-Global/verity/compare/mobile-v1.52.6...mobile-v1.52.7) (2026-10-05)


### Features

* **mobile:** open a session's preview from its list row ([#1154](https://github.com/Heey-Global/verity/issues/1154)) ([c2bb622](https://github.com/Heey-Global/verity/commit/c2bb6222e42074df4d70efddda250aa1c4b319fe))

## [1.52.6](https://github.com/Heey-Global/verity/compare/mobile-v1.52.5...mobile-v1.52.6) (2026-10-05)


### Features

* **remote:** add correlated Core transport diagnostics ([#1150](https://github.com/Heey-Global/verity/issues/1150)) ([809a201](https://github.com/Heey-Global/verity/commit/809a201fe4553fdb8ea8da7183b2e9b844b9b220))

## [1.52.5](https://github.com/Heey-Global/verity/compare/mobile-v1.52.4...mobile-v1.52.5) (2026-10-05)


### ⚠ BREAKING CHANGES

* **sessions:** Session read acknowledgments require counterVersion dev-servers-excluded-v1. Older clients must update before marking sessions seen.

### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.6.0 ([#1137](https://github.com/Heey-Global/verity/issues/1137)) ([0667313](https://github.com/Heey-Global/verity/commit/0667313a9f9260a1b1c714531318e942de3d8773))
* **mobile:** explain both preview tabs in plain words ([#1144](https://github.com/Heey-Global/verity/issues/1144)) ([6b58371](https://github.com/Heey-Global/verity/commit/6b58371534e0571b42f81812d35915f79f45274a))
* **sessions:** exclude dev-server events from unread badges ([#1149](https://github.com/Heey-Global/verity/issues/1149)) ([7bc715b](https://github.com/Heey-Global/verity/commit/7bc715b5cbcebf81b346eac2f7ef7e5c3ded889e))

## [1.52.4](https://github.com/Heey-Global/verity/compare/mobile-v1.52.3...mobile-v1.52.4) (2026-10-04)


### Bug Fixes

* **deps:** update dependency @napi-rs/canvas to v1.0.10 ([#1135](https://github.com/Heey-Global/verity/issues/1135)) ([58a7580](https://github.com/Heey-Global/verity/commit/58a758028357f1a4d05029907bb432425d0d578a))

## [1.52.3](https://github.com/Heey-Global/verity/compare/mobile-v1.52.2...mobile-v1.52.3) (2026-10-04)


### Bug Fixes

* **mobile:** split preview into dev server and static file tabs ([#1128](https://github.com/Heey-Global/verity/issues/1128)) ([2a813a3](https://github.com/Heey-Global/verity/commit/2a813a31aad3734206fe8f645f2d8c5402730e04))

## [1.52.2](https://github.com/Heey-Global/verity/compare/mobile-v1.52.1...mobile-v1.52.2) (2026-10-04)


### Features

* **mobile:** brand Verity tool labels and name Verity CLI runs ([#1125](https://github.com/Heey-Global/verity/issues/1125)) ([856e2d6](https://github.com/Heey-Global/verity/commit/856e2d61e7f537d37f67bdad6ad625014bfea05b))


### Bug Fixes

* **mobile:** include staging prereleases in server changelog ([#1123](https://github.com/Heey-Global/verity/issues/1123)) ([41009e3](https://github.com/Heey-Global/verity/commit/41009e3a2452f5ec660186698ebcd0b99d234a62))
* **mobile:** separate Claude and Codex settings ([#1120](https://github.com/Heey-Global/verity/issues/1120)) ([715744d](https://github.com/Heey-Global/verity/commit/715744d789bc7d4d346fcfb3aacded26d0ecd911))
* **mobile:** show readable names for Verity gateway tools ([#1122](https://github.com/Heey-Global/verity/issues/1122)) ([d790cee](https://github.com/Heey-Global/verity/commit/d790ceee9c0afb562c6b39d02f075f572fcde394))

## [1.52.1](https://github.com/Heey-Global/verity/compare/mobile-v1.52.0...mobile-v1.52.1) (2026-10-04)


### Features

* **automations:** attach recurring automations to sessions ([#1097](https://github.com/Heey-Global/verity/issues/1097)) ([e1dc7eb](https://github.com/Heey-Global/verity/commit/e1dc7eb9b82d5ac39f0e0b1b8e6e9c643b9c0b76))
* **matrix:** expose import failures to Control and room status ([#1112](https://github.com/Heey-Global/verity/issues/1112)) ([90db73c](https://github.com/Heey-Global/verity/commit/90db73cb77b94001b7a52190e1b44a5d6a936ee9))
* **mobile:** version staging OTA releases through Release Please PRs ([#1115](https://github.com/Heey-Global/verity/issues/1115)) ([80a15be](https://github.com/Heey-Global/verity/commit/80a15be8c3637af9efa9873f8774367647da0fcf))
* **preview:** separate target selection from preview access ([#1101](https://github.com/Heey-Global/verity/issues/1101)) ([073384d](https://github.com/Heey-Global/verity/commit/073384d4fcec9933041d37d7c60c93fcdbca453c))


### Bug Fixes

* **automation:** default schedules to the user's time zone ([#1117](https://github.com/Heey-Global/verity/issues/1117)) ([f9a6844](https://github.com/Heey-Global/verity/commit/f9a684430b83f6df2b3181815bbf62f2b0dafc03))
* **mobile:** center session name and branch in header ([#1103](https://github.com/Heey-Global/verity/issues/1103)) ([d2d0767](https://github.com/Heey-Global/verity/commit/d2d0767f686fc753d4b86a696adf6e3ba214c37d))
* **mobile:** open message actions as a menu anchored to the "…" button ([#1110](https://github.com/Heey-Global/verity/issues/1110)) ([dabe408](https://github.com/Heey-Global/verity/commit/dabe4087e7f0a8fed15319036d88d4b75298b11b))
* **mobile:** restore direct Google access shortcuts ([#1106](https://github.com/Heey-Global/verity/issues/1106)) ([c54e521](https://github.com/Heey-Global/verity/commit/c54e5211c71674985012e0acf8de02c1f6c9341c))
* **mobile:** restore the welcome screen with a subtle demo link ([#1096](https://github.com/Heey-Global/verity/issues/1096)) ([c692e6e](https://github.com/Heey-Global/verity/commit/c692e6e420517ff18689215d48fe468715900ea1))
* **mobile:** show a clean empty state for an unconnected Drive tab ([#1113](https://github.com/Heey-Global/verity/issues/1113)) ([2cdfafb](https://github.com/Heey-Global/verity/commit/2cdfafbf19fedd651aa5b4ac1dabfff0fad7e44b))
* **mobile:** show GitHub's pending merge test instead of a dead merge button ([#1105](https://github.com/Heey-Global/verity/issues/1105)) ([94600b1](https://github.com/Heey-Global/verity/commit/94600b1c8a15a35dff395fad8c92558a438dc09d))
* **mobile:** simplify empty session starter cards ([#1108](https://github.com/Heey-Global/verity/issues/1108)) ([9e8c7a2](https://github.com/Heey-Global/verity/commit/9e8c7a27c990b8e0324d09a20636489d68c74aa9))
* **mobile:** simplify Matrix settings and expose connector errors ([#1102](https://github.com/Heey-Global/verity/issues/1102)) ([713ecb4](https://github.com/Heey-Global/verity/commit/713ecb41b3be9966171940fc32f65b8a69e0c4c9))
* preserve read sessions across restarts and separate update channel settings ([#1111](https://github.com/Heey-Global/verity/issues/1111)) ([1a688a4](https://github.com/Heey-Global/verity/commit/1a688a495520f110e4c841b477bd6c8b55220f37))
* **preview:** allow local connector transport and clarify opening actions ([#1090](https://github.com/Heey-Global/verity/issues/1090)) ([a59dc7d](https://github.com/Heey-Global/verity/commit/a59dc7db4e420f479c5278ca548e0963eeb452e0))
* **session:** recognize model-specific usage limit refusals ([#1099](https://github.com/Heey-Global/verity/issues/1099)) ([e3068db](https://github.com/Heey-Global/verity/commit/e3068dbee38b23be5c218e0b61c74b0163e58da4))

## Staging OTA changelog

Release Please records each version published to Staging here. Production promotes the same version.
