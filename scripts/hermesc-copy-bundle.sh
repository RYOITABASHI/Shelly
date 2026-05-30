#!/usr/bin/env bash
set -euo pipefail

out_file=""
input_file=""
expect_out=0

for arg in "$@"; do
  if [ "$expect_out" -eq 1 ]; then
    out_file="$arg"
    expect_out=0
    continue
  fi

  if [ "$arg" = "-out" ]; then
    expect_out=1
    continue
  fi

  input_file="$arg"
done

if [ -z "$out_file" ] || [ -z "$input_file" ]; then
  echo "hermesc-copy-bundle.sh: expected '-out <file> <input bundle>'" >&2
  exit 64
fi

cp "$input_file" "$out_file"
