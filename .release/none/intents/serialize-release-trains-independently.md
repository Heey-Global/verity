Do not cut a Server release for this workflow-only scheduling change. Serialize
Release Please metadata separately from native mobile, website, and the complete
backend publication DAG. Preserve the backend signing workflow identity, manual
recovery inputs, and acceptance gates while allowing independent trains to run
concurrently.
