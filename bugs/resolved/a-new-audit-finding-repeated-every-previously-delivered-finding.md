# A new audit finding repeated every previously delivered finding

A watcher held its delivery history in memory, so restarting could send the
same prompt again. When one new finding arrived, the watcher formatted the
entire audit, which repeated all earlier items. Regression: the SQLite-backed
audit fixture delivers the first item, reopens the database, and verifies that
a later injection contains only the new manager item. A failed injection
remains pending, and resolving and reopening an item produces a new revision.
