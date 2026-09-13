Do not cut a Server release for this CI-only correction. It makes generated backend
release pull requests inherit their already-green immutable base instead of rerunning
the repository test shards.
