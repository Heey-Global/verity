# Changelog

## [1.65.0](https://github.com/Heey-Global/verity/compare/mobile-v1.64.0...mobile-v1.65.0) (2026-10-09)


### Features

* **diagnostics:** correlate session switch transport phases ([#1444](https://github.com/Heey-Global/verity/issues/1444)) ([063bed3](https://github.com/Heey-Global/verity/commit/063bed3d9a2efeefb520852488ae74c32d1d82ab))


### Bug Fixes

* **mobile:** preserve session switch readiness diagnostics ([#1438](https://github.com/Heey-Global/verity/issues/1438)) ([396c63f](https://github.com/Heey-Global/verity/commit/396c63fb7b72e5914dc25a0fde88ce4fc9a71815))

## [1.64.0](https://github.com/Heey-Global/verity/compare/mobile-v1.63.0...mobile-v1.64.0) (2026-10-09)


### Features

* **mobile:** correlate session switch stalls with client activity ([#1430](https://github.com/Heey-Global/verity/issues/1430)) ([d0894cf](https://github.com/Heey-Global/verity/commit/d0894cfbf54983c6298f00d8ae2e3366ce5ca20e))
* **session-links:** allow linking control sessions ([#1434](https://github.com/Heey-Global/verity/issues/1434)) ([4941d84](https://github.com/Heey-Global/verity/commit/4941d84fd198a31025b9740134228ebd5ceff83c))


### Bug Fixes

* **mobile:** prepare dictation before microphone activation ([#1423](https://github.com/Heey-Global/verity/issues/1423)) ([b658103](https://github.com/Heey-Global/verity/commit/b658103bdd29505c28cedf76b2ea9b8e3ee273b6))
* **mobile:** retain stream diagnostics in connection exports ([#1433](https://github.com/Heey-Global/verity/issues/1433)) ([6d2b9ed](https://github.com/Heey-Global/verity/commit/6d2b9ed8bd7a17f956b49c9cb6ffdad859b2102d))
* **mobile:** skip unmounted issue refs during gesture hit testing ([#1424](https://github.com/Heey-Global/verity/issues/1424)) ([3607faa](https://github.com/Heey-Global/verity/commit/3607faa1dbf868cd1ce0a1ef2f368356cc14a680))

## [1.63.0](https://github.com/Heey-Global/verity/compare/mobile-v1.62.0...mobile-v1.63.0) (2026-10-09)


### Features

* **mobile:** add bounded DATA lifecycle recordings ([#1408](https://github.com/Heey-Global/verity/issues/1408)) ([ae8fcc2](https://github.com/Heey-Global/verity/commit/ae8fcc2a090e7d12554f4aaabb4bfff87a2e3db4))
* **mobile:** measure bounded session switch thread stalls ([#1418](https://github.com/Heey-Global/verity/issues/1418)) ([e49f7fc](https://github.com/Heey-Global/verity/commit/e49f7fc723ced50f754544e34235379acf900fff))
* **mobile:** open verity:// app links from chat messages ([#1410](https://github.com/Heey-Global/verity/issues/1410)) ([7ddc100](https://github.com/Heey-Global/verity/commit/7ddc100a737d7f1d0cc748ce92013e87b492dfdc))


### Bug Fixes

* **mobile:** allow session dragging from free row space ([#1416](https://github.com/Heey-Global/verity/issues/1416)) ([e190f9f](https://github.com/Heey-Global/verity/commit/e190f9f0e64f6ff469eca3218ab130be8948e123))
* **mobile:** attribute live meeting speakers per word and suggest names from introductions ([#1395](https://github.com/Heey-Global/verity/issues/1395)) ([3593a03](https://github.com/Heey-Global/verity/commit/3593a0391c1703b441cba3da60aacddb475f7d67))
* **mobile:** defer initial history paging and measure render work ([#1397](https://github.com/Heey-Global/verity/issues/1397)) ([205ec2b](https://github.com/Heey-Global/verity/commit/205ec2b71d24960e7e371b5d6e8e4ec1315500a3))
* **mobile:** open a new session after project setup ([#1414](https://github.com/Heey-Global/verity/issues/1414)) ([7019ffb](https://github.com/Heey-Global/verity/commit/7019ffb6041207bc3252a05b4fdb84c20bfa116c))
* **mobile:** simplify PR waiting button and slow its indicator ([#1399](https://github.com/Heey-Global/verity/issues/1399)) ([458b29a](https://github.com/Heey-Global/verity/commit/458b29aa5ab06b375d2c33d7a410f1a7b51c9788))
* **mobile:** stop passing null as a whole style prop ([#1419](https://github.com/Heey-Global/verity/issues/1419)) ([e60b6f4](https://github.com/Heey-Global/verity/commit/e60b6f4e5a077bf25e43d2004d7a8c260401c6fc))
* **mobile:** use Control voice shortcuts and cancel task capture ([#1396](https://github.com/Heey-Global/verity/issues/1396)) ([dd98c5b](https://github.com/Heey-Global/verity/commit/dd98c5b4e36a1138198f06a2ea4f029d5bae0411))

## [1.62.0](https://github.com/Heey-Global/verity/compare/mobile-v1.61.0...mobile-v1.62.0) (2026-10-09)


### Features

* **mobile:** use SpeechTranscriber with local vocabulary correction ([#1393](https://github.com/Heey-Global/verity/issues/1393)) ([e28551c](https://github.com/Heey-Global/verity/commit/e28551cf683597cf363104cf542f2e3f5d25433e))


### Bug Fixes

* **mobile:** keep pairing link failures from crashing and match the devices design ([#1391](https://github.com/Heey-Global/verity/issues/1391)) ([50abcee](https://github.com/Heey-Global/verity/commit/50abcee3ab75f1427d8e2e2c370607bb4e3146ba))

## [1.61.0](https://github.com/Heey-Global/verity/compare/mobile-v1.60.0...mobile-v1.61.0) (2026-10-08)


### Features

* **mobile:** add bounded interaction timing diagnostics ([#1365](https://github.com/Heey-Global/verity/issues/1365)) ([c8e0135](https://github.com/Heey-Global/verity/commit/c8e01355f1aebf5d0388ae85d253decf8709cb53))


### Bug Fixes

* **mobile:** backport safe Expo query serialization ([#1388](https://github.com/Heey-Global/verity/issues/1388)) ([b1de937](https://github.com/Heey-Global/verity/commit/b1de937f738f91dd4e88e9d91f3c53ca19beeb0f))
* **mobile:** distinguish waiting, mergeable and blocked PR states ([#1382](https://github.com/Heey-Global/verity/issues/1382)) ([12bfacb](https://github.com/Heey-Global/verity/commit/12bfacb591825e8d248bf7afcada7b6b45f9324f))
* **mobile:** keep task dictation active until save ([#1366](https://github.com/Heey-Global/verity/issues/1366)) ([db031c9](https://github.com/Heey-Global/verity/commit/db031c94c58a7b9e036fef58fd19ec0d10a3d165))
* **mobile:** order quick capture projects by the operator's own captures ([#1380](https://github.com/Heey-Global/verity/issues/1380)) ([87ea19c](https://github.com/Heey-Global/verity/commit/87ea19cf358c92dd3ba8cd34c6d67a33d972b02a))
* **mobile:** reduce session selection and history publication delays ([#1384](https://github.com/Heey-Global/verity/issues/1384)) ([a900c2a](https://github.com/Heey-Global/verity/commit/a900c2a55882ebb0b643142293d9aed769c64700))
* **mobile:** save agent settings without shifting the screen ([#1372](https://github.com/Heey-Global/verity/issues/1372)) ([2ffddcc](https://github.com/Heey-Global/verity/commit/2ffddccad44e7aadcb8d7fb10601c055e0d06816))
* **mobile:** show feedback while starting task sessions ([#1369](https://github.com/Heey-Global/verity/issues/1369)) ([c7a148f](https://github.com/Heey-Global/verity/commit/c7a148f2c7a2776c23935d181bc3885f345547b8))
* **mobile:** use Command shortcuts for voice capture ([#1367](https://github.com/Heey-Global/verity/issues/1367)) ([e730119](https://github.com/Heey-Global/verity/commit/e730119b091c4822dd883df2b491ae989dd9d17c))
* **mobile:** use silver for linked session markers ([#1381](https://github.com/Heey-Global/verity/issues/1381)) ([947a4f5](https://github.com/Heey-Global/verity/commit/947a4f5f2ae6cb6a752c8409efdb7c40893c3ffe))
* **planning:** unify plan approval and label accepted proposals ([#1352](https://github.com/Heey-Global/verity/issues/1352)) ([6a53a3a](https://github.com/Heey-Global/verity/commit/6a53a3a6b41832a61816f073790cf86c30e45df5))
* synchronize PR overview markers and immediate status bar ([#1347](https://github.com/Heey-Global/verity/issues/1347)) ([d70103d](https://github.com/Heey-Global/verity/commit/d70103dfafd03f197a6bfa54af0f166f0371be82))
* **tasks:** require projects and retire General ([#1383](https://github.com/Heey-Global/verity/issues/1383)) ([b502c48](https://github.com/Heey-Global/verity/commit/b502c486d70dd15000af06076106fa4825f82c59))

## [1.60.0](https://github.com/Heey-Global/verity/compare/mobile-v1.59.0...mobile-v1.60.0) (2026-10-08)


### Features

* **meetings:** add Attendee online source to Live Meeting ([#1325](https://github.com/Heey-Global/verity/issues/1325)) ([27f66ba](https://github.com/Heey-Global/verity/commit/27f66ba79dbdc9a602cb229c7b10467503769ec4))
* **mobile:** add web browser access to the devices settings screen ([#1339](https://github.com/Heey-Global/verity/issues/1339)) ([5d68513](https://github.com/Heey-Global/verity/commit/5d68513aa96fa9a3792f6de6f92d9fbccd910d9d))
* **mobile:** mark linked sessions with a violet chain icon ([#1338](https://github.com/Heey-Global/verity/issues/1338)) ([3d10fbc](https://github.com/Heey-Global/verity/commit/3d10fbc1ca6ab4e7735625ed48da1cadfeeb500e))
* **mobile:** reorder sessions within projects by long press ([#1323](https://github.com/Heey-Global/verity/issues/1323)) ([98c77f3](https://github.com/Heey-Global/verity/commit/98c77f30a6f92203cf48a5cc506e598309193d9e))
* **projects:** restrict allowed agents per project ([#1326](https://github.com/Heey-Global/verity/issues/1326)) ([e309754](https://github.com/Heey-Global/verity/commit/e30975490d7b637b0bab69299b14ee7a2da039be))
* **sessions:** allow linking sessions in the same project ([#1317](https://github.com/Heey-Global/verity/issues/1317)) ([c366cf3](https://github.com/Heey-Global/verity/commit/c366cf3749b2621a3de769e1761122a310192457))
* **tasks:** unify task views and add project GitHub issues ([#1342](https://github.com/Heey-Global/verity/issues/1342)) ([01f8e0b](https://github.com/Heey-Global/verity/commit/01f8e0b66e0fc5977bcd40058276c5882a65f66d))


### Bug Fixes

* **mobile:** drop the x86-64 restriction from the pairing screen ([#1344](https://github.com/Heey-Global/verity/issues/1344)) ([0168e0f](https://github.com/Heey-Global/verity/commit/0168e0f051fcd2a65276a2462abdf15f17b893cd))
* **mobile:** move PR status to the session row's second line ([#1321](https://github.com/Heey-Global/verity/issues/1321)) ([a662aa1](https://github.com/Heey-Global/verity/commit/a662aa12575fba2c111951a16151686e92293c38))
* **mobile:** preserve session visibility during drag pickup ([#1328](https://github.com/Heey-Global/verity/issues/1328)) ([dc85aeb](https://github.com/Heey-Global/verity/commit/dc85aeb0385aebb35a0de39a48f1cc0ccec41487))
* **planning:** keep plan proposals compact and collapsible ([#1343](https://github.com/Heey-Global/verity/issues/1343)) ([408f594](https://github.com/Heey-Global/verity/commit/408f59480565b5d7ca7d2a5fd9029886ce604435))
* **planning:** make plan proposals clear and actionable ([#1324](https://github.com/Heey-Global/verity/issues/1324)) ([fd78ac3](https://github.com/Heey-Global/verity/commit/fd78ac3388e089541c1da1d2d6a31c99d00dd11a))
* **sessions:** save link edits with session settings ([#1335](https://github.com/Heey-Global/verity/issues/1335)) ([76ce0e4](https://github.com/Heey-Global/verity/commit/76ce0e455eeb82c8ba4e46cbdb84a908c426f1fe))
* **session:** stabilize cancellation, activity and unread indicators ([#1316](https://github.com/Heey-Global/verity/issues/1316)) ([59f357b](https://github.com/Heey-Global/verity/commit/59f357b2e41095590e581e1745118cec6ac78dc7))
* **tasks:** calm capture flow and polish task editing ([#1320](https://github.com/Heey-Global/verity/issues/1320)) ([3056a73](https://github.com/Heey-Global/verity/commit/3056a73c40d70a7901626bf72ee52e15f0beb324))

## [1.59.0](https://github.com/Heey-Global/verity/compare/mobile-v1.58.0...mobile-v1.59.0) (2026-10-07)


### Features

* **mobile:** mark sessions on the row edge and show sharing in green ([#1296](https://github.com/Heey-Global/verity/issues/1296)) ([495135a](https://github.com/Heey-Global/verity/commit/495135a54f409ce1ea8d8d08e207748349a4fc45))
* **mobile:** move session markers to a trailing icon-and-bar column ([#1307](https://github.com/Heey-Global/verity/issues/1307)) ([a4b4c22](https://github.com/Heey-Global/verity/commit/a4b4c22cf3713c76b865912d3645372ca5c5863c))
* **tasks:** capture card redesign, shared action menu, agent steps end with their session ([#1292](https://github.com/Heey-Global/verity/issues/1292)) ([bed9367](https://github.com/Heey-Global/verity/commit/bed93677b8d93bf68f12c3d60651394a99ebf995))


### Bug Fixes

* **mobile:** avoid overview renders during settings navigation ([#1299](https://github.com/Heey-Global/verity/issues/1299)) ([c91c8e6](https://github.com/Heey-Global/verity/commit/c91c8e64f04de18b4fc281349b3846a59fdcb0c2))
* **mobile:** initialize Unistyles before loading routes ([#1288](https://github.com/Heey-Global/verity/issues/1288)) ([0f89d27](https://github.com/Heey-Global/verity/commit/0f89d27388c3a004aa0ca1c04c0b8e28d6b99a0f))
* **mobile:** keep session swipe actions opaque and add Edit beside Delete ([#1293](https://github.com/Heey-Global/verity/issues/1293)) ([b7057b6](https://github.com/Heey-Global/verity/commit/b7057b6e7ced977faa8d2cc413c12ec7d7d86e79))
* **mobile:** preserve Unistyles state during OTA reloads and bound diagnostics ([#1311](https://github.com/Heey-Global/verity/issues/1311)) ([e597a26](https://github.com/Heey-Global/verity/commit/e597a264ca5516b5285b6d4d4864bd3304a7fd63))
* **mobile:** stabilize meeting UI and isolate research replies ([#1308](https://github.com/Heey-Global/verity/issues/1308)) ([66ec3d5](https://github.com/Heey-Global/verity/commit/66ec3d567c629c534a8674ae5124809969e1e80d))
* **mobile:** subscribe to PR updates after branch prefetch ([#1305](https://github.com/Heey-Global/verity/issues/1305)) ([9c07247](https://github.com/Heey-Global/verity/commit/9c072477d40dc8fe2f20a61440d0a4ad21e4cc00))
* **web:** match browser sign-in to the preview code page ([#1295](https://github.com/Heey-Global/verity/issues/1295)) ([1e84862](https://github.com/Heey-Global/verity/commit/1e848627bbb218243ab9a4d29b41f187dfe56edb))
* **web:** restore layouts and composer behavior and optimize loading ([#1273](https://github.com/Heey-Global/verity/issues/1273)) ([ba34bbb](https://github.com/Heey-Global/verity/commit/ba34bbb6118e5ee92d23ae027dca886c40e94a01))
* **web:** style the composer input and support drag and drop in the browser ([#1297](https://github.com/Heey-Global/verity/issues/1297)) ([dbc0368](https://github.com/Heey-Global/verity/commit/dbc03680831cec0b5dd95ab2112d324924787920))

## [1.58.0](https://github.com/Heey-Global/verity/compare/mobile-v1.57.0...mobile-v1.58.0) (2026-10-07)


### Features

* **live:** replace app polling with shared socket updates ([#1262](https://github.com/Heey-Global/verity/issues/1262)) ([bff9df1](https://github.com/Heey-Global/verity/commit/bff9df116a8175ba29edc07b3c2ba0014213c99f))
* **mobile:** add session favorites, swipe actions and context menu ([#1275](https://github.com/Heey-Global/verity/issues/1275)) ([4b5c745](https://github.com/Heey-Global/verity/commit/4b5c745650a691bcb8cd0d7f9792d055778ced93))
* **mobile:** export update diagnostics from settings ([#1282](https://github.com/Heey-Global/verity/issues/1282)) ([b5046ab](https://github.com/Heey-Global/verity/commit/b5046ab5149546445ecd2294df688c65630f6637))
* **tasks:** quieter task surfaces, agent steps apart, bubble physics ([#1276](https://github.com/Heey-Global/verity/issues/1276)) ([f656a4b](https://github.com/Heey-Global/verity/commit/f656a4bf505c977d3fc30e5dcca6ffadd938018c))

## [1.57.0](https://github.com/Heey-Global/verity/compare/mobile-v1.56.0...mobile-v1.57.0) (2026-10-07)


### Features

* **tasks:** add offline capture and task panel ([#1238](https://github.com/Heey-Global/verity/issues/1238)) ([bb922ea](https://github.com/Heey-Global/verity/commit/bb922ead44386bf51f84ea5e7dc88106f6674685))


### Bug Fixes

* **mobile:** display readable names for all Verity tools ([#1236](https://github.com/Heey-Global/verity/issues/1236)) ([3c59133](https://github.com/Heey-Global/verity/commit/3c591338826d0ba376fab95f5e52ef7c98e6118b))

## [1.56.0](https://github.com/Heey-Global/verity/compare/mobile-v1.55.0...mobile-v1.56.0) (2026-10-06)


### Bug Fixes

* **mobile:** preserve Shift+Enter in prompt composer ([#1235](https://github.com/Heey-Global/verity/issues/1235)) ([d194c38](https://github.com/Heey-Global/verity/commit/d194c3823b929e78fd3f7060784c9a61cc4eaff2))
* **preview:** unify detected server controls and require managed starts ([#1237](https://github.com/Heey-Global/verity/issues/1237)) ([98498d1](https://github.com/Heey-Global/verity/commit/98498d17d851cd342a4c8d69fd9796f25be8d838))

## [1.55.0](https://github.com/Heey-Global/verity/compare/mobile-v1.54.0...mobile-v1.55.0) (2026-10-06)


### Features

* **live:** use one connection per device and route notifications per user ([#1225](https://github.com/Heey-Global/verity/issues/1225)) ([4b7b173](https://github.com/Heey-Global/verity/commit/4b7b173517c3a62cb7edf33fcb1192d1f4774fe4))
* **mobile:** compact issue and branch refs in header and overview ([#1215](https://github.com/Heey-Global/verity/issues/1215)) ([e50cf97](https://github.com/Heey-Global/verity/commit/e50cf975272444bf7aeb6e958a756baafb8885cc))
* **web:** ship browser client in Core Docker image ([#1216](https://github.com/Heey-Global/verity/issues/1216)) ([63bb411](https://github.com/Heey-Global/verity/commit/63bb411ecedce8c687a7025f43f9c1af57db2d4e))


### Bug Fixes

* **mobile:** allow dismissing running server hints ([#1209](https://github.com/Heey-Global/verity/issues/1209)) ([35d3e90](https://github.com/Heey-Global/verity/commit/35d3e907b8d2c8f5ef08c1911c713ba6f79971a9))
* **mobile:** match static folder breadcrumbs to explorer ([#1220](https://github.com/Heey-Global/verity/issues/1220)) ([31ced91](https://github.com/Heey-Global/verity/commit/31ced918a59f28a13fb54a3e4390943b4d2f79eb))
* **planning:** avoid redundant tool approval for plan presentation ([#1205](https://github.com/Heey-Global/verity/issues/1205)) ([dd64496](https://github.com/Heey-Global/verity/commit/dd644967a88e63d431339724e27c84d2fd63ea54))

## [1.54.0](https://github.com/Heey-Global/verity/compare/mobile-v1.53.0...mobile-v1.54.0) (2026-10-06)


### Features

* **dev-servers:** control server lifetime with Local and Shared online ([#1186](https://github.com/Heey-Global/verity/issues/1186)) ([3e5f978](https://github.com/Heey-Global/verity/commit/3e5f9785bf9415bca531381142fd91133236fd6f))
* **dev-servers:** manage session servers from Preview and chat ([#1175](https://github.com/Heey-Global/verity/issues/1175)) ([c8aa031](https://github.com/Heey-Global/verity/commit/c8aa03142ec51b3b454119c334a18ecc7bb186ec))
* **session:** add persistent planning with synchronized plan approvals ([#1163](https://github.com/Heey-Global/verity/issues/1163)) ([c774e2b](https://github.com/Heey-Global/verity/commit/c774e2b218b5fd54d65e7b436cf7ffa882a14d11))
* **web:** add local browser client with cookie sessions ([#1183](https://github.com/Heey-Global/verity/issues/1183)) ([29f8e70](https://github.com/Heey-Global/verity/commit/29f8e701df3263fe8ad575903fe87456ea61c4ff))


### Bug Fixes

* **mobile:** allow slower interactive OTA update checks ([#1182](https://github.com/Heey-Global/verity/issues/1182)) ([20cfef4](https://github.com/Heey-Global/verity/commit/20cfef453ec8e78dc41795a2dac9f058267b3ebb))
* **mobile:** attach session row icons to the model name ([#1181](https://github.com/Heey-Global/verity/issues/1181)) ([38c98ea](https://github.com/Heey-Global/verity/commit/38c98ea0331631fc5f6cf5e6720f6542594775e8))
* **mobile:** even out preview cards and name running servers by state ([#1167](https://github.com/Heey-Global/verity/issues/1167)) ([310848f](https://github.com/Heey-Global/verity/commit/310848f2e209f57c95c683f5cce93bd79208a9f3))
* **mobile:** keep chat-enabled Google services scoped to the session ([#1171](https://github.com/Heey-Global/verity/issues/1171)) ([7df6fcb](https://github.com/Heey-Global/verity/commit/7df6fcb7676ce21cafcf988e84963e15556a532e))
* **mobile:** pin session row icons to the row's right edge ([#1166](https://github.com/Heey-Global/verity/issues/1166)) ([17c5a0d](https://github.com/Heey-Global/verity/commit/17c5a0d308b97f156c5fc21363c862de96527dd8))
* **mobile:** prevent chat scroll jumps with persisted plans ([#1180](https://github.com/Heey-Global/verity/issues/1180)) ([9f7efbc](https://github.com/Heey-Global/verity/commit/9f7efbcec98d0dc02ba281977def2ec8cefc674e))
* **push:** alert audibly when the agent waits on the operator ([#1200](https://github.com/Heey-Global/verity/issues/1200)) ([58a9b13](https://github.com/Heey-Global/verity/commit/58a9b138929e0c84c85018855185db6d8e74fcfa))

## [1.53.0](https://github.com/Heey-Global/verity/compare/mobile-v1.52.0...mobile-v1.53.0) (2026-10-05)


### Features

* **automations:** attach recurring automations to sessions ([#1097](https://github.com/Heey-Global/verity/issues/1097)) ([e1dc7eb](https://github.com/Heey-Global/verity/commit/e1dc7eb9b82d5ac39f0e0b1b8e6e9c643b9c0b76))
* **matrix:** expose import failures to Control and room status ([#1112](https://github.com/Heey-Global/verity/issues/1112)) ([90db73c](https://github.com/Heey-Global/verity/commit/90db73cb77b94001b7a52190e1b44a5d6a936ee9))
* **mobile:** open a session's preview from its list row ([#1154](https://github.com/Heey-Global/verity/issues/1154)) ([c2bb622](https://github.com/Heey-Global/verity/commit/c2bb6222e42074df4d70efddda250aa1c4b319fe))
* **mobile:** show subscription plan and usage on provider settings ([#1142](https://github.com/Heey-Global/verity/issues/1142)) ([e3d2e0f](https://github.com/Heey-Global/verity/commit/e3d2e0f352dcb8c6cff031a8b3c8c83253f8b8cf))
* **preview:** separate target selection from preview access ([#1101](https://github.com/Heey-Global/verity/issues/1101)) ([073384d](https://github.com/Heey-Global/verity/commit/073384d4fcec9933041d37d7c60c93fcdbca453c))
* **remote:** add correlated Core transport diagnostics ([#1150](https://github.com/Heey-Global/verity/issues/1150)) ([809a201](https://github.com/Heey-Global/verity/commit/809a201fe4553fdb8ea8da7183b2e9b844b9b220))
* **session:** show agent plans as a live checklist ([#1148](https://github.com/Heey-Global/verity/issues/1148)) ([45ead02](https://github.com/Heey-Global/verity/commit/45ead02bb1cd547547970e655e59f318153d757f))


### Bug Fixes

* **automation:** default schedules to the user's time zone ([#1117](https://github.com/Heey-Global/verity/issues/1117)) ([f9a6844](https://github.com/Heey-Global/verity/commit/f9a684430b83f6df2b3181815bbf62f2b0dafc03))
* **mobile:** center session name and branch in header ([#1103](https://github.com/Heey-Global/verity/issues/1103)) ([d2d0767](https://github.com/Heey-Global/verity/commit/d2d0767f686fc753d4b86a696adf6e3ba214c37d))
* **mobile:** explain both preview tabs in plain words ([#1144](https://github.com/Heey-Global/verity/issues/1144)) ([6b58371](https://github.com/Heey-Global/verity/commit/6b58371534e0571b42f81812d35915f79f45274a))
* **mobile:** expose OTA update failure diagnostics ([#1152](https://github.com/Heey-Global/verity/issues/1152)) ([4d26cdf](https://github.com/Heey-Global/verity/commit/4d26cdf5bae5dfc6364983035796362b87beadd4))
* **mobile:** open message actions as a menu anchored to the "…" button ([#1110](https://github.com/Heey-Global/verity/issues/1110)) ([dabe408](https://github.com/Heey-Global/verity/commit/dabe4087e7f0a8fed15319036d88d4b75298b11b))
* **mobile:** remove redundant secret store settings entry ([#1129](https://github.com/Heey-Global/verity/issues/1129)) ([4e46bc8](https://github.com/Heey-Global/verity/commit/4e46bc8c35b8ae4b9a6337953cecab3fdcd5b2b3))
* **mobile:** restore direct Google access shortcuts ([#1106](https://github.com/Heey-Global/verity/issues/1106)) ([c54e521](https://github.com/Heey-Global/verity/commit/c54e5211c71674985012e0acf8de02c1f6c9341c))
* **mobile:** restore the welcome screen with a subtle demo link ([#1096](https://github.com/Heey-Global/verity/issues/1096)) ([c692e6e](https://github.com/Heey-Global/verity/commit/c692e6e420517ff18689215d48fe468715900ea1))
* **mobile:** separate Claude and Codex settings ([#1120](https://github.com/Heey-Global/verity/issues/1120)) ([715744d](https://github.com/Heey-Global/verity/commit/715744d789bc7d4d346fcfb3aacded26d0ecd911))
* **mobile:** show a clean empty state for an unconnected Drive tab ([#1113](https://github.com/Heey-Global/verity/issues/1113)) ([2cdfafb](https://github.com/Heey-Global/verity/commit/2cdfafbf19fedd651aa5b4ac1dabfff0fad7e44b))
* **mobile:** show GitHub's pending merge test instead of a dead merge button ([#1105](https://github.com/Heey-Global/verity/issues/1105)) ([94600b1](https://github.com/Heey-Global/verity/commit/94600b1c8a15a35dff395fad8c92558a438dc09d))
* **mobile:** simplify empty session starter cards ([#1108](https://github.com/Heey-Global/verity/issues/1108)) ([9e8c7a2](https://github.com/Heey-Global/verity/commit/9e8c7a27c990b8e0324d09a20636489d68c74aa9))
* **mobile:** simplify Matrix settings and expose connector errors ([#1102](https://github.com/Heey-Global/verity/issues/1102)) ([713ecb4](https://github.com/Heey-Global/verity/commit/713ecb41b3be9966171940fc32f65b8a69e0c4c9))
* **mobile:** split preview into dev server and static file tabs ([#1128](https://github.com/Heey-Global/verity/issues/1128)) ([2a813a3](https://github.com/Heey-Global/verity/commit/2a813a31aad3734206fe8f645f2d8c5402730e04))
* preserve read sessions across restarts and separate update channel settings ([#1111](https://github.com/Heey-Global/verity/issues/1111)) ([1a688a4](https://github.com/Heey-Global/verity/commit/1a688a495520f110e4c841b477bd6c8b55220f37))
* **preview:** allow local connector transport and clarify opening actions ([#1090](https://github.com/Heey-Global/verity/issues/1090)) ([a59dc7d](https://github.com/Heey-Global/verity/commit/a59dc7db4e420f479c5278ca548e0963eeb452e0))
* **secrets:** unify scoped approvals and prevent redundant prompts ([#1139](https://github.com/Heey-Global/verity/issues/1139)) ([06e803e](https://github.com/Heey-Global/verity/commit/06e803e62394619f0054544d509c74b082fe4dce))
* **sessions:** exclude dev-server events from unread badges ([7bc715b](https://github.com/Heey-Global/verity/commit/7bc715b5cbcebf81b346eac2f7ef7e5c3ded889e))

## [1.52.0](https://github.com/Heey-Global/verity/compare/mobile-v1.51.0...mobile-v1.52.0) (2026-10-04)


### Features

* **connections:** unify account setup and project access ([#1063](https://github.com/Heey-Global/verity/issues/1063)) ([fe35252](https://github.com/Heey-Global/verity/commit/fe352520795139caf9ed0b88ec6a21b7f2127fe4))
* **drive:** add approved project file management actions ([#1078](https://github.com/Heey-Global/verity/issues/1078)) ([7f51dee](https://github.com/Heey-Global/verity/commit/7f51deeb81920ede3a82c0e4aac4ce66f02555c9))
* **explorer:** clarify file actions and support renaming ([#1049](https://github.com/Heey-Global/verity/issues/1049)) ([6bd57ed](https://github.com/Heey-Global/verity/commit/6bd57eda6681c21b856ad86b8f945042a98f2d3e))
* **explorer:** edit text files with recoverable version history ([#1061](https://github.com/Heey-Global/verity/issues/1061)) ([6e93566](https://github.com/Heey-Global/verity/commit/6e9356675b72f22d43c8c811ad8e401bce294792))
* **explorer:** render Markdown previews with source toggle ([#1053](https://github.com/Heey-Global/verity/issues/1053)) ([c67d9bc](https://github.com/Heey-Global/verity/commit/c67d9bcdc5015c4a02a2e07b74b87f6716cfd90f))
* **mobile:** add an interactive local demo mode ([#1080](https://github.com/Heey-Global/verity/issues/1080)) ([7aff510](https://github.com/Heey-Global/verity/commit/7aff51066738e923b7fd3b246e5a485d9ac44dac))
* **mobile:** larger session header actions and labeled message menu ([#1077](https://github.com/Heey-Global/verity/issues/1077)) ([b5de410](https://github.com/Heey-Global/verity/commit/b5de410798a1374bc2389a9591539b1d3f8acfe1))
* **preview:** add local sharing and automatic listener discovery ([#1076](https://github.com/Heey-Global/verity/issues/1076)) ([4026bb2](https://github.com/Heey-Global/verity/commit/4026bb2af25ef0aa059011a007363df9d8708dda))
* **settings:** select server prereleases and Google app identities ([#1075](https://github.com/Heey-Global/verity/issues/1075)) ([7074d4f](https://github.com/Heey-Global/verity/commit/7074d4ff4798c05a97b4b692c89007841856743a))


### Bug Fixes

* **explorer:** retain ten snapshots per file ([#1074](https://github.com/Heey-Global/verity/issues/1074)) ([0616520](https://github.com/Heey-Global/verity/commit/0616520e12ceafabccca937c86b8a7c35c85bc73))
* **mobile:** explain Global Knowledge approvals ([#1057](https://github.com/Heey-Global/verity/issues/1057)) ([c688a80](https://github.com/Heey-Global/verity/commit/c688a806f087c3c652b8e63d8d97b8d781740f40))
* **mobile:** stop dictation without re-appending the last utterance ([#1083](https://github.com/Heey-Global/verity/issues/1083)) ([598eac0](https://github.com/Heey-Global/verity/commit/598eac0771a8a1934a7125a5207bc97aa94c079f))
* **pr:** repair failures in background and share adaptive status polling ([#1084](https://github.com/Heey-Global/verity/issues/1084)) ([4334331](https://github.com/Heey-Global/verity/commit/4334331da2e33dcf6ecfb4ac58e700ab4a5ae619))

## [1.51.0](https://github.com/Heey-Global/verity/compare/mobile-v1.50.0...mobile-v1.51.0) (2026-10-03)


### Features

* **mobile:** show reusable premium notice for preview sharing ([#1003](https://github.com/Heey-Global/verity/issues/1003)) ([4015fde](https://github.com/Heey-Global/verity/commit/4015fde3c288fb668576d389c09d8ce21abd77ef))
* **preview:** enforce durable PIN lockout and show locked links ([#1006](https://github.com/Heey-Global/verity/issues/1006)) ([6281a4a](https://github.com/Heey-Global/verity/commit/6281a4a8ca8e729b5eb1ec55818c3910adaf9621))
* **preview:** use six-digit PINs for every share duration ([#1004](https://github.com/Heey-Global/verity/issues/1004)) ([49d1695](https://github.com/Heey-Global/verity/commit/49d1695b61882c3839ff73c5985285571f708d05))
* **release:** add staging channels and production promotion ([#1035](https://github.com/Heey-Global/verity/issues/1035)) ([55a7aea](https://github.com/Heey-Global/verity/commit/55a7aea98f8e2bb3aedbf8d6b84a19c0692ce2de))


### Bug Fixes

* **mobile:** settle chat navigation jumps against measured layout ([#1012](https://github.com/Heey-Global/verity/issues/1012)) ([f378079](https://github.com/Heey-Global/verity/commit/f37807975963bb84d578ac2e8ae96319a831b390))
* show local save only for project file changes ([#1017](https://github.com/Heey-Global/verity/issues/1017)) ([b77f133](https://github.com/Heey-Global/verity/commit/b77f133616fa290511edcecb9881180151592de3))

## [1.50.0](https://github.com/Heey-Global/verity/compare/mobile-v1.49.0...mobile-v1.50.0) (2026-10-02)


### Features

* **mobile:** report heartbeat liveness in the tunnel summary ([#999](https://github.com/Heey-Global/verity/issues/999)) ([91a4e16](https://github.com/Heey-Global/verity/commit/91a4e162e13a9c488ab160dd4ea0f7c82fe745d1))


### Bug Fixes

* **knowledge:** keep sessions usable after source deletion ([#998](https://github.com/Heey-Global/verity/issues/998)) ([33e3495](https://github.com/Heey-Global/verity/commit/33e34958815559bf2a9f408b1387f55df2d9edbe))
* **mobile:** reset keyboard spacing and attachment menu anchors ([#1000](https://github.com/Heey-Global/verity/issues/1000)) ([9d1675f](https://github.com/Heey-Global/verity/commit/9d1675f7f083385c3d29aef3bc8ac098a3191f46))

## [1.49.0](https://github.com/Heey-Global/verity/compare/mobile-v1.48.0...mobile-v1.49.0) (2026-10-02)


### Features

* **remote-control:** show Core's side of each tunnel stream in the app ([#978](https://github.com/Heey-Global/verity/issues/978)) ([b83532a](https://github.com/Heey-Global/verity/commit/b83532a64bf5b56d01fa7aa6eea40c3918eb9dee))


### Bug Fixes

* **mobile:** avoid duplicate dictation results when stopping ([#983](https://github.com/Heey-Global/verity/issues/983)) ([10b6095](https://github.com/Heey-Global/verity/commit/10b609516c8955cad0c12b77c9a31e78d82a3fae))
* **remote-control:** send stream data towards the app in 8 KiB frames ([#980](https://github.com/Heey-Global/verity/issues/980)) ([25db259](https://github.com/Heey-Global/verity/commit/25db259f9125a903ac7bd356847d82858ab20a41))

## [1.48.0](https://github.com/Heey-Global/verity/compare/mobile-v1.47.0...mobile-v1.48.0) (2026-10-01)


### Features

* **remote-control:** show Core tunnel streams in mobile diagnostics ([#970](https://github.com/Heey-Global/verity/issues/970)) ([dcb210c](https://github.com/Heey-Global/verity/commit/dcb210cebda6ebe974f7db00b2018c14238fb0a2))


### Performance Improvements

* **mobile:** reuse transcript snapshots and batch rendering ([#973](https://github.com/Heey-Global/verity/issues/973)) ([c03d81a](https://github.com/Heey-Global/verity/commit/c03d81a809e585a866f62b310c960dddace8985f))
* **mobile:** shorten session and settings loading paths ([#969](https://github.com/Heey-Global/verity/issues/969)) ([1447db8](https://github.com/Heey-Global/verity/commit/1447db8cd77819406a61592ea2f502f8064272e0))
* reuse pinned HTTP connections and cache event projections ([#975](https://github.com/Heey-Global/verity/issues/975)) ([aba7a34](https://github.com/Heey-Global/verity/commit/aba7a342800bae353675d05a51963aac38f8a79c))

## [1.47.0](https://github.com/Heey-Global/verity/compare/mobile-v1.46.0...mobile-v1.47.0) (2026-10-01)


### Features

* **google:** add session Calendar and Contacts with incremental consent ([#956](https://github.com/Heey-Global/verity/issues/956)) ([55bfcd6](https://github.com/Heey-Global/verity/commit/55bfcd626fbef940a07c93a3660cfae9c26939d9))
* **mobile:** announce server updates with a banner and a dedicated screen ([#962](https://github.com/Heey-Global/verity/issues/962)) ([fda350c](https://github.com/Heey-Global/verity/commit/fda350c8dfc92503995980c55e0667a167aed669))
* **mobile:** pick what to share before setting up the preview link ([#952](https://github.com/Heey-Global/verity/issues/952)) ([f64d8a1](https://github.com/Heey-Global/verity/commit/f64d8a1c0a0fcbec77a04381eb3a7e41f183028b))
* **mobile:** redesign live meeting screen ([#951](https://github.com/Heey-Global/verity/issues/951)) ([999772f](https://github.com/Heey-Global/verity/commit/999772fedadca11579583186f400e2d12e34fab7))
* **mobile:** show release notes for a pending server update ([#964](https://github.com/Heey-Global/verity/issues/964)) ([0d9f94d](https://github.com/Heey-Global/verity/commit/0d9f94de5414bd3cee4ab5238ff9581cf69aacdc))


### Bug Fixes

* **mobile:** clarify editable session names and disable unchanged saves ([#948](https://github.com/Heey-Global/verity/issues/948)) ([95451f1](https://github.com/Heey-Global/verity/commit/95451f11b145909af658fe07c824792cf6aba69f))
* **mobile:** expose remote diagnostics without Core settings ([#963](https://github.com/Heey-Global/verity/issues/963)) ([d0961b2](https://github.com/Heey-Global/verity/commit/d0961b272d67218dabc8901131797af060beaead))
* **mobile:** float the project picker over session settings ([#941](https://github.com/Heey-Global/verity/issues/941)) ([d5d5185](https://github.com/Heey-Global/verity/commit/d5d51851883f1649636dca41242f55d6af0751e7))
* **mobile:** retry stalled Remote Control reads through alternate proxy ([#945](https://github.com/Heey-Global/verity/issues/945)) ([c1fddb9](https://github.com/Heey-Global/verity/commit/c1fddb9fc0223c7cf7301a3f7d63b4c3672ddb58))
* **release:** keep mobile fixtures out of server releases ([#939](https://github.com/Heey-Global/verity/issues/939)) ([c90a278](https://github.com/Heey-Global/verity/commit/c90a2789ee338ece2d59636f15c5106df720a2c5))
* report a server update the Updater accepted instead of a failed start ([#947](https://github.com/Heey-Global/verity/issues/947)) ([6c830db](https://github.com/Heey-Global/verity/commit/6c830db7a6852a9a15baa4f9d9d0a296c1c91b08))

## [1.46.0](https://github.com/Heey-Global/verity/compare/mobile-v1.45.0...mobile-v1.46.0) (2026-09-30)


### Features

* **preview:** share session dev servers over Uplink ([#934](https://github.com/Heey-Global/verity/issues/934)) ([bdaeda2](https://github.com/Heey-Global/verity/commit/bdaeda2cad3a2767caf5935f90dba6891e1aa169))


### Bug Fixes

* **mobile:** adopt scene lifecycle to prevent iOS 27 launch crash ([#936](https://github.com/Heey-Global/verity/issues/936)) ([add0d0b](https://github.com/Heey-Global/verity/commit/add0d0b3b8632d20459b4bde5eba7656888866a8))

## [1.45.0](https://github.com/Heey-Global/verity/compare/mobile-v1.44.0...mobile-v1.45.0) (2026-09-30)


### ⚠ BREAKING CHANGES

* **tasks:** Remove GET /issues and /tasks routes and the mobile task API.

### Features

* **meeting:** add live speakers and in-screen answers ([#920](https://github.com/Heey-Global/verity/issues/920)) ([b88a606](https://github.com/Heey-Global/verity/commit/b88a60694407502a858bd74041d805c660a11cf1))
* **mobile:** print and share previewed files as PDF ([#925](https://github.com/Heey-Global/verity/issues/925)) ([3b0738d](https://github.com/Heey-Global/verity/commit/3b0738da6b694f605404945364a0e52f26db3285))
* **mobile:** tap haptically when a permission prompt blocks the agent ([#924](https://github.com/Heey-Global/verity/issues/924)) ([40a99e5](https://github.com/Heey-Global/verity/commit/40a99e51a907fb7c5889d4d303120d43d6005ae0))


### Code Refactoring

* **tasks:** remove retired issues and plan board ([#922](https://github.com/Heey-Global/verity/issues/922)) ([663e4c5](https://github.com/Heey-Global/verity/commit/663e4c593ba03bc99884159362a1144ef8f26e8f))

## [1.44.0](https://github.com/Heey-Global/verity/compare/mobile-v1.43.0...mobile-v1.44.0) (2026-09-29)


### Features

* **meeting:** classify spoken requests and preserve note drafts ([#914](https://github.com/Heey-Global/verity/issues/914)) ([7d0446d](https://github.com/Heey-Global/verity/commit/7d0446da86ecf846ec9eb0a00961a49dcf14faeb))
* **preview:** offer shares up to 30 days ([#912](https://github.com/Heey-Global/verity/issues/912)) ([bbe0ac5](https://github.com/Heey-Global/verity/commit/bbe0ac596a2ec3d74255294a76dc596441d86769))
* **preview:** save and share PINs across devices ([#905](https://github.com/Heey-Global/verity/issues/905)) ([209b276](https://github.com/Heey-Global/verity/commit/209b2762f8adaccf7f9e634723f7ba91f47bec3b))


### Bug Fixes

* **mobile:** restore direct routing promptly after resume ([#907](https://github.com/Heey-Global/verity/issues/907)) ([597f508](https://github.com/Heey-Global/verity/commit/597f508cdcfe681448ec1633e32cfc24d92ec635))
* **mobile:** stabilize chat navigation jumps ([#910](https://github.com/Heey-Global/verity/issues/910)) ([af55254](https://github.com/Heey-Global/verity/commit/af55254e5278959356ad079ff8afcd988972fec0))
* **remote-control:** preserve native TLS causes and test production tunnel ([#904](https://github.com/Heey-Global/verity/issues/904)) ([443b6b8](https://github.com/Heey-Global/verity/commit/443b6b891e21c9c9b8daaf86e4d1a0e5aa9b1f77))

## [1.43.0](https://github.com/Heey-Global/verity/compare/mobile-v1.42.0...mobile-v1.43.0) (2026-09-29)


### Features

* **meeting:** analyze live transcripts for shared insights ([#894](https://github.com/Heey-Global/verity/issues/894)) ([bb10291](https://github.com/Heey-Global/verity/commit/bb102914f6176a27912f7a5537b0c5ee626d1294))
* **meeting:** compare live claims with project knowledge ([#900](https://github.com/Heey-Global/verity/issues/900)) ([08bbc2a](https://github.com/Heey-Global/verity/commit/08bbc2a475647fd33fcbd9deaddc3ad2eabf3878))
* **meeting:** start session requests from direct speech ([#903](https://github.com/Heey-Global/verity/issues/903)) ([00918f8](https://github.com/Heey-Global/verity/commit/00918f8fea6cc33ae1165670a314620c9c8a8d34))


### Bug Fixes

* **mobile:** complete history jumps behind loading cover ([#899](https://github.com/Heey-Global/verity/issues/899)) ([88a982b](https://github.com/Heey-Global/verity/commit/88a982b27caf67695bbe830afba755db9080bb5f))
* **mobile:** load session image links through the pinned transport ([#901](https://github.com/Heey-Global/verity/issues/901)) ([064368d](https://github.com/Heey-Global/verity/commit/064368dfd4050775a825c4bd1bb755455d5d1c56))
* **preview:** serve session files and style public pages ([#896](https://github.com/Heey-Global/verity/issues/896)) ([a530286](https://github.com/Heey-Global/verity/commit/a530286e3b5408b2e0d6cbcc6205f9073a1ea798))
* **remote-control:** trace tunnel bytes and TLS probe progress ([#895](https://github.com/Heey-Global/verity/issues/895)) ([6ae6b8e](https://github.com/Heey-Global/verity/commit/6ae6b8ebfc8f9fc26893256fd80ea554cd076c43))

## [1.42.0](https://github.com/Heey-Global/verity/compare/mobile-v1.41.0...mobile-v1.42.0) (2026-09-29)


### Features

* **meeting:** sync live transcripts and notes across devices ([#888](https://github.com/Heey-Global/verity/issues/888)) ([3465ba7](https://github.com/Heey-Global/verity/commit/3465ba7ab3e3ad03730de1c519eeae1c2ce35c6f))
* **mobile:** add movable live meeting controls ([#884](https://github.com/Heey-Global/verity/issues/884)) ([eefd514](https://github.com/Heey-Global/verity/commit/eefd51452d593534f192570782b127e9a63c6749))


### Bug Fixes

* **uplink:** unlock mobile credentials before remote startup ([#874](https://github.com/Heey-Global/verity/issues/874)) ([abcbfce](https://github.com/Heey-Global/verity/commit/abcbfce2682572df66a75c07375e9a7e511a0285))

## [1.41.0](https://github.com/Heey-Global/verity/compare/mobile-v1.40.0...mobile-v1.41.0) (2026-09-28)


### Features

* **mobile:** add continuous voice dictation ([#860](https://github.com/Heey-Global/verity/issues/860)) ([6cd1452](https://github.com/Heey-Global/verity/commit/6cd14527ec31256745cd12191e4da06f604847f6))
* **mobile:** add iPad microphone shortcut ([#863](https://github.com/Heey-Global/verity/issues/863)) ([6a9f835](https://github.com/Heey-Global/verity/commit/6a9f835be4c9cc617a79440ceefe9cfcc714dcfe))
* **mobile:** add local live meeting capture with Nemotron ([#868](https://github.com/Heey-Global/verity/issues/868)) ([552764b](https://github.com/Heey-Global/verity/commit/552764b6ee199a9de7482108f356bd56b6256ac5))
* **uplink:** add connection diagnostics to public preview settings ([#865](https://github.com/Heey-Global/verity/issues/865)) ([701b1d9](https://github.com/Heey-Global/verity/commit/701b1d9c0887f2589531ec6391530c62f11cfef2))


### Bug Fixes

* **mobile:** ease continuous dictation countdown ([#862](https://github.com/Heey-Global/verity/issues/862)) ([5093884](https://github.com/Heey-Global/verity/commit/50938848cc0f41ba06deb3bd3a3df8830692f9e1))
* **mobile:** expose remote tunnel stream diagnostics ([#872](https://github.com/Heey-Global/verity/issues/872)) ([d739442](https://github.com/Heey-Global/verity/commit/d739442a15216f6152a1b44a2afd69919e292972))
* **preview:** use shared explorer rows in preview sheet ([#864](https://github.com/Heey-Global/verity/issues/864)) ([1e0dda2](https://github.com/Heey-Global/verity/commit/1e0dda2e81bce05d0b3b545eb4e4dc0abffc2c28))

## [1.40.0](https://github.com/Heey-Global/verity/compare/mobile-v1.39.0...mobile-v1.40.0) (2026-09-28)


### Bug Fixes

* **mobile:** prepare native 1.40.0 after failed build ([#854](https://github.com/Heey-Global/verity/issues/854)) ([95dfb18](https://github.com/Heey-Global/verity/commit/95dfb181e038499bad2032f8604ddd9f33005a47))
* **remote-control:** clarify mobile failures and trace connection stages ([#855](https://github.com/Heey-Global/verity/issues/855)) ([a6371e3](https://github.com/Heey-Global/verity/commit/a6371e31d9b1a0d544572398516a84e4f5a24bb9))

## [1.39.0](https://github.com/Heey-Global/verity/compare/mobile-v1.38.0...mobile-v1.39.0) (2026-09-28)


### Bug Fixes

* **mobile:** repair live STT runtime and interim updates ([#850](https://github.com/Heey-Global/verity/issues/850)) ([b90836a](https://github.com/Heey-Global/verity/commit/b90836a2d1f1119a9a6789a60c6ce4b4cc572343))
* **remote-control:** stop dropping idle and long-lived sessions ([#849](https://github.com/Heey-Global/verity/issues/849)) ([1883b3a](https://github.com/Heey-Global/verity/commit/1883b3a0af37b615e898906f4147882602202f41))

## [1.38.0](https://github.com/Heey-Global/verity/compare/mobile-v1.37.0...mobile-v1.38.0) (2026-09-28)


### Features

* **mobile:** add live STT engine test screen ([#840](https://github.com/Heey-Global/verity/issues/840)) ([66e4954](https://github.com/Heey-Global/verity/commit/66e495472274729fdeb678c0785f099d6b1ce809))
* **preview:** share static session worktrees via Uplink ([#848](https://github.com/Heey-Global/verity/issues/848)) ([c46928f](https://github.com/Heey-Global/verity/commit/c46928f49085fec88dd35e5e20139b85872911d9))

## [1.37.0](https://github.com/Heey-Global/verity/compare/mobile-v1.36.0...mobile-v1.37.0) (2026-09-28)


### Bug Fixes

* **mobile:** avoid reset after remote stream completion ([#843](https://github.com/Heey-Global/verity/issues/843)) ([213085e](https://github.com/Heey-Global/verity/commit/213085ef169620be0c26457014f540030980ee68))
* **mobile:** prefetch chat history earlier during scrolling ([#827](https://github.com/Heey-Global/verity/issues/827)) ([34271f7](https://github.com/Heey-Global/verity/commit/34271f795637d9347408f757c01de26b16015b56))
* **mobile:** recover failed Uplink reads through direct route ([#832](https://github.com/Heey-Global/verity/issues/832)) ([709404a](https://github.com/Heey-Global/verity/commit/709404afceb68779f3a1fa936ffd28dcb4d7ee93))
* **mobile:** validate remote routing and expose connection failures ([#830](https://github.com/Heey-Global/verity/issues/830)) ([f4a5e7c](https://github.com/Heey-Global/verity/commit/f4a5e7c509fe3a146e02ac24c7f60af25e376771))

## [1.36.0](https://github.com/Heey-Global/verity/compare/mobile-v1.35.0...mobile-v1.36.0) (2026-09-27)


### Features

* **mobile:** connect paired devices through Uplink remote control ([#821](https://github.com/Heey-Global/verity/issues/821)) ([aa14320](https://github.com/Heey-Global/verity/commit/aa143201dd9338caa3238aba615fa572ced8a29f))


### Bug Fixes

* **gmail:** remove unchanged draft after approved send ([#808](https://github.com/Heey-Global/verity/issues/808)) ([5a0f2a2](https://github.com/Heey-Global/verity/commit/5a0f2a29469cf7654611f861319729abdf34d1a0))
* **mobile:** queue local sockets for remote stream capacity ([#824](https://github.com/Heey-Global/verity/issues/824)) ([1a8eb68](https://github.com/Heey-Global/verity/commit/1a8eb68c97d924df1b4a2b0ee02ba58254368963))

## [1.35.0](https://github.com/Heey-Global/verity/compare/mobile-v1.34.0...mobile-v1.35.0) (2026-09-27)


### Features

* **integrations:** import Matrix chats into project knowledge ([#703](https://github.com/Heey-Global/verity/issues/703)) ([974d14b](https://github.com/Heey-Global/verity/commit/974d14bcc6491312c4584e5d352235f12f8cfab4))
* **mobile:** add opt-in remote control smoke request ([#799](https://github.com/Heey-Global/verity/issues/799)) ([907e88b](https://github.com/Heey-Global/verity/commit/907e88ba004d0e25bef1cd2ae29e4cef50ce0b25))
* **mobile:** group model picker and pin OpenCode model order ([#728](https://github.com/Heey-Global/verity/issues/728)) ([ff7ff46](https://github.com/Heey-Global/verity/commit/ff7ff464d164c89d602463bde0e3fb208ef341fb))
* **mobile:** save local session work to project ([#739](https://github.com/Heey-Global/verity/issues/739)) ([a50760a](https://github.com/Heey-Global/verity/commit/a50760a85a05172768ddfa5cf6f722914d3e0b44))
* **sessions:** link agents across projects ([#736](https://github.com/Heey-Global/verity/issues/736)) ([70f9184](https://github.com/Heey-Global/verity/commit/70f9184c48f7515fa982154c996213f960d0102e))
* **sessions:** move sessions between local projects ([#708](https://github.com/Heey-Global/verity/issues/708)) ([e16056b](https://github.com/Heey-Global/verity/commit/e16056b251ddcccd87fca58f82dcbf9f9cd71756))


### Bug Fixes

* **integrations:** configure Matrix account in Verity settings ([#714](https://github.com/Heey-Global/verity/issues/714)) ([c89df9d](https://github.com/Heey-Global/verity/commit/c89df9d345be0a5a4eb98a78b376642e92e91f0d))
* **integrations:** restore overview and show Matrix setup errors ([#717](https://github.com/Heey-Global/verity/issues/717)) ([abbf7e4](https://github.com/Heey-Global/verity/commit/abbf7e401fb1ebd4f7cd7a30e5307ef60951f0d3))
* **mobile:** choose Matrix room project from server settings ([#745](https://github.com/Heey-Global/verity/issues/745)) ([b5bb074](https://github.com/Heey-Global/verity/commit/b5bb07412f38c5ea9ab668076eff53e595170a60))
* **mobile:** clarify Matrix room connection state ([#757](https://github.com/Heey-Global/verity/issues/757)) ([ec0c2e3](https://github.com/Heey-Global/verity/commit/ec0c2e3047dc200e4ca89a23f248fd3d31ce0887))
* **mobile:** keep dragged projects anchored to the finger ([#707](https://github.com/Heey-Global/verity/issues/707)) ([49e3772](https://github.com/Heey-Global/verity/commit/49e377235ba752727113b3efaf27f555cef7e317))
* **mobile:** let session settings scroll and show link failures ([#746](https://github.com/Heey-Global/verity/issues/746)) ([8fc940e](https://github.com/Heey-Global/verity/commit/8fc940e306d2facbf3d981822bd9cb137eaa6b3f))
* **mobile:** make Matrix account form reflect its save state ([#727](https://github.com/Heey-Global/verity/issues/727)) ([bd50611](https://github.com/Heey-Global/verity/commit/bd50611b43ae4dc0c0e039a317bc085a3fe232bb))
* **mobile:** move Matrix settings under Connected services ([#723](https://github.com/Heey-Global/verity/issues/723)) ([992d172](https://github.com/Heey-Global/verity/commit/992d1726ea1f4512ed94dd2fb0e7babd138e56e5))
* **mobile:** open project settings directly ([#731](https://github.com/Heey-Global/verity/issues/731)) ([7168c69](https://github.com/Heey-Global/verity/commit/7168c69294e45d9cd087a1bc659286423f4f6fc4))
* **mobile:** prefetch older chat history before scroll edge ([#732](https://github.com/Heey-Global/verity/issues/732)) ([b9979a9](https://github.com/Heey-Global/verity/commit/b9979a935e27d19a61a1c6e79550a95654e7bf08))
* **mobile:** restore floating project drag with safe ref cleanup ([#712](https://github.com/Heey-Global/verity/issues/712)) ([02dd64b](https://github.com/Heey-Global/verity/commit/02dd64b2a93d126b91d84709f91a117c65823fcf))
* **mobile:** simplify project settings overview ([#735](https://github.com/Heey-Global/verity/issues/735)) ([877fba2](https://github.com/Heey-Global/verity/commit/877fba2f3b5ed6ee1b7a70030d879c3ccaeb7858))
* **mobile:** unify session settings and project selection ([#719](https://github.com/Heey-Global/verity/issues/719)) ([1eaad62](https://github.com/Heey-Global/verity/commit/1eaad62fee1ae55a74960237a16f5dcc0d156bef))
* **session-links:** keep message approvals until decided ([#796](https://github.com/Heey-Global/verity/issues/796)) ([b1a2519](https://github.com/Heey-Global/verity/commit/b1a2519c80750590abddf86083ee5c4e55332488))


### Reverts

* **mobile:** restore the project reorder from build 1.34.0 ([#709](https://github.com/Heey-Global/verity/issues/709)) ([c57330d](https://github.com/Heey-Global/verity/commit/c57330de74cc9e4ea3ce68bfe977a2e65eb996ba))

## [1.34.0](https://github.com/Heey-Global/verity/compare/mobile-v1.33.0...mobile-v1.34.0) (2026-09-24)


### Features

* add managed knowledge library with project access grants ([#526](https://github.com/Heey-Global/verity/issues/526)) ([e92ca3b](https://github.com/Heey-Global/verity/commit/e92ca3b8701c798406536aa46129daa19ec128b3))
* **drive:** browse shared drives ([#688](https://github.com/Heey-Global/verity/issues/688)) ([8b270d6](https://github.com/Heey-Global/verity/commit/8b270d60860c3723ab04cdb6cd9b5b55006b8f8b))
* **drive:** connect project folders ([#669](https://github.com/Heey-Global/verity/issues/669)) ([2fe210e](https://github.com/Heey-Global/verity/commit/2fe210e63e42c4fffd36ba9628cd92b1f036b7a8))
* **explorer:** delete files across roots ([#647](https://github.com/Heey-Global/verity/issues/647)) ([eb35172](https://github.com/Heey-Global/verity/commit/eb35172f39863b0f1635f9012b020be429866adb))
* **gmail:** add session reading and drafts ([#670](https://github.com/Heey-Global/verity/issues/670)) ([37f2e61](https://github.com/Heey-Global/verity/commit/37f2e6118859f75afee17f0d55f0ba45ab0072e1))
* **gmail:** require approval before sending drafts ([#692](https://github.com/Heey-Global/verity/issues/692)) ([24481ab](https://github.com/Heey-Global/verity/commit/24481ab2491c1a198a9c2bc2d68b7f61cb234b92))
* **knowledge:** add managed project wikis ([#539](https://github.com/Heey-Global/verity/issues/539)) ([f9476a3](https://github.com/Heey-Global/verity/commit/f9476a3b79850d911d2c63bcf363189d450d0f4b))
* **knowledge:** add writable insights and shared publishing ([#651](https://github.com/Heey-Global/verity/issues/651)) ([917d95b](https://github.com/Heey-Global/verity/commit/917d95beac1efd9c48c9663d0803f807987239a2))
* **knowledge:** automate wiki maintenance ([#566](https://github.com/Heey-Global/verity/issues/566)) ([6e77fe9](https://github.com/Heey-Global/verity/commit/6e77fe9ece6a1655d6fbf89a93af271221da79a9))
* **mobile:** add iPad Knowledge split view ([#598](https://github.com/Heey-Global/verity/issues/598)) ([a76b694](https://github.com/Heey-Global/verity/commit/a76b694eb3692fe8b70e3925fb6ffb0ae56a9409))
* **mobile:** clarify attachment menu actions ([#627](https://github.com/Heey-Global/verity/issues/627)) ([e90cffc](https://github.com/Heey-Global/verity/commit/e90cffc9ddb90d825b291e1131d1a1ac3ce961a1))
* **mobile:** improve paired device management ([#469](https://github.com/Heey-Global/verity/issues/469)) ([f16b76d](https://github.com/Heey-Global/verity/commit/f16b76de124619b75a689a668d16bd4122e544cb))
* **mobile:** organize settings with expandable details ([#440](https://github.com/Heey-Global/verity/issues/440)) ([bb147cb](https://github.com/Heey-Global/verity/commit/bb147cb6cfbd6c965bc55fce1bf886f1acbfdb89))
* **mobile:** show sleeping projects with moon icon ([#553](https://github.com/Heey-Global/verity/issues/553)) ([132848a](https://github.com/Heey-Global/verity/commit/132848a499bad5420a53c68964b104312121480f))
* **mobile:** show transient dependency status ([#579](https://github.com/Heey-Global/verity/issues/579)) ([422e76f](https://github.com/Heey-Global/verity/commit/422e76fab7420db941b09280755ea1ea79efcecb))
* **opencode:** add reliable model selection ([#453](https://github.com/Heey-Global/verity/issues/453)) ([12e715e](https://github.com/Heey-Global/verity/commit/12e715e41d5859a91b96afa8465caf5d39b1251e))
* **server:** add project sandbox sleep and wake ([#538](https://github.com/Heey-Global/verity/issues/538)) ([5e8054b](https://github.com/Heey-Global/verity/commit/5e8054b8f938b20ddc3a7b7ffd57509bdde942de))
* **workspace:** edit Google Docs and Sheets ([#503](https://github.com/Heey-Global/verity/issues/503)) ([d72ae01](https://github.com/Heey-Global/verity/commit/d72ae0163f5af3a64e448b766bb185ff2a5fd492))


### Bug Fixes

* **attachments:** report empty files before send ([#648](https://github.com/Heey-Global/verity/issues/648)) ([7ea0d65](https://github.com/Heey-Global/verity/commit/7ea0d65570c8577478f665c30942a25f4c72c8cd))
* **drive:** link unconfigured explorer to settings ([#693](https://github.com/Heey-Global/verity/issues/693)) ([b6b9ac3](https://github.com/Heey-Global/verity/commit/b6b9ac306275925452acf7e6a783b418902208e6))
* **drive:** restore use-in-chat action ([#685](https://github.com/Heey-Global/verity/issues/685)) ([8b21628](https://github.com/Heey-Global/verity/commit/8b21628d1c2165f0148790efa10d228778412d81))
* **drive:** stabilize project folder browsing ([#680](https://github.com/Heey-Global/verity/issues/680)) ([d934ffc](https://github.com/Heey-Global/verity/commit/d934ffc4a54be524e2cbd0111f214d38dc9d5908))
* **files:** verify knowledge explorer roots ([#629](https://github.com/Heey-Global/verity/issues/629)) ([d0bb634](https://github.com/Heey-Global/verity/commit/d0bb63468377183861538a6da5dbc215db1d26b5))
* **knowledge:** complete isolated home before ownership handoff ([#597](https://github.com/Heey-Global/verity/issues/597)) ([7373344](https://github.com/Heey-Global/verity/commit/7373344de46ec3c591ed15c22f386a4392d7cd99))
* **knowledge:** hide unadded repositories ([#556](https://github.com/Heey-Global/verity/issues/556)) ([c4a7c64](https://github.com/Heey-Global/verity/commit/c4a7c64e8eb19ca3d52cdd75d710cdfe3065682c))
* **knowledge:** require a global maintenance model ([#590](https://github.com/Heey-Global/verity/issues/590)) ([fa8b5b1](https://github.com/Heey-Global/verity/commit/fa8b5b1360b979e2805cdd80aaa9341280ed56bd))
* **knowledge:** streamline explorer and enable access across model backends ([#531](https://github.com/Heey-Global/verity/issues/531)) ([d213999](https://github.com/Heey-Global/verity/commit/d213999edc8f4eabcee56952420f47eeee880744))
* **mobile:** align settings row icons ([#506](https://github.com/Heey-Global/verity/issues/506)) ([a72c435](https://github.com/Heey-Global/verity/commit/a72c4354bdbd7ca6b4af4e81e09b3d9e2082590e))
* **mobile:** avoid duplicate Knowledge action on iPad ([#594](https://github.com/Heey-Global/verity/issues/594)) ([296ce3a](https://github.com/Heey-Global/verity/commit/296ce3a4c792f22ecbd03de80edc1e97ca315b79))
* **mobile:** compact iPhone landscape chat ([#633](https://github.com/Heey-Global/verity/issues/633)) ([0bd7071](https://github.com/Heey-Global/verity/commit/0bd7071913148e8a98eaf033991cb8cb613b9120))
* **mobile:** handle the keyboard through one controller everywhere ([#537](https://github.com/Heey-Global/verity/issues/537)) ([7bc27d8](https://github.com/Heey-Global/verity/commit/7bc27d8e5e1e18b32f689944c92300dca1ca2444))
* **mobile:** ignore stale project fold animations ([#479](https://github.com/Heey-Global/verity/issues/479)) ([b157192](https://github.com/Heey-Global/verity/commit/b1571929a7929195f0b4923ed529c0d1539f28ba))
* **mobile:** keep Knowledge navigation header stable ([#599](https://github.com/Heey-Global/verity/issues/599)) ([d5a4c29](https://github.com/Heey-Global/verity/commit/d5a4c29e06babb679788f15d06878ef19a2928d4))
* **mobile:** keep project dragging under the finger and pin usage meters ([#496](https://github.com/Heey-Global/verity/issues/496)) ([9702356](https://github.com/Heey-Global/verity/commit/97023560ebf6f577014bcc42c6a467834326339b))
* **mobile:** keep project reordering from stranding collapsed groups ([#466](https://github.com/Heey-Global/verity/issues/466)) ([a008217](https://github.com/Heey-Global/verity/commit/a008217f4140fc659b97ca7a587dd5b3a3709ead))
* **mobile:** keep projects collapsed during sync ([#476](https://github.com/Heey-Global/verity/issues/476)) ([26cdfdd](https://github.com/Heey-Global/verity/commit/26cdfdd20e49dbb01ecd5fa76cd39de240cfafb0))
* **mobile:** move linked Google file below session header ([#522](https://github.com/Heey-Global/verity/issues/522)) ([5a8b516](https://github.com/Heey-Global/verity/commit/5a8b5162866a05503285e2ee3b0bafb2686c7c3b))
* **mobile:** preserve project drag position when folding clamps scroll ([#500](https://github.com/Heey-Global/verity/issues/500)) ([465b7a1](https://github.com/Heey-Global/verity/commit/465b7a1f583899817723a67f8891d9cf6e2eb73a))
* **mobile:** prevent overscroll during project reordering ([#468](https://github.com/Heey-Global/verity/issues/468)) ([bbb8147](https://github.com/Heey-Global/verity/commit/bbb81471e33ff3fc66bf55a02a505ea500f9b307))
* **mobile:** reconnect Google Drive from workspace picker ([#519](https://github.com/Heey-Global/verity/issues/519)) ([85828d4](https://github.com/Heey-Global/verity/commit/85828d48f92667096109ab285bedd12b6e3fde86))
* **mobile:** render project folds immediately ([#483](https://github.com/Heey-Global/verity/issues/483)) ([bc4c538](https://github.com/Heey-Global/verity/commit/bc4c5380572f83f8e0f4f7055a912a7e930f18e3))
* **mobile:** retain project gesture while folding the list ([#524](https://github.com/Heey-Global/verity/issues/524)) ([0263ddf](https://github.com/Heey-Global/verity/commit/0263ddf98dc25a6f6e5b2c593dfd611c97b66fed))
* **mobile:** search OpenCode models and preserve availability selections ([#462](https://github.com/Heey-Global/verity/issues/462)) ([56d8a94](https://github.com/Heey-Global/verity/commit/56d8a94a1aa41d9e14ccaf1fb4aa8918f536d2c1))
* **mobile:** set project fold visibility explicitly ([#492](https://github.com/Heey-Global/verity/issues/492)) ([9e4b8cd](https://github.com/Heey-Global/verity/commit/9e4b8cd14cdcb1f36bea49ea449755c30ed86647))
* **mobile:** show configured OpenCode models in project sessions ([#451](https://github.com/Heey-Global/verity/issues/451)) ([bb1651d](https://github.com/Heey-Global/verity/commit/bb1651df966ca9e747f36fecde0c601eee157073))
* **mobile:** show files when expanding Knowledge folders ([#595](https://github.com/Heey-Global/verity/issues/595)) ([5a947e1](https://github.com/Heey-Global/verity/commit/5a947e1036dd4158c5aa6a3bd24a92d7912047b7))
* **mobile:** smooth project collapse and reordering ([#455](https://github.com/Heey-Global/verity/issues/455)) ([2458a86](https://github.com/Heey-Global/verity/commit/2458a8654368077d0c0ad72899b2225843d563e8))
* **mobile:** unify project status labels and pulse the magenta dot ([#634](https://github.com/Heey-Global/verity/issues/634)) ([35aaf51](https://github.com/Heey-Global/verity/commit/35aaf517a4932d2188b4a5ee9ced0eefdca1c6ed))
* **mobile:** use provider icons in settings ([#509](https://github.com/Heey-Global/verity/issues/509)) ([c9cb866](https://github.com/Heey-Global/verity/commit/c9cb866fe26d13062b4e7161207ebb0cbf690bce))
* **release:** ignore stale server release drafts ([#461](https://github.com/Heey-Global/verity/issues/461)) ([2f9e12a](https://github.com/Heey-Global/verity/commit/2f9e12a32997af3da1664ed34e57d4906f9630a4))
* **server:** answer project fold writes from the written row ([#497](https://github.com/Heey-Global/verity/issues/497)) ([d5620ac](https://github.com/Heey-Global/verity/commit/d5620ac6fe6e34a27dc0c16fa4020159ed9fedec))
* **server:** stop reporting an unrecorded sandbox toolkit as possible drift ([#686](https://github.com/Heey-Global/verity/issues/686)) ([9a7f8de](https://github.com/Heey-Global/verity/commit/9a7f8de44a0e24ad85fa59b7d909c95de8a6bec3))
* **server:** surface sandbox updates blocked by running turns ([#446](https://github.com/Heey-Global/verity/issues/446)) ([50b74fc](https://github.com/Heey-Global/verity/commit/50b74fcd5cb2d79370ff7bcfcf1221445f694f8c))
* **server:** validate public preview artifacts ([#673](https://github.com/Heey-Global/verity/issues/673)) ([3f15f06](https://github.com/Heey-Global/verity/commit/3f15f06e63ef82d82d6c1b5687343cc626de3840))
* **workspace:** add Google OAuth client ID setting ([#510](https://github.com/Heey-Global/verity/issues/510)) ([d9c4217](https://github.com/Heey-Global/verity/commit/d9c4217c8ca5ea445915477d49295a889b7ee043))
* **workspace:** use shared Google OAuth client ([#515](https://github.com/Heey-Global/verity/issues/515)) ([3f16de1](https://github.com/Heey-Global/verity/commit/3f16de1c80543c75d4e5b48fde0add8e81214b7e))

## [1.33.0](https://github.com/Heey-Global/verity/compare/mobile-v1.32.0...mobile-v1.33.0) (2026-09-17)


### Features

* **opencode:** discover provider models automatically ([#423](https://github.com/Heey-Global/verity/issues/423)) ([2652974](https://github.com/Heey-Global/verity/commit/2652974c14de601cb907630c471d1491dd6d7d2d))


### Bug Fixes

* **mobile:** restore sealed store unlock route ([#419](https://github.com/Heey-Global/verity/issues/419)) ([1ae9954](https://github.com/Heey-Global/verity/commit/1ae99540b48c6e406341dff6c587882bb162ec16))
* **mobile:** retry trusted CLI after secret unlock ([#424](https://github.com/Heey-Global/verity/issues/424)) ([a848b27](https://github.com/Heey-Global/verity/commit/a848b27eb1ccbb6fdf8efa862dd82eb684d2ae8a))
* **mobile:** route sealed store directly to unlock ([#421](https://github.com/Heey-Global/verity/issues/421)) ([eb6eec0](https://github.com/Heey-Global/verity/commit/eb6eec0035ff15d177bc3958775228321a362c5f))
* **mobile:** unify quiet settings and onboarding design ([#431](https://github.com/Heey-Global/verity/issues/431)) ([db6eb5f](https://github.com/Heey-Global/verity/commit/db6eb5ff57e9aed23203d604f1da7f402a092c6c))

## [1.32.0](https://github.com/Heey-Global/verity/compare/mobile-v1.31.0...mobile-v1.32.0) (2026-09-17)


### Bug Fixes

* **mobile:** prepare isolated native builds and trial compiler cache ([#408](https://github.com/Heey-Global/verity/issues/408)) ([73dc5ba](https://github.com/Heey-Global/verity/commit/73dc5ba1f9b38073eff26e4674682df33b658bd5))

## [1.31.0](https://github.com/Heey-Global/verity/compare/mobile-v1.30.0...mobile-v1.31.0) (2026-09-16)


### Features

* **attachments:** raise chat and file upload limits ([#361](https://github.com/Heey-Global/verity/issues/361)) ([659397e](https://github.com/Heey-Global/verity/commit/659397ed1c68b917d4593e68dc60dfcd26816faa))
* **mobile:** reorganize settings navigation ([#341](https://github.com/Heey-Global/verity/issues/341)) ([c324673](https://github.com/Heey-Global/verity/commit/c3246735bbe877533eec3062881a3d15952e25da))


### Bug Fixes

* **mobile:** decode pinned text responses as UTF-8 ([#391](https://github.com/Heey-Global/verity/issues/391)) ([22287a9](https://github.com/Heey-Global/verity/commit/22287a967f6354a5f0aa657b25845cce2dd37e06))
* **mobile:** leave onboarding after cold unlock ([#389](https://github.com/Heey-Global/verity/issues/389)) ([3c6c26f](https://github.com/Heey-Global/verity/commit/3c6c26fb4bec6b7248ca3689d287570ec1a827cc))
* **mobile:** restore paired-device access after restart ([#401](https://github.com/Heey-Global/verity/issues/401)) ([d679e34](https://github.com/Heey-Global/verity/commit/d679e340d63a9913297c5319912c393af89ac07f))
* **mobile:** send on Return without a software keyboard ([#397](https://github.com/Heey-Global/verity/issues/397)) ([695a4e2](https://github.com/Heey-Global/verity/commit/695a4e2a65a90564506a6eafa3156da6bf8025d9))
* **onboarding:** move project setup into app ([#325](https://github.com/Heey-Global/verity/issues/325)) ([d05337d](https://github.com/Heey-Global/verity/commit/d05337dd23b604b349012c3ea30ca9d7a35e5f73))
* **setup:** repair runner volume permissions ([#328](https://github.com/Heey-Global/verity/issues/328)) ([1f54f65](https://github.com/Heey-Global/verity/commit/1f54f6579798ce4682df72b424cec29e259fcbad))
* **ui:** keep asynchronous project start in progress ([#380](https://github.com/Heey-Global/verity/issues/380)) ([e27830c](https://github.com/Heey-Global/verity/commit/e27830c235c7ebc86e1f78e78eb486de50c00305))

## [1.30.0](https://github.com/Heey-Global/verity/compare/mobile-v1.29.0...mobile-v1.30.0) (2026-09-14)


### Bug Fixes

* **deps:** update dependency expo-speech-recognition to v57 ([#300](https://github.com/Heey-Global/verity/issues/300)) ([e3c9e59](https://github.com/Heey-Global/verity/commit/e3c9e598f092830d4d1595475ca6346982b0a634))
* **deps:** update dependency react-native-keyboard-controller to v1.22.4 ([#276](https://github.com/Heey-Global/verity/issues/276)) ([7778ae5](https://github.com/Heey-Global/verity/commit/7778ae579f70dd23de209d2a422b240332f0fe7b))
* **deps:** update dependency react-native-nitro-modules to v0.37.1 ([#277](https://github.com/Heey-Global/verity/issues/277)) ([e78d89e](https://github.com/Heey-Global/verity/commit/e78d89e4d3cb2ebc03c76d7214ba4e7b804aef64))
* **deps:** update dependency react-native-screens to ~4.27.0 ([#280](https://github.com/Heey-Global/verity/issues/280)) ([8c27519](https://github.com/Heey-Global/verity/commit/8c27519baa4a1bcbbf3bd8fdf3e6b731614b9b7d))
* **deps:** update dependency react-native-uitextview to v2.7.1 ([#281](https://github.com/Heey-Global/verity/issues/281)) ([29e0c19](https://github.com/Heey-Global/verity/commit/29e0c196ce9e1e2f8f9e36f9e5490fcc00a0ba4c))
* **deps:** update dependency react-native-unistyles to v3.3.0 ([#282](https://github.com/Heey-Global/verity/issues/282)) ([9292149](https://github.com/Heey-Global/verity/commit/929214976bea4e68bcbc7adc408024ecdf216a56))
* **mobile:** clarify signing key setup ([#250](https://github.com/Heey-Global/verity/issues/250)) ([d5b9a1a](https://github.com/Heey-Global/verity/commit/d5b9a1a6696877d056d279b3f68bcb2c3743c7fc))
* **mobile:** guide agent login handoff ([#247](https://github.com/Heey-Global/verity/issues/247)) ([649a1cd](https://github.com/Heey-Global/verity/commit/649a1cd5b1af1f3c99aaba4460651db8aec67d61))
* **mobile:** improve AI provider guidance ([#253](https://github.com/Heey-Global/verity/issues/253)) ([4333f12](https://github.com/Heey-Global/verity/commit/4333f12a8ea38dfe7231e4c596d24854db2be523))

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
