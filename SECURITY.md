# Security Policy

RewindOS captures and stores a continuous record of your screen, locally on
your machine. That makes its security model worth being explicit about — both
how to report problems and what the tool does and doesn't protect against.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately via GitHub's [**Report a vulnerability**](https://github.com/jaypopat/rewindos/security/advisories/new)
(Security → Advisories).

Helpful to include:

- what the issue is and the impact you see,
- steps to reproduce (or a proof of concept),
- affected version (`rewindos-daemon --version`), distro, and desktop environment.

This is a small, independent project — I'll acknowledge reports as quickly as I
can (aim: within a few days) and keep you updated on a fix. Coordinated
disclosure is appreciated: please give a reasonable window to ship a patch
before going public.

## Supported versions

Fixes target the **latest release**. There are no long-term support branches;
please update before reporting (the app and `install.sh --update` both self-update).

## Threat model — what RewindOS does and doesn't protect

RewindOS is **local-first by design**: capture, OCR, search, and optional AI all
run on your machine, and the captured data never leaves it.

**In scope** (please report):

- Captured data (screenshots, OCR text, the SQLite database) being exfiltrated
  off the machine, or any unexpected outbound network connection.
- The exclusion lists (apps / window-title patterns) failing to suppress capture
  when window metadata *is* available.
- Privilege escalation, code execution, or path-traversal via the daemon, the
  D-Bus interface, the MCP server, or the update path.
- The in-app updater installing an unverified or tampered binary (releases are
  checksum-verified; a bypass is a vulnerability).

**Known limitations / out of scope** (by design, not bugs):

- **Data at rest is not encrypted by the app.** Screenshots (WebP) and the
  SQLite database live under `~/.rewindos/` with normal file permissions. Anyone
  with read access to your user account, or your unencrypted disk, can read them.
  Use full-disk encryption (LUKS) if that's part of your threat model.
- **Exclusion is best-effort.** When the compositor can't tell the daemon which
  app/window is focused, the privacy gate fails *closed* (pauses capture) —
  unless you've explicitly enabled `capture_without_exclusion_enforcement`, which
  trades that safety for coverage. Sensitive content shown by an app not on your
  exclusion list will be captured.
- **Anything with local access to your account** (other processes running as
  your user, malware, a logged-in attacker) is outside what a local capture tool
  can defend against.

## The one network call

RewindOS reaches the network on its own only for a daily update check / anonymous
device count, which is documented and published in full at
<https://rewindos-updates.incident-agent.workers.dev/stats>. No screen content,
IP, or identifier is stored. It can be disabled with `usage_heartbeat = false`
under `[privacy]` in `~/.rewindos/config.toml`.
