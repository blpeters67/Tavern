"""Make a consistent copy of the database while Tavern keeps running.

    docker compose exec tavern python -m tavern.backup

Writes data/backups/tavern-<date>.db (or the path given as an argument).
Uploaded files in data/uploads never change once written, so a plain copy of
that folder is enough for them.
"""

from __future__ import annotations

import sqlite3
import sys
import time
from pathlib import Path

from .config import settings


def main() -> None:
    if not settings.db_path.exists():
        sys.exit(f"No database at {settings.db_path}")
    if len(sys.argv) > 1:
        dest = Path(sys.argv[1])
    else:
        dest = settings.data_dir / "backups" / f"tavern-{time.strftime('%Y%m%d-%H%M%S')}.db"
    dest.parent.mkdir(parents=True, exist_ok=True)

    src = sqlite3.connect(settings.db_path)
    dst = sqlite3.connect(dest)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    print(f"Backed up to {dest}")


if __name__ == "__main__":
    main()
