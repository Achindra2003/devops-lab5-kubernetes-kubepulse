"""
Captures REAL evidence for the Lab 5 report.

Runs each command against the live cluster, stores the raw output in
docs/evidence/*.txt and renders it as a terminal-style PNG in docs/screenshots/.
Nothing here is hand-written output: if a command fails, the failure is what gets rendered.

Prerequisites: cluster created, images loaded, metrics-server installed (see README).
WARNING: step 03 deletes and re-creates the `kubepulse` namespace objects.
Usage: python scripts/capture-evidence.py [--skip-scaling]
"""
import os
import subprocess
import sys
import time
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "docs", "screenshots")
EVID = os.path.join(ROOT, "docs", "evidence")
os.makedirs(SHOTS, exist_ok=True)
os.makedirs(EVID, exist_ok=True)

BG, BAR, BORDER = (13, 17, 23), (22, 27, 34), (48, 54, 61)
WHITE, MUTED, GREEN, CYAN, RED = (230, 237, 243), (139, 148, 158), (63, 185, 80), (88, 166, 255), (248, 81, 73)
MAX_COLS = 150

try:
    FONT = ImageFont.truetype("consola.ttf", 15)
    FONT_B = ImageFont.truetype("consolab.ttf", 15)
    FONT_T = ImageFont.truetype("segoeui.ttf", 13)
except OSError:
    FONT = FONT_B = FONT_T = ImageFont.load_default()


def colour(line):
    if line.startswith("PS "):
        return CYAN, True
    if "[PASS]" in line or "PASSED, 0 FAILED" in line:
        return GREEN, False
    if "[FAIL]" in line or "FAILED" in line and "0 FAILED" not in line:
        return RED, False
    if line.lstrip().startswith("->"):
        return MUTED, False
    return WHITE, False


def render(filename, title, lines):
    wrapped = []
    for ln in lines:
        ln = ln.expandtabs(4).rstrip()
        wrapped.extend([ln[i:i + MAX_COLS] for i in range(0, max(len(ln), 1), MAX_COLS)])
    lh, pad, header = 20, 20, 36
    char_w = FONT.getlength("M")
    width = int(min(max(len(l) for l in wrapped), MAX_COLS) * char_w + pad * 2 + 10)
    width = max(width, 900)
    im = Image.new("RGB", (width, header + pad * 2 + lh * len(wrapped)), BG)
    d = ImageDraw.Draw(im)
    d.rectangle([(0, 0), (width, header)], fill=BAR)
    d.line([(0, header), (width, header)], fill=BORDER)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([(16 + i * 20, 12), (28 + i * 20, 24)], fill=c)
    d.text((90, 10), title, fill=MUTED, font=FONT_T)
    y = header + pad
    for ln in wrapped:
        col, bold = colour(ln)
        d.text((pad, y), ln, fill=col, font=FONT_B if bold else FONT)
        y += lh
    im.save(os.path.join(SHOTS, filename))
    print(f"  rendered {filename}")


def run(cmd, timeout=900):
    """Run a command line, return (display_line, output_lines)."""
    p = subprocess.run(cmd, shell=True, cwd=ROOT, capture_output=True, text=True, timeout=timeout, encoding="utf-8", errors="replace")
    out = (p.stdout + p.stderr).replace("\r", "").rstrip("\n")
    return out.split("\n") if out else ["(no output)"]


def capture(num, slug, title, commands, trim=None):
    print(f"[{num}] {title}")
    lines = []
    for c in commands:
        lines.append(f"PS {os.path.basename(ROOT)}> {c}")
        out = run(c)
        lines.extend(out)
        lines.append("")
    if trim:
        lines = trim(lines)
    name = f"{num}-{slug}"
    with open(os.path.join(EVID, name + ".txt"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    render(name + ".png", title, lines)


def first(n):
    return lambda lines: lines[:n]


def main():
    skip_scaling = "--skip-scaling" in sys.argv
    capture("01", "cluster-nodes", "kind cluster: 1 control-plane + 2 workers", [
        "kubectl get nodes -o wide",
        "kubectl -n kube-system get deploy metrics-server",
    ])
    capture("02", "docker-images", "Three release images built from one Dockerfile", ["docker images kubepulse"])

    run("kubectl delete -k k8s/base --ignore-not-found")
    capture("03", "kubectl-apply", "Declarative deploy: kubectl apply -k k8s/base", ["kubectl apply -k k8s/base"])
    run("kubectl -n kubepulse rollout status deploy/kubepulse --timeout=180s")
    time.sleep(15)

    capture("04", "get-all", "Deployment, ReplicaSet, Pods (spread across workers), Services, HPA, PDB",
            ["kubectl -n kubepulse get deploy,rs,pods,svc,hpa,pdb -o wide"])
    capture("05", "describe-deployment", "Deployment spec: strategy, probes, resources, security (excerpt)",
            ["kubectl -n kubepulse describe deploy kubepulse"],
            trim=lambda l: [x for x in l if x.strip()][:46])
    capture("06", "service-load-balancing", "Service endpoints and load balancing across Pods",
            ["kubectl -n kubepulse get svc,endpoints", "node scripts/probe.js 12"])
    capture("07", "validate-deployment", "npm run validate:deploy", ["node scripts/validate-deployment.js"])
    capture("08", "validate-resilience", "npm run validate:resilience (self-healing)", ["node scripts/validate-resilience.js"])
    capture("09", "validate-rollout", "npm run validate:rollout (rolling update, failed release, rollback)",
            ["node scripts/validate-rollout.js", "kubectl -n kubepulse get rs"])
    if not skip_scaling:
        capture("10", "validate-scaling", "npm run validate:scaling (manual scale + HPA)",
                ["node scripts/validate-scaling.js", "kubectl -n kubepulse get hpa"])
    capture("11", "naive-vs-production", "Measured downtime: naive Deployment vs production manifest",
            ["node scripts/compare-naive.js"])
    print("Done. Dashboard screenshot (12) is taken separately — see docs/screenshots/README.md.")


if __name__ == "__main__":
    main()
