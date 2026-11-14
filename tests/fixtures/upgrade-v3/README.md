# Released v3 session fixture

`session.v3.jsonl` was generated with the unmodified
`@deepseek-ai/dsh-session@0.1.5-rc.1` and
`@deepseek-ai/dsh-session-persistence-jsonl@0.1.5-rc.1` packages, with
`compression: none`.

A session owned a `sessionPersistence.create(session.header)` write handle; the
session appended one `user/message` (with producer source `kind: user`), then
`sessions.flush(session)` and the write handle were flushed and closed. The data
is synthetic. The upgrade test substitutes only the fixture's cwd, because the
original machine path is not present on other platforms.
