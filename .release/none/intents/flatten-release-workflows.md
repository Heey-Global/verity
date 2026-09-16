Remove the intermediate release-trains workflow and backend handoff job. Keep
release metadata and publication in release.yml, preserving the installed
Server signing identity, per-train lifecycle locks, and publication gates.
This changes CI orchestration only and does not request a product release.
