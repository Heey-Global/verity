# Changelog

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
