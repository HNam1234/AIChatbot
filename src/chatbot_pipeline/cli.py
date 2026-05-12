from __future__ import annotations

import argparse
from pathlib import Path

from .config import load_settings
from .pipeline import GroundedChatbotPipeline


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="PageIndex grounded chatbot")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest = subparsers.add_parser("ingest", help="Upload PDFs/images to PageIndex")
    ingest.add_argument("paths", nargs="+", type=Path)
    ingest.add_argument("--no-wait", action="store_true", help="Return immediately after submit")

    ask = subparsers.add_parser("ask", help="Ask a question scoped to processed documents")
    ask.add_argument("question")
    ask.add_argument("--doc-id", action="append", dest="doc_ids", help="Limit answer to one doc_id")

    subparsers.add_parser("docs", help="List known documents")
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    pipeline = GroundedChatbotPipeline(load_settings())

    if args.command == "ingest":
        for path in args.paths:
            record = pipeline.ingest(path, wait=not args.no_wait)
            print(f"{record.doc_id}\t{record.status}\t{record.original_name}")
        return

    if args.command == "ask":
        print(pipeline.ask(args.question, doc_ids=args.doc_ids))
        return

    if args.command == "docs":
        for record in pipeline.documents():
            print(f"{record.doc_id}\t{record.status}\t{record.original_name}")


if __name__ == "__main__":
    main()
