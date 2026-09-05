# Changelog

## [17.0.0](https://github.com/Heey-Global/verity/compare/v16.5.0...v17.0.0) (2026-09-05)


### ⚠ BREAKING CHANGES

* **server:** The Doppler legacy remediation endpoint and upgrade-time credential cutover are removed. New installations use only the central Doppler broker identity.

### Features

* **github:** grant sandbox management permissions ([e39198e](https://github.com/Heey-Global/verity/commit/e39198e35aae39d180182f91a74cf14dc7bcbd81))
* **mobile:** allow pasting installer pairing code ([6661cae](https://github.com/Heey-Global/verity/commit/6661cae8bf36f284debddd6f1c2a572672c37068))
* **mobile:** allow pasting installer pairing code ([51a1296](https://github.com/Heey-Global/verity/commit/51a1296864c51b37ab3621b386840e8eb267d2d8))
* **pairing:** add secure device onboarding ([6c89bb0](https://github.com/Heey-Global/verity/commit/6c89bb0b32c4c05db79704135191cccbbb7df98f))
* **pairing:** add secure device onboarding ([86efbf4](https://github.com/Heey-Global/verity/commit/86efbf46d674e04a0f8476b7c0378b1be29f3738))


### Bug Fixes

* **agent:** keep review findings within task scope ([1fbf0ff](https://github.com/Heey-Global/verity/commit/1fbf0ff4cd4264a48abce817a4579767525da9e8))
* **agent:** keep review findings within task scope ([97d2617](https://github.com/Heey-Global/verity/commit/97d26176fde9a5be356e26f022e01388212b23fe))
* **auth:** parse bearer headers linearly ([9cdd6db](https://github.com/Heey-Global/verity/commit/9cdd6dbbff3fefdd6ad78c8c15b5b954954ee83a))
* **ci:** keep paired device type internal ([dcf9fd7](https://github.com/Heey-Global/verity/commit/dcf9fd7b05c30013a5f4d5a102d08db06a24d1eb))
* **installer:** validate pairing DNS labels ([7b06222](https://github.com/Heey-Global/verity/commit/7b06222d86582240d1777c9c570bc296d9b09587))
* **mobile:** create signed OTA promotion commits ([1fd028b](https://github.com/Heey-Global/verity/commit/1fd028bb2a5a0b2ffd3c907d6fed5fbac361230b))
* **mobile:** create staging channel before assignment ([adcc9ed](https://github.com/Heey-Global/verity/commit/adcc9edde4a7ff827d37dbe1e88d05652ab461d4))
* **mobile:** create staging channel before assignment ([2faa96a](https://github.com/Heey-Global/verity/commit/2faa96ac592514e72172220b5eba7448762dd832))
* **mobile:** install dependencies before OTA promotion ([a620a51](https://github.com/Heey-Global/verity/commit/a620a51dc83947e62e2afb53a5a538b8ed53a8ae))
* **pairing:** bind enrollment retries to clients ([0dd1ffd](https://github.com/Heey-Global/verity/commit/0dd1ffd1e6a7ce9020d76dc2f7f5b5dc8b8faa7e))
* **pairing:** make enrollment retries idempotent ([2299f34](https://github.com/Heey-Global/verity/commit/2299f34a293c5489c791297c947afc2abeceea88))
* **pairing:** preserve recoverable enrollment state ([bbb3e81](https://github.com/Heey-Global/verity/commit/bbb3e816dc14cdb5d5767b4e1e01485191bde1f0))
* **pairing:** recover enrollment across restarts ([57014e5](https://github.com/Heey-Global/verity/commit/57014e55ff76cd0c3a2cf7de65fc063422538f1a))
* **pairing:** require durable device credentials ([9a1fe1a](https://github.com/Heey-Global/verity/commit/9a1fe1a144129ee315f3f3df333ae0bc8d8cf2cd))


### Performance Improvements

* **server:** project session overviews without hydrating full logs ([7555a7a](https://github.com/Heey-Global/verity/commit/7555a7adb690a0847627d7d30d31d09fe56af7bc))
* **server:** project session overviews without hydrating full logs ([af1636e](https://github.com/Heey-Global/verity/commit/af1636e9efe9e461d7bb187726fe51e8991c53ec))


### Code Refactoring

* **server:** remove legacy Doppler cutover ([516cd34](https://github.com/Heey-Global/verity/commit/516cd343bb07a2678b52a50013ef1140afeffc19))

## [16.5.0](https://github.com/Heey-Global/verity/compare/v16.4.1...v16.5.0) (2026-09-02)


### Features

* port source update a417cd4 ([20eb25b](https://github.com/Heey-Global/verity/commit/20eb25b89a9f5e2bba35fd5d8c7fa5aa8bcda0ce))
* port source update a417cd4 ([eb4029a](https://github.com/Heey-Global/verity/commit/eb4029a09a5d867fd70f062714dee211ad6e42c8))
* **security:** isolate external prompt content ([58c314a](https://github.com/Heey-Global/verity/commit/58c314ab845049941552858b8a238274027fc1db))
* **security:** isolate external prompt content ([dcaf68b](https://github.com/Heey-Global/verity/commit/dcaf68bf139e4e61b8aebec7697944d9b83a0d12))
* **server:** derive the auth gate's pre-auth set from route declarations ([6783b28](https://github.com/Heey-Global/verity/commit/6783b2886f6140f939d30a5a501d8885f22b4ffc))
* **server:** derive the pre-auth route set from route declarations ([dc97f6e](https://github.com/Heey-Global/verity/commit/dc97f6e342ff9417c48f346543df7bacc1b58d18))


### Bug Fixes

* **ci:** run knip where its native parser is installed ([ed4a226](https://github.com/Heey-Global/verity/commit/ed4a22651810c903741d1e4df3315971d106318c))
* **deps:** declare the npm version the floor needs, and isolate the probe ([48d68dd](https://github.com/Heey-Global/verity/commit/48d68dd569491ceff156ef2eb29514696f8c9572))
* **deps:** make the version the floor depends on binding, not advisory ([2b7617c](https://github.com/Heey-Global/verity/commit/2b7617c744cc0625b4b86d6a92ed0c55ec532405))
* **deps:** use the option Renovate still has for ignoring the npm floor ([4bb8f32](https://github.com/Heey-Global/verity/commit/4bb8f3208c8b2cb02766b37b893bb6ae4e5065e3))
* **release:** retry transient registry failures ([ba8bd02](https://github.com/Heey-Global/verity/commit/ba8bd020754dd157c327cb0b2d338387707c02dc))
* **release:** retry transient registry failures ([42a44b0](https://github.com/Heey-Global/verity/commit/42a44b00aa1bd2d2c1156f99b1fbc892ad9d579a))
* **release:** target Verity App Store record ([#29](https://github.com/Heey-Global/verity/issues/29)) ([73f2d43](https://github.com/Heey-Global/verity/commit/73f2d43162cc39bb86deb639b21ef0dbcff5ab28))
* **release:** use local EAS signing on GitHub ([7fab681](https://github.com/Heey-Global/verity/commit/7fab681f2e59779acb9a085fb7dd3bed454ddead))
* **release:** use local EAS signing on GitHub ([d39a017](https://github.com/Heey-Global/verity/commit/d39a017b07af8e75a0434003b3ed881d310f8119))
* **security:** escape Unicode prompt line separators ([b8c34e2](https://github.com/Heey-Global/verity/commit/b8c34e2e4927d8732f6889b574e6446d7970c50d))
* **security:** preserve Agent Loop action semantics ([80181fc](https://github.com/Heey-Global/verity/commit/80181fcb8194f4a4979c3512a0253f083165e9dd))
* **security:** preserve provenance during prompt composition ([14c3e0e](https://github.com/Heey-Global/verity/commit/14c3e0e4382d75694840c65a3239ffdad19a32db))
* **security:** reject malformed external prompt metadata ([3703f3d](https://github.com/Heey-Global/verity/commit/3703f3d755752d45accf0d7d18470590c0fb663b))
* **security:** serialize external provenance labels ([3180ee8](https://github.com/Heey-Global/verity/commit/3180ee8e36f808a9260212518673e95e900ed8bf))
* **server:** fail at boot when a lockout-critical exemption is missing ([948aceb](https://github.com/Heey-Global/verity/commit/948acebd9bbf9a9682d0e2957994b888f7c24ab7))
* **server:** key the pre-auth gate by method, not by pathname ([6d75973](https://github.com/Heey-Global/verity/commit/6d75973c8a168a483b15b1d82f757d4206afb80a))
* **server:** rate-limit Drive authorization ([1f65009](https://github.com/Heey-Global/verity/commit/1f65009e497754b00246dd17a107eda1aaafe7d3))

## [16.4.1](https://github.com/Heey-Global/verity/compare/v16.4.0...v16.4.1) (2026-08-31)


### Bug Fixes

* **release:** bootstrap first server image ([d310255](https://github.com/Heey-Global/verity/commit/d310255a9ebfc4a20b4172138e630fb1f0414e93))
* **release:** bootstrap first server image ([0b2d710](https://github.com/Heey-Global/verity/commit/0b2d710f1b325ab8d417841a8d7fe46194d18c17))
* **release:** identify smoke agent seed image ([ff87b75](https://github.com/Heey-Global/verity/commit/ff87b75606ef1d878b685ff4ba0edba008683d6f))
* **release:** identify smoke agent seed image ([8b23300](https://github.com/Heey-Global/verity/commit/8b23300eeb84c14a358315b64f19e11eccda7f70))
* **release:** keep recovery harness current ([c6eb668](https://github.com/Heey-Global/verity/commit/c6eb6688a55e966c4e0d04658f1cf7910bb6d890))
* **release:** keep recovery harness current ([855da61](https://github.com/Heey-Global/verity/commit/855da6195bc962127d20fdab80ab940262a6f622))
* **release:** provide smoke database password ([8a2b919](https://github.com/Heey-Global/verity/commit/8a2b919d88e94e25c93f646cf71f210fe4b11eb6))
* **release:** provide smoke database password ([431ea37](https://github.com/Heey-Global/verity/commit/431ea37dcc955f7b938330759475723b30ba8ced))
* **release:** stage current smoke driver ([7612a68](https://github.com/Heey-Global/verity/commit/7612a68fc77d5f3b8d053754240041e22149bd45))
* **release:** stage current smoke driver ([2f33574](https://github.com/Heey-Global/verity/commit/2f3357495e5ba531c8921bbab2f46e83abdf5eb7))
* **release:** target repository during recovery ([d3092e7](https://github.com/Heey-Global/verity/commit/d3092e7d9d0aa9851fa96b007d461f0c6f7e9a19))
* **release:** target repository during recovery ([1028bf5](https://github.com/Heey-Global/verity/commit/1028bf5c1f6e7de13598feee9cd8d7390e0a506c))


### Performance Improvements

* **ci:** streamline mobile release validation ([44537ce](https://github.com/Heey-Global/verity/commit/44537ce86dfb9a7318cfc82f928767c620176a2b))
* **ci:** streamline mobile release validation ([339bd61](https://github.com/Heey-Global/verity/commit/339bd61d61b440c896dd61064028974fb049d768))

## [16.4.0](https://github.com/Heey-Global/verity/compare/v16.3.1...v16.4.0) (2026-08-31)


### Features

* **deploy:** add installer host preflight ([4bbdbfc](https://github.com/Heey-Global/verity/commit/4bbdbfca1f3e5b89bdd6b8bc66002c04ec5c1ee2))
* **deploy:** add installer host preflight ([c67cb75](https://github.com/Heey-Global/verity/commit/c67cb75372c50006bc40dad9e6ec03230cc36e1e))
* import Verity public source snapshot ([b6df3cd](https://github.com/Heey-Global/verity/commit/b6df3cdc1ff9f298de8cf04277aad9e2d9644ce3))
* **import:** add private OCI snapshot verifier ([e490988](https://github.com/Heey-Global/verity/commit/e490988027fde20fec9726d63f885ae2570e1f47))
* publish Verity public source snapshot ([eb54199](https://github.com/Heey-Global/verity/commit/eb541995dae084c04d97b7eb1c050855a611c823))


### Bug Fixes

* **ci:** align clean-install health protocol ([362b6ba](https://github.com/Heey-Global/verity/commit/362b6baa881ed696cbdaafe82c6b839bdcae5995))
* **ci:** isolate clean-install deployment mode ([bcbeeb8](https://github.com/Heey-Global/verity/commit/bcbeeb87d3bf8991ccbc6197a65d63a6f36c2d3b))
* **ci:** isolate installer pairing fixture ([ea9a5f6](https://github.com/Heey-Global/verity/commit/ea9a5f69dd0b2cde48157701a7899b389c9f28e1))
* **ci:** provision clean-install pairing state ([f30af0a](https://github.com/Heey-Global/verity/commit/f30af0a4bba7dac7e2db00d66a7feb3df46e36ba))
* **ci:** scan generated release pull requests ([ef7d136](https://github.com/Heey-Global/verity/commit/ef7d13644728f83a77d8e4d3ffc7e7a6090e8189))
* **ci:** scan generated release pull requests ([3849b8e](https://github.com/Heey-Global/verity/commit/3849b8ef446a4c559aca2ba59db94da730b3e7ac))
* **ci:** stabilize server verification ([6ac69ab](https://github.com/Heey-Global/verity/commit/6ac69ab31562f0834946a563c1c0e3aac33e0019))
* **deploy:** make TLS topology explicit ([e7f6dc7](https://github.com/Heey-Global/verity/commit/e7f6dc7b73676454d9a4cecadf9a300d0c499879))
* **deploy:** pin direct server transport mode ([f917513](https://github.com/Heey-Global/verity/commit/f917513968fb539276110daed8863e7228b0c4f6))
* **deploy:** pin legacy server mode ([0e1baf0](https://github.com/Heey-Global/verity/commit/0e1baf05eda61b9b58af1098ce98ebcc359710b7))
* **deploy:** preserve TLS in runner overlay ([fe298b2](https://github.com/Heey-Global/verity/commit/fe298b28160bf149a95baf7793e9ed8cdad0b57a))
* harden imported Verity source snapshot ([d2868bb](https://github.com/Heey-Global/verity/commit/d2868bb6396cb2ba4923a1db60f957db10efb603))
* **runtime:** restore transcripts under sealed roots ([6f6ec80](https://github.com/Heey-Global/verity/commit/6f6ec80a66d35a436d6594faa796665ac9e2ec1b))
* **server:** preserve transport configuration ([41c9ce7](https://github.com/Heey-Global/verity/commit/41c9ce756b57cf1f081857057f98cf18b5108f56))
* **store:** serialize fence projection rollback ([5d971ef](https://github.com/Heey-Global/verity/commit/5d971ef2dc720a70056102201c9841d931e05cc5))

## Changelog

Public Verity release history starts with this repository. Earlier private
development history is intentionally not published.
