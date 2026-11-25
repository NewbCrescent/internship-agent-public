A classifier receives requirement text and indices only.
It never sees or returns a span, so it cannot anchor a requirement in text the posting does not contain, and an index it invents is discarded.
A failed model call falls back to the deterministic reading rather than failing ingestion.
