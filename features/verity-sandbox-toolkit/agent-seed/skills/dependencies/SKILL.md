---
name: dependencies
description: Use before installing project dependencies, including before running npm install or npm ci in a session worktree.
---

Run `verity dependencies status` first. When dependencies are missing or stale, run `verity dependencies install`: it prepares each dependency version once per project and activates it in this worktree, reusing compatible shared installations. Do not run `npm install` or `npm ci` merely to obtain dependencies in a session worktree; that gives every session its own full installation. Use `npm install <package>` only to change dependencies, then run `verity dependencies install`. Never install incompatible dependencies into the shared tree, hardlink writable packages or remove local patches.
