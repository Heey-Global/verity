# Changelog

## [1.80.4](https://github.com/Heey-Global/verity/compare/mobile-v1.80.3...mobile-v1.80.4) (2026-10-29)


### Features

* **assistant:** add the Verity assistant as a Verity Control function ([#2048](https://github.com/Heey-Global/verity/issues/2048)) ([2a1fd31](https://github.com/Heey-Global/verity/commit/2a1fd319d3e0bd3db35a8ac4eb1a93708d878a7b))
* **logs:** list individual audit and system events ([#2052](https://github.com/Heey-Global/verity/issues/2052)) ([be666a4](https://github.com/Heey-Global/verity/commit/be666a482aaf6420c1dc9e57a82d30a0217af25e))
* **qa:** add opt-in CI supervision and repair coordination ([#2040](https://github.com/Heey-Global/verity/issues/2040)) ([0ccdfbf](https://github.com/Heey-Global/verity/commit/0ccdfbf17a7723aef3936fc4c0ee4d1fd6859447))


### Bug Fixes

* **mobile:** distinguish missing sessions in history errors ([#2050](https://github.com/Heey-Global/verity/issues/2050)) ([828d19c](https://github.com/Heey-Global/verity/commit/828d19c2463bb9079e287714481ca4a6a18b3602))
* **mobile:** improve task microphone gestures and docking ([#2034](https://github.com/Heey-Global/verity/issues/2034)) ([b2afa35](https://github.com/Heey-Global/verity/commit/b2afa35b2df8a738cd3e208b78693f1c09a00bcc))
* **mobile:** preserve selection evidence in diagnostic exports ([#2051](https://github.com/Heey-Global/verity/issues/2051)) ([60b8fb9](https://github.com/Heey-Global/verity/commit/60b8fb940a35b703085cb469f2f147a84aa82495))

## [1.80.3](https://github.com/Heey-Global/verity/compare/mobile-v1.80.2...mobile-v1.80.3) (2026-10-29)


### Features

* **logs:** link build diagnostics with audit and system logs ([#2031](https://github.com/Heey-Global/verity/issues/2031)) ([8f3a05e](https://github.com/Heey-Global/verity/commit/8f3a05ea6a93ed4036ce20eae7a34f7156d7a5be))
* **mobile:** add selection scheduling diagnostics ([#2023](https://github.com/Heey-Global/verity/issues/2023)) ([86c07c2](https://github.com/Heey-Global/verity/commit/86c07c25975201ecb8ad7aea006240639a337f3b))


### Bug Fixes

* **settings:** refine feature order and simplify footer ([#2021](https://github.com/Heey-Global/verity/issues/2021)) ([8fe5dc8](https://github.com/Heey-Global/verity/commit/8fe5dc8e8a9bb5a8f62259ad59550ab2a788dfb3))

## [1.80.2](https://github.com/Heey-Global/verity/compare/mobile-v1.80.1...mobile-v1.80.2) (2026-10-28)


### Features

* **backup:** add encrypted local backups and installer recovery ([#1975](https://github.com/Heey-Global/verity/issues/1975)) ([6d5bc40](https://github.com/Heey-Global/verity/commit/6d5bc40184649e6eeb47f0d519a4ef1e36558379))


### Bug Fixes

* **history:** recover oversized events in bounded chunks ([#2007](https://github.com/Heey-Global/verity/issues/2007)) ([91411a7](https://github.com/Heey-Global/verity/commit/91411a70ccf61236f8171e092f29393717c2fa3b))
* **settings:** group features and app administration settings ([#2005](https://github.com/Heey-Global/verity/issues/2005)) ([82332ff](https://github.com/Heey-Global/verity/commit/82332ffe4eccf6517fc3777c789e070eba41dcb0))

## [1.80.1](https://github.com/Heey-Global/verity/compare/mobile-v1.80.0...mobile-v1.80.1) (2026-10-27)


### Features

* **audit:** add administrator logs for project image operations ([#1977](https://github.com/Heey-Global/verity/issues/1977)) ([3ef0ba7](https://github.com/Heey-Global/verity/commit/3ef0ba792b9ca14728e8df2effac2362c12d9a2a))
* **server:** derive a meeting result after a live meeting ends ([#1978](https://github.com/Heey-Global/verity/issues/1978)) ([06aa780](https://github.com/Heey-Global/verity/commit/06aa780a57f9b478f70143b1319b7a3d9b667759))


### Bug Fixes

* **mobile:** steady the iPad meeting column before and during the transcript ([#1972](https://github.com/Heey-Global/verity/issues/1972)) ([b665b63](https://github.com/Heey-Global/verity/commit/b665b636e5a19440ca61e4284582c115c53c8bdf))
* **server:** revalidate execution and provider authority ([#1971](https://github.com/Heey-Global/verity/issues/1971)) ([ceb7048](https://github.com/Heey-Global/verity/commit/ceb7048d36f2d5bb0ee542e45e4d5ceca04ac4dd))
* **web:** render inline images and readable code blocks ([#1973](https://github.com/Heey-Global/verity/issues/1973)) ([53e9e16](https://github.com/Heey-Global/verity/commit/53e9e165b648dba575b2a3f6ed8d9e54a3b460f2))

## [1.79.3](https://github.com/Heey-Global/verity/compare/mobile-v1.79.2...mobile-v1.79.3) (2026-10-26)


### Bug Fixes

* **deps:** update agent clis ([#1940](https://github.com/Heey-Global/verity/issues/1940)) ([6e6280b](https://github.com/Heey-Global/verity/commit/6e6280b9997e80c7cd27e0af69d3be34672073ef))

## [1.79.2](https://github.com/Heey-Global/verity/compare/mobile-v1.79.1...mobile-v1.79.2) (2026-10-26)


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v2.0.1 ([#1922](https://github.com/Heey-Global/verity/issues/1922)) ([37270b9](https://github.com/Heey-Global/verity/commit/37270b91b56b5abe17e9d26acaeeda1f6c48ddb0))
* **deps:** update dependency expo-server-sdk to v8 ([#1925](https://github.com/Heey-Global/verity/issues/1925)) ([d792523](https://github.com/Heey-Global/verity/commit/d792523f7012482160477274d6f78e8b49880a87))
* **vulnerabilities:** group findings and overview counts by package ([#1929](https://github.com/Heey-Global/verity/issues/1929)) ([d1fb6b4](https://github.com/Heey-Global/verity/commit/d1fb6b49accd6b727aad557651a38613ce86c557))

## [1.79.1](https://github.com/Heey-Global/verity/compare/mobile-v1.79.0...mobile-v1.79.1) (2026-10-25)


### Features

* **documents:** publish session documents automatically without Git ([#1841](https://github.com/Heey-Global/verity/issues/1841)) ([3f99d75](https://github.com/Heey-Global/verity/commit/3f99d75647ab06e319d122058a170773f965d693))


### Bug Fixes

* **merge:** respect credential permissions and prevent unsafe repair turns ([#1900](https://github.com/Heey-Global/verity/issues/1900)) ([d11ae75](https://github.com/Heey-Global/verity/commit/d11ae754228e2bfc4bd47c908e9aa0e22f22227e))
* **mobile:** defer auxiliary session catalog requests ([#1913](https://github.com/Heey-Global/verity/issues/1913)) ([be4c235](https://github.com/Heey-Global/verity/commit/be4c235d21bd438b1db0d5cd8f2349fc097bfa54))
* **mobile:** frame Google account choices as tappable rows ([#1911](https://github.com/Heey-Global/verity/issues/1911)) ([1823178](https://github.com/Heey-Global/verity/commit/18231780049446e08286094c9aa7837e236b0e29))
* **mobile:** invalidate Google actions when leaving a chat ([#1916](https://github.com/Heey-Global/verity/issues/1916)) ([4711bdf](https://github.com/Heey-Global/verity/commit/4711bdffa83af7bfa02e155cb01b09c68f916213))
* **mobile:** preserve text field focus when showing focus shadow ([#1914](https://github.com/Heey-Global/verity/issues/1914)) ([8d1ea99](https://github.com/Heey-Global/verity/commit/8d1ea994b6eb43f1d52bf6d7e994ec9214f458d5))
* **mobile:** restore connection provider icons and consistent statuses ([#1915](https://github.com/Heey-Global/verity/issues/1915)) ([767b852](https://github.com/Heey-Global/verity/commit/767b85289b1c4ff60c208383b8faf5bee5822c6c))
* **mobile:** restrict scroll reports to diagnostic recording ([#1908](https://github.com/Heey-Global/verity/issues/1908)) ([1b43130](https://github.com/Heey-Global/verity/commit/1b43130cdf9d69e932a90624fd0ecb0a76340502))

## [1.77.6](https://github.com/Heey-Global/verity/compare/mobile-v1.77.5...mobile-v1.77.6) (2026-10-24)


### Features

* **mobile:** attribute auxiliary requests and native invocation timing ([#1871](https://github.com/Heey-Global/verity/issues/1871)) ([d636f3c](https://github.com/Heey-Global/verity/commit/d636f3cec564d343337db3d720dc79caa3e7ba76))


### Bug Fixes

* **security:** classify and group vulnerability scan findings ([#1870](https://github.com/Heey-Global/verity/issues/1870)) ([d55f2bf](https://github.com/Heey-Global/verity/commit/d55f2bfb3d7f189dbf7f83d82efdcae50c3e0b9b))

## [1.77.5](https://github.com/Heey-Global/verity/compare/mobile-v1.77.4...mobile-v1.77.5) (2026-10-24)


### Bug Fixes

* **deps:** patch body-parser and ctutils vulnerabilities ([#1866](https://github.com/Heey-Global/verity/issues/1866)) ([3cf1c65](https://github.com/Heey-Global/verity/commit/3cf1c65e20978b8035f00d66767f68e7394c7b8e))
* **mobile:** preserve recording arming after admission completes ([#1865](https://github.com/Heey-Global/verity/issues/1865)) ([d2d9814](https://github.com/Heey-Global/verity/commit/d2d98140930e4b48cc3b1f733720953bcc2529b4))

## [1.77.4](https://github.com/Heey-Global/verity/compare/mobile-v1.77.3...mobile-v1.77.4) (2026-10-24)


### Features

* **security:** expose scoped vulnerability scans to agents ([#1854](https://github.com/Heey-Global/verity/issues/1854)) ([6e789f9](https://github.com/Heey-Global/verity/commit/6e789f95e655d1bb77104b38cb2096208c00cdcb))


### Bug Fixes

* **mobile:** expose local connection test failure receipts ([#1860](https://github.com/Heey-Global/verity/issues/1860)) ([8d6cbe2](https://github.com/Heey-Global/verity/commit/8d6cbe24d871efa7250bab6518d10a0344b2b272))

## [1.77.3](https://github.com/Heey-Global/verity/compare/mobile-v1.77.2...mobile-v1.77.3) (2026-10-24)


### Bug Fixes

* **deps:** use patched zod in Expo CLI ([#1848](https://github.com/Heey-Global/verity/issues/1848)) ([e85a5d8](https://github.com/Heey-Global/verity/commit/e85a5d87d0b5388e753c041d0dcd2e8fa18b43d3))

## [1.77.2](https://github.com/Heey-Global/verity/compare/mobile-v1.77.1...mobile-v1.77.2) (2026-10-24)


### Features

* **diagnostics:** add selected recording admission and bounded attempt ([#1831](https://github.com/Heey-Global/verity/issues/1831)) ([0f29617](https://github.com/Heey-Global/verity/commit/0f29617d2659eacc68f36dd30df86b70cd8772fb))
* **mobile:** expose bounded selected connection test ([#1840](https://github.com/Heey-Global/verity/issues/1840)) ([46a2709](https://github.com/Heey-Global/verity/commit/46a270964e222c5f49e92adefe4e6e7ee4e6ef6a))
* **security:** improve vulnerability indicators and scan lifecycle ([#1828](https://github.com/Heey-Global/verity/issues/1828)) ([079ec9f](https://github.com/Heey-Global/verity/commit/079ec9f7258b44b7c938f577e602e79643e4f62e))


### Bug Fixes

* **deps:** bump fast-uri ([#1844](https://github.com/Heey-Global/verity/issues/1844)) ([3837025](https://github.com/Heey-Global/verity/commit/38370259a8c5677f3d2cc1b9fc15f42bac9a5ede))
* **deps:** update dependency @napi-rs/canvas to v1.0.12 ([#1836](https://github.com/Heey-Global/verity/issues/1836)) ([2beb867](https://github.com/Heey-Global/verity/commit/2beb867c05001019ebdd3dd601431db9c745828c))
* **forgejo:** isolate session credentials and authenticate worktree fetches ([#1839](https://github.com/Heey-Global/verity/issues/1839)) ([f29de54](https://github.com/Heey-Global/verity/commit/f29de54691ca4a59ba881341727856a6bf00e5e2))

## [1.77.1](https://github.com/Heey-Global/verity/compare/mobile-v1.77.0...mobile-v1.77.1) (2026-10-23)


### Features

* **mobile:** calmer update progress and channel settings in the header ([#1823](https://github.com/Heey-Global/verity/issues/1823)) ([fd3529d](https://github.com/Heey-Global/verity/commit/fd3529dd1db2c50903589af9df6124e97234d187))
* **security:** integrate scan UI and harden release handoff ([#1824](https://github.com/Heey-Global/verity/issues/1824)) ([b7870c1](https://github.com/Heey-Global/verity/commit/b7870c1a4fa840e3736e8c6e49f669f628e03474))


### Bug Fixes

* **mobile:** compact meters and session rows in narrow split views ([#1827](https://github.com/Heey-Global/verity/issues/1827)) ([c65b476](https://github.com/Heey-Global/verity/commit/c65b476c8050905282e9450dbd280a3c47919cdc))

## [1.76.1](https://github.com/Heey-Global/verity/compare/mobile-v1.76.0...mobile-v1.76.1) (2026-10-23)


### Features

* **forgejo:** integrate connections and mobile repository workflows ([#1805](https://github.com/Heey-Global/verity/issues/1805)) ([5ebd077](https://github.com/Heey-Global/verity/commit/5ebd0778c995deb3be62dc424b7e980381fa6886))
* **mobile:** let the update banner be dismissed until the next version ([#1807](https://github.com/Heey-Global/verity/issues/1807)) ([2b33ccd](https://github.com/Heey-Global/verity/commit/2b33ccda610b3849379025979990e0e39480f6dd))
* **mobile:** show app updates next to server updates ([#1806](https://github.com/Heey-Global/verity/issues/1806)) ([ea7fdf0](https://github.com/Heey-Global/verity/commit/ea7fdf07d401298c1801c2eb25f5ac237741bea2))


### Bug Fixes

* **deps:** update agent clis ([#1800](https://github.com/Heey-Global/verity/issues/1800)) ([ad920df](https://github.com/Heey-Global/verity/commit/ad920dff37bd82e9b3dc5e2016c35d8dabe9f511))
* **deps:** update dependency @agentclientprotocol/sdk to v2 ([#1801](https://github.com/Heey-Global/verity/issues/1801)) ([f3eda1d](https://github.com/Heey-Global/verity/commit/f3eda1d442dfba91f8e585c2408ca8ead307424b))
* **mobile:** show up to date on the installed row and drop the generation counter ([#1804](https://github.com/Heey-Global/verity/issues/1804)) ([19e5a33](https://github.com/Heey-Global/verity/commit/19e5a33dbb661aeb85bc08fcd45ebe5b6e16c366))

## [1.75.2](https://github.com/Heey-Global/verity/compare/mobile-v1.75.1...mobile-v1.75.2) (2026-10-22)


### Features

* **updates:** recover stuck updates from the app ([#1768](https://github.com/Heey-Global/verity/issues/1768)) ([699be3a](https://github.com/Heey-Global/verity/commit/699be3ad1a7d2e013989441f574de1b3390752af))


### Bug Fixes

* **github:** guard PR creation against session branch mismatches ([#1777](https://github.com/Heey-Global/verity/issues/1777)) ([0526fbc](https://github.com/Heey-Global/verity/commit/0526fbca33f26165dfaf214a8e39272012ad551b))

## [1.75.1](https://github.com/Heey-Global/verity/compare/mobile-v1.75.0...mobile-v1.75.1) (2026-10-21)


### Bug Fixes

* **mobile:** build the new-meeting screen from the design system ([#1763](https://github.com/Heey-Global/verity/issues/1763)) ([3b79f18](https://github.com/Heey-Global/verity/commit/3b79f185c793a68436733dffb80568ec9eb6079c))

## [1.74.3](https://github.com/Heey-Global/verity/compare/mobile-v1.74.2...mobile-v1.74.3) (2026-10-20)


### Bug Fixes

* **github:** explain and recover missing commit-status permissions ([#1737](https://github.com/Heey-Global/verity/issues/1737)) ([2a2b781](https://github.com/Heey-Global/verity/commit/2a2b7813df93f27a68b92123b3399fe9492545d9))
* **mobile:** remove the load earlier history button ([#1735](https://github.com/Heey-Global/verity/issues/1735)) ([18836c5](https://github.com/Heey-Global/verity/commit/18836c5860631eb2d8fc3b460b1593e2c25aecdc))

## [1.74.2](https://github.com/Heey-Global/verity/compare/mobile-v1.74.1...mobile-v1.74.2) (2026-10-19)


### Bug Fixes

* **deps:** update agent clis ([#1711](https://github.com/Heey-Global/verity/issues/1711)) ([55547b0](https://github.com/Heey-Global/verity/commit/55547b0f8a21c8d5abd420466c968fda8f847697))
* **mobile:** remove session settings header menu ([#1714](https://github.com/Heey-Global/verity/issues/1714)) ([8cd1166](https://github.com/Heey-Global/verity/commit/8cd116602dee1804cb8ed61faf513e3193e9ebf0))

## [1.74.1](https://github.com/Heey-Global/verity/compare/mobile-v1.74.0...mobile-v1.74.1) (2026-10-19)


### Features

* **website:** open the homepage with the three promises behind the headline ([#1694](https://github.com/Heey-Global/verity/issues/1694)) ([6425fd8](https://github.com/Heey-Global/verity/commit/6425fd8248da152e4d015497065e5ce229649e79))


### Bug Fixes

* **deps:** update dependency sanitize-html to v2.18.1 ([#1699](https://github.com/Heey-Global/verity/issues/1699)) ([580d818](https://github.com/Heey-Global/verity/commit/580d81843ffd9f054e4c0a5bc8ca61babb6d5199))
* **mobile:** bound session history loading and expose recovery ([#1713](https://github.com/Heey-Global/verity/issues/1713)) ([023feee](https://github.com/Heey-Global/verity/commit/023feee98ea28d75ba78d6ea292717714f8e34a3))
* **mobile:** keep the web app alive on plain-http origins without randomUUID ([#1705](https://github.com/Heey-Global/verity/issues/1705)) ([974b52b](https://github.com/Heey-Global/verity/commit/974b52bc3898ba30d8f4125650bde9fc4bbd055d))

## [1.72.5](https://github.com/Heey-Global/verity/compare/mobile-v1.72.4...mobile-v1.72.5) (2026-10-16)


### Features

* **website:** render product images from the app and rebuild the homepage ([#1657](https://github.com/Heey-Global/verity/issues/1657)) ([79eac56](https://github.com/Heey-Global/verity/commit/79eac56417ef70c019c71a18f401f5e1666b9c23))


### Bug Fixes

* **deps:** update dependency zod to v4.6.7 ([#1661](https://github.com/Heey-Global/verity/issues/1661)) ([c253e3d](https://github.com/Heey-Global/verity/commit/c253e3d70851ff52832e486d89ee8d2064467f1d))

## [1.72.4](https://github.com/Heey-Global/verity/compare/mobile-v1.72.3...mobile-v1.72.4) (2026-10-16)


### Bug Fixes

* **mobile:** preserve recording preparation failures and partial exports ([#1663](https://github.com/Heey-Global/verity/issues/1663)) ([f5f63d0](https://github.com/Heey-Global/verity/commit/f5f63d057b1e619546ea694b2aeeea32196ee523))

## [1.72.3](https://github.com/Heey-Global/verity/compare/mobile-v1.72.2...mobile-v1.72.3) (2026-10-15)


### Features

* **google:** support multiple accounts across Workspace ([#1654](https://github.com/Heey-Global/verity/issues/1654)) ([064049f](https://github.com/Heey-Global/verity/commit/064049f0353b04d87565deb41b3558b4b0772b1a))


### Bug Fixes

* **deps:** update dependency zod to v4.6.6 ([#1648](https://github.com/Heey-Global/verity/issues/1648)) ([b29dffc](https://github.com/Heey-Global/verity/commit/b29dffc9ccf5011dffc3c51ed840bcfac325fffb))

## [1.72.2](https://github.com/Heey-Global/verity/compare/mobile-v1.72.1...mobile-v1.72.2) (2026-10-14)


### Bug Fixes

* **diagnostics:** capture selected sessions with fresh readiness ([#1639](https://github.com/Heey-Global/verity/issues/1639)) ([40e9194](https://github.com/Heey-Global/verity/commit/40e9194ff92ceecc7ff94e030fe60387eb1aa777))

## [1.72.1](https://github.com/Heey-Global/verity/compare/mobile-v1.72.0...mobile-v1.72.1) (2026-10-14)


### Features

* **diagnostics:** verify versioned socket evidence exports ([#1634](https://github.com/Heey-Global/verity/issues/1634)) ([77d5f7a](https://github.com/Heey-Global/verity/commit/77d5f7a04aaede29450da93b9a9ed4b14c3ef109))

## [1.69.1](https://github.com/Heey-Global/verity/compare/mobile-v1.69.0...mobile-v1.69.1) (2026-10-13)


### Bug Fixes

* **web:** support CSS-variable theme colors in tint() ([#1582](https://github.com/Heey-Global/verity/issues/1582)) ([f4a67a5](https://github.com/Heey-Global/verity/commit/f4a67a5a0381175b1771c6a79f907976cabd3202))

## [1.68.4](https://github.com/Heey-Global/verity/compare/mobile-v1.68.3...mobile-v1.68.4) (2026-10-12)


### Features

* **preview:** inject alias-bound secrets into managed servers ([#1565](https://github.com/Heey-Global/verity/issues/1565)) ([ca26935](https://github.com/Heey-Global/verity/commit/ca269359a1adbdc341fc3a7e5518861d0f636ddb))

## [1.68.3](https://github.com/Heey-Global/verity/compare/mobile-v1.68.2...mobile-v1.68.3) (2026-10-12)


### Performance Improvements

* **mobile:** reduce session startup and sidebar render work ([#1559](https://github.com/Heey-Global/verity/issues/1559)) ([83f83e5](https://github.com/Heey-Global/verity/commit/83f83e564fdd2558ad7f1c2e2c01a8e0031a4c32))

## [1.68.2](https://github.com/Heey-Global/verity/compare/mobile-v1.68.1...mobile-v1.68.2) (2026-10-12)


### Features

* **diagnostics:** record bounded socket and receiver state ([#1557](https://github.com/Heey-Global/verity/issues/1557)) ([a0839a2](https://github.com/Heey-Global/verity/commit/a0839a208d4eea1c266f5d5cc272176308dd86da))


### Bug Fixes

* **mobile:** restore red attention colors ([#1554](https://github.com/Heey-Global/verity/issues/1554)) ([ecd42c3](https://github.com/Heey-Global/verity/commit/ecd42c36a75b37ef7b67bd25a212675788f984c7))
* **session:** retry model capacity failures with system notices ([#1553](https://github.com/Heey-Global/verity/issues/1553)) ([42395f9](https://github.com/Heey-Global/verity/commit/42395f93ee87c0407212d6164242cbc64cad133e))

## [1.68.1](https://github.com/Heey-Global/verity/compare/mobile-v1.68.0...mobile-v1.68.1) (2026-10-12)


### Features

* **diagnostics:** coordinate App, Core and Uplink recording ([#1546](https://github.com/Heey-Global/verity/issues/1546)) ([fb53784](https://github.com/Heey-Global/verity/commit/fb53784db2be914f711058205f32bdd36c5311d0))

## [1.67.1](https://github.com/Heey-Global/verity/compare/mobile-v1.67.0...mobile-v1.67.1) (2026-10-12)


### Features

* **mobile:** add the design-system building blocks ([#1542](https://github.com/Heey-Global/verity/issues/1542)) ([4afbb49](https://github.com/Heey-Global/verity/commit/4afbb49b81ed4bca6d10fc2ed72cf85323ac6592))
* **mobile:** adopt the design-system palette ([#1535](https://github.com/Heey-Global/verity/issues/1535)) ([7bc0fe5](https://github.com/Heey-Global/verity/commit/7bc0fe5844eb6d02a68fda0c5335ccc23c82e226))
* **mobile:** set type in Inter with the design-system type styles ([#1536](https://github.com/Heey-Global/verity/issues/1536)) ([5b00966](https://github.com/Heey-Global/verity/commit/5b00966a6355c5095574da021cf38795136f9e7c))


### Bug Fixes

* **deps:** update agent clis ([#1534](https://github.com/Heey-Global/verity/issues/1534)) ([4f6a6a8](https://github.com/Heey-Global/verity/commit/4f6a6a8f83caadf636484671b4f7ebe04760cf84))
* **deps:** update dependency @fastify/compress to v9.2.1 ([#1531](https://github.com/Heey-Global/verity/issues/1531)) ([5691c79](https://github.com/Heey-Global/verity/commit/5691c79150cab6de855e631e3c8112f157d09f62))
* **deps:** update dependency @fastify/rate-limit to v11.2.1 ([#1532](https://github.com/Heey-Global/verity/issues/1532)) ([9f378dc](https://github.com/Heey-Global/verity/commit/9f378dcf5b04817d1c1e6960a0ed44513dd2bb5d))
* **mobile:** avoid direct request scheduling waits ([#1541](https://github.com/Heey-Global/verity/issues/1541)) ([7c25425](https://github.com/Heey-Global/verity/commit/7c25425aa2bde8249fe023b4a64c6b309672182b))

## [1.66.5](https://github.com/Heey-Global/verity/compare/mobile-v1.66.4...mobile-v1.66.5) (2026-10-11)


### Bug Fixes

* **mobile:** prevent session keyboard padding from being overwritten ([#1514](https://github.com/Heey-Global/verity/issues/1514)) ([63d7485](https://github.com/Heey-Global/verity/commit/63d74851974e7d4e319c464002b0d85465ec0ba0))

## [1.66.4](https://github.com/Heey-Global/verity/compare/mobile-v1.66.3...mobile-v1.66.4) (2026-10-11)


### Bug Fixes

* **deps:** update agent clis ([#1506](https://github.com/Heey-Global/verity/issues/1506)) ([086c5b3](https://github.com/Heey-Global/verity/commit/086c5b3654ee71be20c0b6f1c9fb04e5d7d21f04))

## [1.66.3](https://github.com/Heey-Global/verity/compare/mobile-v1.66.2...mobile-v1.66.3) (2026-10-11)


### Features

* **mobile:** export Remote Control CI test inputs ([#1507](https://github.com/Heey-Global/verity/issues/1507)) ([58adde4](https://github.com/Heey-Global/verity/commit/58adde41ba272710c588638e68ce43f0ba7bd656))

## [1.66.2](https://github.com/Heey-Global/verity/compare/mobile-v1.66.1...mobile-v1.66.2) (2026-10-10)


### Bug Fixes

* **mobile:** correct session keyboard visibility and overlap ([#1495](https://github.com/Heey-Global/verity/issues/1495)) ([7a22ff0](https://github.com/Heey-Global/verity/commit/7a22ff079eede32b186fcd5cfb0aa403fb80c71c))
* **mobile:** correlate touch diagnostics and expose route waits ([#1496](https://github.com/Heey-Global/verity/issues/1496)) ([9868bd8](https://github.com/Heey-Global/verity/commit/9868bd8c57e915dc5e0b637ed628dfe02e54fe74))

## [1.66.1](https://github.com/Heey-Global/verity/compare/mobile-v1.66.0...mobile-v1.66.1) (2026-10-10)


### Features

* **tasks:** streamline spoken capture and scope agent tasks to sessions ([#1472](https://github.com/Heey-Global/verity/issues/1472)) ([5b430ac](https://github.com/Heey-Global/verity/commit/5b430ac30ced9d7f2cf28f2c283a8c81cc7495f0))


### Bug Fixes

* **mobile:** avoid white screen during OTA reload ([#1473](https://github.com/Heey-Global/verity/issues/1473)) ([eb28e19](https://github.com/Heey-Global/verity/commit/eb28e19b8ca335fdcd12dfe363bb273b5c886390))
* **mobile:** isolate chat rendering from unrelated interaction updates ([#1478](https://github.com/Heey-Global/verity/issues/1478)) ([da99368](https://github.com/Heey-Global/verity/commit/da9936804014ece4299a9012cf2013ace11634bd))
* **session:** stop agent output and activity immediately ([#1480](https://github.com/Heey-Global/verity/issues/1480)) ([d80d19d](https://github.com/Heey-Global/verity/commit/d80d19dde17ce76566bea62abc0945367bafe1ea))


### Performance Improvements

* **mobile:** coordinate activity and preview refreshes ([#1482](https://github.com/Heey-Global/verity/issues/1482)) ([33467d6](https://github.com/Heey-Global/verity/commit/33467d67d4aa14e9de0444fffe7513c0b2f4ec38))
* **mobile:** retain unchanged overview row snapshots ([#1481](https://github.com/Heey-Global/verity/issues/1481)) ([bea26a2](https://github.com/Heey-Global/verity/commit/bea26a2fddacfec1d295bb3c94c5cba93bdf7776))
* **mobile:** share task capture and overview context ([#1483](https://github.com/Heey-Global/verity/issues/1483)) ([c2f5247](https://github.com/Heey-Global/verity/commit/c2f524752dad8702a271d8ae0f2030f81b7b74ef))

## [1.65.2](https://github.com/Heey-Global/verity/compare/mobile-v1.65.1...mobile-v1.65.2) (2026-10-09)


### Bug Fixes

* **mobile:** record connection tests from a fresh tunnel ([#1449](https://github.com/Heey-Global/verity/issues/1449)) ([1d97933](https://github.com/Heey-Global/verity/commit/1d9793383956bfc339d478fff901084d661a4a40))

## [1.65.1](https://github.com/Heey-Global/verity/compare/mobile-v1.65.0...mobile-v1.65.1) (2026-10-09)


### Bug Fixes

* **mobile:** distinguish connection recording export failures ([#1446](https://github.com/Heey-Global/verity/issues/1446)) ([df98937](https://github.com/Heey-Global/verity/commit/df98937c01e522a0ef65e030e4955bd25fc25ed2))

## [1.64.1](https://github.com/Heey-Global/verity/compare/mobile-v1.64.0...mobile-v1.64.1) (2026-10-09)


### Bug Fixes

* **mobile:** preserve session switch readiness diagnostics ([#1438](https://github.com/Heey-Global/verity/issues/1438)) ([396c63f](https://github.com/Heey-Global/verity/commit/396c63fb7b72e5914dc25a0fde88ce4fc9a71815))

## [1.63.1](https://github.com/Heey-Global/verity/compare/mobile-v1.63.0...mobile-v1.63.1) (2026-10-09)


### Features

* **agent:** add verity_app_help tool with shared app help catalog ([#1415](https://github.com/Heey-Global/verity/issues/1415)) ([3db7e07](https://github.com/Heey-Global/verity/commit/3db7e0774cf3254c98212096d8612ba34ba2f7d1))


### Bug Fixes

* **deps:** update agent clis ([#1403](https://github.com/Heey-Global/verity/issues/1403)) ([abcecd4](https://github.com/Heey-Global/verity/commit/abcecd426c58d144b9e31859086295fe28295598))
* **mobile:** skip unmounted issue refs during gesture hit testing ([#1424](https://github.com/Heey-Global/verity/issues/1424)) ([3607faa](https://github.com/Heey-Global/verity/commit/3607faa1dbf868cd1ce0a1ef2f368356cc14a680))

## [1.62.1](https://github.com/Heey-Global/verity/compare/mobile-v1.62.0...mobile-v1.62.1) (2026-10-09)


### Bug Fixes

* **mobile:** defer initial history paging and measure render work ([#1397](https://github.com/Heey-Global/verity/issues/1397)) ([205ec2b](https://github.com/Heey-Global/verity/commit/205ec2b71d24960e7e371b5d6e8e4ec1315500a3))
* **mobile:** simplify PR waiting button and slow its indicator ([#1399](https://github.com/Heey-Global/verity/issues/1399)) ([458b29a](https://github.com/Heey-Global/verity/commit/458b29aa5ab06b375d2c33d7a410f1a7b51c9788))

## [1.60.3](https://github.com/Heey-Global/verity/compare/mobile-v1.60.2...mobile-v1.60.3) (2026-10-08)


### Bug Fixes

* **mobile:** save agent settings without shifting the screen ([#1372](https://github.com/Heey-Global/verity/issues/1372)) ([2ffddcc](https://github.com/Heey-Global/verity/commit/2ffddccad44e7aadcb8d7fb10601c055e0d06816))

## [1.60.2](https://github.com/Heey-Global/verity/compare/mobile-v1.60.1...mobile-v1.60.2) (2026-10-08)


### Features

* **mobile:** add bounded interaction timing diagnostics ([#1365](https://github.com/Heey-Global/verity/issues/1365)) ([c8e0135](https://github.com/Heey-Global/verity/commit/c8e01355f1aebf5d0388ae85d253decf8709cb53))
* **models:** replace Haiku 4.5 with Haiku 5.5 ([#1363](https://github.com/Heey-Global/verity/issues/1363)) ([ee15eab](https://github.com/Heey-Global/verity/commit/ee15eabd94e5ad6b3aa24e2dabf333ce02864583))


### Bug Fixes

* **mobile:** keep task dictation active until save ([#1366](https://github.com/Heey-Global/verity/issues/1366)) ([db031c9](https://github.com/Heey-Global/verity/commit/db031c94c58a7b9e036fef58fd19ec0d10a3d165))
* **mobile:** show feedback while starting task sessions ([#1369](https://github.com/Heey-Global/verity/issues/1369)) ([c7a148f](https://github.com/Heey-Global/verity/commit/c7a148f2c7a2776c23935d181bc3885f345547b8))
* **planning:** unify plan approval and label accepted proposals ([#1352](https://github.com/Heey-Global/verity/issues/1352)) ([6a53a3a](https://github.com/Heey-Global/verity/commit/6a53a3a6b41832a61816f073790cf86c30e45df5))
* **sessions:** append new sessions after manual ordering ([#1368](https://github.com/Heey-Global/verity/issues/1368)) ([a68e149](https://github.com/Heey-Global/verity/commit/a68e1497c42618efeff7013dc1045853827b397a))

## [1.60.1](https://github.com/Heey-Global/verity/compare/mobile-v1.60.0...mobile-v1.60.1) (2026-10-08)


### Bug Fixes

* synchronize PR overview markers and immediate status bar ([#1347](https://github.com/Heey-Global/verity/issues/1347)) ([d70103d](https://github.com/Heey-Global/verity/commit/d70103dfafd03f197a6bfa54af0f166f0371be82))

## [1.59.3](https://github.com/Heey-Global/verity/compare/mobile-v1.59.2...mobile-v1.59.3) (2026-10-08)


### Features

* **projects:** restrict allowed agents per project ([#1326](https://github.com/Heey-Global/verity/issues/1326)) ([e309754](https://github.com/Heey-Global/verity/commit/e30975490d7b637b0bab69299b14ee7a2da039be))

## [1.59.2](https://github.com/Heey-Global/verity/compare/mobile-v1.59.1...mobile-v1.59.2) (2026-10-08)


### Features

* **meetings:** add Attendee online source to Live Meeting ([#1325](https://github.com/Heey-Global/verity/issues/1325)) ([27f66ba](https://github.com/Heey-Global/verity/commit/27f66ba79dbdc9a602cb229c7b10467503769ec4))


### Bug Fixes

* **mobile:** preserve session visibility during drag pickup ([#1328](https://github.com/Heey-Global/verity/issues/1328)) ([dc85aeb](https://github.com/Heey-Global/verity/commit/dc85aeb0385aebb35a0de39a48f1cc0ccec41487))
* **planning:** make plan proposals clear and actionable ([#1324](https://github.com/Heey-Global/verity/issues/1324)) ([fd78ac3](https://github.com/Heey-Global/verity/commit/fd78ac3388e089541c1da1d2d6a31c99d00dd11a))

## [1.59.1](https://github.com/Heey-Global/verity/compare/mobile-v1.59.0...mobile-v1.59.1) (2026-10-08)


### Features

* **mobile:** reorder sessions within projects by long press ([#1323](https://github.com/Heey-Global/verity/issues/1323)) ([98c77f3](https://github.com/Heey-Global/verity/commit/98c77f30a6f92203cf48a5cc506e598309193d9e))
* **sessions:** allow linking sessions in the same project ([#1317](https://github.com/Heey-Global/verity/issues/1317)) ([c366cf3](https://github.com/Heey-Global/verity/commit/c366cf3749b2621a3de769e1761122a310192457))


### Bug Fixes

* **mobile:** move PR status to the session row's second line ([#1321](https://github.com/Heey-Global/verity/issues/1321)) ([a662aa1](https://github.com/Heey-Global/verity/commit/a662aa12575fba2c111951a16151686e92293c38))
* **sandbox:** kill the largest agent command before gVisor's host OOM kill ([#1322](https://github.com/Heey-Global/verity/issues/1322)) ([3be664e](https://github.com/Heey-Global/verity/commit/3be664e9126103d028915f386834ddbf239d0e08))
* **session:** stabilize cancellation, activity and unread indicators ([#1316](https://github.com/Heey-Global/verity/issues/1316)) ([59f357b](https://github.com/Heey-Global/verity/commit/59f357b2e41095590e581e1745118cec6ac78dc7))
* **tasks:** calm capture flow and polish task editing ([#1320](https://github.com/Heey-Global/verity/issues/1320)) ([3056a73](https://github.com/Heey-Global/verity/commit/3056a73c40d70a7901626bf72ee52e15f0beb324))

## [1.58.4](https://github.com/Heey-Global/verity/compare/mobile-v1.58.3...mobile-v1.58.4) (2026-10-07)


### Features

* **mobile:** move session markers to a trailing icon-and-bar column ([#1307](https://github.com/Heey-Global/verity/issues/1307)) ([a4b4c22](https://github.com/Heey-Global/verity/commit/a4b4c22cf3713c76b865912d3645372ca5c5863c))


### Bug Fixes

* **mobile:** stabilize meeting UI and isolate research replies ([#1308](https://github.com/Heey-Global/verity/issues/1308)) ([66ec3d5](https://github.com/Heey-Global/verity/commit/66ec3d567c629c534a8674ae5124809969e1e80d))
* **mobile:** subscribe to PR updates after branch prefetch ([#1305](https://github.com/Heey-Global/verity/issues/1305)) ([9c07247](https://github.com/Heey-Global/verity/commit/9c072477d40dc8fe2f20a61440d0a4ad21e4cc00))
* **session:** require actionable next steps for unfinished outcomes ([#1303](https://github.com/Heey-Global/verity/issues/1303)) ([1caf118](https://github.com/Heey-Global/verity/commit/1caf1184c24395765c3e06b3c8031f065d596b9c))

## [1.58.3](https://github.com/Heey-Global/verity/compare/mobile-v1.58.2...mobile-v1.58.3) (2026-10-07)


### Bug Fixes

* **mobile:** avoid overview renders during settings navigation ([#1299](https://github.com/Heey-Global/verity/issues/1299)) ([c91c8e6](https://github.com/Heey-Global/verity/commit/c91c8e64f04de18b4fc281349b3846a59fdcb0c2))

## [1.58.2](https://github.com/Heey-Global/verity/compare/mobile-v1.58.1...mobile-v1.58.2) (2026-10-07)


### Features

* **mobile:** mark sessions on the row edge and show sharing in green ([#1296](https://github.com/Heey-Global/verity/issues/1296)) ([495135a](https://github.com/Heey-Global/verity/commit/495135a54f409ce1ea8d8d08e207748349a4fc45))
* **tasks:** capture card redesign, shared action menu, agent steps end with their session ([#1292](https://github.com/Heey-Global/verity/issues/1292)) ([bed9367](https://github.com/Heey-Global/verity/commit/bed93677b8d93bf68f12c3d60651394a99ebf995))


### Bug Fixes

* **mobile:** keep session swipe actions opaque and add Edit beside Delete ([#1293](https://github.com/Heey-Global/verity/issues/1293)) ([b7057b6](https://github.com/Heey-Global/verity/commit/b7057b6e7ced977faa8d2cc413c12ec7d7d86e79))
* **web:** match browser sign-in to the preview code page ([#1295](https://github.com/Heey-Global/verity/issues/1295)) ([1e84862](https://github.com/Heey-Global/verity/commit/1e848627bbb218243ab9a4d29b41f187dfe56edb))
* **web:** style the composer input and support drag and drop in the browser ([#1297](https://github.com/Heey-Global/verity/issues/1297)) ([dbc0368](https://github.com/Heey-Global/verity/commit/dbc03680831cec0b5dd95ab2112d324924787920))

## [1.58.1](https://github.com/Heey-Global/verity/compare/mobile-v1.58.0...mobile-v1.58.1) (2026-10-07)


### Bug Fixes

* **mobile:** initialize Unistyles before loading routes ([#1288](https://github.com/Heey-Global/verity/issues/1288)) ([0f89d27](https://github.com/Heey-Global/verity/commit/0f89d27388c3a004aa0ca1c04c0b8e28d6b99a0f))
* **web:** restore layouts and composer behavior and optimize loading ([#1273](https://github.com/Heey-Global/verity/issues/1273)) ([ba34bbb](https://github.com/Heey-Global/verity/commit/ba34bbb6118e5ee92d23ae027dca886c40e94a01))

## [1.57.5](https://github.com/Heey-Global/verity/compare/mobile-v1.57.4...mobile-v1.57.5) (2026-10-07)


### Bug Fixes

* **mobile:** use general diagnostics settings label ([#1285](https://github.com/Heey-Global/verity/issues/1285)) ([915723e](https://github.com/Heey-Global/verity/commit/915723e19fc9311b5667eb6bcf6c83d056a04485))

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
