Persist the non-secret trusted CLI capability after the runner worker securely
consumes its one-use start request, so trusted commands can reach the sandbox
spawn broker during a live turn and after supervisor recovery.
