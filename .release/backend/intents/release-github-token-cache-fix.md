Release the GitHub App token caching and bounded retry fix merged in #241. The original
pull request predated the explicit backend-intent requirement and therefore was not
selected for the Server release train when it merged immediately after that migration.
