"""Each module in this package defines one source.

Convention:
  - module-level constant SOURCE_ID (filesystem-safe id, used for output dir)
  - module-level constant FEED_URL (or a function that builds it)
  - dataclass Record (what one row looks like)
  - function fetch(client: PoliteClient) -> list[Record]
  - function key_for(record: Record) -> str (for dedup / resume)

The CLI discovers sources by importing this package and reading SOURCE_ID.
"""
