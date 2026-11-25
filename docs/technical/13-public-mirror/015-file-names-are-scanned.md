File names are scanned as well: `scanPath` runs the deny-list, forbidden-pattern, run-id, and secret checks on every exported path, read once as written and once with its hyphens, underscores, dots, and slashes as spaces, because doc and bug file names now come from titles and first words.
A hit fails the sync like a content hit and is listed as `<path>:0 path <kind>: <rule>`.
