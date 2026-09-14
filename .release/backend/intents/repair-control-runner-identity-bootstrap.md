Release the managed Control Runner self-repair that republishes identity after
the first-install volume preparation race instead of remaining in a restart loop,
initializes the Control workspace repository, restores devcontainer identity
compatibility, and accepts release evidence from the current Verity repository.
