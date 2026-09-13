# Changelog

## [1.29.0](https://github.com/Heey-Global/verity/compare/mobile-v1.28.0...mobile-v1.29.0) (2026-09-13)


### Features

* **mcp:** support OAuth connections ([#225](https://github.com/Heey-Global/verity/issues/225)) ([181b277](https://github.com/Heey-Global/verity/commit/181b277eb33371270388e3bc7def4bb417c79821))


### Bug Fixes

* **deps:** update dependency react-native-qrcode-svg to v6.3.24 ([#232](https://github.com/Heey-Global/verity/issues/232)) ([0770303](https://github.com/Heey-Global/verity/commit/0770303c19e3cfbc8e35bf75655c843d6437d71d))
* **mobile:** authorize GitHub HTTPS callbacks ([#227](https://github.com/Heey-Global/verity/issues/227)) ([ae00382](https://github.com/Heey-Global/verity/commit/ae003829defb4ddfb2b7fc389eed13ddc9c7e963))
* **mobile:** let the GitHub authorization sheet actually present ([#223](https://github.com/Heey-Global/verity/issues/223)) ([03d96f3](https://github.com/Heey-Global/verity/commit/03d96f32b1ad3d4434dc0c5175d91d556dc23f06))

## [1.28.0](https://github.com/Heey-Global/verity/compare/mobile-v1.27.0...mobile-v1.28.0) (2026-09-12)


### Bug Fixes

* **deps:** update dependency expo to v57.0.21 ([75cc4f7](https://github.com/Heey-Global/verity/commit/75cc4f77db4635aa2929a1d3e5219c5cd7ef1a7f))
* **mobile:** report an authorization sheet that never opened ([cfacc9c](https://github.com/Heey-Global/verity/commit/cfacc9cf2cd353923f343212bfab7ac39332a0c4))
* **mobile:** stop the GitHub connect button failing silently ([f4df578](https://github.com/Heey-Global/verity/commit/f4df5787b41eef19dca7312217791ad9b3d2b70d))
* **mobile:** surface GitHub authorization startup ([542bea4](https://github.com/Heey-Global/verity/commit/542bea459bae8f63a3632ecce65c4cd6c55c6e27))

## [1.27.0](https://github.com/Heey-Global/verity/compare/mobile-v1.26.0...mobile-v1.27.0) (2026-09-11)


### Features

* **mcp:** add project-scoped HTTP proxy connections ([2d1e270](https://github.com/Heey-Global/verity/commit/2d1e2703118214f313c958064109855d1ac38350))
* **settings:** manage OpenCode centrally ([8aa3d00](https://github.com/Heey-Global/verity/commit/8aa3d00c6cddec9b86c0217a7ef50ea167cd4c66))


### Bug Fixes

* **deps:** update dependency react-native-qrcode-svg to v6.3.23 ([3b62a12](https://github.com/Heey-Global/verity/commit/3b62a126bac681815b0c717e1fe5ebdbefb1aeee))
* **github:** route organization setup through public bridge ([1ce4932](https://github.com/Heey-Global/verity/commit/1ce4932bc11576404d9c4b2231a40cc018673ec5))
* **mcp:** address proxy review findings ([e71215d](https://github.com/Heey-Global/verity/commit/e71215d338ee9bca42fef7e99e96fdca782210c5))
* **mcp:** bound event stream resources ([c3b521a](https://github.com/Heey-Global/verity/commit/c3b521a8c16979c4bb8a5b2389799c07a3c98022))
* **mcp:** enforce connection lifecycle invariants ([f7ae2bc](https://github.com/Heey-Global/verity/commit/f7ae2bcde84c0bc021db289d42d7e97cca248230))
* **mcp:** guard mobile connection refreshes ([2c24afc](https://github.com/Heey-Global/verity/commit/2c24afc7db4913c045d16d1d360dd4157a696923))
* **mcp:** handle proxy and settings races ([1677fd7](https://github.com/Heey-Global/verity/commit/1677fd7a566b431e2d0d9c1679ed246949cd4ab8))
* **mcp:** invalidate stale loads on deletion ([c201234](https://github.com/Heey-Global/verity/commit/c201234ac05b1036ab3eb51d0eb1946786780276))
* **mcp:** preserve failed catalog mutations ([dff59d1](https://github.com/Heey-Global/verity/commit/dff59d1b3cebb348a9aa99bf3430e082a239daa0))
* **mcp:** refresh catalog and normalize streams ([8e806e9](https://github.com/Heey-Global/verity/commit/8e806e91bdcf2f0735cbae533157716a457c24ec))
* **mcp:** serialize mobile connection mutations ([93cf8b2](https://github.com/Heey-Global/verity/commit/93cf8b22edeec34ac1455ccdac8bc0528bbee98e))
* **mobile:** complete GitHub setup in auth session ([7b0082d](https://github.com/Heey-Global/verity/commit/7b0082d59903123a8e4696bfa024e22bf7e2fc50))
* **settings:** preserve secrets across async autosave ([6c1b990](https://github.com/Heey-Global/verity/commit/6c1b9904fc303ae0b17c1721f67758dad68340df))

## [1.26.0](https://github.com/Heey-Global/verity/compare/mobile-v1.25.0...mobile-v1.26.0) (2026-09-10)


### Bug Fixes

* **mobile:** clear stale pairing after reinstall ([9a39aba](https://github.com/Heey-Global/verity/commit/9a39aba9828dae48efd975bf935ecfb0176ac931))

## [1.25.0](https://github.com/Heey-Global/verity/compare/mobile-v1.24.0...mobile-v1.25.0) (2026-09-10)


### Bug Fixes

* **github:** return manifest callbacks through the app ([768e5c0](https://github.com/Heey-Global/verity/commit/768e5c0fe74110ce6de2c752be9d73c61d38f912))
* **website:** harden GitHub App bridge ([9eb6f6c](https://github.com/Heey-Global/verity/commit/9eb6f6cefd3c32c0b9698ef7a4ac5168d00e0050))

## [1.24.0](https://github.com/Heey-Global/verity/compare/mobile-v1.23.0...mobile-v1.24.0) (2026-09-09)


### Bug Fixes

* **mobile:** let pinned servers bypass ATS ([63d6f3c](https://github.com/Heey-Global/verity/commit/63d6f3c2c393cb15cf39f2ee015693440d482fac))

## [1.23.0](https://github.com/Heey-Global/verity/compare/mobile-v1.22.0...mobile-v1.23.0) (2026-09-09)


### Bug Fixes

* **mobile:** trust the pinned server chain on iOS ([e2deb2c](https://github.com/Heey-Global/verity/commit/e2deb2cf924bfea93b00829f4db0b930704e52fd))

## [1.22.0](https://github.com/Heey-Global/verity/compare/mobile-v1.21.0...mobile-v1.22.0) (2026-09-09)


### Bug Fixes

* **deps:** update dependency expo to v57.0.20 ([33bc7a1](https://github.com/Heey-Global/verity/commit/33bc7a11cc23054cfac080006dbbefeea3a1de90))
* **deps:** update dependency react-native-qrcode-svg to v6.3.22 ([6cdf57e](https://github.com/Heey-Global/verity/commit/6cdf57e7527a1fadcfdfaff497b61b1de557ff55))
* **mobile:** anchor the pinned server leaf ([b2a37e1](https://github.com/Heey-Global/verity/commit/b2a37e111ec23f64cdd4668b77f7f301dbdeab57))

## [1.21.0](https://github.com/Heey-Global/verity/compare/mobile-v1.20.0...mobile-v1.21.0) (2026-09-09)


### Bug Fixes

* **mobile:** trust exact server key pins ([6c85273](https://github.com/Heey-Global/verity/commit/6c85273c15f572a268258c430b350bf2536cf6b3))

## [1.20.0](https://github.com/Heey-Global/verity/compare/mobile-v1.19.0...mobile-v1.20.0) (2026-09-08)


### Bug Fixes

* **mobile:** preserve pinned transport errors ([88e25e6](https://github.com/Heey-Global/verity/commit/88e25e6b6a1bf6a062badcd535b7feaf7f1d92f2))
* **mobile:** preserve pinned transport errors ([e2b4b82](https://github.com/Heey-Global/verity/commit/e2b4b82c1e71372973d34d32209c577007814698))

## [1.19.0](https://github.com/Heey-Global/verity/compare/mobile-v1.18.0...mobile-v1.19.0) (2026-09-08)


### Bug Fixes

* **mobile:** expose generic Apple TLS diagnostics ([ff9e636](https://github.com/Heey-Global/verity/commit/ff9e63637391b241d3b4f8b7606b56d48ee62214))
* **mobile:** expose pinned TLS diagnostics ([cee8db5](https://github.com/Heey-Global/verity/commit/cee8db527c8cd42097fa633724186618ec4ae3c2))
* **pairing:** use a local CA certificate chain ([3e6f746](https://github.com/Heey-Global/verity/commit/3e6f7468fe3eb463ff140f50a1389e8c65e4a190))

## [1.18.0](https://github.com/Heey-Global/verity/compare/mobile-v1.17.0...mobile-v1.18.0) (2026-09-08)


### Bug Fixes

* **mobile:** normalize iOS certificate pin keys ([9dba864](https://github.com/Heey-Global/verity/commit/9dba86450a5fda28197d8ee29779c398e2651e5a))

## [1.17.0](https://github.com/Heey-Global/verity/compare/mobile-v1.16.0...mobile-v1.17.0) (2026-09-08)


### Bug Fixes

* **mobile:** trust the pinned self-signed certificate ([89bd742](https://github.com/Heey-Global/verity/commit/89bd742c7e873953e0080a47f56d9f48ee724bf3))
* **mobile:** trust the pinned self-signed certificate ([f6bf01e](https://github.com/Heey-Global/verity/commit/f6bf01efcec0328b4dcea58e3d43ca0f4e4f82a5))

## [1.16.0](https://github.com/Heey-Global/verity/compare/mobile-v1.15.0...mobile-v1.16.0) (2026-09-07)


### Features

* **mobile:** allow pasting installer pairing code ([6661cae](https://github.com/Heey-Global/verity/commit/6661cae8bf36f284debddd6f1c2a572672c37068))
* **mobile:** allow pasting installer pairing code ([51a1296](https://github.com/Heey-Global/verity/commit/51a1296864c51b37ab3621b386840e8eb267d2d8))
* **slides:** edit assigned decks from sessions ([069d84c](https://github.com/Heey-Global/verity/commit/069d84c1af8b49b14d9b452a5d5f83aeaee9e6d9))
* **slides:** edit assigned decks from sessions ([17e9db2](https://github.com/Heey-Global/verity/commit/17e9db2c36dcfc5cbb08ca548d1e0aec60481ae6))


### Bug Fixes

* **mobile:** handle pinned TLS pairing challenges ([5e64a80](https://github.com/Heey-Global/verity/commit/5e64a80a55ac0a9c481bb111e51c9761c067a083))
* **onboarding:** align and separate pairing steps ([e2eedf7](https://github.com/Heey-Global/verity/commit/e2eedf74b2c34d8a5278810102889392aa29a6f6))
* **onboarding:** align and separate pairing steps ([9b0a82a](https://github.com/Heey-Global/verity/commit/9b0a82a605b639216f0da229ec05990be9fd2ba0))

## [1.15.0](https://github.com/Heey-Global/verity/compare/mobile-v1.14.0...mobile-v1.15.0) (2026-09-02)


### Features

* **pairing:** add secure device onboarding ([6c89bb0](https://github.com/Heey-Global/verity/commit/6c89bb0b32c4c05db79704135191cccbbb7df98f))
* **pairing:** add secure device onboarding ([86efbf4](https://github.com/Heey-Global/verity/commit/86efbf46d674e04a0f8476b7c0378b1be29f3738))


### Bug Fixes

* **auth:** ignore legacy token cleanup failures ([64faa59](https://github.com/Heey-Global/verity/commit/64faa59e425a341ae362a07e1a15aee355e7ad5b))
* **pairing:** bind enrollment retries to clients ([0dd1ffd](https://github.com/Heey-Global/verity/commit/0dd1ffd1e6a7ce9020d76dc2f7f5b5dc8b8faa7e))
* **pairing:** hide expired invitations ([c2c6eda](https://github.com/Heey-Global/verity/commit/c2c6eda23c5f86e00f9e2e25ea62e8089a49bb6c))
* **pairing:** latch duplicate QR scans ([106e83c](https://github.com/Heey-Global/verity/commit/106e83c1bfddce810771bfe5a77de2e069c11278))
* **pairing:** preserve recoverable enrollment state ([bbb3e81](https://github.com/Heey-Global/verity/commit/bbb3e816dc14cdb5d5767b4e1e01485191bde1f0))
* **pairing:** recover enrollment across restarts ([57014e5](https://github.com/Heey-Global/verity/commit/57014e55ff76cd0c3a2cf7de65fc063422538f1a))
* **pairing:** require durable device credentials ([9a1fe1a](https://github.com/Heey-Global/verity/commit/9a1fe1a144129ee315f3f3df333ae0bc8d8cf2cd))

## [1.14.0](https://github.com/Heey-Global/verity/compare/mobile-v1.13.0...mobile-v1.14.0) (2026-09-02)


### Bug Fixes

* **release:** target Verity App Store record ([#29](https://github.com/Heey-Global/verity/issues/29)) ([73f2d43](https://github.com/Heey-Global/verity/commit/73f2d43162cc39bb86deb639b21ef0dbcff5ab28))

## [1.13.0](https://github.com/Heey-Global/verity/compare/mobile-v1.12.0...mobile-v1.13.0) (2026-08-31)


### Features

* port source update a417cd4 ([20eb25b](https://github.com/Heey-Global/verity/commit/20eb25b89a9f5e2bba35fd5d8c7fa5aa8bcda0ce))
* port source update a417cd4 ([eb4029a](https://github.com/Heey-Global/verity/commit/eb4029a09a5d867fd70f062714dee211ad6e42c8))

## [1.12.0](https://github.com/Heey-Global/verity/compare/mobile-v1.11.0...mobile-v1.12.0) (2026-08-31)


### Features

* import Verity public source snapshot ([b6df3cd](https://github.com/Heey-Global/verity/commit/b6df3cdc1ff9f298de8cf04277aad9e2d9644ce3))
* publish Verity public source snapshot ([eb54199](https://github.com/Heey-Global/verity/commit/eb541995dae084c04d97b7eb1c050855a611c823))


### Bug Fixes

* harden imported Verity source snapshot ([d2868bb](https://github.com/Heey-Global/verity/commit/d2868bb6396cb2ba4923a1db60f957db10efb603))

## Mobile changelog

Public Verity mobile release history starts with this repository. Earlier
private development history is intentionally not published.
