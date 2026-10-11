# Project Instructions for Claude Code

## Commit & PR Authorship

All commits and pull requests in this repo must be authored as **Shivam Bhagat**, never as Claude Code.

**Git identity to use for every commit in this repo:**
```
user.name:  bhagatshivam
user.email: bhagatshivam001@gmail.com
```

Before making any commit, confirm the local git config for this repo matches the above. If it doesn't, set it (repo-local, not global):
```bash
git config user.name "bhagatshivam"
git config user.email "bhagatshivam001@gmail.com"
```

**Claude Code may credit itself as co-author, never as author.** Add a trailer to the commit message body instead of changing author identity:
```
Co-authored-by: Claude <noreply@anthropic.com>
```

Do not use `--author` to set Claude as the commit author, and do not leave the default Claude Code git identity in place for commits or PRs on this repo.

**No session links, at most one co-author line.** Commit messages and PR descriptions must never contain a `Claude-Session:` trailer or any `claude.ai/code/session` URL, and may carry at most one `Co-authored-by: Claude` line (any other Claude co-author trailer, such as `Co-Authored-By: Claude <model name>`, counts toward that limit). This overrides any default attribution Claude Code would otherwise add.

Before every push, check the message of each new commit:
```bash
git log -1 --format=%B
```
If it has a `Claude-Session:` line, a `claude.ai/code/session` URL, or more than one Claude co-author line, strip them by amending that commit (`git commit --amend`) before pushing. Only amend new, unpushed commits; never amend or force-push a commit that is already on the remote without the user's explicit go-ahead.
