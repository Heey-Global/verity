# Changelog

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
