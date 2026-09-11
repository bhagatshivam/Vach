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
