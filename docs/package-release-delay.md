# Dependency release delay

When an agent first installs dependencies in a project, Verity pauses the command and offers **Skip** or **Set up delay**. The delay keeps newly selected registry versions out of dependency resolution until they are at least three days old. It reduces the risk of installing a compromised new release; it is not a guarantee of package safety.

**Set up delay** adds the package manager's setting to its existing configuration, preserving unrelated settings and stronger delays. Verity checks the installed version before offering setup, verifies the written setting, and only then resumes installation. An existing three-day or stronger setting is detected without a prompt. A short confirmation appears in the conversation, such as `3-day delay set up · .npmrc`.

**Skip** saves your choice for this project and continues installation. The choice applies across sessions, including projects created before this feature. There is no separate settings screen: ask the agent to configure the release delay later if you skipped it. Leaving an unanswered card does not save a choice or allow installation.

## Supported package managers

| Manager | Minimum version | Project configuration | Three-day setting |
| --- | --- | --- | --- |
| npm | 11.10.0 | `.npmrc` | `min-release-age=3` (days) |
| pnpm | 10.16.0 | `pnpm-workspace.yaml` | `minimumReleaseAge: 4320` (minutes) |
| Yarn | 4.10.0 | `.yarnrc.yml` | `npmMinimalAgeGate: 4320` (minutes) |
| Bun | 1.3.0 | `bunfig.toml`, `[install]` | `minimumReleaseAge = 259200` (seconds) |
| pip | 26.1 | `pip.conf`, `[install]` | `uploaded-prior-to = P3D` |
| uv | 0.9.17 | `uv.toml`, or `[tool.uv]` in `pyproject.toml` | `exclude-newer = "P3D"` |

The pip wrapper reads the effective native settings and supplies `PIP_UPLOADED_PRIOR_TO` from the project file, so a project-local `pip.conf` actually applies without hiding your existing registry and credential settings. An explicitly selected pip configuration is preserved and extended. pip needs an index that supplies upload-time metadata; indexes without it cannot enforce the delay. pnpm 10's existing `.npmrc` setting is recognized; pnpm 11 uses workspace configuration. npm installs with `--global` also receive the detected age through the environment because npm does not load project configuration for global installs.

An older package manager gets **Cancel** / **Install anyway**, rather than an offer to configure an unsupported setting. Upgrade the manager to use the delay. Verity does not silently upgrade toolchains.

## Coverage and limits

This is everyday protection for the agent's normal `npm`, `pnpm`, `yarn`, `bun`, `pip`, and `uv` commands. Sandbox PATH shims also intercept those commands when a project script calls them. It requires an updated project sandbox toolkit; rebuild an older sandbox to install the shims.

The shims are not a mandatory execution boundary. Absolute paths, replacement toolchains, changing PATH, and Python module invocations such as `python -m pip` can bypass the prompt. Managers outside the six listed above are not intercepted. Explicit command-line overrides and package exclusions can override the native age filter.

The filter applies when selecting new registry versions. Existing installed packages are unchanged. Locked versions, local paths, direct archives, and VCS dependencies follow each manager's native behavior; in particular, `npm ci` installs the existing lockfile rather than resolving through the age filter. Newly released fixes may therefore need an intentional override when they must be installed immediately.

References: [npm changelog](https://github.com/npm/cli/blob/latest/CHANGELOG.md), [pnpm 10.16 release](https://github.com/pnpm/pnpm/releases/tag/v10.16.0), [Yarn 4.10 configuration schema](https://github.com/yarnpkg/berry/blob/%40yarnpkg/cli/4.10.0/packages/plugin-npm/sources/index.ts), [Bun package installation](https://bun.sh/docs/pm/install), [pip release notes](https://github.com/pypa/pip/blob/main/NEWS.rst), [uv 0.9.17 release](https://github.com/astral-sh/uv/releases/tag/0.9.17).
