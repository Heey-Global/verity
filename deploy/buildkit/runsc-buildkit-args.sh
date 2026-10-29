#!/bin/sh
# BuildKit's runc executor requests retained state with `run --keep`. runsc's
# synchronous run owns its cleanup and has no --keep option. Let runsc finish
# that lifecycle; BuildKit's subsequent best-effort delete may find no state.
set -eu
runtime=$1
shift
remaining=$#
in_run=false
while [ "$remaining" -gt 0 ]; do
    argument=$1
    shift
    remaining=$((remaining - 1))
    if [ "$argument" = run ]; then in_run=true; fi
    if [ "$in_run" = true ] && [ "$argument" = --keep ]; then continue; fi
    set -- "$@" "$argument"
done
exec "$runtime" "$@"
