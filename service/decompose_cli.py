"""Decompose a video into motions from the command line (verifies Step 1).

  routervenv/bin/python service/decompose_cli.py assets/videos/flag.mp4

Uses Bedrock by default in this environment (CLAUDE_CODE_USE_BEDROCK=1); set
ROUTER_USE_BEDROCK=0 + ANTHROPIC_API_KEY to use the direct API instead. Prints the
Contract-A JSON the VLM Router would return — handy for checking the Step-1 done-when
("a flag+smoke+birds clip -> correctly-classed entries") without running the server.
"""
import sys, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import vlm_router as R

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: decompose_cli.py <video>", file=sys.stderr); sys.exit(2)
    if not R._auth_ready():
        print("ERROR: no credentials for backend "
              f"{'bedrock' if R.USE_BEDROCK else 'anthropic'}", file=sys.stderr); sys.exit(1)
    print(f"[cli] backend={'bedrock' if R.USE_BEDROCK else 'anthropic'} model={R.MODEL}",
          file=sys.stderr)
    contract, warnings = R.decompose(sys.argv[1])
    if warnings:
        contract["warnings"] = warnings
    print(json.dumps(contract, indent=2))
