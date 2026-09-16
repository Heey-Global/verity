Release the Server provisioning fix that rebuilds devcontainer images when their
Docker build reads repository inputs outside `.devcontainer/`, preventing stale
baked bootstrap tools from breaking project setup and repair.
