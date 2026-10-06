# Changelog

## [4.20.1](https://github.com/Heey-Global/verity/compare/v4.20.0...v4.20.1) (2026-10-06)


### Bug Fixes

* **preview:** unify detected server controls and require managed starts ([#1237](https://github.com/Heey-Global/verity/issues/1237)) ([98498d1](https://github.com/Heey-Global/verity/commit/98498d17d851cd342a4c8d69fd9796f25be8d838))

## [4.20.0](https://github.com/Heey-Global/verity/compare/v4.19.0...v4.20.0) (2026-10-06)


### Features

* **diagnostics:** expose local and historical runtime evidence ([#1234](https://github.com/Heey-Global/verity/issues/1234)) ([7e39988](https://github.com/Heey-Global/verity/commit/7e3998869cbd828ae355d0c2d72ad0ea77fa6faf))
* **preview:** support PIN authentication for WebSocket upgrades ([#1232](https://github.com/Heey-Global/verity/issues/1232)) ([1099441](https://github.com/Heey-Global/verity/commit/10994411ffe05e9cad9acd6f6d0f3c561a76a27d))


### Bug Fixes

* **broker:** resolve entry-script project paths from the session worktree ([#1233](https://github.com/Heey-Global/verity/issues/1233)) ([d385d82](https://github.com/Heey-Global/verity/commit/d385d82ab5230eead3bd37254d625d457f05cea3))
* **tasks:** preserve captures and secure assignments and attachments ([#1230](https://github.com/Heey-Global/verity/issues/1230)) ([3ab8790](https://github.com/Heey-Global/verity/commit/3ab87905b222d9513c40165d710afcf937195621))

## [4.19.0](https://github.com/Heey-Global/verity/compare/v4.18.0...v4.19.0) (2026-10-06)


### Features

* **live:** use one connection per device and route notifications per user ([#1225](https://github.com/Heey-Global/verity/issues/1225)) ([4b7b173](https://github.com/Heey-Global/verity/commit/4b7b173517c3a62cb7edf33fcb1192d1f4774fe4))

## [4.18.0](https://github.com/Heey-Global/verity/compare/v4.17.0...v4.18.0) (2026-10-06)


### Features

* **tasks:** add durable task persistence and agent access ([#1226](https://github.com/Heey-Global/verity/issues/1226)) ([9f446ec](https://github.com/Heey-Global/verity/commit/9f446ec22f298a086db72803fca1403386075055))


### Bug Fixes

* **session:** restore Claude and OpenCode task checklists ([#1222](https://github.com/Heey-Global/verity/issues/1222)) ([47bdd2c](https://github.com/Heey-Global/verity/commit/47bdd2cb2774ee7e754d3e54303dab4a2c7d54fe))

## [4.17.0](https://github.com/Heey-Global/verity/compare/v4.16.2...v4.17.0) (2026-10-06)


### Features

* **broker:** mediate GitHub sandbox traffic through HTTP secret broker ([#1204](https://github.com/Heey-Global/verity/issues/1204)) ([2ff5ca9](https://github.com/Heey-Global/verity/commit/2ff5ca92923fba2f989be248fcd907545c1ed990))
* **mobile:** compact issue and branch refs in header and overview ([#1215](https://github.com/Heey-Global/verity/issues/1215)) ([e50cf97](https://github.com/Heey-Global/verity/commit/e50cf975272444bf7aeb6e958a756baafb8885cc))
* **web:** ship browser client in Core Docker image ([#1216](https://github.com/Heey-Global/verity/issues/1216)) ([63bb411](https://github.com/Heey-Global/verity/commit/63bb411ecedce8c687a7025f43f9c1af57db2d4e))


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.7.0 ([#1194](https://github.com/Heey-Global/verity/issues/1194)) ([7669e6e](https://github.com/Heey-Global/verity/commit/7669e6e896454294b3d136875df25ac06370da76))

## [4.16.2](https://github.com/Heey-Global/verity/compare/v4.16.1...v4.16.2) (2026-10-06)


### Bug Fixes

* **sessions:** restore shared project containers and session worktrees ([#1211](https://github.com/Heey-Global/verity/issues/1211)) ([b4ba92b](https://github.com/Heey-Global/verity/commit/b4ba92b2dacb1e0a4179067b08fe4e643d001319))

## [4.16.1](https://github.com/Heey-Global/verity/compare/v4.16.0...v4.16.1) (2026-10-06)


### Bug Fixes

* **planning:** avoid redundant tool approval for plan presentation ([#1205](https://github.com/Heey-Global/verity/issues/1205)) ([dd64496](https://github.com/Heey-Global/verity/commit/dd644967a88e63d431339724e27c84d2fd63ea54))
* **sandbox:** stop image-update recreate loop for devcontainer projects ([#1210](https://github.com/Heey-Global/verity/issues/1210)) ([34a9429](https://github.com/Heey-Global/verity/commit/34a9429b51884792530b1789d27dbf0e302e35ce))

## [4.16.0](https://github.com/Heey-Global/verity/compare/v4.15.0...v4.16.0) (2026-10-06)


### Features

* **dev-servers:** control server lifetime with Local and Shared online ([#1186](https://github.com/Heey-Global/verity/issues/1186)) ([3e5f978](https://github.com/Heey-Global/verity/commit/3e5f9785bf9415bca531381142fd91133236fd6f))
* **web:** add local browser client with cookie sessions ([#1183](https://github.com/Heey-Global/verity/issues/1183)) ([29f8e70](https://github.com/Heey-Global/verity/commit/29f8e701df3263fe8ad575903fe87456ea61c4ff))


### Bug Fixes

* **push:** alert audibly when the agent waits on the operator ([#1200](https://github.com/Heey-Global/verity/issues/1200)) ([58a9b13](https://github.com/Heey-Global/verity/commit/58a9b138929e0c84c85018855185db6d8e74fcfa))
* **session:** remove missing-image warning ([#1184](https://github.com/Heey-Global/verity/issues/1184)) ([841eb82](https://github.com/Heey-Global/verity/commit/841eb822fe17a4781d161afc25249f616db10ca0))
* **sessions:** isolate session workspaces and Git state ([0d83513](https://github.com/Heey-Global/verity/commit/0d835134034a39ceb47b0f95f450863339385580))

## [4.15.0](https://github.com/Heey-Global/verity/compare/v4.14.0...v4.15.0) (2026-10-05)


### Features

* **dev-servers:** manage session servers from Preview and chat ([#1175](https://github.com/Heey-Global/verity/issues/1175)) ([c8aa031](https://github.com/Heey-Global/verity/commit/c8aa03142ec51b3b454119c334a18ecc7bb186ec))
* **session:** add persistent planning with synchronized plan approvals ([#1163](https://github.com/Heey-Global/verity/issues/1163)) ([c774e2b](https://github.com/Heey-Global/verity/commit/c774e2b218b5fd54d65e7b436cf7ffa882a14d11))


### Bug Fixes

* **matrix:** persist early redactions and reconcile left rooms ([#1172](https://github.com/Heey-Global/verity/issues/1172)) ([f3fac93](https://github.com/Heey-Global/verity/commit/f3fac931958e0c2aae2e5539f9a91d0ecc48eb16))
* **mobile:** keep chat-enabled Google services scoped to the session ([#1171](https://github.com/Heey-Global/verity/issues/1171)) ([7df6fcb](https://github.com/Heey-Global/verity/commit/7df6fcb7676ce21cafcf988e84963e15556a532e))
* **release:** ignore retired OTA publication blockers ([#1173](https://github.com/Heey-Global/verity/issues/1173)) ([67542fa](https://github.com/Heey-Global/verity/commit/67542fad00b18d5176cf1c3b1439635272a2afd2))
* **release:** plan OTA after native runtime advances ([#1170](https://github.com/Heey-Global/verity/issues/1170)) ([1f41199](https://github.com/Heey-Global/verity/commit/1f411999fecb29614969c67d3b17b2b56b748898))

## [4.14.0](https://github.com/Heey-Global/verity/compare/v4.13.0...v4.14.0) (2026-10-05)


### Features

* **release:** allow manual native mobile release planning ([#1158](https://github.com/Heey-Global/verity/issues/1158)) ([9372243](https://github.com/Heey-Global/verity/commit/93722435260c4ee57d63ac29a1c17757b0bf55d8))

## [4.13.0](https://github.com/Heey-Global/verity/compare/v4.12.0...v4.13.0) (2026-10-05)


### Features

* **mobile:** open a session's preview from its list row ([#1154](https://github.com/Heey-Global/verity/issues/1154)) ([c2bb622](https://github.com/Heey-Global/verity/commit/c2bb6222e42074df4d70efddda250aa1c4b319fe))
* **remote:** add correlated Core transport diagnostics ([#1150](https://github.com/Heey-Global/verity/issues/1150)) ([809a201](https://github.com/Heey-Global/verity/commit/809a201fe4553fdb8ea8da7183b2e9b844b9b220))
* **session:** show agent plans as a live checklist ([#1148](https://github.com/Heey-Global/verity/issues/1148)) ([45ead02](https://github.com/Heey-Global/verity/commit/45ead02bb1cd547547970e655e59f318153d757f))


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.6.0 ([#1137](https://github.com/Heey-Global/verity/issues/1137)) ([0667313](https://github.com/Heey-Global/verity/commit/0667313a9f9260a1b1c714531318e942de3d8773))
* **matrix:** identify rejected event imports in server logs ([#1155](https://github.com/Heey-Global/verity/issues/1155)) ([d5fd602](https://github.com/Heey-Global/verity/commit/d5fd60207ab006c48ca87508360bed6c0931ac26))
* **sessions:** exclude dev-server events from unread badges ([7bc715b](https://github.com/Heey-Global/verity/commit/7bc715b5cbcebf81b346eac2f7ef7e5c3ded889e))

## [4.12.0](https://github.com/Heey-Global/verity/compare/v4.11.1...v4.12.0) (2026-10-05)


### Features

* **mobile:** show subscription plan and usage on provider settings ([#1142](https://github.com/Heey-Global/verity/issues/1142)) ([e3d2e0f](https://github.com/Heey-Global/verity/commit/e3d2e0f352dcb8c6cff031a8b3c8c83253f8b8cf))


### Bug Fixes

* **control:** permit bounded diagnostics across knowledge boundaries ([#1132](https://github.com/Heey-Global/verity/issues/1132)) ([fbf3a92](https://github.com/Heey-Global/verity/commit/fbf3a92bd572a236960175134a4e1c8fb61b6cc9))
* **deps:** update dependency @napi-rs/canvas to v1.0.10 ([#1135](https://github.com/Heey-Global/verity/issues/1135)) ([58a7580](https://github.com/Heey-Global/verity/commit/58a758028357f1a4d05029907bb432425d0d578a))
* **secrets:** unify scoped approvals and prevent redundant prompts ([#1139](https://github.com/Heey-Global/verity/issues/1139)) ([06e803e](https://github.com/Heey-Global/verity/commit/06e803e62394619f0054544d509c74b082fe4dce))

## [4.11.1](https://github.com/Heey-Global/verity/compare/v4.11.0...v4.11.1) (2026-10-04)


### Bug Fixes

* **preview:** enable local access through LAN and VPN interfaces ([#1124](https://github.com/Heey-Global/verity/issues/1124)) ([0539b70](https://github.com/Heey-Global/verity/commit/0539b705c3aeac16146f6cc82688f5572c28faba))

## [4.11.0](https://github.com/Heey-Global/verity/compare/v4.10.0...v4.11.0) (2026-10-04)


### Features

* **control:** add read-only diagnostic snapshots ([#1104](https://github.com/Heey-Global/verity/issues/1104)) ([1c44827](https://github.com/Heey-Global/verity/commit/1c4482752b8d0ef71a946a1a2be982311886ea3d))
* **matrix:** expose import failures to Control and room status ([#1112](https://github.com/Heey-Global/verity/issues/1112)) ([90db73c](https://github.com/Heey-Global/verity/commit/90db73cb77b94001b7a52190e1b44a5d6a936ee9))
* **mobile:** version staging OTA releases through Release Please PRs ([#1115](https://github.com/Heey-Global/verity/issues/1115)) ([80a15be](https://github.com/Heey-Global/verity/commit/80a15be8c3637af9efa9873f8774367647da0fcf))


### Bug Fixes

* **automation:** default schedules to the user's time zone ([#1117](https://github.com/Heey-Global/verity/issues/1117)) ([f9a6844](https://github.com/Heey-Global/verity/commit/f9a684430b83f6df2b3181815bbf62f2b0dafc03))
* **mobile:** show GitHub's pending merge test instead of a dead merge button ([#1105](https://github.com/Heey-Global/verity/issues/1105)) ([94600b1](https://github.com/Heey-Global/verity/commit/94600b1c8a15a35dff395fad8c92558a438dc09d))
* preserve read sessions across restarts and separate update channel settings ([#1111](https://github.com/Heey-Global/verity/issues/1111)) ([1a688a4](https://github.com/Heey-Global/verity/commit/1a688a495520f110e4c841b477bd6c8b55220f37))
* **preview:** migrate local gateway ingress during managed updates ([#1116](https://github.com/Heey-Global/verity/issues/1116)) ([b9b648a](https://github.com/Heey-Global/verity/commit/b9b648a263632749fcae8e6fe6365f867317b1fa))
* **server:** hide worktree recovery metadata from session output ([#1114](https://github.com/Heey-Global/verity/issues/1114)) ([21b702f](https://github.com/Heey-Global/verity/commit/21b702fde35c2478acf14b131722a0429613a223))

## [4.10.0](https://github.com/Heey-Global/verity/compare/v4.9.1...v4.10.0) (2026-10-04)


### Features

* **automations:** attach recurring automations to sessions ([#1097](https://github.com/Heey-Global/verity/issues/1097)) ([e1dc7eb](https://github.com/Heey-Global/verity/commit/e1dc7eb9b82d5ac39f0e0b1b8e6e9c643b9c0b76))


### Bug Fixes

* **mobile:** keep production promotion in TestFlight ([#1098](https://github.com/Heey-Global/verity/issues/1098)) ([a88ab65](https://github.com/Heey-Global/verity/commit/a88ab655297882db40e3110dee5ddd2286b0aa4a))
* **session:** recognize model-specific usage limit refusals ([#1099](https://github.com/Heey-Global/verity/issues/1099)) ([e3068db](https://github.com/Heey-Global/verity/commit/e3068dbee38b23be5c218e0b61c74b0163e58da4))

## [4.9.1](https://github.com/Heey-Global/verity/compare/v4.9.0...v4.9.1) (2026-10-04)


### Bug Fixes

* **preview:** allow local connector transport and clarify opening actions ([#1090](https://github.com/Heey-Global/verity/issues/1090)) ([a59dc7d](https://github.com/Heey-Global/verity/commit/a59dc7db4e420f479c5278ca548e0963eeb452e0))

## [4.9.0](https://github.com/Heey-Global/verity/compare/v4.8.0...v4.9.0) (2026-10-04)


### Features

* **connections:** unify account setup and project access ([#1063](https://github.com/Heey-Global/verity/issues/1063)) ([fe35252](https://github.com/Heey-Global/verity/commit/fe352520795139caf9ed0b88ec6a21b7f2127fe4))
* **drive:** add approved project file management actions ([#1078](https://github.com/Heey-Global/verity/issues/1078)) ([7f51dee](https://github.com/Heey-Global/verity/commit/7f51deeb81920ede3a82c0e4aac4ce66f02555c9))
* **explorer:** edit text files with recoverable version history ([#1061](https://github.com/Heey-Global/verity/issues/1061)) ([6e93566](https://github.com/Heey-Global/verity/commit/6e9356675b72f22d43c8c811ad8e401bce294792))
* **preview:** add local sharing and automatic listener discovery ([#1076](https://github.com/Heey-Global/verity/issues/1076)) ([4026bb2](https://github.com/Heey-Global/verity/commit/4026bb2af25ef0aa059011a007363df9d8708dda))
* **settings:** select server prereleases and Google app identities ([#1075](https://github.com/Heey-Global/verity/issues/1075)) ([7074d4f](https://github.com/Heey-Global/verity/commit/7074d4ff4798c05a97b4b692c89007841856743a))


### Bug Fixes

* **deps:** update dependency pg to v8.23.1 ([#1068](https://github.com/Heey-Global/verity/issues/1068)) ([edf0b66](https://github.com/Heey-Global/verity/commit/edf0b664b4a45d6dcd7ce7b55c3fe89387563c1a))
* **deps:** update dependency sanitize-html to v2.18.0 ([#1071](https://github.com/Heey-Global/verity/issues/1071)) ([ffb3a73](https://github.com/Heey-Global/verity/commit/ffb3a73e4957fb9018fbb53f0789e16ca1ec638b))
* **explorer:** retain ten snapshots per file ([#1074](https://github.com/Heey-Global/verity/issues/1074)) ([0616520](https://github.com/Heey-Global/verity/commit/0616520e12ceafabccca937c86b8a7c35c85bc73))
* **pr:** repair failures in background and share adaptive status polling ([#1084](https://github.com/Heey-Global/verity/issues/1084)) ([4334331](https://github.com/Heey-Global/verity/commit/4334331da2e33dcf6ecfb4ac58e700ab4a5ae619))
* **relay:** restart exited relays and increase memory headroom ([#1087](https://github.com/Heey-Global/verity/issues/1087)) ([7cf8571](https://github.com/Heey-Global/verity/commit/7cf8571205f0b7ab8b68ff97df1b889f1f1969fe))
* **release:** read staging identities from repository secrets ([#1079](https://github.com/Heey-Global/verity/issues/1079)) ([e9b770b](https://github.com/Heey-Global/verity/commit/e9b770b077a609f940ab4bfad1c1d59978f2248d))

## [4.8.0](https://github.com/Heey-Global/verity/compare/v4.7.0...v4.8.0) (2026-10-03)


### Features

* **explorer:** clarify file actions and support renaming ([#1049](https://github.com/Heey-Global/verity/issues/1049)) ([6bd57ed](https://github.com/Heey-Global/verity/commit/6bd57eda6681c21b856ad86b8f945042a98f2d3e))
* **server:** attribute backend latency and add optional CPU profiles ([#1041](https://github.com/Heey-Global/verity/issues/1041)) ([bfe1db4](https://github.com/Heey-Global/verity/commit/bfe1db450f6d120451d154443eccffd4adc730d4))


### Bug Fixes

* **broker:** accept larger bounded diagnostic argv policies ([#1048](https://github.com/Heey-Global/verity/issues/1048)) ([54bb9de](https://github.com/Heey-Global/verity/commit/54bb9de55017d51ba7f9dffe5e0b16b3e284b95f))
* **preview:** contain WebSocket errors and reject blocking FIFOs ([#1052](https://github.com/Heey-Global/verity/issues/1052)) ([5de160c](https://github.com/Heey-Global/verity/commit/5de160c0a5c9ca169b2a13fcbc67eb10907b2b6d))
* **uplink:** bound pending control message work ([#1056](https://github.com/Heey-Global/verity/issues/1056)) ([47847db](https://github.com/Heey-Global/verity/commit/47847dbedfcbd3e5ab4694726dfbcf3646defab6))

## [4.7.0](https://github.com/Heey-Global/verity/compare/v4.6.0...v4.7.0) (2026-10-03)


### Features

* **release:** add staging channels and production promotion ([#1035](https://github.com/Heey-Global/verity/issues/1035)) ([55a7aea](https://github.com/Heey-Global/verity/commit/55a7aea98f8e2bb3aedbf8d6b84a19c0692ce2de))


### Bug Fixes

* **server:** build project images from tracked files, not the whole clone ([#1039](https://github.com/Heey-Global/verity/issues/1039)) ([3b413b7](https://github.com/Heey-Global/verity/commit/3b413b749230a62a93870171b974f4dff43a715f))

## [4.6.0](https://github.com/Heey-Global/verity/compare/v4.5.0...v4.6.0) (2026-10-03)


### Features

* **preview:** enforce durable PIN lockout and show locked links ([#1006](https://github.com/Heey-Global/verity/issues/1006)) ([6281a4a](https://github.com/Heey-Global/verity/commit/6281a4a8ca8e729b5eb1ec55818c3910adaf9621))


### Bug Fixes

* **deps:** update dependency fast-xml-parser to v5.11.2 ([#1025](https://github.com/Heey-Global/verity/issues/1025)) ([f76b578](https://github.com/Heey-Global/verity/commit/f76b578035c618031708a9075b4d1fb3a621f36a))
* **installer:** preserve sudo terminal and filter Docker pairing addresses ([#1013](https://github.com/Heey-Global/verity/issues/1013)) ([6c7b118](https://github.com/Heey-Global/verity/commit/6c7b1184f0814a7d60cca549a4f3628917c76f8f))
* **preview:** enforce server-side session cookie expiry ([#1033](https://github.com/Heey-Global/verity/issues/1033)) ([2254409](https://github.com/Heey-Global/verity/commit/2254409b1d1262eb252544a5b8e1b30c0f41dc59))
* **preview:** reject cross-origin browser writes and websocket upgrades ([#1032](https://github.com/Heey-Global/verity/issues/1032)) ([a66073e](https://github.com/Heey-Global/verity/commit/a66073ef7705849019c48856156f568e8d348755))
* **security:** confine project builds and revoke device streams ([d28cb13](https://github.com/Heey-Global/verity/commit/d28cb13b0ed370e4090f7e4a17b77940e5174178))
* **security:** sign supporting release artifacts ([#1026](https://github.com/Heey-Global/verity/issues/1026)) ([33b3757](https://github.com/Heey-Global/verity/commit/33b3757a30e3abcbd5447ee01d6b11d6025303a0))
* **security:** verify server images before installation and updates ([#1018](https://github.com/Heey-Global/verity/issues/1018)) ([fdf09e0](https://github.com/Heey-Global/verity/commit/fdf09e0d32889d87417d8d46ea9dea5ce47c565a))
* **server:** serialize full session projection fallback reads ([#1016](https://github.com/Heey-Global/verity/issues/1016)) ([304bc21](https://github.com/Heey-Global/verity/commit/304bc21a8623ecb6d698192a59cdcd2ec56835a6))
* **session:** recover quick-action lists without closing tags ([#1011](https://github.com/Heey-Global/verity/issues/1011)) ([c3e5f9a](https://github.com/Heey-Global/verity/commit/c3e5f9a4d171b5571955b8c1c5369d4598bda5db))
* show local save only for project file changes ([#1017](https://github.com/Heey-Global/verity/issues/1017)) ([b77f133](https://github.com/Heey-Global/verity/commit/b77f133616fa290511edcecb9881180151592de3))

## [4.5.0](https://github.com/Heey-Global/verity/compare/v4.4.2...v4.5.0) (2026-10-02)


### Features

* **mobile:** report heartbeat liveness in the tunnel summary ([#999](https://github.com/Heey-Global/verity/issues/999)) ([91a4e16](https://github.com/Heey-Global/verity/commit/91a4e162e13a9c488ab160dd4ea0f7c82fe745d1))
* **preview:** use six-digit PINs for every share duration ([#1004](https://github.com/Heey-Global/verity/issues/1004)) ([49d1695](https://github.com/Heey-Global/verity/commit/49d1695b61882c3839ff73c5985285571f708d05))


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.5.1 ([#987](https://github.com/Heey-Global/verity/issues/987)) ([894f335](https://github.com/Heey-Global/verity/commit/894f335c13ad56c9543fd07d2e7cb08b09fa8633))
* **knowledge:** keep sessions usable after source deletion ([#998](https://github.com/Heey-Global/verity/issues/998)) ([33e3495](https://github.com/Heey-Global/verity/commit/33e34958815559bf2a9f408b1387f55df2d9edbe))
* **mobile:** replace a tunnel attachment that goes dead without a close ([#1001](https://github.com/Heey-Global/verity/issues/1001)) ([03a83bb](https://github.com/Heey-Global/verity/commit/03a83bb95195f073f88c3785abf76a492238860b))
* **server:** repair session worktree deletion and review sandbox ([#995](https://github.com/Heey-Global/verity/issues/995)) ([49ac280](https://github.com/Heey-Global/verity/commit/49ac280d55f85d892c8e41588366eba519a02012))
* **session:** present usage limits without crash diagnostics ([#1005](https://github.com/Heey-Global/verity/issues/1005)) ([2830dab](https://github.com/Heey-Global/verity/commit/2830dabfb05425236e2c989d0897b210ffdcd079))

## [4.4.2](https://github.com/Heey-Global/verity/compare/v4.4.1...v4.4.2) (2026-10-02)


### Bug Fixes

* **server:** skip unchanged installation project writes ([#993](https://github.com/Heey-Global/verity/issues/993)) ([360175f](https://github.com/Heey-Global/verity/commit/360175fd61133c5a636ceee322419585a24f05b9))

## [4.4.1](https://github.com/Heey-Global/verity/compare/v4.4.0...v4.4.1) (2026-10-02)


### Bug Fixes

* **remote-control:** send stream data towards the app in 8 KiB frames ([#980](https://github.com/Heey-Global/verity/issues/980)) ([25db259](https://github.com/Heey-Global/verity/commit/25db259f9125a903ac7bd356847d82858ab20a41))
* **server:** handle missing preview containers and diagnose slow reads ([#992](https://github.com/Heey-Global/verity/issues/992)) ([6d0c313](https://github.com/Heey-Global/verity/commit/6d0c31376c4475a5fde1f17041830ad48a8bbbb8))

## [4.4.0](https://github.com/Heey-Global/verity/compare/v4.3.1...v4.4.0) (2026-10-01)


### Features

* **remote-control:** show Core's side of each tunnel stream in the app ([#978](https://github.com/Heey-Global/verity/issues/978)) ([b83532a](https://github.com/Heey-Global/verity/commit/b83532a64bf5b56d01fa7aa6eea40c3918eb9dee))

## [4.3.1](https://github.com/Heey-Global/verity/compare/v4.3.0...v4.3.1) (2026-10-01)


### Bug Fixes

* **previews:** accept public SSH volume subpaths ([#976](https://github.com/Heey-Global/verity/issues/976)) ([a1105f4](https://github.com/Heey-Global/verity/commit/a1105f48c96473fcf5421de15c1f8317a474e555))

## [4.3.0](https://github.com/Heey-Global/verity/compare/v4.2.0...v4.3.0) (2026-10-01)


### Features

* **remote-control:** show Core tunnel streams in mobile diagnostics ([#970](https://github.com/Heey-Global/verity/issues/970)) ([dcb210c](https://github.com/Heey-Global/verity/commit/dcb210cebda6ebe974f7db00b2018c14238fb0a2))


### Performance Improvements

* **mobile:** shorten session and settings loading paths ([#969](https://github.com/Heey-Global/verity/issues/969)) ([1447db8](https://github.com/Heey-Global/verity/commit/1447db8cd77819406a61592ea2f502f8064272e0))
* reuse pinned HTTP connections and cache event projections ([#975](https://github.com/Heey-Global/verity/issues/975)) ([aba7a34](https://github.com/Heey-Global/verity/commit/aba7a342800bae353675d05a51963aac38f8a79c))

## [4.2.0](https://github.com/Heey-Global/verity/compare/v4.1.1...v4.2.0) (2026-10-01)


### Features

* **google:** add session Calendar and Contacts with incremental consent ([#956](https://github.com/Heey-Global/verity/issues/956)) ([55bfcd6](https://github.com/Heey-Global/verity/commit/55bfcd626fbef940a07c93a3660cfae9c26939d9))
* **mobile:** redesign live meeting screen ([#951](https://github.com/Heey-Global/verity/issues/951)) ([999772f](https://github.com/Heey-Global/verity/commit/999772fedadca11579583186f400e2d12e34fab7))

## [4.1.1](https://github.com/Heey-Global/verity/compare/v4.1.0...v4.1.1) (2026-10-01)


### Bug Fixes

* **previews:** share standard mount contracts and tolerate gateway metadata ([#954](https://github.com/Heey-Global/verity/issues/954)) ([5c78442](https://github.com/Heey-Global/verity/commit/5c784427d82b8f764e8a4aede27bb44f7e19baf3))
* report a server update the Updater accepted instead of a failed start ([#947](https://github.com/Heey-Global/verity/issues/947)) ([6c830db](https://github.com/Heey-Global/verity/commit/6c830db7a6852a9a15baa4f9d9d0a296c1c91b08))

## [4.1.0](https://github.com/Heey-Global/verity/compare/v4.0.1...v4.1.0) (2026-10-01)


### Features

* **preview:** accept PIN from share URL query ([#944](https://github.com/Heey-Global/verity/issues/944)) ([2f9539d](https://github.com/Heey-Global/verity/commit/2f9539dc3d2e79249d43ec6ad9361298c0ddd279))


### Bug Fixes

* **deps:** update dependency sharp to v0.35.5 ([#942](https://github.com/Heey-Global/verity/issues/942)) ([6957589](https://github.com/Heey-Global/verity/commit/6957589b7b211401ea42ff579c4da81338820d32))
* **release:** keep mobile fixtures out of server releases ([#939](https://github.com/Heey-Global/verity/issues/939)) ([c90a278](https://github.com/Heey-Global/verity/commit/c90a2789ee338ece2d59636f15c5106df720a2c5))

## [4.0.1](https://github.com/Heey-Global/verity/compare/v4.0.0...v4.0.1) (2026-09-30)


### Bug Fixes

* **mobile:** adopt scene lifecycle to prevent iOS 27 launch crash ([#936](https://github.com/Heey-Global/verity/issues/936)) ([add0d0b](https://github.com/Heey-Global/verity/commit/add0d0b3b8632d20459b4bde5eba7656888866a8))

## [4.0.0](https://github.com/Heey-Global/verity/compare/v3.0.0...v4.0.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **mobile:** require iOS 27 for background inference ([#930](https://github.com/Heey-Global/verity/issues/930))

### Features

* **preview:** share session dev servers over Uplink ([#934](https://github.com/Heey-Global/verity/issues/934)) ([bdaeda2](https://github.com/Heey-Global/verity/commit/bdaeda2cad3a2767caf5935f90dba6891e1aa169))
* **session:** record structured ACP diagnostics for control plane ([#933](https://github.com/Heey-Global/verity/issues/933)) ([bc52cc4](https://github.com/Heey-Global/verity/commit/bc52cc47c9505f90dcae6156bc699285801ca156))


### Bug Fixes

* **mobile:** recover Remote Control over Uplink without VPN ([#931](https://github.com/Heey-Global/verity/issues/931)) ([f03c7c8](https://github.com/Heey-Global/verity/commit/f03c7c8a045acbecd00fa6055a4d5d8ed0cbcd4b))
* **mobile:** require iOS 27 for background inference ([#930](https://github.com/Heey-Global/verity/issues/930)) ([85c38ad](https://github.com/Heey-Global/verity/commit/85c38ad31c136c929446931eed76b2aebd0c01a4))

## [3.0.0](https://github.com/Heey-Global/verity/compare/v2.19.0...v3.0.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **tasks:** Remove GET /issues and /tasks routes and the mobile task API.

### Features

* **knowledge:** organize sources and approve shared publication ([#921](https://github.com/Heey-Global/verity/issues/921)) ([6d54422](https://github.com/Heey-Global/verity/commit/6d544226b3a011bfc5b932c99c10c70e08bdd5c3))
* **meeting:** add live speakers and in-screen answers ([#920](https://github.com/Heey-Global/verity/issues/920)) ([b88a606](https://github.com/Heey-Global/verity/commit/b88a60694407502a858bd74041d805c660a11cf1))
* **mobile:** print and share previewed files as PDF ([#925](https://github.com/Heey-Global/verity/issues/925)) ([3b0738d](https://github.com/Heey-Global/verity/commit/3b0738da6b694f605404945364a0e52f26db3285))
* **models:** add Codex Sol 6.1 and move Haiku to more models ([#918](https://github.com/Heey-Global/verity/issues/918)) ([e194ac3](https://github.com/Heey-Global/verity/commit/e194ac3734b49bd34ad6dc53003353a06d090073))


### Bug Fixes

* **deps:** update dependency ws to v8.22.0 ([#915](https://github.com/Heey-Global/verity/issues/915)) ([bd93af8](https://github.com/Heey-Global/verity/commit/bd93af8096d7ba058cb67a167fbad6ab22fb5d55))
* **session:** render Claude quick-action lists as choices ([#927](https://github.com/Heey-Global/verity/issues/927)) ([ce06f99](https://github.com/Heey-Global/verity/commit/ce06f99a987b43934465e0d523bc520d71e21016))


### Code Refactoring

* **tasks:** remove retired issues and plan board ([#922](https://github.com/Heey-Global/verity/issues/922)) ([663e4c5](https://github.com/Heey-Global/verity/commit/663e4c593ba03bc99884159362a1144ef8f26e8f))

## [2.19.0](https://github.com/Heey-Global/verity/compare/v2.18.0...v2.19.0) (2026-09-29)


### Features

* **meeting:** classify spoken requests and preserve note drafts ([#914](https://github.com/Heey-Global/verity/issues/914)) ([7d0446d](https://github.com/Heey-Global/verity/commit/7d0446da86ecf846ec9eb0a00961a49dcf14faeb))
* **preview:** add branded expired and unavailable pages ([#909](https://github.com/Heey-Global/verity/issues/909)) ([2fe1be7](https://github.com/Heey-Global/verity/commit/2fe1be7e409084917962a6b923583a83be55788b))
* **preview:** offer shares up to 30 days ([#912](https://github.com/Heey-Global/verity/issues/912)) ([bbe0ac5](https://github.com/Heey-Global/verity/commit/bbe0ac596a2ec3d74255294a76dc596441d86769))
* **preview:** save and share PINs across devices ([#905](https://github.com/Heey-Global/verity/issues/905)) ([209b276](https://github.com/Heey-Global/verity/commit/209b2762f8adaccf7f9e634723f7ba91f47bec3b))


### Bug Fixes

* **preview:** schedule expiry beyond Node timer limit ([#911](https://github.com/Heey-Global/verity/issues/911)) ([9a47096](https://github.com/Heey-Global/verity/commit/9a4709620fe65daf11cf7c65a7e70419c778602f))
* **preview:** simplify share status page copy ([#913](https://github.com/Heey-Global/verity/issues/913)) ([9237bd8](https://github.com/Heey-Global/verity/commit/9237bd86fcf2aac7a1d3169c0b8ab3c14e8ee295))
* **remote-control:** preserve native TLS causes and test production tunnel ([#904](https://github.com/Heey-Global/verity/issues/904)) ([443b6b8](https://github.com/Heey-Global/verity/commit/443b6b891e21c9c9b8daaf86e4d1a0e5aa9b1f77))

## [2.18.0](https://github.com/Heey-Global/verity/compare/v2.17.0...v2.18.0) (2026-09-29)


### Features

* **meeting:** analyze live transcripts for shared insights ([#894](https://github.com/Heey-Global/verity/issues/894)) ([bb10291](https://github.com/Heey-Global/verity/commit/bb102914f6176a27912f7a5537b0c5ee626d1294))
* **meeting:** compare live claims with project knowledge ([#900](https://github.com/Heey-Global/verity/issues/900)) ([08bbc2a](https://github.com/Heey-Global/verity/commit/08bbc2a475647fd33fcbd9deaddc3ad2eabf3878))
* **models:** add Claude Sonnet 5.5 ([#892](https://github.com/Heey-Global/verity/issues/892)) ([86d1246](https://github.com/Heey-Global/verity/commit/86d1246c9a036704099756250e41860e27fdbd1d))
* **preview:** brand public preview pages ([#902](https://github.com/Heey-Global/verity/issues/902)) ([b1ab656](https://github.com/Heey-Global/verity/commit/b1ab6561d171c7af0549e20335bad140e57f2010))


### Bug Fixes

* **preview:** serve session files and style public pages ([#896](https://github.com/Heey-Global/verity/issues/896)) ([a530286](https://github.com/Heey-Global/verity/commit/a530286e3b5408b2e0d6cbcc6205f9073a1ea798))
* **remote-control:** trace tunnel bytes and TLS probe progress ([#895](https://github.com/Heey-Global/verity/issues/895)) ([6ae6b8e](https://github.com/Heey-Global/verity/commit/6ae6b8ebfc8f9fc26893256fd80ea554cd076c43))

## [2.17.0](https://github.com/Heey-Global/verity/compare/v2.16.1...v2.17.0) (2026-09-29)


### Features

* **meeting:** sync live transcripts and notes across devices ([#888](https://github.com/Heey-Global/verity/issues/888)) ([3465ba7](https://github.com/Heey-Global/verity/commit/3465ba7ab3e3ad03730de1c519eeae1c2ce35c6f))


### Bug Fixes

* **preview:** trace Uplink share creation lifecycle ([#883](https://github.com/Heey-Global/verity/issues/883)) ([a70909c](https://github.com/Heey-Global/verity/commit/a70909c5a3729e410b1d5cad2eef82c5c6ffbd86))
* **release:** reconcile unpublished releases on every run and sweep for missed pushes ([#877](https://github.com/Heey-Global/verity/issues/877)) ([4a71b37](https://github.com/Heey-Global/verity/commit/4a71b371b8a5a983949c44d53ee9c972bebd569f))

## [2.16.1](https://github.com/Heey-Global/verity/compare/v2.16.0...v2.16.1) (2026-09-28)


### Bug Fixes

* **uplink:** unlock mobile credentials before remote startup ([#874](https://github.com/Heey-Global/verity/issues/874)) ([abcbfce](https://github.com/Heey-Global/verity/commit/abcbfce2682572df66a75c07375e9a7e511a0285))

## [2.16.0](https://github.com/Heey-Global/verity/compare/v2.15.0...v2.16.0) (2026-09-28)


### Features

* **mobile:** add iPad microphone shortcut ([#863](https://github.com/Heey-Global/verity/issues/863)) ([6a9f835](https://github.com/Heey-Global/verity/commit/6a9f835be4c9cc617a79440ceefe9cfcc714dcfe))
* **mobile:** add local live meeting capture with Nemotron ([#868](https://github.com/Heey-Global/verity/issues/868)) ([552764b](https://github.com/Heey-Global/verity/commit/552764b6ee199a9de7482108f356bd56b6256ac5))


### Bug Fixes

* **preview:** allow share creation beyond gateway timeout ([#869](https://github.com/Heey-Global/verity/issues/869)) ([669eb71](https://github.com/Heey-Global/verity/commit/669eb71d9c8145692661dbc6bf810d825244f8d5))
* **runner:** let worktree recovery restore Runner traverse and name refused spawn paths ([#873](https://github.com/Heey-Global/verity/issues/873)) ([3e7f9b7](https://github.com/Heey-Global/verity/commit/3e7f9b7d2e63fff7194fccb36d404cb0c7e337d0))

## [2.15.0](https://github.com/Heey-Global/verity/compare/v2.14.2...v2.15.0) (2026-09-28)


### Features

* **uplink:** add connection diagnostics to public preview settings ([#865](https://github.com/Heey-Global/verity/issues/865)) ([701b1d9](https://github.com/Heey-Global/verity/commit/701b1d9c0887f2589531ec6391530c62f11cfef2))

## [2.14.2](https://github.com/Heey-Global/verity/compare/v2.14.1...v2.14.2) (2026-09-28)


### Bug Fixes

* **mobile:** prepare native 1.40.0 after failed build ([#854](https://github.com/Heey-Global/verity/issues/854)) ([95dfb18](https://github.com/Heey-Global/verity/commit/95dfb181e038499bad2032f8604ddd9f33005a47))
* **release:** route native supersession as source change ([#856](https://github.com/Heey-Global/verity/issues/856)) ([44b38a5](https://github.com/Heey-Global/verity/commit/44b38a5fa489ac3218e6630c368680f82d194a33))
* **remote-control:** clarify mobile failures and trace connection stages ([#855](https://github.com/Heey-Global/verity/issues/855)) ([a6371e3](https://github.com/Heey-Global/verity/commit/a6371e31d9b1a0d544572398516a84e4f5a24bb9))
* **session:** externalize oversized ACP image updates ([#858](https://github.com/Heey-Global/verity/issues/858)) ([fd3609e](https://github.com/Heey-Global/verity/commit/fd3609e2252d7e6f9d6537e01afe45b276d75e97))

## [2.14.1](https://github.com/Heey-Global/verity/compare/v2.14.0...v2.14.1) (2026-09-28)


### Bug Fixes

* **remote-control:** stop dropping idle and long-lived sessions ([#849](https://github.com/Heey-Global/verity/issues/849)) ([1883b3a](https://github.com/Heey-Global/verity/commit/1883b3a0af37b615e898906f4147882602202f41))

## [2.14.0](https://github.com/Heey-Global/verity/compare/v2.13.3...v2.14.0) (2026-09-28)


### Features

* **mobile:** add live STT engine test screen ([#840](https://github.com/Heey-Global/verity/issues/840)) ([66e4954](https://github.com/Heey-Global/verity/commit/66e495472274729fdeb678c0785f099d6b1ce809))
* **preview:** share static session worktrees via Uplink ([#848](https://github.com/Heey-Global/verity/issues/848)) ([c46928f](https://github.com/Heey-Global/verity/commit/c46928f49085fec88dd35e5e20139b85872911d9))

## [2.13.3](https://github.com/Heey-Global/verity/compare/v2.13.2...v2.13.3) (2026-09-28)


### Bug Fixes

* **mobile:** avoid reset after remote stream completion ([#843](https://github.com/Heey-Global/verity/issues/843)) ([213085e](https://github.com/Heey-Global/verity/commit/213085ef169620be0c26457014f540030980ee68))
* **server:** allow standard mounts in public previews ([#842](https://github.com/Heey-Global/verity/issues/842)) ([3af16a9](https://github.com/Heey-Global/verity/commit/3af16a9fee80db187f073b058055a32a89ea4a6c))

## [2.13.2](https://github.com/Heey-Global/verity/compare/v2.13.1...v2.13.2) (2026-09-28)


### Bug Fixes

* **server:** tolerate reset after remote stream completion ([#839](https://github.com/Heey-Global/verity/issues/839)) ([e4370c3](https://github.com/Heey-Global/verity/commit/e4370c397efc1598d64622d533d135dfb2e46833))

## [2.13.1](https://github.com/Heey-Global/verity/compare/v2.13.0...v2.13.1) (2026-09-28)


### Bug Fixes

* **server:** retain remote data socket after peer stream reset ([#836](https://github.com/Heey-Global/verity/issues/836)) ([6e40d06](https://github.com/Heey-Global/verity/commit/6e40d06539951be4c83c33ee4870fe2bb97f679c))

## [2.13.0](https://github.com/Heey-Global/verity/compare/v2.12.0...v2.13.0) (2026-09-27)


### Features

* **slides:** insert images from session worktree ([#829](https://github.com/Heey-Global/verity/issues/829)) ([4d5c457](https://github.com/Heey-Global/verity/commit/4d5c457099b18349df3c4d75bff6b80965c7d768))

## [2.12.0](https://github.com/Heey-Global/verity/compare/v2.11.0...v2.12.0) (2026-09-27)


### Features

* **mobile:** connect paired devices through Uplink remote control ([#821](https://github.com/Heey-Global/verity/issues/821)) ([aa14320](https://github.com/Heey-Global/verity/commit/aa143201dd9338caa3238aba615fa572ced8a29f))

## [2.11.0](https://github.com/Heey-Global/verity/compare/v2.10.0...v2.11.0) (2026-09-27)


### Features

* **workspace:** allow all Docs and Sheets updates ([#817](https://github.com/Heey-Global/verity/issues/817)) ([4f1d7c2](https://github.com/Heey-Global/verity/commit/4f1d7c220ce30170e34c92270ac705fa7f017553))

## [2.10.0](https://github.com/Heey-Global/verity/compare/v2.9.1...v2.10.0) (2026-09-27)


### Features

* **server:** offer remote control through paired TLS by default ([#816](https://github.com/Heey-Global/verity/issues/816)) ([8ac307c](https://github.com/Heey-Global/verity/commit/8ac307c6d67ecc870c98b84d73c512fda7c7d781))
* **server:** opt in to Uplink remote control through TLS gateway ([#814](https://github.com/Heey-Global/verity/issues/814)) ([cae3afb](https://github.com/Heey-Global/verity/commit/cae3afb853b5619cbdc4a4d0104e16038df133d8))


### Bug Fixes

* **gmail:** remove unchanged draft after approved send ([#808](https://github.com/Heey-Global/verity/issues/808)) ([5a0f2a2](https://github.com/Heey-Global/verity/commit/5a0f2a29469cf7654611f861319729abdf34d1a0))
* **knowledge:** retire managed-library operations from verity_knowledge ([#813](https://github.com/Heey-Global/verity/issues/813)) ([29e62c2](https://github.com/Heey-Global/verity/commit/29e62c2b87d8642e2109258aed32c47605deda9a))
* **server:** stop certifying failed node_modules installs and bound the lock wait ([#809](https://github.com/Heey-Global/verity/issues/809)) ([72f4785](https://github.com/Heey-Global/verity/commit/72f4785a3a2d4e912f21a28cb2b5c92ccb288db7))

## [2.9.1](https://github.com/Heey-Global/verity/compare/v2.9.0...v2.9.1) (2026-09-27)


### Bug Fixes

* **server:** stop racing the node_modules install against postCreateCommand ([#804](https://github.com/Heey-Global/verity/issues/804)) ([cb9e9d4](https://github.com/Heey-Global/verity/commit/cb9e9d4a7d34db63c3d1742d76d13700e76649bb))

## [2.9.0](https://github.com/Heey-Global/verity/compare/v2.8.0...v2.9.0) (2026-09-26)


### Features

* **server:** add bounded remote control connector for existing TLS ingress ([#792](https://github.com/Heey-Global/verity/issues/792)) ([8e5c2a2](https://github.com/Heey-Global/verity/commit/8e5c2a2560c6ffaabd70b8aaa5349eac90f77247))
* **server:** negotiate remote control admission safely ([#786](https://github.com/Heey-Global/verity/issues/786)) ([46c3865](https://github.com/Heey-Global/verity/commit/46c386562d4a02561464576390666c207d952a43))
* **server:** reserve remote connector before session acceptance ([#790](https://github.com/Heey-Global/verity/issues/790)) ([0b3bccd](https://github.com/Heey-Global/verity/commit/0b3bccd94e4bcc3f963a3a315586b10b8aeb1c98))
* **server:** wire opt-in remote connector into Uplink control ([#793](https://github.com/Heey-Global/verity/issues/793)) ([69343eb](https://github.com/Heey-Global/verity/commit/69343ebf1abd755429f6748b32bea65b46acde15))


### Bug Fixes

* **session-links:** keep message approvals until decided ([#796](https://github.com/Heey-Global/verity/issues/796)) ([b1a2519](https://github.com/Heey-Global/verity/commit/b1a2519c80750590abddf86083ee5c4e55332488))

## [2.8.0](https://github.com/Heey-Global/verity/compare/v2.7.2...v2.8.0) (2026-09-26)


### Features

* **matrix:** extract text from chat images with the default model ([#784](https://github.com/Heey-Global/verity/issues/784)) ([99294e1](https://github.com/Heey-Global/verity/commit/99294e106cbbda83142a60522c9b8d483c98cc81))


### Bug Fixes

* **deps:** update dependency @agentclientprotocol/sdk to v1.5.0 ([#776](https://github.com/Heey-Global/verity/issues/776)) ([517d881](https://github.com/Heey-Global/verity/commit/517d8813dabd74376af013be953eb53345d49287))
* **deps:** update rust crate base64 to v0.23.1 ([#777](https://github.com/Heey-Global/verity/issues/777)) ([2b6d5b4](https://github.com/Heey-Global/verity/commit/2b6d5b46072b1e129c102872ac2bcdabfa3cf086))
* **deps:** update rust crate sha2 to 0.11 ([#778](https://github.com/Heey-Global/verity/issues/778)) ([a260a55](https://github.com/Heey-Global/verity/commit/a260a55faaeb73516f38f798097a39fcdfca7b27))

## [2.7.2](https://github.com/Heey-Global/verity/compare/v2.7.1...v2.7.2) (2026-09-26)


### Bug Fixes

* **matrix:** allow connector attachment requests through auth gate ([#779](https://github.com/Heey-Global/verity/issues/779)) ([08b0671](https://github.com/Heey-Global/verity/commit/08b0671602d3b991cc668e058c4f018aa73d4513))

## [2.7.1](https://github.com/Heey-Global/verity/compare/v2.7.0...v2.7.1) (2026-09-25)


### Bug Fixes

* **server:** advertise union gateway tools as flat object schemas ([#767](https://github.com/Heey-Global/verity/issues/767)) ([d671425](https://github.com/Heey-Global/verity/commit/d67142573559eb49569a352540cc02b9aaa9c1fe))

## [2.7.0](https://github.com/Heey-Global/verity/compare/v2.6.0...v2.7.0) (2026-09-25)


### Features

* **matrix:** import chat attachments into project knowledge ([#765](https://github.com/Heey-Global/verity/issues/765)) ([792ebd3](https://github.com/Heey-Global/verity/commit/792ebd37248b50c3cd7a2ae3f995bb592ec052bc))
* **server:** assign ownership to HTTP MCP connections ([#761](https://github.com/Heey-Global/verity/issues/761)) ([e252789](https://github.com/Heey-Global/verity/commit/e25278994167bd77168a3e7e531e2057a2f552ad))
* **server:** scope project overview to local memberships ([#762](https://github.com/Heey-Global/verity/issues/762)) ([ff4ecf7](https://github.com/Heey-Global/verity/commit/ff4ecf75166e6551abb49b1fe53b1062948a6e70))

## [2.6.0](https://github.com/Heey-Global/verity/compare/v2.5.1...v2.6.0) (2026-09-25)


### Features

* **store:** seed local users and project memberships ([#755](https://github.com/Heey-Global/verity/issues/755)) ([c2036fd](https://github.com/Heey-Global/verity/commit/c2036fd1ff14ec33030e12d23775745982723ad8))


### Bug Fixes

* **matrix:** discover auto-accepted rooms without leaving them ([#759](https://github.com/Heey-Global/verity/issues/759)) ([65ae4d4](https://github.com/Heey-Global/verity/commit/65ae4d4d0a1448c3cd3a83b2d9805c87456a90b7))
* **store:** reset users between shared test databases ([#760](https://github.com/Heey-Global/verity/issues/760)) ([82ce6b6](https://github.com/Heey-Global/verity/commit/82ce6b68737d40989584bc01350c16e0a8861a02))

## [2.5.1](https://github.com/Heey-Global/verity/compare/v2.5.0...v2.5.1) (2026-09-25)


### Bug Fixes

* **sandbox:** close the Claude CLI's cross-session inbox ([#751](https://github.com/Heey-Global/verity/issues/751)) ([6126371](https://github.com/Heey-Global/verity/commit/61263718be50300c357319e76a12545672ece364))
* **server:** let sessions in sleeping projects be linked and messaged ([#750](https://github.com/Heey-Global/verity/issues/750)) ([a780078](https://github.com/Heey-Global/verity/commit/a78007897cf9e58f151a980f31c10ce39094739c))

## [2.5.0](https://github.com/Heey-Global/verity/compare/v2.4.1...v2.5.0) (2026-09-25)


### Features

* **integrations:** manage Matrix connector after account setup ([#734](https://github.com/Heey-Global/verity/issues/734)) ([b900c70](https://github.com/Heey-Global/verity/commit/b900c70be434d771698a45ed8d398757a7d82221))
* **sessions:** link agents across projects ([#736](https://github.com/Heey-Global/verity/issues/736)) ([70f9184](https://github.com/Heey-Global/verity/commit/70f9184c48f7515fa982154c996213f960d0102e))

## [2.4.1](https://github.com/Heey-Global/verity/compare/v2.4.0...v2.4.1) (2026-09-25)


### Bug Fixes

* **mobile:** open project settings directly ([#731](https://github.com/Heey-Global/verity/issues/731)) ([7168c69](https://github.com/Heey-Global/verity/commit/7168c69294e45d9cd087a1bc659286423f4f6fc4))
* **sessions:** exclude worktree metadata from moves ([#726](https://github.com/Heey-Global/verity/issues/726)) ([c5ffe27](https://github.com/Heey-Global/verity/commit/c5ffe271681d26e16e802247ddf7b8a3c0d07403))

## [2.4.0](https://github.com/Heey-Global/verity/compare/v2.3.0...v2.4.0) (2026-09-25)


### Features

* **sessions:** move sessions between local projects ([#708](https://github.com/Heey-Global/verity/issues/708)) ([e16056b](https://github.com/Heey-Global/verity/commit/e16056b251ddcccd87fca58f82dcbf9f9cd71756))


### Bug Fixes

* **integrations:** configure Matrix account in Verity settings ([#714](https://github.com/Heey-Global/verity/issues/714)) ([c89df9d](https://github.com/Heey-Global/verity/commit/c89df9d345be0a5a4eb98a78b376642e92e91f0d))
* **mobile:** move Matrix settings under Connected services ([#723](https://github.com/Heey-Global/verity/issues/723)) ([992d172](https://github.com/Heey-Global/verity/commit/992d1726ea1f4512ed94dd2fb0e7babd138e56e5))
* **release:** discover pending merges without the search index ([#720](https://github.com/Heey-Global/verity/issues/720)) ([97a4e43](https://github.com/Heey-Global/verity/commit/97a4e439d5bc7ad2b28a32a8e8643b3339ddeaaa))

## [2.3.0](https://github.com/Heey-Global/verity/compare/v2.2.0...v2.3.0) (2026-09-24)


### Features

* **integrations:** import Matrix chats into project knowledge ([#703](https://github.com/Heey-Global/verity/issues/703)) ([974d14b](https://github.com/Heey-Global/verity/commit/974d14bcc6491312c4584e5d352235f12f8cfab4))
* **knowledge:** preserve reusable insights proactively ([#705](https://github.com/Heey-Global/verity/issues/705)) ([f2e4779](https://github.com/Heey-Global/verity/commit/f2e4779ad17c1476f1f6f1a2e3f4b8d8cdf026b0))


### Bug Fixes

* **sandbox:** isolate approved scripts under gVisor ([#702](https://github.com/Heey-Global/verity/issues/702)) ([965ef61](https://github.com/Heey-Global/verity/commit/965ef61000049694b0e3d6198026125ceddc73dc))

## [2.2.0](https://github.com/Heey-Global/verity/compare/v2.1.2...v2.2.0) (2026-09-24)


### Features

* **drive:** browse shared drives ([#688](https://github.com/Heey-Global/verity/issues/688)) ([8b270d6](https://github.com/Heey-Global/verity/commit/8b270d60860c3723ab04cdb6cd9b5b55006b8f8b))
* **gmail:** require approval before sending drafts ([#692](https://github.com/Heey-Global/verity/issues/692)) ([24481ab](https://github.com/Heey-Global/verity/commit/24481ab2491c1a198a9c2bc2d68b7f61cb234b92))


### Bug Fixes

* **mobile:** bound OTA release metadata ([#696](https://github.com/Heey-Global/verity/issues/696)) ([bffc526](https://github.com/Heey-Global/verity/commit/bffc526b83ba2ef0f258eb1539e473f116ccd688))
* **models:** remove Claude Opus 5 from the model picker ([#690](https://github.com/Heey-Global/verity/issues/690)) ([9e3fdf5](https://github.com/Heey-Global/verity/commit/9e3fdf50601d74c161ccc755363a4881d17c99f1))
* **relay:** retry automatic DNS port collisions ([#691](https://github.com/Heey-Global/verity/issues/691)) ([037be56](https://github.com/Heey-Global/verity/commit/037be568e64a49c68b572d60dd57ce162f8b6918))
* **release:** bound lifecycle release metadata ([#694](https://github.com/Heey-Global/verity/issues/694)) ([6e127a2](https://github.com/Heey-Global/verity/commit/6e127a231f3e99cff72c5153ab757c86b5cf4337))
* **release:** ignore obsolete mobile drafts ([#698](https://github.com/Heey-Global/verity/issues/698)) ([d1de610](https://github.com/Heey-Global/verity/commit/d1de61016df9b7de99c9cdc08b5b888fb6284e14))
* **server:** avoid duplicate dependency volume mounts ([#687](https://github.com/Heey-Global/verity/issues/687)) ([4cfe3c9](https://github.com/Heey-Global/verity/commit/4cfe3c96620e10b74f693ded336a08c0deb81c9a))
* **server:** confirm pull request merge after lost response ([#697](https://github.com/Heey-Global/verity/issues/697)) ([1dacbaf](https://github.com/Heey-Global/verity/commit/1dacbaf98906a45a7be915b558b9bc71eea6707a))
* **server:** stop reporting an unrecorded sandbox toolkit as possible drift ([#686](https://github.com/Heey-Global/verity/issues/686)) ([9a7f8de](https://github.com/Heey-Global/verity/commit/9a7f8de44a0e24ad85fa59b7d909c95de8a6bec3))

## [2.1.2](https://github.com/Heey-Global/verity/compare/v2.1.1...v2.1.2) (2026-09-24)


### Bug Fixes

* **server:** validate public preview artifacts ([#673](https://github.com/Heey-Global/verity/issues/673)) ([3f15f06](https://github.com/Heey-Global/verity/commit/3f15f06e63ef82d82d6c1b5687343cc626de3840))
* **session:** retain MCP when ACP capability is omitted ([#681](https://github.com/Heey-Global/verity/issues/681)) ([d398eee](https://github.com/Heey-Global/verity/commit/d398eeefa379fb676b04d2bf37c303de9925a672))
* **session:** settle turns stuck running after their sandbox dies ([#674](https://github.com/Heey-Global/verity/issues/674)) ([6a80102](https://github.com/Heey-Global/verity/commit/6a8010293c698ad54529ef15c662662cb0cc360a))


### Performance Improvements

* **sandbox:** cache Node dependencies outside the gVisor shared mount ([#682](https://github.com/Heey-Global/verity/issues/682)) ([e18eec3](https://github.com/Heey-Global/verity/commit/e18eec31472e4dc5aac6ab2b8d82f3b37ccb8791))

## [2.1.1](https://github.com/Heey-Global/verity/compare/v2.1.0...v2.1.1) (2026-09-24)


### Bug Fixes

* **models:** expose GPT-6 Sol and Luna ([#676](https://github.com/Heey-Global/verity/issues/676)) ([90ad41b](https://github.com/Heey-Global/verity/commit/90ad41b9efde003d17d0080d9b465f2053c9f70f))
* **slides:** support uploaded and remote images ([#677](https://github.com/Heey-Global/verity/issues/677)) ([43299ba](https://github.com/Heey-Global/verity/commit/43299ba1c4049cb85c6df35d41acda38db03b632))

## [2.1.0](https://github.com/Heey-Global/verity/compare/v2.0.0...v2.1.0) (2026-09-24)


### Features

* **drive:** connect project folders ([#669](https://github.com/Heey-Global/verity/issues/669)) ([2fe210e](https://github.com/Heey-Global/verity/commit/2fe210e63e42c4fffd36ba9628cd92b1f036b7a8))
* **gmail:** add session reading and drafts ([#670](https://github.com/Heey-Global/verity/issues/670)) ([37f2e61](https://github.com/Heey-Global/verity/commit/37f2e6118859f75afee17f0d55f0ba45ab0072e1))


### Bug Fixes

* **sandbox:** size gVisor project sandboxes for their real load ([#675](https://github.com/Heey-Global/verity/issues/675)) ([c6b9965](https://github.com/Heey-Global/verity/commit/c6b9965e0ff94dfff4d5d0d6298b14e9b74bf21f))

## [2.0.0](https://github.com/Heey-Global/verity/compare/v1.5.4...v2.0.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* **sandbox:** the verity-sandbox-toolkit Feature no longer accepts `installPi` / `piVersion`, and images built from it carry no `pi` binary.

### Features

* **models:** add Claude Opus 5.5 ([#667](https://github.com/Heey-Global/verity/issues/667)) ([73b4df4](https://github.com/Heey-Global/verity/commit/73b4df4e07675c5e105ed97ed989c01b2a0426b7))


### Miscellaneous Chores

* **sandbox:** drop the pi coding agent ([#666](https://github.com/Heey-Global/verity/issues/666)) ([20ed9d2](https://github.com/Heey-Global/verity/commit/20ed9d2b2d20e40b81bb05dd89fba9f8eb026547))

## [1.5.4](https://github.com/Heey-Global/verity/compare/v1.5.3...v1.5.4) (2026-09-23)


### Bug Fixes

* **relay:** answer DNS for gVisor project sandboxes through the relay ([#664](https://github.com/Heey-Global/verity/issues/664)) ([451c4f6](https://github.com/Heey-Global/verity/commit/451c4f6499043dbbc32dccd754c0ba24142c0245))

## [1.5.3](https://github.com/Heey-Global/verity/compare/v1.5.2...v1.5.3) (2026-09-23)


### Bug Fixes

* **deploy:** reconcile host Docker runtimes before activating a release ([#660](https://github.com/Heey-Global/verity/issues/660)) ([b5053a3](https://github.com/Heey-Global/verity/commit/b5053a345e5ac661e5188c46d18dcc428c107eb7))

## [1.5.2](https://github.com/Heey-Global/verity/compare/v1.5.1...v1.5.2) (2026-09-23)


### Bug Fixes

* **runner:** run project sandboxes under a gVisor runtime that can host the Runner ([#658](https://github.com/Heey-Global/verity/issues/658)) ([d79c42c](https://github.com/Heey-Global/verity/commit/d79c42c7533ad1538426ef25a2f40962cc1d9fa0))

## [1.5.1](https://github.com/Heey-Global/verity/compare/v1.5.0...v1.5.1) (2026-09-23)


### Bug Fixes

* **runner:** start the Runner when the sandbox runtime lacks Landlock ([#656](https://github.com/Heey-Global/verity/issues/656)) ([60650cd](https://github.com/Heey-Global/verity/commit/60650cd0e9b21b808d959b7f0ff213d94cc0eef1))

## [1.5.0](https://github.com/Heey-Global/verity/compare/v1.4.9...v1.5.0) (2026-09-23)


### Features

* **explorer:** delete files across roots ([#647](https://github.com/Heey-Global/verity/issues/647)) ([eb35172](https://github.com/Heey-Global/verity/commit/eb35172f39863b0f1635f9012b020be429866adb))
* **knowledge:** add writable insights and shared publishing ([#651](https://github.com/Heey-Global/verity/issues/651)) ([917d95b](https://github.com/Heey-Global/verity/commit/917d95beac1efd9c48c9663d0803f807987239a2))


### Bug Fixes

* **attachments:** report empty files before send ([#648](https://github.com/Heey-Global/verity/issues/648)) ([7ea0d65](https://github.com/Heey-Global/verity/commit/7ea0d65570c8577478f665c30942a25f4c72c8cd))
* **knowledge:** preserve Unicode attachment names ([#646](https://github.com/Heey-Global/verity/issues/646)) ([9040ca7](https://github.com/Heey-Global/verity/commit/9040ca70585e96d74f3fc2eef20e55b221faecd4))

## [1.4.9](https://github.com/Heey-Global/verity/compare/v1.4.8...v1.4.9) (2026-09-22)


### Bug Fixes

* **store:** clear session log rows in the legacy Wiki cleanup ([#644](https://github.com/Heey-Global/verity/issues/644)) ([c4942ce](https://github.com/Heey-Global/verity/commit/c4942ceb972cf2c6d9bdede480ad0ee7f06346f5)), closes [#643](https://github.com/Heey-Global/verity/issues/643)

## [1.4.8](https://github.com/Heey-Global/verity/compare/v1.4.7...v1.4.8) (2026-09-22)


### Bug Fixes

* **knowledge:** retire legacy Wiki job writes ([#642](https://github.com/Heey-Global/verity/issues/642)) ([c209088](https://github.com/Heey-Global/verity/commit/c2090880ae2eea18f5f8c4ba7d64897b6eb6c3ea))
* **server:** forward knowledge data root ([#641](https://github.com/Heey-Global/verity/issues/641)) ([262c0cc](https://github.com/Heey-Global/verity/commit/262c0cc8071292f6695b93f5f347ede5735fdb45))
* **server:** forward Uplink control-plane dependencies ([#638](https://github.com/Heey-Global/verity/issues/638)) ([1b9eff6](https://github.com/Heey-Global/verity/commit/1b9eff6d594904cbd7d9bc552fdc1334d43c522d))

## [1.4.7](https://github.com/Heey-Global/verity/compare/v1.4.6...v1.4.7) (2026-09-22)


### Bug Fixes

* **files:** verify knowledge explorer roots ([#629](https://github.com/Heey-Global/verity/issues/629)) ([d0bb634](https://github.com/Heey-Global/verity/commit/d0bb63468377183861538a6da5dbc215db1d26b5))
* **server:** recover from stalled Uplink lease close ([#632](https://github.com/Heey-Global/verity/issues/632)) ([8203fd5](https://github.com/Heey-Global/verity/commit/8203fd5d4d086948963a5ab8338eaac482809dcc))

## [1.4.6](https://github.com/Heey-Global/verity/compare/v1.4.5...v1.4.6) (2026-09-22)


### Bug Fixes

* **deps:** update dependency @fastify/websocket to v11.3.1 ([#621](https://github.com/Heey-Global/verity/issues/621)) ([e8ef31a](https://github.com/Heey-Global/verity/commit/e8ef31ade26373a2df850cdfc60a9adf87299a36))

## [1.4.5](https://github.com/Heey-Global/verity/compare/v1.4.4...v1.4.5) (2026-09-21)


### Bug Fixes

* **server:** preserve active sandbox wake state ([#609](https://github.com/Heey-Global/verity/issues/609)) ([ace8380](https://github.com/Heey-Global/verity/commit/ace8380533407660be4aa04d2e3c2c323700cd20))
* **server:** preserve sleeping sandbox on inspect failure ([#612](https://github.com/Heey-Global/verity/issues/612)) ([a9612a0](https://github.com/Heey-Global/verity/commit/a9612a0d7127482f3bd848c198cb0ead88f03132))
* **server:** report live public preview availability ([#611](https://github.com/Heey-Global/verity/issues/611)) ([fa284e4](https://github.com/Heey-Global/verity/commit/fa284e416698936de28a4b50bb8377e00d5a8571))

## [1.4.4](https://github.com/Heey-Global/verity/compare/v1.4.3...v1.4.4) (2026-09-21)


### Bug Fixes

* **server:** reconcile sandbox gateway identities ([#604](https://github.com/Heey-Global/verity/issues/604)) ([a0cb3ee](https://github.com/Heey-Global/verity/commit/a0cb3ee19cb429513aab107007a3616ff1a269fc))
* **status:** stop badging transient Sandbox lifecycle failures as crashed ([#605](https://github.com/Heey-Global/verity/issues/605)) ([b67908a](https://github.com/Heey-Global/verity/commit/b67908a92d4ae0962d85e5bad72a13bdbbcf10d2))

## [1.4.3](https://github.com/Heey-Global/verity/compare/v1.4.2...v1.4.3) (2026-09-21)


### Bug Fixes

* **knowledge:** restore Wiki runtime traversal ([#601](https://github.com/Heey-Global/verity/issues/601)) ([a79bb0c](https://github.com/Heey-Global/verity/commit/a79bb0c0eb95d09a8810583d930d9b92a262d7ba))
* **server:** persist Uplink identity before cleanup ([#600](https://github.com/Heey-Global/verity/issues/600)) ([ed6d3e1](https://github.com/Heey-Global/verity/commit/ed6d3e11311abb7700a6402c8da0de211698c30d))

## [1.4.2](https://github.com/Heey-Global/verity/compare/v1.4.1...v1.4.2) (2026-09-21)


### Bug Fixes

* **knowledge:** complete isolated home before ownership handoff ([#597](https://github.com/Heey-Global/verity/issues/597)) ([7373344](https://github.com/Heey-Global/verity/commit/7373344de46ec3c591ed15c22f386a4392d7cd99))
* **mobile:** restage OTA after promotion ([#592](https://github.com/Heey-Global/verity/issues/592)) ([4d9b9b4](https://github.com/Heey-Global/verity/commit/4d9b9b45922a4ad6ec85ea75f7d918671377c2d4))

## [1.4.1](https://github.com/Heey-Global/verity/compare/v1.4.0...v1.4.1) (2026-09-21)


### Bug Fixes

* **knowledge:** require a global maintenance model ([#590](https://github.com/Heey-Global/verity/issues/590)) ([fa8b5b1](https://github.com/Heey-Global/verity/commit/fa8b5b1360b979e2805cdd80aaa9341280ed56bd))
* **server:** spawn into sleeping projects without reprovisioning ([#586](https://github.com/Heey-Global/verity/issues/586)) ([6bc4c45](https://github.com/Heey-Global/verity/commit/6bc4c45262ce326bbbe7e015683f10b4b5476bb6))
* **server:** wire Uplink control logging ([#589](https://github.com/Heey-Global/verity/issues/589)) ([5cd3a19](https://github.com/Heey-Global/verity/commit/5cd3a1970fd020664d22361e9a23385fc6f0ff3e))

## [1.4.0](https://github.com/Heey-Global/verity/compare/v1.3.3...v1.4.0) (2026-09-21)


### Features

* **knowledge:** automate wiki maintenance ([#566](https://github.com/Heey-Global/verity/issues/566)) ([6e77fe9](https://github.com/Heey-Global/verity/commit/6e77fe9ece6a1655d6fbf89a93af271221da79a9))
* **mobile:** show transient dependency status ([#579](https://github.com/Heey-Global/verity/issues/579)) ([422e76f](https://github.com/Heey-Global/verity/commit/422e76fab7420db941b09280755ea1ea79efcecb))


### Bug Fixes

* **deps:** update dependency fastify to v5.12.5 ([#576](https://github.com/Heey-Global/verity/issues/576)) ([5dc33b1](https://github.com/Heey-Global/verity/commit/5dc33b1b4f9f094ebe8a6060448ea6c5e0e05cf2))
* **server:** serialize wiki maintenance debounce writes ([#584](https://github.com/Heey-Global/verity/issues/584)) ([c2ddc37](https://github.com/Heey-Global/verity/commit/c2ddc3724cb81b58beb983ea0950f6a63cad858b))
* **uplink:** recover from temporary control refusals ([#582](https://github.com/Heey-Global/verity/issues/582)) ([1be7402](https://github.com/Heey-Global/verity/commit/1be74027198693d47fe94a024a3f129f3eaebdce))


### Performance Improvements

* **server:** read the overview projection as a bounded tail ([#583](https://github.com/Heey-Global/verity/issues/583)) ([75bc53c](https://github.com/Heey-Global/verity/commit/75bc53c3398cd821338953f10e9897c4bcb236a8))
* **store:** sum session token totals in SQL ([#581](https://github.com/Heey-Global/verity/issues/581)) ([b005737](https://github.com/Heey-Global/verity/commit/b005737229c237acf514d6eecfe8c8cd9ef255c9))

## [1.3.3](https://github.com/Heey-Global/verity/compare/v1.3.2...v1.3.3) (2026-09-20)


### Bug Fixes

* **server:** diagnose MCP gateway bearer rejection ([#562](https://github.com/Heey-Global/verity/issues/562)) ([e160bb7](https://github.com/Heey-Global/verity/commit/e160bb71491e0f593ae86a7833a9c753dbf58e70))
* **server:** exclude waking turn from busy check ([#564](https://github.com/Heey-Global/verity/issues/564)) ([a80392c](https://github.com/Heey-Global/verity/commit/a80392ce871efc16b2641d07959e8b7c3e39b03d))

## [1.3.2](https://github.com/Heey-Global/verity/compare/v1.3.1...v1.3.2) (2026-09-20)


### Bug Fixes

* **knowledge:** hide unadded repositories ([#556](https://github.com/Heey-Global/verity/issues/556)) ([c4a7c64](https://github.com/Heey-Global/verity/commit/c4a7c64e8eb19ca3d52cdd75d710cdfe3065682c))
* **server:** wake sleeping sandbox on session turn ([#559](https://github.com/Heey-Global/verity/issues/559)) ([471d9c6](https://github.com/Heey-Global/verity/commit/471d9c6e7389a54c57ac84458901cb4217c21a3a))


### Performance Improvements

* **server:** scope large body limits to upload routes ([#555](https://github.com/Heey-Global/verity/issues/555)) ([ca5ee6e](https://github.com/Heey-Global/verity/commit/ca5ee6e2ed3f7750284d0576f1fb78dbbe80feb0))

## [1.3.1](https://github.com/Heey-Global/verity/compare/v1.3.0...v1.3.1) (2026-09-20)


### Performance Improvements

* **server:** bound activity projection reads ([#557](https://github.com/Heey-Global/verity/issues/557)) ([87eb98e](https://github.com/Heey-Global/verity/commit/87eb98eb6ad3058bbeb7b5e8aee08c50420bd943))

## [1.3.0](https://github.com/Heey-Global/verity/compare/v1.2.0...v1.3.0) (2026-09-20)


### Features

* **knowledge:** add managed project wikis ([#539](https://github.com/Heey-Global/verity/issues/539)) ([f9476a3](https://github.com/Heey-Global/verity/commit/f9476a3b79850d911d2c63bcf363189d450d0f4b))
* **server:** add operator-only memory diagnostics route ([#551](https://github.com/Heey-Global/verity/issues/551)) ([6f9db14](https://github.com/Heey-Global/verity/commit/6f9db14d006a7ff2b2141eb25e441af55d6644fc))


### Bug Fixes

* **server:** make sandbox idle sleep unconditional ([#549](https://github.com/Heey-Global/verity/issues/549)) ([c4bc3c7](https://github.com/Heey-Global/verity/commit/c4bc3c758c48fb42e27a1509024b8f2dc6c1441f))

## [1.2.0](https://github.com/Heey-Global/verity/compare/v1.1.0...v1.2.0) (2026-09-20)


### Features

* **server:** sleep idle project sandboxes ([#547](https://github.com/Heey-Global/verity/issues/547)) ([9ade70a](https://github.com/Heey-Global/verity/commit/9ade70a7ae9e9caf2dedd1a7131bed88a8fad430))
* **server:** wake sleeping projects for queued work ([#544](https://github.com/Heey-Global/verity/issues/544)) ([cdbe23b](https://github.com/Heey-Global/verity/commit/cdbe23b4547744df1f497492bd83e388b056e23e))


### Bug Fixes

* **sandbox:** serialize Codex SQLite initialization ([#542](https://github.com/Heey-Global/verity/issues/542)) ([d65a73d](https://github.com/Heey-Global/verity/commit/d65a73de17395ae4518b6bba4cbca239bb6d869b))

## [1.1.0](https://github.com/Heey-Global/verity/compare/v1.0.0...v1.1.0) (2026-09-20)


### Features

* **server:** add project sandbox sleep and wake ([#538](https://github.com/Heey-Global/verity/issues/538)) ([5e8054b](https://github.com/Heey-Global/verity/commit/5e8054b8f938b20ddc3a7b7ffd57509bdde942de))

## [1.0.0](https://github.com/Heey-Global/verity/compare/v0.17.0...v1.0.0) (2026-09-20)


### ⚠ BREAKING CHANGES

* **control-plane:** the control-plane Runner must be recreated after the Server image is deployed, in that order. A Runner from an older image refuses OpenCode turns at the spawn broker; one with an older spec runs OpenCode without its provider configuration. Claude and Codex control-plane turns are unaffected by either. Managed deployments reconcile themselves; Compose deployments recreate the Runner by hand. See docs/runbooks/opencode-brokered-tools-container-refresh.md.
* **secrets:** admit OpenCode to the brokered Verity tools ([#527](https://github.com/Heey-Global/verity/issues/527))

### Features

* **control-plane:** run OpenCode turns on the dedicated Runner ([#532](https://github.com/Heey-Global/verity/issues/532)) ([eb39376](https://github.com/Heey-Global/verity/commit/eb3937607c3d35a21198f1e3d9a1d7567a66ff47))
* **secrets:** admit OpenCode to the brokered Verity tools ([#527](https://github.com/Heey-Global/verity/issues/527)) ([b3a440e](https://github.com/Heey-Global/verity/commit/b3a440eec7c0581453e3e98876340a54130eb05e))
* **server:** retain recent Verity release images ([#536](https://github.com/Heey-Global/verity/issues/536)) ([788d3ea](https://github.com/Heey-Global/verity/commit/788d3ea540271ed4e36dd9aee2c24a208acfe936))


### Bug Fixes

* **knowledge:** streamline explorer and enable access across model backends ([#531](https://github.com/Heey-Global/verity/issues/531)) ([d213999](https://github.com/Heey-Global/verity/commit/d213999edc8f4eabcee56952420f47eeee880744))


### Performance Improvements

* **server:** load companion runtimes without the server module graph ([#534](https://github.com/Heey-Global/verity/issues/534)) ([b9d18e6](https://github.com/Heey-Global/verity/commit/b9d18e615fa3689b60ee4c025afbdc111d512a62))

## [0.17.0](https://github.com/Heey-Global/verity/compare/v0.16.4...v0.17.0) (2026-09-20)


### Features

* add managed knowledge library with project access grants ([#526](https://github.com/Heey-Global/verity/issues/526)) ([e92ca3b](https://github.com/Heey-Global/verity/commit/e92ca3b8701c798406536aa46129daa19ec128b3))

## [0.16.4](https://github.com/Heey-Global/verity/compare/v0.16.3...v0.16.4) (2026-09-19)


### Bug Fixes

* **update:** recover generation server deployments ([#517](https://github.com/Heey-Global/verity/issues/517)) ([d946bb7](https://github.com/Heey-Global/verity/commit/d946bb7c6e4647fe7fa5590283a2ca3a77e98dec))
* **workspace:** invalidate access token after reconnect ([#521](https://github.com/Heey-Global/verity/issues/521)) ([aaa236d](https://github.com/Heey-Global/verity/commit/aaa236d62fe3c72f56c4243c37d27a6f2300b381))

## [0.16.3](https://github.com/Heey-Global/verity/compare/v0.16.2...v0.16.3) (2026-09-19)


### Bug Fixes

* **update:** permit verified forward schema upgrades ([#516](https://github.com/Heey-Global/verity/issues/516)) ([163568a](https://github.com/Heey-Global/verity/commit/163568a971eeae500e8622ac40786adaeb2ccc45))
* **update:** recover blocked updates through verified schema bridges ([#513](https://github.com/Heey-Global/verity/issues/513)) ([140a89f](https://github.com/Heey-Global/verity/commit/140a89ff90cb2141bb116ccd2103173ea0cdf179))
* **workspace:** use shared Google OAuth client ([#515](https://github.com/Heey-Global/verity/issues/515)) ([3f16de1](https://github.com/Heey-Global/verity/commit/3f16de1c80543c75d4e5b48fde0add8e81214b7e))

## [0.16.2](https://github.com/Heey-Global/verity/compare/v0.16.1...v0.16.2) (2026-09-19)


### Bug Fixes

* **workspace:** add Google OAuth client ID setting ([#510](https://github.com/Heey-Global/verity/issues/510)) ([d9c4217](https://github.com/Heey-Global/verity/commit/d9c4217c8ca5ea445915477d49295a889b7ee043))

## [0.16.1](https://github.com/Heey-Global/verity/compare/v0.16.0...v0.16.1) (2026-09-19)


### Bug Fixes

* **release:** gate updates on image schema compatibility ([#507](https://github.com/Heey-Global/verity/issues/507)) ([03eebe6](https://github.com/Heey-Global/verity/commit/03eebe690897bf5cf36a8413a0b7bc518bdccd95))

## [0.16.0](https://github.com/Heey-Global/verity/compare/v0.15.1...v0.16.0) (2026-09-19)


### Features

* **workspace:** edit Google Docs and Sheets ([#503](https://github.com/Heey-Global/verity/issues/503)) ([d72ae01](https://github.com/Heey-Global/verity/commit/d72ae0163f5af3a64e448b766bb185ff2a5fd492))


### Bug Fixes

* **mobile:** retire answered permission prompts ([#502](https://github.com/Heey-Global/verity/issues/502)) ([2608a21](https://github.com/Heey-Global/verity/commit/2608a213d537cbc2362ede645d03e654c94b104a))
* **secrets:** load legacy trusted CLI policies ([#504](https://github.com/Heey-Global/verity/issues/504)) ([a728ae8](https://github.com/Heey-Global/verity/commit/a728ae80707af002a1ecc9013412d3b0bffc3f8e))
* **server:** answer project fold writes from the written row ([#497](https://github.com/Heey-Global/verity/issues/497)) ([d5620ac](https://github.com/Heey-Global/verity/commit/d5620ac6fe6e34a27dc0c16fa4020159ed9fedec))

## [0.15.1](https://github.com/Heey-Global/verity/compare/v0.15.0...v0.15.1) (2026-09-19)


### Bug Fixes

* **deps:** update dependency kysely to v0.29.6 ([#488](https://github.com/Heey-Global/verity/issues/488)) ([5c45bb6](https://github.com/Heey-Global/verity/commit/5c45bb62d8e4406918b29bd9c5d5db64e083c8d0))
* **secrets:** accept approved dynamic directory arguments and expose validation rules ([#495](https://github.com/Heey-Global/verity/issues/495)) ([127d6df](https://github.com/Heey-Global/verity/commit/127d6df24a5bca1ded72e60100849ad48cba5ff4))

## [0.15.0](https://github.com/Heey-Global/verity/compare/v0.14.0...v0.15.0) (2026-09-18)


### Features

* **mobile:** improve paired device management ([#469](https://github.com/Heey-Global/verity/issues/469)) ([f16b76d](https://github.com/Heey-Global/verity/commit/f16b76de124619b75a689a668d16bd4122e544cb))
* **secrets:** support generic credential headers ([#481](https://github.com/Heey-Global/verity/issues/481)) ([9a3c217](https://github.com/Heey-Global/verity/commit/9a3c2170a9d3c454b490807b038c6fd77bfe3cb5))


### Bug Fixes

* **release:** preserve toolkit provenance in valid metadata ([#471](https://github.com/Heey-Global/verity/issues/471)) ([d01f7e1](https://github.com/Heey-Global/verity/commit/d01f7e1d7d32594ac37c4bfb7a045e88967dfe98))

## [0.14.0](https://github.com/Heey-Global/verity/compare/v0.13.2...v0.14.0) (2026-09-18)


### Features

* **opencode:** add reliable model selection ([#453](https://github.com/Heey-Global/verity/issues/453)) ([12e715e](https://github.com/Heey-Global/verity/commit/12e715e41d5859a91b96afa8465caf5d39b1251e))


### Bug Fixes

* **installer:** repair stopped servers and automate installed acceptance ([#458](https://github.com/Heey-Global/verity/issues/458)) ([851159f](https://github.com/Heey-Global/verity/commit/851159fb95d074fcc3fb3a9d16261ce3364f8f47))
* **mobile:** search OpenCode models and preserve availability selections ([#462](https://github.com/Heey-Global/verity/issues/462)) ([56d8a94](https://github.com/Heey-Global/verity/commit/56d8a94a1aa41d9e14ccaf1fb4aa8918f536d2c1))
* **release:** ignore stale server release drafts ([#461](https://github.com/Heey-Global/verity/issues/461)) ([2f9e12a](https://github.com/Heey-Global/verity/commit/2f9e12a32997af3da1664ed34e57d4906f9630a4))
* **release:** separate planning and batch immutable OTA candidates ([#454](https://github.com/Heey-Global/verity/issues/454)) ([16d7c27](https://github.com/Heey-Global/verity/commit/16d7c27d0ed534e873f02fb8f29a49a6e68b9fe0))

## [0.13.2](https://github.com/Heey-Global/verity/compare/v0.13.1...v0.13.2) (2026-09-17)


### Bug Fixes

* **secrets:** allow trusted CLI secret directory traversal ([#449](https://github.com/Heey-Global/verity/issues/449)) ([4306ecd](https://github.com/Heey-Global/verity/commit/4306ecd41af26eb4484bff242daa1bb732a8bb06))
* **server:** surface sandbox updates blocked by running turns ([#446](https://github.com/Heey-Global/verity/issues/446)) ([50b74fc](https://github.com/Heey-Global/verity/commit/50b74fcd5cb2d79370ff7bcfcf1221445f694f8c))

## [0.13.1](https://github.com/Heey-Global/verity/compare/v0.13.0...v0.13.1) (2026-09-17)


### Bug Fixes

* **secrets:** isolate trusted CLI secret files ([#443](https://github.com/Heey-Global/verity/issues/443)) ([8fa1726](https://github.com/Heey-Global/verity/commit/8fa1726a69da368860c87aea21fdc6bc9f53b386))

## [0.13.0](https://github.com/Heey-Global/verity/compare/v0.12.0...v0.13.0) (2026-09-17)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))
* **opencode:** discover provider models automatically ([#423](https://github.com/Heey-Global/verity/issues/423)) ([2652974](https://github.com/Heey-Global/verity/commit/2652974c14de601cb907630c471d1491dd6d7d2d))
* **release:** publish arm64 release channel ([#322](https://github.com/Heey-Global/verity/issues/322)) ([ad34d7a](https://github.com/Heey-Global/verity/commit/ad34d7a6a023c44f0c5948232d1f21c95165d33d))
* **security:** enable arm64 brokered secrets ([#337](https://github.com/Heey-Global/verity/issues/337)) ([529e19e](https://github.com/Heey-Global/verity/commit/529e19e7aee1e657f22fef938afb2d1043e68dba))


### Bug Fixes

* **installer:** correct first-install setup ([#249](https://github.com/Heey-Global/verity/issues/249)) ([2888c1b](https://github.com/Heey-Global/verity/commit/2888c1b7480f7cc60644a07f34af553eaf4d79b4))
* **installer:** prevent stale interactive reinstall ([#379](https://github.com/Heey-Global/verity/issues/379)) ([d71dc54](https://github.com/Heey-Global/verity/commit/d71dc54e464fb7ed09fcbdef0fb35010683499d2))
* **provisioner:** rebuild images with external devcontainer inputs ([#413](https://github.com/Heey-Global/verity/issues/413)) ([85e2dbc](https://github.com/Heey-Global/verity/commit/85e2dbc6e546bf1f37825dbbb2b1b947e082b8e9))
* **secrets:** preserve trusted CLI turn capability ([#409](https://github.com/Heey-Global/verity/issues/409)) ([0a8edfd](https://github.com/Heey-Global/verity/commit/0a8edfdbe309b7a5801a77f0e76f3b368ea83d69))
* **secrets:** redact decoded trusted CLI file credentials ([#393](https://github.com/Heey-Global/verity/issues/393)) ([c348055](https://github.com/Heey-Global/verity/commit/c348055f04cff326ab4d6a7ac97c4599e792ab95))
* **server:** release GitHub token cache fix ([#242](https://github.com/Heey-Global/verity/issues/242)) ([e0f8185](https://github.com/Heey-Global/verity/commit/e0f81851952eeaa36d3ffe654966037840fd5e16))
* **server:** release runner permission repair ([#330](https://github.com/Heey-Global/verity/issues/330)) ([1283539](https://github.com/Heey-Global/verity/commit/1283539c3af3d63998e0537d991bb537f2b0e459))
* **server:** release sandbox recovery and PR discovery fixes ([#404](https://github.com/Heey-Global/verity/issues/404)) ([41b18af](https://github.com/Heey-Global/verity/commit/41b18afae63c987f3cde163ff9d445cdfd32c4b1))
* **setup:** initialize managed runner state ([#370](https://github.com/Heey-Global/verity/issues/370)) ([35b343a](https://github.com/Heey-Global/verity/commit/35b343a2b3e0860a76af1294005c8714bdf68cf1))
* **setup:** repair fresh managed installation ([#338](https://github.com/Heey-Global/verity/issues/338)) ([191e181](https://github.com/Heey-Global/verity/commit/191e1817fba58f23ce3b01e610d8ad79e8b137b1))

## [0.12.0](https://github.com/Heey-Global/verity/compare/v0.11.0...v0.12.0) (2026-09-17)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))
* **opencode:** discover provider models automatically ([#423](https://github.com/Heey-Global/verity/issues/423)) ([2652974](https://github.com/Heey-Global/verity/commit/2652974c14de601cb907630c471d1491dd6d7d2d))
* **release:** publish arm64 release channel ([#322](https://github.com/Heey-Global/verity/issues/322)) ([ad34d7a](https://github.com/Heey-Global/verity/commit/ad34d7a6a023c44f0c5948232d1f21c95165d33d))
* **security:** enable arm64 brokered secrets ([#337](https://github.com/Heey-Global/verity/issues/337)) ([529e19e](https://github.com/Heey-Global/verity/commit/529e19e7aee1e657f22fef938afb2d1043e68dba))


### Bug Fixes

* **installer:** correct first-install setup ([#249](https://github.com/Heey-Global/verity/issues/249)) ([2888c1b](https://github.com/Heey-Global/verity/commit/2888c1b7480f7cc60644a07f34af553eaf4d79b4))
* **installer:** prevent stale interactive reinstall ([#379](https://github.com/Heey-Global/verity/issues/379)) ([d71dc54](https://github.com/Heey-Global/verity/commit/d71dc54e464fb7ed09fcbdef0fb35010683499d2))
* **provisioner:** rebuild images with external devcontainer inputs ([#413](https://github.com/Heey-Global/verity/issues/413)) ([85e2dbc](https://github.com/Heey-Global/verity/commit/85e2dbc6e546bf1f37825dbbb2b1b947e082b8e9))
* **secrets:** preserve trusted CLI turn capability ([#409](https://github.com/Heey-Global/verity/issues/409)) ([0a8edfd](https://github.com/Heey-Global/verity/commit/0a8edfdbe309b7a5801a77f0e76f3b368ea83d69))
* **secrets:** redact decoded trusted CLI file credentials ([#393](https://github.com/Heey-Global/verity/issues/393)) ([c348055](https://github.com/Heey-Global/verity/commit/c348055f04cff326ab4d6a7ac97c4599e792ab95))
* **server:** release GitHub token cache fix ([#242](https://github.com/Heey-Global/verity/issues/242)) ([e0f8185](https://github.com/Heey-Global/verity/commit/e0f81851952eeaa36d3ffe654966037840fd5e16))
* **server:** release runner permission repair ([#330](https://github.com/Heey-Global/verity/issues/330)) ([1283539](https://github.com/Heey-Global/verity/commit/1283539c3af3d63998e0537d991bb537f2b0e459))
* **server:** release sandbox recovery and PR discovery fixes ([#404](https://github.com/Heey-Global/verity/issues/404)) ([41b18af](https://github.com/Heey-Global/verity/commit/41b18afae63c987f3cde163ff9d445cdfd32c4b1))
* **setup:** initialize managed runner state ([#370](https://github.com/Heey-Global/verity/issues/370)) ([35b343a](https://github.com/Heey-Global/verity/commit/35b343a2b3e0860a76af1294005c8714bdf68cf1))
* **setup:** repair fresh managed installation ([#338](https://github.com/Heey-Global/verity/issues/338)) ([191e181](https://github.com/Heey-Global/verity/commit/191e1817fba58f23ce3b01e610d8ad79e8b137b1))

## [0.11.0](https://github.com/Heey-Global/verity/compare/v0.10.5...v0.11.0) (2026-09-17)


### Features

* **opencode:** discover provider models automatically ([#423](https://github.com/Heey-Global/verity/issues/423)) ([2652974](https://github.com/Heey-Global/verity/commit/2652974c14de601cb907630c471d1491dd6d7d2d))

## [0.10.5](https://github.com/Heey-Global/verity/compare/v0.10.4...v0.10.5) (2026-09-17)


### Bug Fixes

* **provisioner:** rebuild images with external devcontainer inputs ([#413](https://github.com/Heey-Global/verity/issues/413)) ([85e2dbc](https://github.com/Heey-Global/verity/commit/85e2dbc6e546bf1f37825dbbb2b1b947e082b8e9))

## [0.10.4](https://github.com/Heey-Global/verity/compare/v0.10.3...v0.10.4) (2026-09-16)


### Bug Fixes

* **server:** release sandbox recovery and PR discovery fixes ([#404](https://github.com/Heey-Global/verity/issues/404)) ([41b18af](https://github.com/Heey-Global/verity/commit/41b18afae63c987f3cde163ff9d445cdfd32c4b1))

## [0.10.3](https://github.com/Heey-Global/verity/compare/v0.10.2...v0.10.3) (2026-09-16)


### Bug Fixes

* **secrets:** redact decoded trusted CLI file credentials ([#393](https://github.com/Heey-Global/verity/issues/393)) ([c348055](https://github.com/Heey-Global/verity/commit/c348055f04cff326ab4d6a7ac97c4599e792ab95))

## [0.10.2](https://github.com/Heey-Global/verity/compare/v0.10.1...v0.10.2) (2026-09-16)


### Bug Fixes

* **installer:** prevent stale interactive reinstall ([#379](https://github.com/Heey-Global/verity/issues/379)) ([d71dc54](https://github.com/Heey-Global/verity/commit/d71dc54e464fb7ed09fcbdef0fb35010683499d2))

## [0.10.1](https://github.com/Heey-Global/verity/compare/v0.10.0...v0.10.1) (2026-09-15)


### Bug Fixes

* **setup:** initialize managed runner state ([#370](https://github.com/Heey-Global/verity/issues/370)) ([35b343a](https://github.com/Heey-Global/verity/commit/35b343a2b3e0860a76af1294005c8714bdf68cf1))

## [0.10.0](https://github.com/Heey-Global/verity/compare/v0.9.0...v0.10.0) (2026-09-15)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))
* **release:** publish arm64 release channel ([#322](https://github.com/Heey-Global/verity/issues/322)) ([ad34d7a](https://github.com/Heey-Global/verity/commit/ad34d7a6a023c44f0c5948232d1f21c95165d33d))
* **security:** enable arm64 brokered secrets ([#337](https://github.com/Heey-Global/verity/issues/337)) ([529e19e](https://github.com/Heey-Global/verity/commit/529e19e7aee1e657f22fef938afb2d1043e68dba))


### Bug Fixes

* **installer:** correct first-install setup ([#249](https://github.com/Heey-Global/verity/issues/249)) ([2888c1b](https://github.com/Heey-Global/verity/commit/2888c1b7480f7cc60644a07f34af553eaf4d79b4))
* **server:** release GitHub token cache fix ([#242](https://github.com/Heey-Global/verity/issues/242)) ([e0f8185](https://github.com/Heey-Global/verity/commit/e0f81851952eeaa36d3ffe654966037840fd5e16))
* **server:** release runner permission repair ([#330](https://github.com/Heey-Global/verity/issues/330)) ([1283539](https://github.com/Heey-Global/verity/commit/1283539c3af3d63998e0537d991bb537f2b0e459))
* **setup:** repair fresh managed installation ([#338](https://github.com/Heey-Global/verity/issues/338)) ([191e181](https://github.com/Heey-Global/verity/commit/191e1817fba58f23ce3b01e610d8ad79e8b137b1))

## [0.5.0](https://github.com/Heey-Global/verity/compare/v0.4.1...v0.5.0) (2026-09-15)


### Features

* **security:** enable arm64 brokered secrets ([#337](https://github.com/Heey-Global/verity/issues/337)) ([529e19e](https://github.com/Heey-Global/verity/commit/529e19e7aee1e657f22fef938afb2d1043e68dba))

## [0.4.1](https://github.com/Heey-Global/verity/compare/v0.4.0...v0.4.1) (2026-09-14)


### Bug Fixes

* **setup:** repair fresh managed installation ([#338](https://github.com/Heey-Global/verity/issues/338)) ([191e181](https://github.com/Heey-Global/verity/commit/191e1817fba58f23ce3b01e610d8ad79e8b137b1))

## [0.4.0](https://github.com/Heey-Global/verity/compare/v0.3.1...v0.4.0) (2026-09-14)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))

## [0.3.1](https://github.com/Heey-Global/verity/compare/v0.3.0...v0.3.1) (2026-09-14)


### Bug Fixes

* **server:** release runner permission repair ([#330](https://github.com/Heey-Global/verity/issues/330)) ([1283539](https://github.com/Heey-Global/verity/commit/1283539c3af3d63998e0537d991bb537f2b0e459))

## [0.3.0](https://github.com/Heey-Global/verity/compare/v0.2.2...v0.3.0) (2026-09-14)


### Features

* **release:** publish arm64 release channel ([#322](https://github.com/Heey-Global/verity/issues/322)) ([ad34d7a](https://github.com/Heey-Global/verity/commit/ad34d7a6a023c44f0c5948232d1f21c95165d33d))

## [0.2.2](https://github.com/Heey-Global/verity/compare/v0.2.1...v0.2.2) (2026-09-14)


### Bug Fixes

* **installer:** correct first-install setup ([#249](https://github.com/Heey-Global/verity/issues/249)) ([2888c1b](https://github.com/Heey-Global/verity/commit/2888c1b7480f7cc60644a07f34af553eaf4d79b4))

## [0.2.1](https://github.com/Heey-Global/verity/compare/v0.2.0...v0.2.1) (2026-09-13)


### Bug Fixes

* **server:** release GitHub token cache fix ([#242](https://github.com/Heey-Global/verity/issues/242)) ([e0f8185](https://github.com/Heey-Global/verity/commit/e0f81851952eeaa36d3ffe654966037840fd5e16))

## [0.2.0](https://github.com/Heey-Global/verity/compare/v0.1.1...v0.2.0) (2026-09-13)


### Features

* **mcp:** support OAuth connections ([#225](https://github.com/Heey-Global/verity/issues/225)) ([181b277](https://github.com/Heey-Global/verity/commit/181b277eb33371270388e3bc7def4bb417c79821))


### Bug Fixes

* **deps:** update dependency react-native-qrcode-svg to v6.3.24 ([#232](https://github.com/Heey-Global/verity/issues/232)) ([0770303](https://github.com/Heey-Global/verity/commit/0770303c19e3cfbc8e35bf75655c843d6437d71d))

## [0.1.1](https://github.com/Heey-Global/verity/compare/v0.1.0...v0.1.1) (2026-09-12)


### Bug Fixes

* **ci:** disable unconfigured secret canary schedule ([#219](https://github.com/Heey-Global/verity/issues/219)) ([ed6ade5](https://github.com/Heey-Global/verity/commit/ed6ade5edabd2b7b4593a23bd8da7f9f2a6efb08))
* **mobile:** let the GitHub authorization sheet actually present ([#223](https://github.com/Heey-Global/verity/issues/223)) ([03d96f3](https://github.com/Heey-Global/verity/commit/03d96f32b1ad3d4434dc0c5175d91d556dc23f06))
* **release:** bootstrap smoke from the candidate commit ([#221](https://github.com/Heey-Global/verity/issues/221)) ([159d790](https://github.com/Heey-Global/verity/commit/159d7902778850fc66df794f4df53b9a633b1389))

## 0.1.0 (2026-09-12)


### Bug Fixes

* **release:** isolate automation from release notes ([#214](https://github.com/Heey-Global/verity/issues/214)) ([955de6f](https://github.com/Heey-Global/verity/commit/955de6ffd4c891eaeec28d7c4181f21dbe424d9d))
* **server:** repoint the dead sandbox fallbacks at the 0.x train ([#218](https://github.com/Heey-Global/verity/issues/218)) ([6b12947](https://github.com/Heey-Global/verity/commit/6b129474d0f9d64aefdc6bace756754972513ef8))

## Release history before 0.1.0

The Server release train was reset to 0.x on 2026-09-12, before public launch.
The versions it carried until then were cut while the project was private;
their tags, GitHub releases and images no longer exist, so nothing here could
point at them. The commits themselves remain in Git history — none of it was
rewritten.

release-please writes its own `# Changelog` heading above this section when it
cuts the first release, which is why this section carries a heading of its own.
