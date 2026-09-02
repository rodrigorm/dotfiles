# Sandbox glossary

The canonical terms for the OpenCode sandbox system are:

- **Host**: the machine where the user started the OpenCode session.
- **Session**: one OpenCode conversation with its own execution location.
- **Workspace**: OpenCode's durable association between a session, project, branch, and execution target.
- **Runtime**: the isolated environment that can execute a session away from the host.
- **Provider**: the kind of runtime used for a workspace.
- **Target**: the local directory or remote endpoint where OpenCode routes a session.
- **Capture**: the committed revision, tracked changes, and untracked files taken from the host before activation.
- **Sync**: preservation of runtime changes outside the runtime before detachment or deletion.
- **Generation**: one activation attempt for a session. A later generation invalidates control granted to an earlier one.
- **Ownership**: the identity that links a session, workspace, generation, provider, and runtime resource.
- **Control capability**: short-lived authority for one session generation and one role, either host or remote.
- **Drift**: disagreement between the lifecycle record, OpenCode workspace, in-memory handle, provider resource, or Git worktree.
- **Control lost**: the lifecycle owner has no live handle for a runtime it previously controlled. The runtime may or may not still exist.
- **Orphan**: an observed provider resource whose owner is verified but whose live control handle has been lost.
- **Preserved worktree**: a Git worktree retained because automatic integration or cleanup could lose changes.
