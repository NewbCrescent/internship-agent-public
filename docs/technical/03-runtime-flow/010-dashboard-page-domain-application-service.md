```text
Dashboard page -> domain/application service -> SQLite repository
Dashboard form -> Server Action -> Zod validation -> service -> repository
Question -> deterministic mapper -> policy gate -> scoped fact lookup -> resolution
Evidence page -> Server Action -> GitHub evidence service -> GitHub REST read + SQLite repositories
Jobs page -> Server Action -> agent orchestrator -> jobs normalization -> SQLite repositories
Jobs page -> Server Action -> agent match orchestrator -> matching eligibility + fit -> SQLite match reports
Jobs page -> Server Action -> agent application orchestrator -> writer package -> verifier gate -> SQLite packages, resume variants, event log
Applications page -> Server Action -> agent browser orchestrator -> sign-in check -> fill -> upload (Handshake base PDF or rendered variant PDF) -> approval-gated submit
Profile page -> Server Action -> base resume service -> profile data directory + SQLite checksum row
Resume page -> Server Action -> resume entry service -> SQLite entry revisions; /resume/preview route -> structured resume -> Chromium PDF
Profile page -> Server Action -> Connect Handshake -> visible browser window -> URL-only sign-in state -> SQLite browser_sessions
```
