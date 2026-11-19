# Contributing

Thanks for helping out! Bug reports, fixes and on-boat test results are all welcome.

## A human in the loop

Pull requests, issues and comments here come from people, not from autonomous agents or bots acting on their own.

Using AI tools to help write, debug or test your change is fine. What we ask is that you:

- **Understand the change.** You can explain what it does and why, and you'll answer review questions yourself.
- **Have run it.** `npm test` passes, and changes to `scanner.js` have been tried on real hardware (a Linux host with BlueZ) where possible. Say what you tested and what you couldn't.
- **Submit it yourself.** No unattended agents opening PRs, issues or comments.
- **Tell us if you used AI.** A sentence in the PR description is enough, e.g. "Drafted with an AI assistant; I reviewed it and tested it on my boat." Whether you also credit it in commit trailers is up to you.

PRs and issues that look like unattended agent output, with nobody responding to review, may be closed without detailed review. Dependabot updates are the exception.

## Making a change

1. Open an issue first for anything larger than a small fix, so we can agree on the approach.
2. Keep PRs focused on one thing. Use conventional commit subjects (`fix(scanner): …`, `feat: …`).
3. Run `npm test`.
4. In the PR description, describe the problem, the change, how you tested it, and whether AI was used.

PRs are squash-merged once CI passes and the review is done.

Agent-specific guidance for this repo lives in [AGENTS.md](AGENTS.md).
