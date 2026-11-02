#!/bin/sh
# Synthetic lifecycle hook; no real package manager or registry is invoked.
set -eu
python3 /probe/agent.py send "$1"
