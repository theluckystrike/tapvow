# Records the Nebius demo in fake mode (no key, no spend). Run from the repo root.
#   vhs examples/nebius-demo/demo-fake.tape
Output examples/nebius-demo/.run-video/nebius-demo-fake.mp4
Output examples/nebius-demo/.run-video/nebius-demo-fake.gif

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 24
Set TypingSpeed 40ms
Set Theme "Builtin Dark"

Hide
Type "export PS1='> ' DEMO_PACE=2 DEMO_CALL_PAUSE_MS=700 && clear"
Enter
Show

Type "# TapVow puts one signed spending limit on a Nemotron coding agent. Fake mode, no key, no spend."
Enter
Sleep 2s
Type "examples/nebius-demo/run.sh --fake"
Enter
Wait@120s
Sleep 4s
Type "# github.com/theluckystrike/tapvow   MIT   npx tapvow init --provider nebius"
Sleep 8s
