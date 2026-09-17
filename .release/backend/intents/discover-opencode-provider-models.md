Release the Server change that discovers OpenCode models from the configured
provider's authenticated `/models` endpoint. Setup now requires only the API base
URL and API key, and the server-owned catalog refreshes on configuration changes,
startup, secret unlock, and every 24 hours. This replaces the manually configured
model list used by session selection and sandbox provisioning.
