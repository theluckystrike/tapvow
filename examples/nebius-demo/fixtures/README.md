# Recorded Nemotron replies for the parser tests

Model nvidia/nemotron-3-super-120b-a12b on Nebius Token Factory, through the TapVow gateway, with the demo agent's first prompt.

- `nemotron-reasoning-off-20261027.txt`. Real reply, 27 Oct 2026, `chat_template_kwargs.enable_thinking` false. 467 output tokens, 0 reasoning tokens. No Markdown fences, only `// file:` lines.
- `nemotron-reasoning-on-20261027.txt`. Real reply, 27 Oct 2026, reasoning on. 1611 output tokens, 971 of them reasoning (sent in `reasoning_content`, not in this file). Also no fences.
- `nemotron-fenced-20261026-rebuilt.txt`. Rebuilt, not raw. The two files the agent wrote from call 1 of the 26 Oct run, put back into the fenced form that the old parser accepted. The raw replies of the 26 and 27 Oct runs were not saved. The agent now saves every reply in `replies/`.
- `nemotron-run-*.txt`. Real replies from the capped demo run, copied from its `replies/` folder.
