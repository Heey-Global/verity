# Changelog

## [1.7.0](https://github.com/Heey-Global/verity/compare/website-v1.6.1...website-v1.7.0) (2026-09-16)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))
* **installer:** improve download progress and output hierarchy ([1ef36f3](https://github.com/Heey-Global/verity/commit/1ef36f3ef377251276faa1c803b0bfe27c4c2d6c))
* **installer:** show inline download progress ([150530a](https://github.com/Heey-Global/verity/commit/150530ad466dd9525bbf7ef31b26075a58ea848e))
* **installer:** show installation progress ([7f2cef1](https://github.com/Heey-Global/verity/commit/7f2cef19c79d00688061f4ae4a75c0ba7b46f96c))
* **installer:** show installation progress ([d805252](https://github.com/Heey-Global/verity/commit/d80525295f477dad74ae218ba7d25be4db18002c))
* **mcp:** support OAuth connections ([#225](https://github.com/Heey-Global/verity/issues/225)) ([181b277](https://github.com/Heey-Global/verity/commit/181b277eb33371270388e3bc7def4bb417c79821))


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged docker tag to v1.31 ([#285](https://github.com/Heey-Global/verity/issues/285)) ([a36a64f](https://github.com/Heey-Global/verity/commit/a36a64fd0cdab1bf0789dff3c0e5b0af87917da1))
* **deps:** update nginxinc/nginx-unprivileged:1.31-alpine docker digest to 19c132c ([#342](https://github.com/Heey-Global/verity/issues/342)) ([e718ccb](https://github.com/Heey-Global/verity/commit/e718ccbbdaa52d5534969e0321ff537f3ad64065))
* **deps:** update nginxinc/nginx-unprivileged:1.31-alpine docker digest to b54ac35 ([#375](https://github.com/Heey-Global/verity/issues/375)) ([6d04d2f](https://github.com/Heey-Global/verity/commit/6d04d2fb5f142c3821ec73d4e6c1d2da82a324a3))
* **github:** return manifest callbacks through the app ([768e5c0](https://github.com/Heey-Global/verity/commit/768e5c0fe74110ce6de2c752be9d73c61d38f912))
* **github:** route organization setup through public bridge ([1ce4932](https://github.com/Heey-Global/verity/commit/1ce4932bc11576404d9c4b2231a40cc018673ec5))
* **installer:** fence unpaired retries at bootstrap ([a4a52ea](https://github.com/Heey-Global/verity/commit/a4a52ea2ae7994678164c218bf8dccab5afbfdff))
* **installer:** handle existing deployments safely ([b8419ea](https://github.com/Heey-Global/verity/commit/b8419ea0f714d33a5504ddc4cef231526570d395))
* **installer:** handle existing deployments safely ([2582c19](https://github.com/Heey-Global/verity/commit/2582c1907bf2e573640967e71f6adcb25d9faf71))
* **installer:** honor explicit bootstrap image ([9a93173](https://github.com/Heey-Global/verity/commit/9a93173b3b2b7d27acf8e4f002ebe07efed7bb5a))
* **installer:** prevent stale interactive reinstall ([#379](https://github.com/Heey-Global/verity/issues/379)) ([d71dc54](https://github.com/Heey-Global/verity/commit/d71dc54e464fb7ed09fcbdef0fb35010683499d2))
* **installer:** recover the sealed server image ([256ca76](https://github.com/Heey-Global/verity/commit/256ca76b410fcefa6c898e4233c46e5d74ab77ef))
* **installer:** recover the sealed server image ([e1a6d7d](https://github.com/Heey-Global/verity/commit/e1a6d7d120ee7b626d1a006cdbb55b9660a3d61a))
* **installer:** resume unpaired setup on latest release ([83ef246](https://github.com/Heey-Global/verity/commit/83ef2464d9d49894db6a11522f64cdf992359bcc))
* **installer:** retain explicit image fence ([d7135a6](https://github.com/Heey-Global/verity/commit/d7135a6ebb32dcc5b1a9017f829230183fd611f7))
* **mobile:** authorize GitHub HTTPS callbacks ([#227](https://github.com/Heey-Global/verity/issues/227)) ([ae00382](https://github.com/Heey-Global/verity/commit/ae003829defb4ddfb2b7fc389eed13ddc9c7e963))
* **website:** harden GitHub App bridge ([9eb6f6c](https://github.com/Heey-Global/verity/commit/9eb6f6cefd3c32c0b9698ef7a4ac5168d00e0050))

## [1.6.1](https://github.com/Heey-Global/verity/compare/website-v1.6.0...website-v1.6.1) (2026-09-16)


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged:1.31-alpine docker digest to b54ac35 ([#375](https://github.com/Heey-Global/verity/issues/375)) ([6d04d2f](https://github.com/Heey-Global/verity/commit/6d04d2fb5f142c3821ec73d4e6c1d2da82a324a3))
* **installer:** prevent stale interactive reinstall ([#379](https://github.com/Heey-Global/verity/issues/379)) ([d71dc54](https://github.com/Heey-Global/verity/commit/d71dc54e464fb7ed09fcbdef0fb35010683499d2))

## [1.6.0](https://github.com/Heey-Global/verity/compare/website-v1.5.1...website-v1.6.0) (2026-09-15)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))
* **installer:** improve download progress and output hierarchy ([1ef36f3](https://github.com/Heey-Global/verity/commit/1ef36f3ef377251276faa1c803b0bfe27c4c2d6c))
* **installer:** show inline download progress ([150530a](https://github.com/Heey-Global/verity/commit/150530ad466dd9525bbf7ef31b26075a58ea848e))
* **installer:** show installation progress ([7f2cef1](https://github.com/Heey-Global/verity/commit/7f2cef19c79d00688061f4ae4a75c0ba7b46f96c))
* **installer:** show installation progress ([d805252](https://github.com/Heey-Global/verity/commit/d80525295f477dad74ae218ba7d25be4db18002c))
* **mcp:** support OAuth connections ([#225](https://github.com/Heey-Global/verity/issues/225)) ([181b277](https://github.com/Heey-Global/verity/commit/181b277eb33371270388e3bc7def4bb417c79821))


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged docker tag to v1.31 ([#285](https://github.com/Heey-Global/verity/issues/285)) ([a36a64f](https://github.com/Heey-Global/verity/commit/a36a64fd0cdab1bf0789dff3c0e5b0af87917da1))
* **deps:** update nginxinc/nginx-unprivileged:1.31-alpine docker digest to 19c132c ([#342](https://github.com/Heey-Global/verity/issues/342)) ([e718ccb](https://github.com/Heey-Global/verity/commit/e718ccbbdaa52d5534969e0321ff537f3ad64065))
* **github:** return manifest callbacks through the app ([768e5c0](https://github.com/Heey-Global/verity/commit/768e5c0fe74110ce6de2c752be9d73c61d38f912))
* **github:** route organization setup through public bridge ([1ce4932](https://github.com/Heey-Global/verity/commit/1ce4932bc11576404d9c4b2231a40cc018673ec5))
* **installer:** fence unpaired retries at bootstrap ([a4a52ea](https://github.com/Heey-Global/verity/commit/a4a52ea2ae7994678164c218bf8dccab5afbfdff))
* **installer:** handle existing deployments safely ([b8419ea](https://github.com/Heey-Global/verity/commit/b8419ea0f714d33a5504ddc4cef231526570d395))
* **installer:** handle existing deployments safely ([2582c19](https://github.com/Heey-Global/verity/commit/2582c1907bf2e573640967e71f6adcb25d9faf71))
* **installer:** honor explicit bootstrap image ([9a93173](https://github.com/Heey-Global/verity/commit/9a93173b3b2b7d27acf8e4f002ebe07efed7bb5a))
* **installer:** recover the sealed server image ([256ca76](https://github.com/Heey-Global/verity/commit/256ca76b410fcefa6c898e4233c46e5d74ab77ef))
* **installer:** recover the sealed server image ([e1a6d7d](https://github.com/Heey-Global/verity/commit/e1a6d7d120ee7b626d1a006cdbb55b9660a3d61a))
* **installer:** resume unpaired setup on latest release ([83ef246](https://github.com/Heey-Global/verity/commit/83ef2464d9d49894db6a11522f64cdf992359bcc))
* **installer:** retain explicit image fence ([d7135a6](https://github.com/Heey-Global/verity/commit/d7135a6ebb32dcc5b1a9017f829230183fd611f7))
* **mobile:** authorize GitHub HTTPS callbacks ([#227](https://github.com/Heey-Global/verity/issues/227)) ([ae00382](https://github.com/Heey-Global/verity/commit/ae003829defb4ddfb2b7fc389eed13ddc9c7e963))
* **website:** harden GitHub App bridge ([9eb6f6c](https://github.com/Heey-Global/verity/commit/9eb6f6cefd3c32c0b9698ef7a4ac5168d00e0050))

## [1.5.1](https://github.com/Heey-Global/verity/compare/website-v1.5.0...website-v1.5.1) (2026-09-15)


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged:1.31-alpine docker digest to 19c132c ([#342](https://github.com/Heey-Global/verity/issues/342)) ([e718ccb](https://github.com/Heey-Global/verity/commit/e718ccbbdaa52d5534969e0321ff537f3ad64065))

## [1.5.0](https://github.com/Heey-Global/verity/compare/website-v1.4.1...website-v1.5.0) (2026-09-14)


### Features

* **deploy:** enable arm64 hosts ([#332](https://github.com/Heey-Global/verity/issues/332)) ([eb92547](https://github.com/Heey-Global/verity/commit/eb9254752fbfd70e10832c0ba8c8640b159d4797))

## [1.4.1](https://github.com/Heey-Global/verity/compare/website-v1.4.0...website-v1.4.1) (2026-09-14)


### Bug Fixes

* **deps:** update nginxinc/nginx-unprivileged docker tag to v1.31 ([#285](https://github.com/Heey-Global/verity/issues/285)) ([a36a64f](https://github.com/Heey-Global/verity/commit/a36a64fd0cdab1bf0789dff3c0e5b0af87917da1))

## [1.4.0](https://github.com/Heey-Global/verity/compare/website-v1.3.5...website-v1.4.0) (2026-09-13)


### Features

* **mcp:** support OAuth connections ([#225](https://github.com/Heey-Global/verity/issues/225)) ([181b277](https://github.com/Heey-Global/verity/commit/181b277eb33371270388e3bc7def4bb417c79821))


### Bug Fixes

* **mobile:** authorize GitHub HTTPS callbacks ([#227](https://github.com/Heey-Global/verity/issues/227)) ([ae00382](https://github.com/Heey-Global/verity/commit/ae003829defb4ddfb2b7fc389eed13ddc9c7e963))

## [1.3.5](https://github.com/Heey-Global/verity/compare/website-v1.3.4...website-v1.3.5) (2026-09-12)


### Bug Fixes

* **installer:** recover the sealed server image ([256ca76](https://github.com/Heey-Global/verity/commit/256ca76b410fcefa6c898e4233c46e5d74ab77ef))
* **installer:** recover the sealed server image ([e1a6d7d](https://github.com/Heey-Global/verity/commit/e1a6d7d120ee7b626d1a006cdbb55b9660a3d61a))

## [1.3.4](https://github.com/Heey-Global/verity/compare/website-v1.3.3...website-v1.3.4) (2026-09-11)


### Bug Fixes

* **installer:** handle existing deployments safely ([b8419ea](https://github.com/Heey-Global/verity/commit/b8419ea0f714d33a5504ddc4cef231526570d395))
* **installer:** handle existing deployments safely ([2582c19](https://github.com/Heey-Global/verity/commit/2582c1907bf2e573640967e71f6adcb25d9faf71))

## [1.3.3](https://github.com/Heey-Global/verity/compare/website-v1.3.2...website-v1.3.3) (2026-09-11)


### Bug Fixes

* **github:** route organization setup through public bridge ([1ce4932](https://github.com/Heey-Global/verity/commit/1ce4932bc11576404d9c4b2231a40cc018673ec5))

## [1.3.2](https://github.com/Heey-Global/verity/compare/website-v1.3.1...website-v1.3.2) (2026-09-10)


### Bug Fixes

* **github:** return manifest callbacks through the app ([768e5c0](https://github.com/Heey-Global/verity/commit/768e5c0fe74110ce6de2c752be9d73c61d38f912))
* **website:** harden GitHub App bridge ([9eb6f6c](https://github.com/Heey-Global/verity/commit/9eb6f6cefd3c32c0b9698ef7a4ac5168d00e0050))

## [1.3.1](https://github.com/Heey-Global/verity/compare/website-v1.3.0...website-v1.3.1) (2026-09-07)


### Bug Fixes

* **installer:** fence unpaired retries at bootstrap ([a4a52ea](https://github.com/Heey-Global/verity/commit/a4a52ea2ae7994678164c218bf8dccab5afbfdff))
* **installer:** retain explicit image fence ([d7135a6](https://github.com/Heey-Global/verity/commit/d7135a6ebb32dcc5b1a9017f829230183fd611f7))

## [1.3.0](https://github.com/Heey-Global/verity/compare/website-v1.2.1...website-v1.3.0) (2026-09-06)


### Features

* **installer:** improve download progress and output hierarchy ([1ef36f3](https://github.com/Heey-Global/verity/commit/1ef36f3ef377251276faa1c803b0bfe27c4c2d6c))
* **installer:** show inline download progress ([150530a](https://github.com/Heey-Global/verity/commit/150530ad466dd9525bbf7ef31b26075a58ea848e))

## [1.2.1](https://github.com/Heey-Global/verity/compare/website-v1.2.0...website-v1.2.1) (2026-09-06)


### Bug Fixes

* **installer:** honor explicit bootstrap image ([9a93173](https://github.com/Heey-Global/verity/commit/9a93173b3b2b7d27acf8e4f002ebe07efed7bb5a))
* **installer:** resume unpaired setup on latest release ([83ef246](https://github.com/Heey-Global/verity/commit/83ef2464d9d49894db6a11522f64cdf992359bcc))

## [1.2.0](https://github.com/Heey-Global/verity/compare/website-v1.1.0...website-v1.2.0) (2026-09-06)


### Features

* **installer:** show installation progress ([7f2cef1](https://github.com/Heey-Global/verity/commit/7f2cef19c79d00688061f4ae4a75c0ba7b46f96c))
* **installer:** show installation progress ([d805252](https://github.com/Heey-Global/verity/commit/d80525295f477dad74ae218ba7d25be4db18002c))

## [1.1.0](https://github.com/Heey-Global/verity/compare/website-v1.0.0...website-v1.1.0) (2026-08-31)


### Features

* **deploy:** add installer host preflight ([4bbdbfc](https://github.com/Heey-Global/verity/commit/4bbdbfca1f3e5b89bdd6b8bc66002c04ec5c1ee2))
* **deploy:** add installer host preflight ([c67cb75](https://github.com/Heey-Global/verity/commit/c67cb75372c50006bc40dad9e6ec03230cc36e1e))
* import Verity public source snapshot ([b6df3cd](https://github.com/Heey-Global/verity/commit/b6df3cdc1ff9f298de8cf04277aad9e2d9644ce3))
* publish Verity public source snapshot ([eb54199](https://github.com/Heey-Global/verity/commit/eb541995dae084c04d97b7eb1c050855a611c823))


### Bug Fixes

* harden imported Verity source snapshot ([d2868bb](https://github.com/Heey-Global/verity/commit/d2868bb6396cb2ba4923a1db60f957db10efb603))

## Website changelog

Public Verity website release history starts with this repository. Earlier
private development history is intentionally not published.
