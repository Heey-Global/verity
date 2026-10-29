#!/usr/bin/env bash
# Render the systemd path as a literal, preserving custom diagnostic mounts.
set -euo pipefail
template=$1
directory=$2
[[ $directory == /* && $directory != / && $directory != */ &&
   $directory != *:* && $directory != *//* &&
   ! $directory =~ (^|/)\.\.?(/|$) &&
   ! $directory =~ [[:cntrl:]] ]] || { echo 'Invalid build diagnostic directory' >&2; exit 1; }
quoted=${directory//\\/\\\\}
quoted=${quoted//\"/\\\"}
quoted=${quoted//%/%%}
while IFS= read -r line || [[ -n $line ]]; do
    case $line in
        *@DIAGNOSTIC_DIR@*) printf '%s%s%s\n' "${line%%@DIAGNOSTIC_DIR@*}" "$quoted" "${line#*@DIAGNOSTIC_DIR@}" ;;
        *) printf '%s\n' "$line" ;;
    esac
done < "$template"
