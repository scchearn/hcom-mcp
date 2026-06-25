# Security Notes

## Scanner Flagged Patterns

Automated security scanners (Gen, Socket, Snyk) may flag the `hcom-agent-messaging` skill with High or Critical risk. These are false positives — the flagged patterns are legitimate hcom CLI operations documented for agent use.

### Flagged patterns and why they are intentional

| Pattern | Location | Why it exists |
|--------|----------|---------------|
| `curl -fsSL ... \| sh` | SKILL.md install section | Official hcom install method from [github.com/aannoo/hcom](https://github.com/aannoo/hcom). Agents follow this to install hcom when it is not already on PATH. |
| `pip install hcom` / `brew install` | SKILL.md setup table | Alternative install methods from the official hcom distribution. |
| `hcom reset all` | SKILL.md troubleshooting | Documented recovery command for broken hook state. Not run automatically — only when the user reports hcom is not working. |
| `hcom kill` | SKILL.md, references, scripts | Standard hcom CLI command for stopping headless agents and closing terminal panes. Not OS-level `kill`. |
| `subprocess.run(["hcom"] + ...)` | references/script-template.md | Python example for calling the hcom CLI from workflow scripts. Executes a known local binary, not arbitrary code. |
| `--go` flag | throughout | hcom CLI flag to skip interactive confirmation prompts in headless/automated contexts. Not a privilege escalation. |

### What this skill does NOT do

- Does not download or execute arbitrary remote code beyond the official hcom installer
- Does not modify system files, environment, or security settings
- Does not access secrets, credentials, or authentication tokens
- Does not exfiltrate data
- All commands are hcom CLI operations or standard shell patterns (trap, cleanup) for workflow scripting

## Reporting

To report a genuine security issue, open an issue at [github.com/scchearn/hcom-mcp/issues](https://github.com/scchearn/hcom-mcp/issues) or email the maintainer via GitHub.