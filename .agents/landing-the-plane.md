# Landing the Plane

## Trigger Phrase

**When the user says "let's land the plane"**, you MUST complete ALL steps below. The plane is NOT landed until `git push` succeeds.

> NEVER stop before pushing. NEVER say "ready to push when you are!" - that is a FAILURE.

## Mandatory Workflow

Complete ALL steps in order:

1. **File tk issues** for any remaining work that needs follow-up

2. **Run quality gates** (only if code changes were made):
   ```bash
   make shellcheck
   make test
   ```
   File P0 issues if broken.

3. **Update tk issues** - close finished work, update status

4. **PUSH TO REMOTE - NON-NEGOTIABLE**:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin/main"
   ```

5. **Clean up git state**:
   ```bash
   git stash clear
   git remote prune origin
   ```

6. **Verify clean state** - All changes committed AND pushed, no untracked files

7. **Choose a follow-up issue** - Provide prompt for next session:
   > "Continue work on df-X: [issue title]. [Brief context about what's been done and what's next]"

## Critical Rules

- The plane has NOT landed until `git push` completes successfully
- NEVER stop before `git push` - that leaves work stranded locally
- NEVER say "ready to push when you are!" - YOU must push, not the user
- If `git push` fails, resolve the issue and retry until it succeeds
- Unpushed work breaks coordination workflow
