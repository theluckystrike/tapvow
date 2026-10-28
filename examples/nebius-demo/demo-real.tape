# Records the Nebius demo with real calls to Nebius Token Factory. Run from the
# repo root with the key in a 0600 file. The key is never typed or shown.
#   NEBIUS_API_KEY_FILE=$HOME/.secrets/nebius-api-key vhs examples/nebius-demo/demo-real.tape
# The TapVow cap holds the spend at DEMO_BUDGET (0.02 USD here).
Output examples/nebius-demo/.run-video/nebius-demo-real.mp4
Output examples/nebius-demo/.run-video/nebius-demo-real.gif

Set Shell "bash"
Set FontSize 15
Set Width 1440
Set Height 900
Set Padding 24
Set TypingSpeed 40ms
Set Theme "Builtin Dark"

Hide
Type "export PS1='> ' DEMO_PACE=2 DEMO_BUDGET=0.02 && clear"
Enter
Show

Type "# TapVow puts one signed spending limit on a Nemotron coding agent on Nebius Token Factory."
Enter
Sleep 2s
Type "examples/nebius-demo/run.sh"
Enter
Wait@600s
Sleep 4s
Type "# github.com/theluckystrike/tapvow   MIT   npx tapvow init --provider nebius"
Sleep 8s
