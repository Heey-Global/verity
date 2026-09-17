Trusted CLI failures now carry a stable, secret-safe broker error code and the
existing gateway call id through the supervisor response. This lets support
correlate one failed materialization with its audit record without exposing raw
exceptions, paths, aliases, provider responses, environment variables, or secret
values.
