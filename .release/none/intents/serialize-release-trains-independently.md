Do not cut a Server release for this workflow-only scheduling change. Serialize
complete backend, native mobile, and website release lifecycles independently,
with a short shared lock for Release Please metadata. Preserve the backend
signing workflow identity, manual recovery inputs, and acceptance gates while
allowing independent trains to run concurrently.
