from typing import Protocol, Any
from pathlib import Path

class Parser(Protocol):
    source_name: str

    def parse(self, path: Path) -> list[dict[str, Any]]:
        ...
