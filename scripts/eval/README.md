# Local LLM A/B eval

`local-llm-ab-eval.js` runs a fixed prompt set against a llama-server
(`/v1/chat/completions`) and prints a markdown table. `run-local-llm-ab.sh`
runs it on device for two or more GGUFs back to back, starting a separate
server for each one.

Prompt set (fixed; if you change it, old results are no longer comparable):

| suite | n | what is scored |
|---|---|---|
| `router` | 12 | Japanese intent classification over Shelly's routing surface (`agent_create` / `agent_control` / `web_research` / `code_task` / `summarize` / `terminal_command` / `chat`). Exact match on `{"intent": ...}` |
| `tools` | 8 | JSON function call `{"tool","arguments"}` against a tool catalog shaped like Shelly's, plus one "no tool needed" case. Exact match on tool name, arguments checked against the schema, and per-case value checks |
| `tools_native` | 8 | Only with `--native-tools`. The same cases sent as OpenAI `tools`, scored from `message.tool_calls`. This needs a llama.cpp build that has a parser for the model's tool-call format (MiniCPM5: b9833+) |
| `summary` | 5 | Short Japanese summaries. Scored on recall of required key facts, the line limit, Japanese output, and no `<think>` leaking into the answer |

The table reports these metrics per suite:
- accuracy
- JSON validity (raw text, no grammar, unless you pass `--grammar`)
- mean key recall
- mean wall latency
- generation and prompt tokens/s (from llama-server `timings`)

Decoding is greedy (`temperature 0`, `min_p 0`). Thinking is turned off with
`chat_template_kwargs.enable_thinking=false`, the same as `lib/local-llm.ts`.
A warm-up request runs first and is not counted.

## On device (Galaxy Z Fold6)

Prerequisites:
- llama.cpp is installed (Settings -> llama.cpp Setup).
- Both GGUFs are in `~/models` or `/sdcard/Download`. Qwen3.5-2B comes from the
  in-app catalog. Fetch MiniCPM5-2B from the catalog (builds that include
  this entry) or with curl from Shelly's terminal:

  ```bash
  curl -L -o /sdcard/Download/MiniCPM5-2B-Q4_K_M.gguf \
    https://huggingface.co/openbmb/MiniCPM5-2B-GGUF/resolve/main/MiniCPM5-2B-Q4_K_M.gguf
  # expected: 1561318368 bytes, sha256 ec2d5801640099e97d8d7e8003ad4d81f336e757811f03a26173dddf386602fd
  ```

Run it from Shelly's **in-app terminal**. `adb shell` does not work here: it
can't see the app's `$HOME` or its llama.cpp install. Always call the script
with `bash`, because Knox blocks running a shebang script directly:

```bash
bash scripts/eval/run-local-llm-ab.sh                       # Qwen3.5-2B vs MiniCPM5-2B
EVAL_ARGS="--native-tools" bash scripts/eval/run-local-llm-ab.sh
bash scripts/eval/run-local-llm-ab.sh Qwen3.5-0.8B-Q4_K_M MiniCPM5-2B-Q4_K_M
```

The servers run on `127.0.0.1:8091` (set `EVAL_PORT` to change it), so
Shelly's own `:8080` server keeps running. Each server is started with
`--jinja`, and without `--embedding`, so the numbers measure chat only.
The script prints a combined table, the llama.cpp build line, and a
temporary results directory that holds the per-case JSON and the server logs.

If MiniCPM5 dies at startup with `unknown pre-tokenizer type: 'minicpm5'`,
the installed llama.cpp is older than b9360. Re-run llama.cpp Setup.

## Against any running server

```bash
node scripts/eval/local-llm-ab-eval.js --base-url http://127.0.0.1:8080 \
  --model MiniCPM5-2B-Q4_K_M --out minicpm.json [--native-tools] [--grammar]
node scripts/eval/local-llm-ab-eval.js --compare qwen.json minicpm.json
```
