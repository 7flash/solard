Solard V35 — first-run wallet vault onboarding

What changes
- `slrd wallet create` no longer dumps a MissingConfigError stack on first use.
- First signing-wallet setup launches an interactive password wizard.
- Passwords are never stored.
- A random SLRD master key is wrapped with PBKDF2-SHA256 + AES-256-GCM under the user's password.
- On Windows, the same master key can also be cached with CurrentUser DPAPI for zero-prompt subsequent CLI runs.
- The portable wrapped key remains in ~/.solard/vault.json, so the password is still a recovery path on another machine.
- Existing legacy wallets are protected: if encrypted wallets already exist but no vault profile is present, V35 refuses to generate a new key and tells the user to restore SLRD_MASTER_KEY and run `slrd setup --adopt-env`.
- `slrd setup`, `slrd setup --status`, and `slrd setup --adopt-env` are added.
- Expected vault/config failures are printed compactly by default. Use `--debug` or SLRD_DEBUG=1 for full stacks.

First run
  bunx slrd wallet create

Example flow
  ╭──────────────────────────────────────────────────────╮
  │                    🦉  SOLARD                       │
  │                  Local wallet vault                 │
  ╰──────────────────────────────────────────────────────╯

  Create vault password: ********
  Confirm password:      ********
  Remember unlock on this Windows account? [Y/n]

  ✓ Vault created
    profile: C:\Users\you\.solard\vault.json
    unlock:  remembered for this Windows user

  🦉 created @main <address>

Legacy migration
  $env:SLRD_MASTER_KEY = "<the old key>"
  bunx slrd setup --adopt-env

Security
- The password itself is never persisted.
- The portable vault file contains only an AES-GCM wrapped master key plus KDF parameters.
- Windows auto-unlock is protected with DPAPI CurrentUser.
- SLRD_MASTER_KEY remains a supported override for CI/automation.
