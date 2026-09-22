#!/usr/bin/env python3
"""Turns text into a pgvector-ready embedding literal.

Reads the text to embed from stdin (not argv - grading text can be long,
multi-line, and contain characters that are painful to shell-escape safely).
Prints exactly one line: "[0.0123,-0.0456,...]", the same bracketed-list
format pgvector expects inside a SQL literal, e.g.:

    INSERT INTO graded_examples (..., embedding) VALUES (..., '[0.01,...]')

Model is BAAI/bge-small-en-v1.5 via fastembed (ONNX, no PyTorch) - 384
dimensions, ~130MB, picked specifically because this box only has ~900MB
of RAM total and PyTorch alone would risk crashing it. This script is meant
to be invoked as a short-lived subprocess per call (like grading_query.sh),
not imported into the long-running Flask process, so the model's memory is
freed the moment the embedding is produced.
"""
import sys

from fastembed import TextEmbedding

text = sys.stdin.read().strip()
if not text:
    print("usage: echo '<text>' | embed_text.py", file=sys.stderr)
    sys.exit(1)

model = TextEmbedding()
vector = list(model.embed([text]))[0]
print("[" + ",".join(f"{v:.6f}" for v in vector) + "]")
