Prevent an interactive repair run from offering a destructive replacement after
the public bootstrap has already pinned its installer payload to the currently
installed release. Replacements must be requested explicitly so they resolve the
latest release before any data is deleted.
Use that selected, digest-pinned Server image for the gVisor host smoke as well,
so registry cleanup of an unrelated untagged image cannot block installation.
