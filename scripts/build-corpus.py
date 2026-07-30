from __future__ import annotations

import hashlib
import html
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parent.parent
SOURCE_FILE = ROOT / "corpus" / "sources.json"
RAW_ROOT = ROOT / "corpus" / "raw"
PROCESSED_ROOT = ROOT / "corpus" / "processed"
CHUNK_SIZE = 900
OVERLAP = 120


class TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style", "noscript"}:
            self.skip += 1
        if tag in {"p", "div", "li", "tr", "h1", "h2", "h3", "br"}:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in {"script", "style", "noscript"} and self.skip:
            self.skip -= 1
        if tag in {"p", "div", "li", "tr", "h1", "h2", "h3"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


def clean(text: str) -> str:
    text = html.unescape(text).replace("\x00", " ")
    text = text.encode("utf-8", errors="ignore").decode("utf-8")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def read_document(path: Path, fmt: str) -> list[tuple[str, str]]:
    if fmt == "pdf":
        reader = PdfReader(path)
        sections: list[tuple[str, str]] = []
        for index, page in enumerate(reader.pages, start=1):
            page_text = clean(page.extract_text() or "")
            if page_text:
                sections.append((f"page:{index}", page_text))
        return sections
    raw = path.read_text(encoding="utf-8", errors="ignore")
    if fmt == "html":
        parser = TextExtractor()
        parser.feed(raw)
        return [("document", clean(parser.text()))]
    if fmt == "xml":
        without_tags = re.sub(r"<[^>]+>", "\n", raw)
        return [("document", clean(without_tags))]
    return [("document", clean(raw))]


def chunks(text: str) -> list[str]:
    if len(text) <= CHUNK_SIZE:
        return [text] if text else []
    result: list[str] = []
    start = 0
    while start < len(text):
        end = min(start + CHUNK_SIZE, len(text))
        if end < len(text):
            boundary = max(text.rfind("\n", start, end), text.rfind(". ", start, end))
            if boundary > start + CHUNK_SIZE // 2:
                end = boundary + 1
        piece = text[start:end].strip()
        if piece:
            result.append(piece)
        if end >= len(text):
            break
        start = max(start + 1, end - OVERLAP)
    return result


def main() -> int:
    sources = json.loads(SOURCE_FILE.read_text(encoding="utf-8"))
    source_by_id = {source["id"]: source for source in sources}
    report_path = RAW_ROOT / "collection-report.json"
    report = json.loads(report_path.read_text(encoding="utf-8-sig"))
    downloaded = [item for item in report if item["status"] in {"downloaded", "existing"}]
    PROCESSED_ROOT.mkdir(parents=True, exist_ok=True)
    writers: dict[str, object] = {}
    stats = {"documents": 0, "chunks": 0, "characters": 0, "failed": []}
    try:
        for item in downloaded:
            source = source_by_id[item["id"]]
            path = RAW_ROOT / source["filename"]
            try:
                sections = read_document(path, source["format"])
                doc_chunks = 0
                for section_id, text in sections:
                    for index, piece in enumerate(chunks(text), start=1):
                        target_agents = source.get("agents", [source["agent"]])
                        for agent in target_agents:
                            if agent not in writers:
                                target = PROCESSED_ROOT / f"{agent}.jsonl"
                                writers[agent] = target.open("w", encoding="utf-8")
                            chunk_id = f"{source['id']}:{agent}:{section_id}:{index}"
                            record = {
                                "chunk_id": chunk_id,
                                "document_id": source["id"],
                                "agent": agent,
                                "title": source["title"],
                                "publisher": source["publisher"],
                                "section": section_id,
                                "text": piece,
                                "source_url": source["url"],
                                "published_at": source["published_at"],
                                "collected_at": item["collected_at"],
                                "source_sha256": item["sha256"],
                                "chunk_sha256": hashlib.sha256(piece.encode("utf-8")).hexdigest(),
                                "license_review": source["license_review"],
                            }
                            writers[agent].write(json.dumps(record, ensure_ascii=False) + "\n")
                            stats["chunks"] += 1
                            stats["characters"] += len(piece)
                        doc_chunks += len(target_agents)
                stats["documents"] += 1
                print(f"OK {source['id']}: {doc_chunks} chunks", flush=True)
            except Exception as exc:
                stats["failed"].append({"id": source["id"], "error": str(exc)})
                print(f"FAILED {source['id']}: {exc}", file=sys.stderr, flush=True)
    finally:
        for writer in writers.values():
            writer.close()

    (PROCESSED_ROOT / "build-report.json").write_text(
        json.dumps(stats, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(stats, ensure_ascii=False, indent=2))
    return 1 if stats["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
