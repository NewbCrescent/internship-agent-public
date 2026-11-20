# GitHub evidence package

Milestone 2 ingests bounded public GitHub repository evidence without cloning or executing repository code.

The package:

- resolves a repository's default branch, head commit, tree, metadata, and languages through the versioned GitHub REST API;
- selects README files, manifests, and a bounded set of source files;
- fetches only new or changed blobs after the initial sync;
- creates deterministic project, technology, skill-signal, and metric claim candidates;
- pins evidence to a commit, path, line range, excerpt hash, and GitHub source link;
- requires explicit allow, question, or reject review before a current claim is considered verified.

Public repositories work without credentials subject to GitHub's unauthenticated limits. Set `GITHUB_TOKEN` locally for a higher read limit. Tokens are never persisted or logged.
